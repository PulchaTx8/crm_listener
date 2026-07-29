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
-- null). For a Station-scoped row, member_blocks_company_org_fk
-- (organization_id must be the company's, 0032:138-139) and
-- member_blocks_member_org_fk (organization_id must be the member's,
-- 0032:136-137) TOGETHER force the row's one organization_id to be the
-- single Organization shared by both — member_id and company_id can only
-- both match on a row when they already share an Organization — a
-- cross-Organization match is structurally impossible there. The
-- Organization-wide branch (company_id is null) carries no such term:
-- nothing in "b.company_id is null" ties the row to p_company_id's
-- Organization at all. Without a further check, a caller entitled to their
-- own Station could pass any member_id UUID and learn whether THAT member —
-- of any Organization, not just the caller's — carries an active
-- Organization-wide block, purely by knowing or guessing the UUID. That is
-- the same cross-tenant boolean oracle shape the Block 3 whole-branch
-- review closed for is_member_blocked (0032, I1), reopened here for ids
-- outside the caller's own Organization.
-- is_member_blocked (0032) carries the identical gap for a single row —
-- confirmed by reading its body. Owner's ruling, 2026-07-29 (Task 3 review):
-- fix it here too, alongside its bulk twin, rather than leave it leaking
-- while the batch form is corrected — is_member_blocked is not a dormant
-- path (services/members.ts's checkMemberBlocked calls it by name, in turn
-- called from listOrganizationMembers and listMemberStations). See the
-- "is_member_blocked (0032) superseded" section below, after this
-- function's own grant, for that fix and its full story.
--
-- Closed here by resolving p_company_id's own Organization once and requiring
-- every candidate block row's organization_id to match it. The FK argument
-- above already makes that sufficient on its own for excluding member ids
-- from another Organization — a member_blocks row can only carry a given
-- member_id and organization_id pair if the member actually belongs to that
-- Organization (member_blocks_member_org_fk, 0032:136-137) — so no join back
-- to members is needed to reach the same result.
--
-- Owner's ruling, 2026-07-29 (Task 3 review, second round): even with the
-- Organization term above, a caller holding members.view at ONE Station in
-- their own Organization could still pass any member_id from that SAME
-- Organization and learn whether it carries an active block — including a
-- Member linked only to a Station the caller cannot reach, whom
-- members_select_reachable (0035:95-100) hides from them entirely, and whom
-- member_blocks_select_reachable was deliberately narrowed to also hide
-- (0035:163-175, reasoning written out at 0035:141-144: "a delegate at
-- Station A only could read every Organization-wide block in the whole
-- Organization ... including for Members members_select_reachable itself
-- hides from them entirely"). Both SECURITY DEFINER functions here were
-- looser than the RLS policy sitting right beside them. Closed by requiring
-- public.member_reachable(member_id, v_organization_id, 'members.view')
-- (0033) — the SAME predicate 0035's own policies call, not a hand-rolled
-- equivalent: this project has already paid for two hand-copies of this
-- exact reachability rule drifting apart, which is precisely why 0033 was
-- built to be the one implementation.
--
-- This puts per-row work back inside the bulk function — the thing this
-- task exists to remove. The resulting shape: one round trip containing N
-- reachability checks (one member_reachable call per id in the batch, each
-- itself a permission lookup plus a member_company_links scan), rather than
-- N round trips each redoing a full permission subtree. Still one round
-- trip instead of up to fifty, so the trade holds — but it is not free, and
-- is named here rather than left to be discovered later as an unexplained
-- cost.
--
-- For every call this codebase's application code actually makes today,
-- this term is redundant: listOrganizationMembers only ever asks about a
-- block for a Member members_select_reachable (0035) already returned under
-- RLS, and listMemberStations is reached — via the listener detail page —
-- only after getMember's own RLS-gated read
-- (src/app/(app)/members/[memberId]/page.tsx:60-74) has already confirmed
-- that same Member reachable; a caller who could not reach the Member never
-- gets far enough in either real screen to ask about their block. The term
-- matters only against a direct RPC call supplying a member_id the caller
-- could not have reached through either normal read path.
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
    public.member_reachable(ids.id, v_organization_id, 'members.view')
    and exists (
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
  'Whether an active block bars each listed Member at p_company_id right now, derived at read time from starts_at/ends_at/lifted_at. The set-at-a-time form of is_member_blocked (0032): same three-arm caller guard, checked once for the one Station the whole batch concerns. Also requires each candidate block row to belong to p_company_id''s own Organization, AND that the caller can reach the Member at all (public.member_reachable, 0033, the same predicate members_select_reachable and member_blocks_select_reachable use, 0035) — closing two cross-tenant oracles a company_id-only match would leave open: one across Organizations, one within the caller''s own Organization against a Member they hold no link to (Task 3 review, both rounds; see the function''s header comment for the full argument).';

revoke execute on function public.members_blocked_bulk(uuid[], uuid) from public;
grant execute on function public.members_blocked_bulk(uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- is_member_blocked (0032) superseded.
--
-- Owner's ruling, 2026-07-29, on the Task 3 review finding above: the gap
-- that shipped in the first draft of members_blocked_bulk was already live
-- in is_member_blocked (0032) — its query was copied into the bulk
-- predicate unchanged, gap included. 0032 is merged and shipped, and this
-- project amends a migration in place only on an unreleased branch, so the
-- fix is a CREATE OR REPLACE here, not an edit to 0032's file. Read 0032 in
-- isolation — its body, and the comment attached to it — and both still
-- read as current; they are not. This section is what actually runs; 0032
-- is historical from here on for this one function.
--
-- Reproduces 0032's body (0032:184-214) exactly, with the identical
-- organization_id and member_reachable terms added to members_blocked_bulk
-- above. Why the Organization gap was there, precisely: for a Station-scoped
-- block (member_blocks.company_id set), member_blocks_company_org_fk
-- (organization_id must be the company's, 0032:138-139) and
-- member_blocks_member_org_fk (organization_id must be the member's,
-- 0032:136-137) TOGETHER force the row's one organization_id to be the
-- single Organization shared by both — member_id and company_id could never
-- both match on a row spanning two different Organizations, so no
-- additional term was needed there. The company FK is MATCH SIMPLE
-- (Postgres' default), so it is not checked at all when company_id is null
-- (0032:132-135, "when company_id is null, this half of the constraint is
-- not checked, which is exactly right for an Organization-wide block") — an
-- Organization-wide row therefore carries nothing tying its organization_id
-- to p_company_id. Without the term added below, a caller holding
-- members.view at their own Station could pass ANY member_id UUID —
-- belonging to any Organization, not only the caller's — and learn whether
-- that member carried an active Organization-wide block, purely from
-- knowing or guessing the UUID: the exact cross-tenant boolean oracle shape
-- the Block 3 whole-branch review (I1) believed it had closed by adding the
-- caller guard below, which checks only that the caller can reach
-- p_company_id and never that p_member_id relates to it at all.
--
-- Second round (owner's ruling, 2026-07-29): even Organization-scoped, a
-- caller holding members.view at one Station could still pass any member_id
-- from their OWN Organization and learn its block status, including a
-- Member linked only to a Station they cannot reach — the same residual
-- oracle closed in members_blocked_bulk above by requiring
-- public.member_reachable(member_id, v_organization_id, 'members.view')
-- (0033), the same predicate members_select_reachable and
-- member_blocks_select_reachable use (0035; full reasoning in
-- members_blocked_bulk's own header comment above, not repeated here). Same
-- redundancy note applies: every real call to checkMemberBlocked (from
-- listOrganizationMembers or listMemberStations) only ever names a Member
-- already confirmed reachable by RLS before this function is called: this
-- term matters only against a direct RPC call.
--
-- Call-site check (Task 3 fix round, before this shipped): is_member_blocked
-- is called by checkMemberBlocked, in turn called from
-- listOrganizationMembers and listMemberStations, both in
-- src/services/members.ts — that is real, live traffic, not a dormant path.
-- (isMemberBlocked, the public one-off wrapper that also calls this RPC, has
-- no caller anywhere in this codebase today — grepped the whole src and
-- tests trees to confirm — so it does not itself count as evidence either
-- way; the two calls above already establish this is a live function.)
-- Every one of checkMemberBlocked's two call sites derives its company_id
-- argument from a member_company_links row keyed by that same member_id —
-- and member_company_links' own composite foreign keys
-- (member_links_member_org_fk / member_links_company_org_fk, 0031:132-135)
-- force member_id and company_id to already share one Organization on every
-- such row. No existing call site could ever have supplied a cross-Organization
-- pair, so the Organization fix changes no result any shipped code path can
-- observe; it only forecloses a pair no legitimate caller has ever
-- constructed. The reachability fix is checked the same way, in the
-- redundancy note above.
create or replace function public.is_member_blocked(p_member_id uuid, p_company_id uuid)
returns boolean
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
    raise log 'is_member_blocked denied: actor=% member=% company=%', auth.uid(), p_member_id, p_company_id;
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  select c.organization_id into v_organization_id
  from public.companies c
  where c.id = p_company_id;

  return public.member_reachable(p_member_id, v_organization_id, 'members.view')
    and exists (
      select 1
      from public.member_blocks b
      where b.member_id = p_member_id
        and b.organization_id = v_organization_id
        and (b.company_id is null or b.company_id = p_company_id)
        and b.lifted_at is null
        and b.starts_at <= now()
        and (b.ends_at is null or b.ends_at > now())
    );
end;
$$;

-- Overwrites 0032's comment on this same function (COMMENT ON is a property
-- of the live catalog object, not of the migration file that last set it) —
-- a reader of \df+ or obj_description sees this text, not 0032's, from this
-- migration onward. Deliberately says so explicitly, since the whole point
-- of this section is that 0032's file is no longer an accurate description
-- of what runs.
comment on function public.is_member_blocked(uuid, uuid) is
  'Whether an active block bars this Member at p_company_id right now, derived at read time from starts_at/ends_at/lifted_at rather than a maintained status column. Re-checks the caller is the platform admin, the owner of p_company_id''s Organization, or holds members.view at p_company_id — mirroring member_company_links_select_reachable''s own three arms (0035) exactly. Also requires the matching block row to belong to p_company_id''s own Organization, AND that the caller can reach the Member at all (public.member_reachable, 0033, the same predicate members_select_reachable and member_blocks_select_reachable use, 0035) — closing two cross-tenant oracles a company_id-only match left open: one across Organizations, one within the caller''s own Organization against a Member they hold no link to. THIS BODY SUPERSEDES the one 0032 shipped, which lacked both terms — see the "is_member_blocked (0032) superseded" comment in 0036_member_blocked_bulk.sql for the full story. 0032''s own file and its comment on this function describe a body that no longer runs.';

revoke execute on function public.is_member_blocked(uuid, uuid) from public;
grant execute on function public.is_member_blocked(uuid, uuid) to authenticated;

-- CREATE OR REPLACE FUNCTION preserves the existing ACL when the signature
-- is unchanged, so the two lines above do not change any privilege 0032
-- did not already grant. Restated anyway, matching this project's actual
-- precedent for superseding a shipped, security-relevant function in a
-- later migration: 0030_inventory_adjustment_semantics.sql (0030:188-194)
-- considered this exact question in writing when it replaced
-- apply_inventory_movement, and restated its own revoke "so this migration
-- is self-contained and does not rely on [the earlier migration] having run
-- first doing the right thing silently" — then restated both lines again
-- for adjust_stock (0030:336-337). Following that considered choice here,
-- not 0016_memberships.sql's SILENT omission when it replaced
-- has_company_access: 0016 writes nothing about the grant question at all,
-- so it is not a precedent that anyone decided this either way — a gap this
-- migration's first draft mistook for one.

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
