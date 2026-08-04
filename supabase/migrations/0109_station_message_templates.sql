-- supabase/migrations/0109_station_message_templates.sql

-- The Templates block, Task 1: a Station's own words.
--
-- Every sentence the bot speaks is a constant in
-- src/lib/conversation/engine.ts today — the same Portuguese for every Station
-- of every Organization. A group with five radios has five voices and one
-- script. This is the table that ends that.

-- The ten texts, and only the ten that exist. The legacy screen the owner
-- showed also had "Inatividade", "Aguarde", "Rejeita Áudio" and "Rejeita
-- Ligação"; none of those BEHAVIOURS exists in this system, and a key here
-- for a message nothing sends would be a field that configures nothing (D3).
-- They are named in the block's report with their cost instead.
--
-- Eight of these mirror RequestedField, whose FIELD_PROMPTS record is TOTAL —
-- so a ninth requested field fails to compile there AND has no key here.
-- Both, deliberately: the failure mode a lookup table would produce is a
-- listener receiving an empty message.
create type public.system_message_key as enum (
  'REFUSAL', 'ABANDON',
  'FULL_NAME', 'ADDRESS', 'CITY', 'NEIGHBOURHOOD',
  'AGE', 'CPF', 'PASSPORT', 'DISCOVERY_SOURCE'
);

comment on type public.system_message_key is
  'The ten messages engine.ts hard-codes: the refusal, the abandon, and the eight field prompts. Not a catalogue of everything a bot could say — only what this system already says.';

create table public.station_message_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  key             public.system_message_key not null,
  -- PORTUGUESE, and the one place in this codebase where that is correct:
  -- this is what a LISTENER reads. Every operator-facing string in the block
  -- is English, as everywhere else.
  body            text not null,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint station_message_templates_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  -- Blank is not an override. '   ' satisfies NOT NULL and reaches a listener
  -- as an empty message — strictly worse than the default it replaced.
  constraint station_message_templates_body_not_blank check (btrim(body) <> '')
);

comment on table public.station_message_templates is
  'One row per OVERRIDDEN text, never one row per Station (D2). Three consequences, each of them the reason: overriding one field prompt does not freeze the other seven at whatever the code said that day; a new Station speaks before anybody configures it, with no backfill migration and no seed step; and the bot can never go mute, because an absent row is a valid state that resolves to the constant in engine.ts. Required rows would make a missing one a silence a listener experiences and nobody sees.';

-- Partial on deleted_at, so clearing an override frees the key. A total
-- unique index would let an operator clear a text and never set another.
create unique index station_message_templates_key_unique
  on public.station_message_templates (company_id, key)
  where deleted_at is null;

alter table public.station_message_templates enable row level security;
revoke all on public.station_message_templates from anon, authenticated;
grant select on public.station_message_templates to authenticated;

create policy station_message_templates_select_view on public.station_message_templates
  for select to authenticated
  using (deleted_at is null and public.has_permission('templates.view', company_id));

-- service_role READS, and that is not a convenience: the conversation engine
-- runs in the worker under service_role and resolves a Station's wording on
-- every turn. It writes nothing — the operator doors are SECURITY DEFINER and
-- run as the table owner (0099's reasoning, applied to a second module).
grant select on public.station_message_templates to service_role;
revoke truncate on public.station_message_templates from service_role;

-- The two codes. NOT the three-way split Block 7 needed: nothing here
-- destroys the way a merge does. Removing an override falls back to a default
-- the code still holds, and there is no history to lose. Recorded as a
-- decision rather than an omission (spec §5).
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('templates.view',   'Read the Station''s message templates',        'Templates', 'templates', 'See the message templates',    'company', 10),
  ('templates.manage', 'Edit the Station''s message templates',        'Templates', 'templates', 'Edit the message templates',   'company', 20);
