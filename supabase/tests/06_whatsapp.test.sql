begin;
select plan(29);

select has_type('public', 'integration_provider', 'the provider enum exists');
select has_table('public', 'integrations', 'integrations exists');
select has_column('public', 'integrations', 'phone_number_id',
                  'integrations carries Meta''s id for the number');

select is(relrowsecurity, true, 'RLS enabled on integrations')
  from pg_class where oid = 'public.integrations'::regclass;

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'integrations'),
  0, 'no policy admits authenticated to integrations');

select ok(not has_table_privilege('authenticated', 'public.integrations', 'SELECT'),
          'authenticated may not read integrations');

-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000005f1', 'Org 5a');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005f1',
   'Station 5a', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000005c2', '00000000-0000-0000-0000-0000000005f1',
   'Station 5a Two', 'America/Sao_Paulo');

insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c1', 'WHATSAPP', '111111111111111', true);

select throws_ok($$
  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id, enabled)
  values
    ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c2',
     'WHATSAPP', '111111111111111', true)
$$, '23505', null, 'one number cannot serve two Stations');

select throws_ok($$
  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id, enabled)
  values
    ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     'WHATSAPP', '222222222222222', true)
$$, '23505', null, 'a Station cannot hold two WhatsApp numbers');

-- The reason the two indexes above are PARTIAL. Without this pair, replacing
-- them with total unique constraints would leave every assertion in this file
-- passing while the comment on them became false.
--
-- integrations_archival_shape demands deleted_by be set together with
-- deleted_at, not left null, so the archiving actor needs a real auth.users
-- row to reference.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000005b1', 'archivist-5a@example.test');

update public.integrations
   set deleted_at = now(), deleted_by = '00000000-0000-0000-0000-0000000005b1'
 where phone_number_id = '111111111111111';

select lives_ok($$
  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id, enabled)
  values
    ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c2',
     'WHATSAPP', '111111111111111', true)
$$, 'a number can be moved to another Station once the old row is archived');

select lives_ok($$
  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id, enabled)
  values
    ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     'WHATSAPP', '222222222222222', true)
$$, 'a Station can take a new number once its old one is archived');

-- webhook_events --------------------------------------------------------------

select has_type('public', 'webhook_event_status', 'the event status enum exists');
select is(relrowsecurity, true, 'RLS enabled on webhook_events')
  from pg_class where oid = 'public.webhook_events'::regclass;
select ok(not has_table_privilege('authenticated', 'public.webhook_events', 'SELECT'),
          'authenticated may not read webhook_events');

insert into public.webhook_events (provider, external_id, payload) values
  ('WHATSAPP', 'wamid.TEST1', '{"hello":"world"}');

select throws_ok($$
  insert into public.webhook_events (provider, external_id, payload)
  values ('WHATSAPP', 'wamid.TEST1', '{"hello":"again"}')
$$, '23505', null, 'the same message id cannot be stored twice');

-- A second event, left at its natural (recent) received_at. Without it, a
-- prune_webhook_payloads that nulled every payload regardless of age would
-- pass the assertion below just as well as a correct one.
insert into public.webhook_events (provider, external_id, payload) values
  ('WHATSAPP', 'wamid.TEST2', '{"still":"here"}');

-- The row survives pruning; only the payload goes. external_id is what
-- idempotency needs and it is not personal data.
update public.webhook_events
   set received_at = now() - interval '40 days'
 where external_id = 'wamid.TEST1';
select public.prune_webhook_payloads('30 days');
select is(
  (select payload from public.webhook_events where external_id = 'wamid.TEST1'),
  null, 'pruning clears the payload');
select is(
  (select count(*)::int from public.webhook_events where external_id = 'wamid.TEST1'),
  1, 'the pruned row is still present');
select is(
  (select payload is not null from public.webhook_events
    where external_id = 'wamid.TEST2'),
  true, 'a recent event keeps its payload after pruning');

-- Tenancy guard: webhook_events_company_org_fk -------------------------------
-- A composite FK defaults to MATCH SIMPLE: it is satisfied whenever any
-- referencing column is null, so (null, null) must keep passing — that is
-- the state a message is in before its number resolves. But once both
-- columns are populated, the pair must be a real Station/Organization
-- combination, the same guard integrations (0057) already has.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000005f2', 'Org 5a Two');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000005c3', '00000000-0000-0000-0000-0000000005f2',
   'Station 5a Three', 'America/Sao_Paulo');

select throws_ok($$
  insert into public.webhook_events (provider, external_id, company_id, organization_id)
  values ('WHATSAPP', 'wamid.TEST-MISMATCH',
          '00000000-0000-0000-0000-0000000005c3',
          '00000000-0000-0000-0000-0000000005f1')
$$, '23503', null, 'a Station cannot be paired with a foreign Organization on webhook_events');

select lives_ok($$
  insert into public.webhook_events (provider, external_id, company_id, organization_id)
  values ('WHATSAPP', 'wamid.TEST-BOTHNULL', null, null)
$$, 'company_id and organization_id may both be null before a number resolves');

-- Shape guard: webhook_events_done_shape ---------------------------------------
-- DONE is a claim about outcome and processed_at: finishing a decision means
-- recording why and when, held structurally rather than trusted. RECEIVED,
-- PROCESSING and FAILED alike have decided nothing yet, so a plain row with
-- neither must stay legal.

select throws_ok($$
  insert into public.webhook_events (provider, external_id, status)
  values ('WHATSAPP', 'wamid.TEST-DONE-BARE', 'DONE')
$$, '23514', null, 'DONE with no outcome and no processed_at is not a legal webhook_events row');

select lives_ok($$
  insert into public.webhook_events (provider, external_id)
  values ('WHATSAPP', 'wamid.TEST-RECEIVED-PLAIN')
$$, 'a plain RECEIVED row with no outcome or processed_at is legal');

-- outbox_messages -------------------------------------------------------------

select has_type('public', 'outbox_status', 'the outbox status enum exists');
select is(relrowsecurity, true, 'RLS enabled on outbox_messages')
  from pg_class where oid = 'public.outbox_messages'::regclass;
select ok(not has_table_privilege('authenticated', 'public.outbox_messages', 'SELECT'),
          'authenticated may not read outbox_messages');

insert into public.outbox_messages
  (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key)
values
  ('WHATSAPP', '00000000-0000-0000-0000-0000000005a1',
   '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
   '11999998888', 'ok', 'p1:confirmation');

select throws_ok($$
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key)
  values
    ('WHATSAPP', '00000000-0000-0000-0000-0000000005a1',
     '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     '11999998888', 'ok again', 'p1:confirmation')
$$, '23505', null, 'reprocessing cannot send the same confirmation twice');

-- Tenancy guard: outbox_messages_company_org_fk -------------------------------
-- Unlike webhook_events, company_id and organization_id here are NOT NULL, so
-- there is no null-passes-untouched case to preserve — only the mismatch to
-- refuse, the same guard integrations (0057) and webhook_events (0058) use.

select throws_ok($$
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key)
  values
    ('WHATSAPP', '00000000-0000-0000-0000-0000000005a1',
     '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c3',
     '11999998888', 'ok', 'p1:mismatch')
$$, '23503', null, 'a Station cannot be paired with a foreign Organization on outbox_messages');

-- Shape guard: outbox_messages_sent_shape --------------------------------------
-- SENT is a claim about sent_at and external_id: the transport never reports
-- a send as accepted without a wamid, so a plain row with neither must stay
-- legal on every status but SENT.

select throws_ok($$
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key, status)
  values
    ('WHATSAPP', '00000000-0000-0000-0000-0000000005a1',
     '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     '11999998888', 'ok', 'p1:sent-bare', 'SENT')
$$, '23514', null, 'SENT with no sent_at and no external_id is not a legal outbox_messages row');

select lives_ok($$
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key)
  values
    ('WHATSAPP', '00000000-0000-0000-0000-0000000005a1',
     '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     '11999998888', 'ok', 'p1:pending-plain')
$$, 'a plain PENDING row with no sent_at or external_id is legal');

select ok(
  'WHATSAPP' = any(enum_range(null::public.participation_source)::text[]),
  'a participation can have arrived by WhatsApp');

select * from finish();
rollback;
