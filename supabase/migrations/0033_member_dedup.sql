-- supabase/migrations/0033_member_dedup.sql

-- THE ONE PLACE IN THIS PROJECT THAT READS ACROSS THE VISIBILITY BOUNDARY BY DESIGN.
-- Everywhere else, a cross-tenant read is a defect; here it is the feature, which
-- makes it the thing to review hardest.
--
-- A Member is Organization-scoped but visibility is per Station. So when someone
-- registers a phone number that already exists at a Station they cannot reach, the
-- system must refuse the duplicate WITHOUT revealing who holds it.
--
-- Three answers, and only three:
--   none      — no Member in this Organization carries that identifier.
--   visible   — there is one, and the caller may see it: the id comes back.
--   elsewhere — there is one, and the caller may NOT see it: existence only.
--
-- The third leaks that SOMEBODY holds the identifier. That is unavoidable — any
-- system preventing duplicates across a boundary leaks the existence of what is on
-- the other side. What it must never leak is WHO: no id, no name, no Station name,
-- no count. (Task-3 review, Important 3: an earlier draft of this comment claimed
-- the answer "says what to do next," as if it carried a message field — it does
-- not, in any branch. That copy belongs to the client that turns this outcome into
-- a workflow, Task 6's Node layer, not to this function.)

-- Whether the caller holds p_permission at ANY Station p_member_id is linked to.
-- has_permission requires an ACTIVE Station (has_company_access, 0005_rls_helpers.sql,
-- redefined 0016_memberships.sql), so a Member linked only to a suspended or archived
-- Station would be unreachable to literally everyone — including the owner and the
-- platform admin — unless their bypass sits OUTSIDE that gate. Fixed here for
-- find_member_by_identifier, below, by Task 3's review (Important 2). Defined once,
-- in this one place, rather than left as a hand-copy inside each of 0034's write RPCs
-- that need the identical check (update_member, archive_member, anonymize_member) —
-- Task 4 review, Important 5: 0031's own comment on normalize_phone/normalize_email
-- is a standing warning about exactly that kind of drift, and it applies here too.
--
-- SECURITY INVOKER. Reachable from inside a SECURITY DEFINER body, where it runs
-- with that body's already-elevated privileges (apply_inventory_movement's
-- convention, 0027_inventory_rpcs.sql) — update_member, archive_member and
-- anonymize_member (0034) all call it that way, and so does find_member_by_identifier,
-- below. Also, since Task 5's review, called directly from members_select_reachable's
-- USING clause (0035_rls_members.sql) — which is why EXECUTE is granted to
-- authenticated below rather than withheld entirely. That grant widens no real
-- capability: is_platform_admin(), is_owner() and has_permission() were already
-- granted to authenticated, and member_company_links, the one table this function
-- reads, is itself RLS-protected (0035). Called this second way, the exists() below
-- runs under member_company_links' own SELECT policy rather than bypassing it — the
-- two must be kept in agreement, or members visibility silently drifts from what this
-- function computes.
create or replace function public.member_reachable(
  p_member_id       uuid,
  p_organization_id uuid,
  p_permission      text
)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select
    public.is_platform_admin()
    or public.is_owner(p_organization_id)
    or exists (
      select 1
      from public.member_company_links l
      where l.member_id = p_member_id
        and public.has_permission(p_permission, l.company_id)
    );
$$;

comment on function public.member_reachable(uuid, uuid, text) is
  'Whether the caller holds p_permission at any Station p_member_id is linked to, admitting the platform admin and the Organization owner outside the per-link has_permission check (Task 3 review, Important 2) so a Member whose only Station is suspended or archived is not a permanent dead end. SECURITY INVOKER. Called from inside a SECURITY DEFINER body by find_member_by_identifier, below, and update_member/archive_member/anonymize_member (0034_member_rpcs.sql), and — since Task 5''s review — directly from members_select_reachable''s USING clause (0035_rls_members.sql), which is why EXECUTE is granted to authenticated rather than withheld entirely. Called that second way, the exists() sub-query in this function''s body runs under member_company_links'' own RLS policy (0035) instead of bypassing it; the two must be kept in agreement.';

revoke execute on function public.member_reachable(uuid, uuid, text) from public;
-- Granted to authenticated, not withheld: 0035's members_select_reachable calls this
-- directly from an RLS policy (see the block comment above the function).
grant execute on function public.member_reachable(uuid, uuid, text) to authenticated;

create or replace function public.find_member_by_identifier(
  p_organization_id uuid,
  p_phone           text default null,
  p_email           text default null,
  p_cpf_hash        text default null,
  p_passport        text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  -- The same functions the generated columns use (public.normalize_phone /
  -- public.normalize_email, 0031_members.sql) — not a hand-copy of their
  -- expressions. Task-3 review, Important 5: a local re-derivation here would be
  -- exactly the "whoever remembers" drift 0031's own comment warns about, with
  -- nothing left to pin the two together once someone edits one side and not
  -- the other.
  v_phone    text := public.normalize_phone(p_phone);
  v_email    text := public.normalize_email(p_email);
  -- cpf_hash and passport have no generated column to delegate to (cpf_hash is
  -- already a fixed-format hex digest; passport has no canonical case). Task-3
  -- review, Important 4: both are normalised into locals and used in BOTH the
  -- guard below and the search, so a blank string ('' — the default a JSON/HTTP
  -- client sends for an empty field) cannot slip past nullif untested the way a
  -- raw p_cpf_hash / p_passport comparison let it before.
  v_cpf_hash text := nullif(lower(trim(coalesce(p_cpf_hash, ''))), '');
  v_passport text := nullif(trim(coalesce(p_passport, '')), '');
  v_id       uuid;
  v_visible  boolean;
begin
  -- The caller must hold members.view somewhere in this Organization. Without this
  -- the function is an Organization-wide existence oracle for anyone with a session.
  if not public.has_org_permission('members.view', p_organization_id) then
    raise log 'find_member_by_identifier denied: actor=% org=%', auth.uid(), p_organization_id;
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  -- Testing the normalised locals, not the raw arguments: an all-blank call
  -- (every field null OR '' OR whitespace) is refused here, before it can reach
  -- the search below and manufacture a false 'none' — see Important 4 above.
  if v_phone is null and v_email is null and v_cpf_hash is null and v_passport is null then
    raise exception 'give at least one identifier to search by' using errcode = '22023';
  end if;

  -- Task-3 review, Important 1: phone, e-mail, CPF and passport each carry their
  -- own per-Organization unique index (0031_members.sql), so nothing stops
  -- Member P holding the phone this call searches for while Member Q holds the
  -- e-mail. An unordered `limit 1` over the four OR'd identifiers would then
  -- hand back whichever row the planner happened to reach first: a wrong answer
  -- when the reachable Member (P) loses the race to the one the caller cannot
  -- see (Q), and a DIFFERENT wrong answer on the next call if the plan changes —
  -- not idempotent, which a registration workflow cannot tolerate.
  --
  -- candidates collects every distinct Member any supplied identifier matches
  -- (ordinarily one row; more than one only in the split-identifier case this
  -- finding describes) together with whether the caller can reach each one. The
  -- outer query then picks deterministically: the reachable Member first, and
  -- among equally-reachable candidates the lowest id — a fixed order every time,
  -- not a repeat of the planner's arbitrary one. This does not change the
  -- three-outcome contract (the owner's ruling: resolving per-identifier so the
  -- caller learns WHICH field collided was deliberately rejected, because it
  -- would ripple into Tasks 6 and 9); it only makes the single id this function
  -- already promised to return the right one, and the same one every time.
  with candidates as (
    select
      m.id,
      -- Reachability is computed by member_reachable, defined above in this same
      -- file (Task 3 review, Important 2 — the platform admin and owner are
      -- admitted outside the per-link has_permission check, so a Member linked
      -- only to an archived or suspended Station is not a dead end to literally
      -- nobody). Task 4 review, Important 5: shared with 0034's write RPCs rather
      -- than a second hand-copy, so the fix above does not have to be re-applied
      -- twice.
      --
      -- Consequence, decided deliberately rather than left implicit: a Member
      -- with zero rows in member_company_links has no link for has_permission to
      -- ever approve, so an ordinary role holder can never reach one — that is a
      -- data-hygiene state (every registration flow, Task 6, creates a link on
      -- write), not a permission state. The owner and platform admin can still
      -- resolve it, because member_reachable's bypass does not require a link to
      -- exist at all; an ordinary delegate cannot, and should not be able to.
      public.member_reachable(m.id, p_organization_id, 'members.view') as reachable
    from public.members m
    where m.organization_id = p_organization_id
      and m.deleted_at is null
      and (
           (v_phone     is not null and m.phone_normalized = v_phone)
        or (v_email     is not null and m.email_normalized = v_email)
        or (v_cpf_hash  is not null and m.cpf_hash = v_cpf_hash)
        or (v_passport  is not null and lower(m.passport) = lower(v_passport))
      )
  )
  select c.id, c.reachable
    into v_id, v_visible
  from candidates c
  order by c.reachable desc, c.id
  limit 1;

  if v_id is null then
    return jsonb_build_object('outcome', 'none');
  end if;

  if v_visible then
    return jsonb_build_object('outcome', 'visible', 'member_id', v_id);
  end if;

  -- Existence, and nothing else. Returning the id here would hand a caller a handle
  -- to a record every policy in this block exists to keep from them.
  return jsonb_build_object('outcome', 'elsewhere');
end;
$$;

revoke execute on function public.find_member_by_identifier(uuid, text, text, text, text) from public;
grant execute on function public.find_member_by_identifier(uuid, text, text, text, text) to authenticated;
