-- supabase/migrations/0110_message_templates.sql

-- The Templates block, Task 2: the approved-template registry.
--
-- Meta accepts a Station-initiated WhatsApp message only as a template it
-- has already approved — this table is the record of those approvals, so
-- later code can send by PURPOSE ('PICKUP_REMINDER') instead of an
-- environment variable holding one hard-coded name and language. Task 3's
-- enqueue_whatsapp_outbound resolves a row here; Task 4 is the first caller,
-- for the pickup reminder Block 6d shipped without.
--
-- Only one purpose exists today. A second purpose is a later block adding a
-- value to this enum, not renaming PICKUP_REMINDER out from under Task 4.
create type public.template_purpose as enum ('PICKUP_REMINDER');

comment on type public.template_purpose is
  'What a registered template is FOR. One value today (PICKUP_REMINDER); a later block adds a second rather than renaming this one, because Task 4 references it by name.';

create table public.message_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  purpose         public.template_purpose not null,
  -- The name and language as REGISTERED WITH META. Together they are what the
  -- Cloud API takes; neither is chosen here, both are transcribed from what
  -- Meta approved (D4).
  name            text not null,
  language        text not null,
  -- The approved text, with its {{1}}...{{n}} placeholders. Portuguese, like
  -- every other string a listener reads.
  body            text not null,
  -- Ordered. What each position MEANS, so the screen can label the fields and
  -- a reader can compare against what was submitted. jsonb array of strings.
  variables       jsonb not null default '[]'::jsonb,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint message_templates_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint message_templates_name_not_blank     check (btrim(name) <> ''),
  constraint message_templates_language_not_blank check (btrim(language) <> ''),
  constraint message_templates_body_not_blank     check (btrim(body) <> ''),
  constraint message_templates_variables_is_array check (jsonb_typeof(variables) = 'array')
);

comment on table public.message_templates is
  'One approved template per (company_id, purpose), REGISTERED after Meta approves it out of band. Deliberately has no status column (spec §3.2): this system records what the operator was told at registration and cannot know whether Meta still approves it, so a status here would look like live truth and would actually be a memory. A revoked approval is discovered by the first rejected send, not by reading a column — do not add one without addressing that.';

-- Partial on deleted_at, same shape as Task 1's station_message_templates and
-- for the same reason: without it, archiving a stale template would leave an
-- operator unable to register its replacement for the same purpose.
create unique index message_templates_purpose_unique
  on public.message_templates (company_id, purpose)
  where deleted_at is null;

alter table public.message_templates enable row level security;
revoke all on public.message_templates from anon, authenticated;
grant select on public.message_templates to authenticated;

create policy message_templates_select_view on public.message_templates
  for select to authenticated
  using (deleted_at is null and public.has_permission('templates.view', company_id));

-- service_role READS, and that is not a convenience: Task 3's
-- enqueue_whatsapp_outbound runs as the table owner (SECURITY DEFINER) and
-- resolves a Station's approved template by (company_id, purpose) on every
-- call. It writes nothing here — a registration screen is a later door, and
-- it too will be SECURITY DEFINER (0099's reasoning, applied to a third
-- module).
grant select on public.message_templates to service_role;
revoke truncate on public.message_templates from service_role;
