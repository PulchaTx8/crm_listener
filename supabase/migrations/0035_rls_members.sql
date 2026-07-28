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
-- Reachability: one rule, five uses — mirrored from member_reachable (0033),
-- not called through it. Decided deliberately; see the Task 5 report for the
-- write-up.
-- ---------------------------------------------------------------------------
-- member_reachable(member_id, organization_id, permission) is this block's own name
-- for "is_platform_admin() OR is_owner(organization_id) OR a link at which
-- has_permission holds" — the fix Task 3's review made so the platform admin and the
-- Organization owner are never dead-ended by a Member whose only Station happens to be
-- archived or suspended (has_permission is gated by has_company_access, 0016/0024,
-- which requires an ACTIVE Station for every caller, bypasses included). That same fix
-- is what these five policies need: an owner who can still call archive_member or
-- anonymize_member on such a Member (both go through member_reachable, 0034) must not
-- be unable to SELECT the very row they are permitted to write.
--
-- member_reachable itself is not called here. Its signature answers "is ANY Station
-- this Member is linked to reachable" — the right shape for the members table below,
-- where a Member is Organization-scoped identity, visible if reachable via any link.
-- It is the WRONG shape for the other four tables: member_company_links,
-- member_consents, member_notes and member_blocks each carry their OWN company_id —
-- the Station the row belongs to or was recorded at — and member_notes' own table
-- comment (0032) is explicit that a note "is not automatically visible at another
-- [Station]" even when the Member is linked to several. Calling member_reachable for
-- those four would silently widen visibility to every Station the Member is linked to,
-- the opposite of what "scoped to the Station that wrote it" requires. The four
-- policies below therefore test the ROW's own company_id, a genuinely different
-- predicate member_reachable cannot express regardless of how it is called.
--
-- For the one table member_reachable's shape does fit (members), calling it directly
-- was still rejected. member_reachable is SECURITY INVOKER with EXECUTE granted to
-- nobody (0033's own comment: "reachable only from inside a SECURITY DEFINER body"),
-- the same convention apply_inventory_movement (0027) uses, by deliberate design.
-- Granting it to `authenticated` so a policy could call it would be the first time
-- this project widens that invariant, and — because member_reachable would then run AS
-- the invoking role against member_company_links, itself RLS-protected by the policy
-- below — every read would re-enter RLS a second time through a path nothing in this
-- project has exercised before. (Traced through: harmless here, since the exists()
-- clause's own has_permission('members.view', ...) term and member_company_links'
-- policy below would be checking the same permission code, and the is_platform_admin/
-- is_owner disjuncts sit ahead of it either way — but "harmless once traced through"
-- is a weaker property than "the grant boundary was never touched", and the second
-- was available at no cost.) is_platform_admin(), is_owner() and has_permission() are
-- already granted to `authenticated` and already called directly from policy USING
-- clauses elsewhere in this project (0006, 0019, 0024, 0029), so the members policy
-- below reproduces member_reachable's exact three-term rule from those same granted
-- primitives instead of calling the function that assembles them. The trade-off, made
-- deliberately: if member_reachable's own shape ever changes, this policy needs the
-- identical change made by hand — accepted in exchange for not touching an existing,
-- documented "internal-helper-only" grant boundary just to secure one read policy.
-- ---------------------------------------------------------------------------

grant select on public.members              to authenticated;
grant select on public.member_company_links to authenticated;
grant select on public.member_consents      to authenticated;
grant select on public.member_notes         to authenticated;
grant select on public.member_blocks        to authenticated;

-- The audience, Organization-scoped (0031): visible if reachable via ANY Station the
-- Member is linked to. members.view is checked per link, with the platform admin and
-- Organization owner admitted outside that check (see above) so a Member whose only
-- Station is archived or suspended is not invisible to the one person the RPCs already
-- let edit it.
create policy members_select_reachable on public.members
  for select to authenticated
  using (
    deleted_at is null
    and (
      public.is_platform_admin()
      or public.is_owner(organization_id)
      or exists (
        select 1 from public.member_company_links l
        where l.member_id = members.id
          and public.has_permission('members.view', l.company_id)
      )
    )
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
-- notes above; Organization-wide (company_id null, "every Station this Member can
-- reach, not one") is checked with has_org_permission instead of a single company_id —
-- the same asymmetry block_member (0034) already gates writes with.
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
