-- supabase/migrations/0032_member_lifecycle_tables.sql

-- Consent, notes and blocks: what happened to a Member after they were registered.
-- The three tables are append-only for the Station's OWN writes — a withdrawn
-- consent is a new row, a correction to a note is a new note, and a lifted block is
-- recorded on the row it lifts rather than as a new row beside it (see member_blocks
-- below, the one deliberate exception to "new row").
--
-- anonymize_member (0034_member_rpcs.sql) is the one path that rewrites an existing
-- row in these three tables rather than appending one, and it only ever removes: for
-- an erased Member it nulls member_consents.origin, member_notes.body and
-- member_blocks.reason AND lift_reason — every free-text column that could
-- re-identify them — while the row, its dates, its type/kind and its author all
-- survive. Owner's ruling (Task 4 review, Ruling B; extended after the fix round to
-- cover lift_reason as well as reason — "unblocked after <name> called and
-- apologised" is exactly the kind of free text about a person the ruling exists to
-- keep out, and the original "three columns" reflected the review's list, not a
-- judgement that a fourth should survive): a note reading "this is the person we
-- erased, phone ..." would otherwise outlive the erasure it describes.
--
-- None of the three carries an updated_at — an append-only write needs no edit
-- timestamp, and the one edit that does happen (anonymize_member's erasure) is dated
-- by members.anonymized_at, not by a per-row timestamp of its own.

-- The three consents decision 2 fixed: the promotion's rules, the use of the
-- Member's image and name, and communication from a sponsor. WhatsApp consent is
-- deliberately absent — decision 3 treats a Member who messages the Station first
-- as having authorised the reply, and that position is evidenced by
-- members.first_contact_at / first_contact_origin, not by a row in this table.
create type public.member_consent_type as enum ('rules', 'image_use', 'sponsor_communication');

-- What a Member agreed to, or withdrew, at a Station. Append-only for the Station's
-- own writes: a withdrawal is a new row with granted = false, never an edit of the
-- row that granted it — "did they consent on the day they entered" must be
-- answerable years later, and a mutable row cannot answer that. The one exception is
-- anonymize_member (0034, Ruling B), which edits an existing consent row to null
-- origin for an erased Member rather than leaving it standing — the property this
-- comment describes holds for every Station-driven write, not for that one.
create table public.member_consents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  member_id       uuid not null,
  company_id      uuid not null,
  consent_type    public.member_consent_type not null,
  granted         boolean not null,
  granted_at      timestamptz not null default now(),
  origin          text,
  -- Promotions do not exist yet — this block predates them. Nullable, with no
  -- foreign key: only the 'rules' consent_type is expected to carry it, recording
  -- which promotion's rules the Member agreed to. Add the foreign key once
  -- public.promotions exists; nothing in this block can validate it before then.
  promotion_id    uuid,
  recorded_by     uuid references auth.users (id),

  constraint member_consents_member_org_fk
    foreign key (member_id, organization_id) references public.members (id, organization_id),
  constraint member_consents_company_org_fk
    foreign key (company_id, organization_id) references public.companies (id, organization_id)
);

comment on table public.member_consents is 'What a Member agreed to, or withdrew, at a Station. Append-only for the Station''s own writes: a withdrawal is a new row, not an edit. anonymize_member (0034) is the one exception — it nulls origin for an erased Member''s consents, keeping the row, its type, its granted flag and its date.';
comment on column public.member_consents.promotion_id is 'No foreign key yet: public.promotions does not exist. Expected to be set only when consent_type = ''rules''.';

create index member_consents_member_idx on public.member_consents (member_id);

-- Free text an operator adds about a Member, scoped to the Station that wrote it —
-- per Station, not per Organization: a note written at one Station is not
-- automatically visible at another (spec §5). Append-only in spirit: a correction is
-- a new note, not an edit of an old one — except anonymize_member (0034), the one
-- path that nulls an existing note's body for an erased Member (Ruling B).
create table public.member_notes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  member_id       uuid not null,
  company_id      uuid not null,
  -- Not null in practice — add_member_note (0034) enforces a non-blank body and no
  -- other write path exists (no INSERT grant to any role). Nullable here, rather
  -- than NOT NULL, only so anonymize_member (0034) can clear it for an erased
  -- Member; the row, its Station, its date and its author survive.
  body            text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),

  constraint member_notes_member_org_fk
    foreign key (member_id, organization_id) references public.members (id, organization_id),
  constraint member_notes_company_org_fk
    foreign key (company_id, organization_id) references public.companies (id, organization_id)
);

comment on table public.member_notes is 'Free text an operator adds about a Member, scoped to the Station that wrote it. Append-only: a correction is a new note — except anonymize_member (0034), which nulls body for an erased Member, keeping the row, its Station, its date and its author.';
comment on column public.member_notes.body is 'Not null in practice (add_member_note, 0034, enforces it); nullable here only so anonymize_member (0034) can clear it for an erased Member.';

create index member_notes_member_idx on public.member_notes (member_id);

-- The two things a block covers, matching the members.block permission label ("Bar a
-- listener from draws, or suspend them"). Archiving and erasing a Member are
-- different mechanisms entirely — members.deleted_at and anonymize_member — not
-- kinds of block.
create type public.member_block_kind as enum ('draw_ban', 'suspension');

-- Who is barred, and until when. Append-only for the Station's own writes, with two
-- exceptions now, not one: lifting a block is recorded on the row it lifts
-- (lifted_at / lifted_by / lift_reason), not as a separate row beside it —
-- is_member_blocked below reads lifted_at directly, so the lift has to land on the
-- block it ends — and anonymize_member (0034, Ruling B) edits an existing block row
-- to null reason and lift_reason for an erased Member.
create table public.member_blocks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  member_id       uuid not null,
  -- Null means the whole Organization: every Station this Member can reach, not one.
  company_id      uuid,
  kind            public.member_block_kind not null,
  -- Not null in practice — block_member (0034) enforces a non-blank reason and no
  -- other write path exists. Nullable here, rather than NOT NULL, only so
  -- anonymize_member (0034) can clear it for an erased Member; the row, its kind,
  -- its dates and its author survive.
  reason          text,
  starts_at       timestamptz not null default now(),
  ends_at         timestamptz,
  created_by      uuid references auth.users (id),
  lifted_at       timestamptz,
  lifted_by       uuid references auth.users (id),
  -- Already nullable (a block that has never been lifted has no lift_reason yet).
  -- lift_member_block (0034) enforces a non-blank value at the moment of lifting;
  -- anonymize_member (0034) is, in addition to that normal empty state, the one
  -- path that clears an EXISTING lift_reason for an erased Member (Ruling B,
  -- extended after the fix round) — free text describing a person is exactly what
  -- the ruling removes, whether it is the block's own reason or its lift's.
  lift_reason     text,

  -- FOREIGN KEY match is MATCH SIMPLE by default: when company_id is null, this half
  -- of the constraint is not checked, which is exactly right for an Organization-wide
  -- block. organization_id is still validated unconditionally — member_org_fk below
  -- covers it, since member_id is never null.
  constraint member_blocks_member_org_fk
    foreign key (member_id, organization_id) references public.members (id, organization_id),
  constraint member_blocks_company_org_fk
    foreign key (company_id, organization_id) references public.companies (id, organization_id)
);

comment on table public.member_blocks is 'Draw bans and suspensions, Organization-wide or per Station. Append-only, except the lift itself (recorded on the row it ends) and anonymize_member (0034), which nulls reason and lift_reason for an erased Member, keeping the row, its kind, its dates and its author.';
comment on column public.member_blocks.company_id is 'Null means the block applies across the whole Organization, not one Station.';
comment on column public.member_blocks.reason is 'Not null in practice (block_member, 0034, enforces it); nullable here only so anonymize_member (0034) can clear it for an erased Member.';
comment on column public.member_blocks.lift_reason is 'Null until the block is lifted (lift_member_block, 0034, then enforces a non-blank value). anonymize_member (0034) also nulls an already-set lift_reason for an erased Member — the same free-text erasure as reason, extended to this column after the Task 4 fix round.';

create index member_blocks_member_idx on public.member_blocks (member_id);

-- A dated suspension ends because the date passed, not because a job ran. The owner
-- fixed this principle in Block 2 for the uncollected prize and it applies unchanged:
-- no cron marks a block expired, so no cron can fail to. Nothing maintains a status
-- column, because a status column nobody maintains lies.
--
-- SECURITY DEFINER with no caller check inside it was a defect, not a design choice
-- (whole-branch review, I1): any authenticated caller holding two UUIDs — any
-- member_id, any company_id, no tenant relationship required between them — could
-- ask "is this person barred" cross-tenant, with nothing gating the answer. The plan
-- dictated this body verbatim, so the version below (before this fix) was a defect in
-- the plan, faithfully implemented, and violated this project's own Global Constraint
-- that every SECURITY DEFINER function re-checks the caller in its own body. Owner's
-- ruling (2026-07-28): close it.
--
-- The guard mirrors member_company_links_select_reachable's own three arms
-- (0035_rls_members.sql:106-112) exactly — is_platform_admin() OR is_owner(...) OR
-- has_permission('members.view', p_company_id) — NOT has_permission alone (whole-
-- branch re-review, Regression 1: an earlier version of this fix used has_permission
-- alone, on the wrong belief that every caller reaching this function already came
-- through that policy's has_permission arm specifically. has_permission is gated by
-- has_company_access (0016_memberships.sql), which requires an ACTIVE Station for
-- EVERY caller, bypasses included — so has_permission alone refused the owner and the
-- platform admin too, for exactly the suspended/archived-Station Members
-- member_company_links_select_reachable's first two arms exist to keep reachable.
-- services/members.ts's listOrganizationMembers/listMemberStations both read
-- member_company_links first — under that three-armed policy, which admits an
-- owner's link at a suspended Station — and then call this function once per link
-- returned; a narrower guard here than the policy that produced those links broke
-- the read for exactly the caller the policy meant to keep it working for. Mirroring
-- all three arms costs no capability against the original cross-tenant-oracle
-- finding: an ordinary caller with none of the three still gets 42501, same as
-- before.
--
-- RAISE LOG then RAISE EXCEPTION on denial, the same shape every other SECURITY
-- DEFINER body in this project uses (0017_role_rpcs.sql).
create or replace function public.is_member_blocked(p_member_id uuid, p_company_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
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

  return exists (
    select 1
    from public.member_blocks b
    where b.member_id = p_member_id
      and (b.company_id is null or b.company_id = p_company_id)
      and b.lifted_at is null
      and b.starts_at <= now()
      and (b.ends_at is null or b.ends_at > now())
  );
end;
$$;

comment on function public.is_member_blocked(uuid, uuid) is
  'Whether an active block bars this Member at p_company_id right now, derived at read time from starts_at/ends_at/lifted_at rather than a maintained status column. Re-checks the caller is the platform admin, the owner of p_company_id''s Organization, or holds members.view at p_company_id (whole-branch review, I1, fixed again at Regression 1 in re-review) — mirroring member_company_links_select_reachable''s own three arms (0035) exactly, not has_permission alone, since has_permission''s has_company_access gate refuses the admin/owner bypass too for a suspended or archived Station. Without any caller check at all, this was a cross-tenant boolean oracle for anyone holding two UUIDs, despite being SECURITY DEFINER.';

revoke execute on function public.is_member_blocked(uuid, uuid) from public;
grant execute on function public.is_member_blocked(uuid, uuid) to authenticated;
