-- Block 5b. The conversation needs three things the schema does not have: a
-- per-promotion freshness rule, a per-field record of when a listener's data
-- was last confirmed, and somewhere to put a refusal that is not a bad entry.

-- D1. Null means no freshness requirement and a filled field is never asked
-- again; 0 means every requested field is asked every time. It pairs with
-- requested_fields, which says WHICH fields -- this says how old they may be.
alter table public.promotions
  add column data_validity_months integer
    check (data_validity_months is null or data_validity_months >= 0);

comment on column public.promotions.data_validity_months is
  'How old a value on the listener''s record may be and still be accepted for this promotion, in months. Null = no requirement. 0 = ask every time. Pairs with requested_fields: that column says which fields, this one says how stale they may be.';

-- D2. PER FIELD, not per record, and the reason is the listener who uses the
-- system most: one timestamp on members would be refreshed by every
-- conversation, so somebody entering weekly through promotions that ask only
-- for city would never be asked for their address again at any age. The
-- feature would switch itself off for the heaviest participant.
--
-- `field` is the SAME enum the promotion marks, so the two sides cannot name
-- different things.
create table public.member_field_confirmations (
  member_id       uuid not null,
  organization_id uuid not null references public.organizations (id),
  field           public.promotion_requested_field not null,
  confirmed_at    timestamptz not null default now(),

  primary key (member_id, field),

  constraint member_field_confirmations_member_org_fk
    foreign key (member_id, organization_id)
    references public.members (id, organization_id)
);

create index member_field_confirmations_member
  on public.member_field_confirmations (member_id);

alter table public.member_field_confirmations enable row level security;

-- Unlike webhook_events, this is not a system-only table: the operator's
-- screens will show when a field was last confirmed. The policy mirrors
-- members_select_reachable (0035) so a row is visible exactly when its listener
-- is.
create policy member_field_confirmations_select_reachable
  on public.member_field_confirmations for select to authenticated
  using (public.member_reachable(member_id, organization_id, 'members.view'));

revoke all on public.member_field_confirmations from anon, authenticated;
revoke truncate on public.member_field_confirmations from service_role;
grant select on public.member_field_confirmations to authenticated;
grant select, insert, update on public.member_field_confirmations to service_role;

-- ---------------------------------------------------------------------------
-- The eight-way mapping from a promotion_requested_field value to the column
-- on members it names. Lives in EXACTLY this one function -- every other place
-- that needs it (the backfill just below, Task 2's whatsapp_conversation_steps,
-- and Task 10's write path) calls here, so a ninth requested field is one edit
-- rather than a search. It moved here, ahead of the backfill, rather than
-- staying beside its other caller in 0066: the backfill below is the SECOND
-- place this mapping would otherwise have been hand-written, and a function
-- that exists to be the one place has to be defined before its first caller.
--
-- Returns null for a blank string, not just for a null column: `nullif(btrim(...), '')`
-- so a field holding '' or '   ' counts as empty, the same way apply_member_creation
-- (0061) treats a blank string as "not supplied" on the write side. birth_date is
-- cast to text because the column it names is a date and every other branch of
-- this CASE returns text; the cast happens before btrim so a literal date value
-- (never blank) simply passes through.
--
-- PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from inside
-- a SECURITY DEFINER body -- the shape apply_participation (0054) established.
-- ---------------------------------------------------------------------------
create or replace function public.member_field_value(
  p_member_id uuid,
  p_field     public.promotion_requested_field
)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select nullif(btrim(coalesce(
    case p_field
      when 'full_name'        then m.full_name
      when 'address'          then m.address_line
      when 'city'              then m.city
      when 'neighbourhood'    then m.neighbourhood
      when 'age'                then m.birth_date::text
      when 'cpf'               then m.cpf_hash
      when 'passport'          then m.passport
      when 'discovery_source' then m.discovery_source
    end,
    '')), '')
  from public.members m
  where m.id = p_member_id;
$$;

revoke execute on function public.member_field_value(uuid, public.promotion_requested_field) from public;

comment on function public.member_field_value(uuid, public.promotion_requested_field) is
  'The eight-way mapping from a promotion_requested_field value to the members column it names -- full_name, address_line, city, neighbourhood, birth_date::text, cpf_hash, passport, discovery_source. Lives in EXACTLY this one function; every other place that needs the mapping (the backfill just below, whatsapp_conversation_steps in 0066, and Task 10''s write path) calls here rather than repeating the CASE, so a ninth requested field is one edit rather than a search. Returns null for a blank or whitespace-only string as well as for a null column, so an empty field always counts as empty. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from inside a SECURITY DEFINER body.';

-- D3. Data an operator typed counts as confirmed when it was typed. The
-- backfill uses created_at and NOT updated_at: a 2024 record whose phone was
-- corrected yesterday would otherwise report a fresh address, and created_at
-- never claims a field is newer than can be proved.
--
-- Kept as a callable function rather than a bare migration statement for one
-- reason: this project ships no seed.sql, so at the moment this migration
-- applies -- in CI and in every local db:reset -- public.members is empty and
-- the statement below inserts nothing. A bare INSERT here would be provably
-- unwitnessable by any test: 08_conversation.test.sql runs after every
-- migration has already applied, so it can only ever observe the empty result,
-- and pasting a copy of this SQL into the test file would test that copy, not
-- this one -- it would go on passing even if THIS statement were edited to
-- read updated_at. Defining it once and having both the migration and the
-- test call the same function closes that gap: there is exactly one copy of
-- the logic, and 08_conversation.test.sql calls it a second time, against
-- fixtures of its own, to prove which column it reads.
--
-- The field-by-field mapping is member_field_value's, called once per
-- (member, requested field) pair rather than hand-written a second time here
-- as a VALUES list -- that VALUES list is exactly what a ninth field would
-- have needed a second edit to. enum_range gives every field the enum has,
-- independent of any promotion's requested_fields, because the backfill's job
-- is dating every field a member already holds, not just the ones somebody
-- happens to have marked on a promotion.
create function public.backfill_member_field_confirmations()
returns void
language sql
as $$
  insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at)
  select m.id, m.organization_id, f.field, m.created_at
  from public.members m
  cross join unnest(enum_range(null::public.promotion_requested_field)) as f(field)
  where m.deleted_at is null
    and public.member_field_value(m.id, f.field) is not null
  on conflict do nothing;
$$;

comment on function public.backfill_member_field_confirmations() is
  'D3''s one-time backfill. Not part of any request path and not meant to be: revoked from public and granted to nobody, callable only by a superuser migration role or by pgTAP (both bypass grants). Re-running it is safe (on conflict do nothing) but pointless outside the migration that calls it once and the test that calls it again to prove created_at is what it reads.';

revoke execute on function public.backfill_member_field_confirmations() from public;

select public.backfill_member_field_confirmations();

-- D4. A refusal is not a bad entry. Block 4c's reasoning holds: a fifth
-- participation_status would let the draw's "VALID only" filter go on looking
-- complete while hiding a different kind of fact.
create table public.promotion_refusals (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null,
  member_id       uuid not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  refused_at      timestamptz not null default now(),
  source          public.participation_source not null,

  constraint promotion_refusals_promotion_fk
    foreign key (promotion_id, company_id)
    references public.promotions (id, company_id),
  constraint promotion_refusals_member_org_fk
    foreign key (member_id, organization_id)
    references public.members (id, organization_id),
  constraint promotion_refusals_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);

create index promotion_refusals_promotion on public.promotion_refusals (promotion_id);

alter table public.promotion_refusals enable row level security;

create policy promotion_refusals_select_reachable
  on public.promotion_refusals for select to authenticated
  using (public.has_permission('promotions.view', company_id));

revoke all on public.promotion_refusals from anon, authenticated;
revoke truncate on public.promotion_refusals from service_role;
grant select on public.promotion_refusals to authenticated;
grant select, insert on public.promotion_refusals to service_role;

-- D5/D6. The default ConversationStore. The Redis driver holds the same shape
-- with a native TTL and nothing to sweep; this one carries expires_at and the
-- worker sweeps it on the tick it already runs.
--
-- Keyed on (integration, phone) and NOT on the listener: the key has to work
-- before anybody has been resolved.
create table public.whatsapp_conversations (
  integration_id uuid not null references public.integrations (id),
  phone          text not null check (length(btrim(phone)) > 0),
  state          jsonb not null,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (integration_id, phone)
);

create index whatsapp_conversations_expiry on public.whatsapp_conversations (expires_at);

alter table public.whatsapp_conversations enable row level security;
-- No policy: a system table, like webhook_events. service_role only.

revoke all on public.whatsapp_conversations from anon, authenticated;
revoke truncate on public.whatsapp_conversations from service_role;
grant select, insert, update, delete on public.whatsapp_conversations to service_role;

comment on table public.whatsapp_conversations is
  'The default ConversationStore (design spec D6). DELETE is granted here and nowhere else in this block, because a finished conversation is removed rather than tombstoned -- there is nothing in it worth keeping once the entry is written, and the row holds a phone number. RLS on with no policy: service_role only.';
