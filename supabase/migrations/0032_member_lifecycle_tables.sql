-- supabase/migrations/0032_member_lifecycle_tables.sql

-- Consent, notes and blocks: what happened to a Member after they were registered.
-- The three tables are append-only in spirit — a withdrawn consent is a new row, a
-- correction to a note is a new note, and a lifted block is recorded on the row it
-- lifts rather than as a new row beside it (see member_blocks below, the one
-- deliberate exception). None of the three carries an updated_at: a table nobody
-- edits does not need a column that says when it was edited.

-- The three consents decision 2 fixed: the promotion's rules, the use of the
-- Member's image and name, and communication from a sponsor. WhatsApp consent is
-- deliberately absent — decision 3 treats a Member who messages the Station first
-- as having authorised the reply, and that position is evidenced by
-- members.first_contact_at / first_contact_origin, not by a row in this table.
create type public.member_consent_type as enum ('rules', 'image_use', 'sponsor_communication');

-- What a Member agreed to, or withdrew, at a Station. Append-only: a withdrawal is a
-- new row with granted = false, never an edit of the row that granted it — "did they
-- consent on the day they entered" must be answerable years later, and a mutable row
-- cannot answer that.
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

comment on table public.member_consents is 'What a Member agreed to, or withdrew, at a Station. Append-only: a withdrawal is a new row, not an edit.';
comment on column public.member_consents.promotion_id is 'No foreign key yet: public.promotions does not exist. Expected to be set only when consent_type = ''rules''.';

create index member_consents_member_idx on public.member_consents (member_id);

-- Free text an operator adds about a Member, scoped to the Station that wrote it —
-- per Station, not per Organization: a note written at one Station is not
-- automatically visible at another (spec §5). Append-only in spirit: a correction is
-- a new note, not an edit of an old one.
create table public.member_notes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  member_id       uuid not null,
  company_id      uuid not null,
  body            text not null,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),

  constraint member_notes_member_org_fk
    foreign key (member_id, organization_id) references public.members (id, organization_id),
  constraint member_notes_company_org_fk
    foreign key (company_id, organization_id) references public.companies (id, organization_id)
);

comment on table public.member_notes is 'Free text an operator adds about a Member, scoped to the Station that wrote it. Append-only: a correction is a new note.';

create index member_notes_member_idx on public.member_notes (member_id);

-- The two things a block covers, matching the members.block permission label ("Bar a
-- listener from draws, or suspend them"). Archiving and erasing a Member are
-- different mechanisms entirely — members.deleted_at and anonymize_member — not
-- kinds of block.
create type public.member_block_kind as enum ('draw_ban', 'suspension');

-- Who is barred, and until when. Append-only, with one deliberate exception: lifting
-- a block is recorded on the row it lifts (lifted_at / lifted_by / lift_reason), not
-- as a separate row beside it — is_member_blocked below reads lifted_at directly, so
-- the lift has to land on the block it ends.
create table public.member_blocks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  member_id       uuid not null,
  -- Null means the whole Organization: every Station this Member can reach, not one.
  company_id      uuid,
  kind            public.member_block_kind not null,
  reason          text not null,
  starts_at       timestamptz not null default now(),
  ends_at         timestamptz,
  created_by      uuid references auth.users (id),
  lifted_at       timestamptz,
  lifted_by       uuid references auth.users (id),
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

comment on table public.member_blocks is 'Draw bans and suspensions, Organization-wide or per Station. Append-only, except the lift itself, which is recorded on the row it ends.';
comment on column public.member_blocks.company_id is 'Null means the block applies across the whole Organization, not one Station.';

create index member_blocks_member_idx on public.member_blocks (member_id);

-- A dated suspension ends because the date passed, not because a job ran. The owner
-- fixed this principle in Block 2 for the uncollected prize and it applies unchanged:
-- no cron marks a block expired, so no cron can fail to. Nothing maintains a status
-- column, because a status column nobody maintains lies.
create or replace function public.is_member_blocked(p_member_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.member_blocks b
    where b.member_id = p_member_id
      and (b.company_id is null or b.company_id = p_company_id)
      and b.lifted_at is null
      and b.starts_at <= now()
      and (b.ends_at is null or b.ends_at > now())
  );
$$;

revoke execute on function public.is_member_blocked(uuid, uuid) from public;
grant execute on function public.is_member_blocked(uuid, uuid) to authenticated;
