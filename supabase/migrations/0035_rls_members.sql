-- supabase/migrations/0035_rls_members.sql

-- Five tables, built in Task 1 (members, member_company_links, 0031) and Task 2
-- (member_consents, member_notes, member_blocks, 0032), secured only now — the same
-- create-here/secure-there split every block in this project has used, closed safe by
-- Block 1c's final review: a freshly created table under `public` grants the Supabase
-- roles no DML by default, so there was never a readable window between those
-- migrations and this one. A table this migration misses looks exactly like one that
-- never needed securing (this project has shipped that mistake once already —
-- rate_limit_counters, Block 0) — so the state is asserted in 02_permissions.test.sql
-- rather than left to whoever reads the migration list.

alter table public.members              enable row level security;
alter table public.member_company_links enable row level security;
alter table public.member_consents      enable row level security;
alter table public.member_notes         enable row level security;
alter table public.member_blocks        enable row level security;

revoke all on public.members              from anon, authenticated;
revoke all on public.member_company_links from anon, authenticated;
revoke all on public.member_consents      from anon, authenticated;
revoke all on public.member_notes         from anon, authenticated;
revoke all on public.member_blocks        from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reachability: member_reachable (0033) for members; a narrower, per-row test for
-- the other four. Two different rules, not one hand-copied four more times.
-- ---------------------------------------------------------------------------
-- members is Organization-scoped identity (0031), visible if reachable via ANY
-- Station the Member is linked to — exactly what member_reachable(member_id,
-- organization_id, permission) computes: is_platform_admin() OR is_owner(...) OR a
-- link at which has_permission holds, with the platform admin and Organization
-- owner admitted OUTSIDE the per-link has_permission check (Task 3's review, 0033)
-- so a Member whose only Station is archived or suspended is not a permanent dead
-- end (has_permission is gated by has_company_access, 0016/0024, which requires an
-- ACTIVE Station for every caller, bypasses included). This is also why an owner
-- who can still call update_member or anonymize_member on such a Member (both go
-- through member_reachable, 0034) must not be unable to SELECT the very row they
-- are permitted to write. archive_member is NOT part of that reasoning: it sets
-- deleted_at, which the policy below tests OUTSIDE the bypass — the moment an
-- owner archives a Member, the row becomes unselectable to everyone, owner
-- included, the same as every other soft-deleted row in this project. That is by
-- design, not a gap this migration leaves open.
--
-- The members policy below calls member_reachable directly rather than
-- hand-copying its rule a fifth time — 0031's own comment on
-- normalize_phone/normalize_email is a standing warning about exactly that kind of
-- drift, and Task 4's review found the fourth copy of this specific rule before
-- 0033 was created to stop it. Doing so needed member_reachable's EXECUTE widened
-- to authenticated (0033, amended by this task's fix round) — that widens no real
-- capability, since is_platform_admin(), is_owner() and has_permission() were
-- already granted to authenticated, and member_company_links, the one table
-- member_reachable reads, is itself RLS-protected below. Called this way rather
-- than from inside a SECURITY DEFINER body (member_reachable's original use in
-- 0034), the function's internal exists() runs under member_company_links' own
-- SELECT policy instead of bypassing it — see 0033's comment on the function for
-- that coupling, which the members policy below now depends on: tighten
-- member_company_links' policy and members visibility changes with it.
--
-- member_reachable's signature takes no company_id, so it cannot express "just
-- this row's own Station" — the WRONG question for the other four tables.
-- member_company_links, member_consents, member_notes and member_blocks each
-- carry their OWN company_id — the Station the row belongs to or was recorded at
-- — and member_notes' own table comment (0032) is explicit that a note "is not
-- automatically visible at another [Station]" even when the Member is linked to
-- several. Calling member_reachable for those four would silently widen
-- visibility to every Station the Member is linked to, the opposite of what
-- "scoped to the Station that wrote it" requires. The four policies below
-- therefore reproduce member_reachable's is_platform_admin()/is_owner() bypass by
-- hand, conjoined with has_permission (or, for member_blocks' Organization-wide
-- branch, has_org_permission plus an explicit reachability check — see that
-- policy's own comment) tested against the ROW's own company_id — a genuinely
-- different, narrower rule member_reachable cannot express regardless of how it
-- is called, not a hand-copy of the same one.
--
-- None of the four child tables filters on the parent Member's own deleted_at: an
-- archived Member's links, consents, notes and blocks all remain readable through
-- these same policies. This matches 0029's own precedent (inventory_movements and
-- inventory_balances carry no deleted_at filter at all) rather than a fresh
-- decision here — but unlike a stock movement, the rows this leaves reachable
-- carry free text about a person, so it is named rather than left implicit.
-- ---------------------------------------------------------------------------

grant select on public.members              to authenticated;
grant select on public.member_company_links to authenticated;
grant select on public.member_consents      to authenticated;
grant select on public.member_notes         to authenticated;
grant select on public.member_blocks        to authenticated;

-- The audience, Organization-scoped (0031). deleted_at is null stays OUTSIDE
-- member_reachable's own bypass — an archived Member (archive_member, 0034) is
-- unselectable to everyone, owner included, the same as every other soft-deleted
-- row in this project. See the block comment above for why this calls
-- member_reachable (0033) directly rather than hand-copying its rule.
create policy members_select_reachable on public.members
  for select to authenticated
  using (
    deleted_at is null
    and public.member_reachable(members.id, members.organization_id, 'members.view')
  );

-- What RLS reads to answer the question above (member_company_links.company_id — "for
-- links, the row's own Station"), so the link table's own visibility cannot be looser
-- than what it is used to prove: a link is visible only at the Station it names, not
-- at every other Station the same Member happens to be linked to as well.
create policy member_company_links_select_reachable on public.member_company_links
  for select to authenticated
  using (
    public.is_platform_admin()
    or public.is_owner(organization_id)
    or public.has_permission('members.view', company_id)
  );

-- Recorded at one Station (0032); visible only there, same per-row reasoning as
-- member_company_links above — a Member linked to Stations A and B does not make a
-- consent recorded at A visible at B.
create policy member_consents_select_reachable on public.member_consents
  for select to authenticated
  using (
    public.is_platform_admin()
    or public.is_owner(organization_id)
    or public.has_permission('members.view', company_id)
  );

-- "Scoped to the Station that wrote it" is exactly the row's own company_id — the same
-- per-row test as member_consents above, not the members table's any-link test.
-- Matches 0032's own table comment on member_notes: a note "is not automatically
-- visible at another [Station]".
create policy member_notes_select_reachable on public.member_notes
  for select to authenticated
  using (
    public.is_platform_admin()
    or public.is_owner(organization_id)
    or public.has_permission('members.view', company_id)
  );

-- Two shapes (0032): Station-scoped (company_id set) reads exactly like consents and
-- notes above. Organization-wide (company_id null, "every Station this Member can
-- reach, not one") is checked with has_org_permission — but has_org_permission alone
-- is satisfied by holding members.view at ANY active Station in the Organization, and
-- says nothing about member_id. Without a further check, a delegate at Station A only
-- could read every Organization-wide block in the whole Organization — member_id,
-- kind, dates, created_by and reason (mandatory free text about a person, 0032) —
-- including for Members members_select_reachable itself hides from them entirely.
-- block_member (0034) gates the WRITE side on has_org_permission alone, because
-- writing an Organization-wide block discloses nobody's data; reading one does, so
-- mirroring that write asymmetry onto this policy would have been a different,
-- wrong decision (owner's ruling, Task 5 review). Fixed by conjoining
-- has_org_permission with the same per-link reachability member_reachable (0033)
-- would compute for this Member — narrowing costs no operational capability, because
-- is_member_blocked (0032) already answers "is this person barred" as a SECURITY
-- DEFINER function regardless of what this policy allows.
create policy member_blocks_select_reachable on public.member_blocks
  for select to authenticated
  using (
    public.is_platform_admin()
    or public.is_owner(organization_id)
    or (
      company_id is not null
      and public.has_permission('members.view', company_id)
    )
    or (
      company_id is null
      and public.has_org_permission('members.view', organization_id)
      and exists (
        select 1 from public.member_company_links l
        where l.member_id = member_blocks.member_id
          and public.has_permission('members.view', l.company_id)
      )
    )
  );

-- service_role needs explicit grants: the default ACL gives it no DML at all, and
-- BYPASSRLS does not substitute for a GRANT (Block 1a §3.9; 0029's own comment).
-- Read-only, same as every table in this block: every write goes through one of the
-- nine SECURITY DEFINER RPCs in 0034, which run as the table owner and so need no
-- grant of their own. No role — not even service_role — ever holds INSERT, UPDATE or
-- DELETE on any of the five tables; the default ACL a fresh `public` table grants
-- (0029's own finding) contains none of the three to begin with, so nothing above had
-- to revoke them explicitly.
grant select on public.members              to service_role;
grant select on public.member_company_links to service_role;
grant select on public.member_consents      to service_role;
grant select on public.member_notes         to service_role;
grant select on public.member_blocks        to service_role;

-- `revoke all` above only ever ran against anon/authenticated, so service_role kept
-- the default ACL's TRUNCATE grant on all five tables — the same gap 0029's final
-- review found and closed for the four inventory tables, with more force here: these
-- five hold personal data (names, phone numbers, e-mail addresses, CPF hashes,
-- addresses, consent and block history), not stock counts. TRUNCATE is neither
-- INSERT, UPDATE nor DELETE, so nothing above closes it on its own.
revoke truncate on public.members              from service_role;
revoke truncate on public.member_company_links from service_role;
revoke truncate on public.member_consents      from service_role;
revoke truncate on public.member_notes         from service_role;
revoke truncate on public.member_blocks        from service_role;
