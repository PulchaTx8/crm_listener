-- supabase/migrations/0036_member_blocked_bulk.sql

-- The set-at-a-time form of is_member_blocked (0032).
--
-- The audience list asks the same question for every listener on the page, at
-- the same Station. Asked one row at a time it costs up to fifty round trips,
-- and — because is_member_blocked is SECURITY DEFINER and re-checks its caller
-- on every invocation — it recomputes the identical permission subtree
-- (a permissions lookup, has_company_access, and a
-- company_memberships-roles-role_permissions join) fifty times for one Station.
--
-- The caller guard is checked ONCE here, for the single Station every row in
-- the batch is asked about, and it is the same three arms 0032 uses, for the
-- same reason: has_permission alone refuses the platform admin and the owner
-- for a suspended or archived Station, which is the regression the Block 3
-- whole-branch review caught. The batch changes nothing about that reasoning
-- — every id in p_member_ids is asked about the same, single p_company_id, so
-- one guard check for the whole call is the same guarantee as checking it on
-- every row.
--
-- Returning a row per input id, rather than only the blocked ones, is
-- deliberate: the caller can then map without deciding what a missing id
-- means. unnest() preserves duplicate ids verbatim, so a caller who passes
-- the same id twice gets two rows back, both carrying the same blocked value
-- — harmless for a map keyed by member_id, since both writes agree. An empty
-- array, and a SQL NULL array, both make unnest() produce zero rows: the
-- guard still runs (a caller with no access to p_company_id is refused even
-- for an empty or null batch), and the function then returns no rows rather
-- than raising.
--
-- Task 3 review: matching member_blocks by member_id and company_id alone,
-- with no organization_id term, is safe for a Station-scoped block
-- (company_id set) but not for an Organization-wide one (company_id is
-- null). For a Station-scoped row, member_blocks_company_org_fk forces the
-- row's organization_id to be the shared Organization of both its member and
-- its company (0032:132-139), so member_id and company_id can only both
-- match on a row when they already share an Organization — a cross-Organization
-- match is structurally impossible there. The Organization-wide branch
-- (company_id is null) carries no such term: nothing in "b.company_id is
-- null" ties the row to p_company_id's Organization at all. Without a
-- further check, a caller entitled to their own Station could pass any
-- member_id UUID and learn whether THAT member — of any Organization, not
-- just the caller's — carries an active Organization-wide block, purely by
-- knowing or guessing the UUID. That is the same cross-tenant boolean oracle
-- shape the Block 3 whole-branch review closed for is_member_blocked (0032,
-- I1), reopened here for ids outside the caller's own Organization.
-- is_member_blocked (0032) carries the identical gap for a single row —
-- confirmed by reading its body, not touched here, since this migration's
-- brief is explicit that is_member_blocked stays exactly as it is; flagged
-- in the task report as a pre-existing concern for a future task to weigh,
-- not fixed by this one.
--
-- Closed here by resolving p_company_id's own Organization once and requiring
-- every candidate block row's organization_id to match it. The FK argument
-- above already makes that sufficient on its own for excluding member ids
-- from another Organization — a member_blocks row can only carry a given
-- member_id and organization_id pair if the member actually belongs to that
-- Organization (member_blocks_member_org_fk, 0032:136-137) — so no join back
-- to members is needed to reach the same result.
create or replace function public.members_blocked_bulk(
  p_member_ids uuid[],
  p_company_id uuid
)
returns table (member_id uuid, blocked boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_organization_id uuid;
begin
  if not (
    public.is_platform_admin()
    or exists (
      select 1 from public.companies c
      where c.id = p_company_id and public.is_owner(c.organization_id)
    )
    or public.has_permission('members.view', p_company_id)
  ) then
    raise log 'members_blocked_bulk denied: actor=% company=% batch=%',
      auth.uid(), p_company_id, coalesce(array_length(p_member_ids, 1), 0);
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  select c.organization_id into v_organization_id
  from public.companies c
  where c.id = p_company_id;

  return query
  select
    ids.id,
    exists (
      select 1
      from public.member_blocks b
      where b.member_id = ids.id
        and b.organization_id = v_organization_id
        and (b.company_id is null or b.company_id = p_company_id)
        and b.lifted_at is null
        and b.starts_at <= now()
        and (b.ends_at is null or b.ends_at > now())
    )
  from unnest(p_member_ids) as ids(id);
end;
$$;

comment on function public.members_blocked_bulk(uuid[], uuid) is
  'Whether an active block bars each listed Member at p_company_id right now, derived at read time from starts_at/ends_at/lifted_at. The set-at-a-time form of is_member_blocked (0032): same three-arm caller guard, checked once for the one Station the whole batch concerns. Also requires each candidate block row to belong to p_company_id''s own Organization — closing a cross-tenant oracle in the Organization-wide-block branch that a company_id-only match would leave open (Task 3 review; see the function''s header comment for the full argument).';

revoke execute on function public.members_blocked_bulk(uuid[], uuid) from public;
grant execute on function public.members_blocked_bulk(uuid[], uuid) to authenticated;

-- The indexes the audience list's sorting and filtering need. Neither column
-- has one today (verified against 0031_members.sql).
--
-- members_name_idx already exists, but on (organization_id, lower(full_name)) —
-- so sorting by name must order by the SAME expression or the index is ignored
-- silently, which looks like nothing at all until the table is large.
create index members_created_at_idx
  on public.members (organization_id, created_at, id)
  where deleted_at is null;

-- The age filter is a birth_date range, never a per-row age computation: an
-- expression in the WHERE clause cannot use this index.
create index members_birth_date_idx
  on public.members (organization_id, birth_date)
  where deleted_at is null;
