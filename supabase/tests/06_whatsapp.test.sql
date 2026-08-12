begin;
select plan(147);

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

-- external_id holds the SHA-256 of the provider's message id, never the id
-- itself (0058): a wamid decodes to bytes containing the counterparty's phone,
-- and this column deliberately outlives the payload. THE ROUTE HASHES IN NODE
-- (0058, and 0031's reasoning for cpf_hash). This helper hashes in SQL because
-- there is no Node in a pgTAP file -- a convenience of the harness, and not a
-- sanction to hash in SQL on any write path.
create or replace function pg_temp.wamid_hash(p_wamid text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(p_wamid, 'UTF8')), 'hex');
$$;

insert into public.webhook_events (provider, external_id, payload) values
  ('WHATSAPP', pg_temp.wamid_hash('wamid.TEST1'), '{"hello":"world"}');

select throws_ok($$
  insert into public.webhook_events (provider, external_id, payload)
  values ('WHATSAPP', pg_temp.wamid_hash('wamid.TEST1'), '{"hello":"again"}')
$$, '23505', null, 'the same message id cannot be stored twice');

-- The contract Task 11 has to keep, held structurally rather than by comment.
-- A raw wamid in external_id would be a recoverable phone number in a column
-- that deliberately survives prune_webhook_payloads -- so the guarantee does
-- not rest on the route remembering to hash, exactly as members.cpf_hash (0031)
-- refuses a raw CPF rather than trusting the Node that should have hashed it.
select throws_ok($$
  insert into public.webhook_events (provider, external_id, payload)
  values ('WHATSAPP', 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNBMEQ3', '{}')
$$, '23514', null, 'a raw provider message id cannot be stored as external_id');

-- WHAT prune_webhook_payloads MAY AND MAY NOT TOUCH (design spec D9) ----------
--
-- The row survives pruning; only the payload goes. external_id is what
-- idempotency needs, and it survives BECAUSE it is a hash: the raw provider id
-- is personal data, so it lives in the payload and expires with it. That
-- asymmetry is the whole reason 0058 hashes rather than stores.
--
-- WHICH rows is the other half, and it is not answered by age. Two properties
-- have to hold together, and each fixture below breaks a different plausible
-- predicate:
--
--   * AGE ALONE -- the shipped version -- empties rows this system still means
--     to act on. ingest_whatsapp_event reads five paths out of the payload, so
--     an emptied one finds no phone_number_id, misses the integration lookup
--     and finishes DONE/no_integration: a routing verdict invented for a
--     message whose content was destroyed. That is what the missing-timestamp
--     RAISE (0062) exists to stop happening for the other malformed case.
--   * `status = 'DONE'` ALONE keeps a PARKED row's phone number and profile
--     name for ever. A parked row is one nothing will look at again
--     automatically, and retention is not conditional on the outcome having
--     been a happy one.
--
-- So: DONE, or FAILED with next_attempt_at = infinity, past the cut. Six rows,
-- one per state, all with a payload and all but one older than the cut.
insert into public.webhook_events
  (provider, external_id, payload, status, received_at, outcome, processed_at)
values
  ('WHATSAPP', pg_temp.wamid_hash('wamid.PR-DONE-OLD'), '{"gone":"soon"}',
   'DONE', now() - interval '40 days', 'recorded', now() - interval '40 days'),
  -- Recent and DONE, so ONLY its age keeps it: a prune that dropped the age
  -- predicate would take this one and no other assertion here would notice.
  ('WHATSAPP', pg_temp.wamid_hash('wamid.PR-DONE-NEW'), '{"still":"here"}',
   'DONE', now(), 'recorded', now());

insert into public.webhook_events
  (provider, external_id, payload, status, received_at, next_attempt_at, claimed_at)
values
  -- Parked: the ladder is spent and the worker wrote infinity, which is beyond
  -- due_whatsapp_events' index condition for ever. Nothing will look at it
  -- again on its own, so its payload must go.
  ('WHATSAPP', pg_temp.wamid_hash('wamid.PR-PARKED'), '{"gone":"soon"}',
   'FAILED', now() - interval '40 days', 'infinity', null),
  -- FAILED but still on the ladder: due again in a minute. Old, and NOT
  -- finished.
  ('WHATSAPP', pg_temp.wamid_hash('wamid.PR-RETRY'), '{"still":"here"}',
   'FAILED', now() - interval '40 days', now() + interval '1 minute', null),
  -- Never processed at all -- the tick was down for a month. Still the work
  -- this system intends to do.
  ('WHATSAPP', pg_temp.wamid_hash('wamid.PR-RECEIVED'), '{"still":"here"}',
   'RECEIVED', now() - interval '40 days', null, null),
  -- Claimed and abandoned. reclaim_stale_whatsapp_claims (0063) returns it to
  -- RECEIVED, so it too is still awaiting processing.
  ('WHATSAPP', pg_temp.wamid_hash('wamid.PR-PROCESSING'), '{"still":"here"}',
   'PROCESSING', now() - interval '40 days', null, now() - interval '40 days');

select public.prune_webhook_payloads('30 days');

select is(
  (select payload from public.webhook_events
    where external_id = pg_temp.wamid_hash('wamid.PR-DONE-OLD')),
  null, 'pruning clears the payload of a decided event past the cut');
select is(
  (select payload from public.webhook_events
    where external_id = pg_temp.wamid_hash('wamid.PR-PARKED')),
  null, 'and of a parked one, which holds a phone number exactly as a decided one does');
select is(
  (select count(*)::int from public.webhook_events
    where external_id in (pg_temp.wamid_hash('wamid.PR-DONE-OLD'),
                          pg_temp.wamid_hash('wamid.PR-PARKED'))),
  2, 'both pruned rows are still present, so a replayed message is still refused');
select is(
  (select payload is not null from public.webhook_events
    where external_id = pg_temp.wamid_hash('wamid.PR-DONE-NEW')),
  true, 'a recent event keeps its payload after pruning');
select is(
  (select payload is not null from public.webhook_events
    where external_id = pg_temp.wamid_hash('wamid.PR-RETRY')),
  true, 'an old event still on the retry ladder keeps its payload: it has not finished');
select is(
  (select payload is not null from public.webhook_events
    where external_id = pg_temp.wamid_hash('wamid.PR-RECEIVED')),
  true, 'and so does one never processed at all, however long the tick was down');
select is(
  (select payload is not null from public.webhook_events
    where external_id = pg_temp.wamid_hash('wamid.PR-PROCESSING')),
  true, 'and one claimed and abandoned, which the reclaim will hand back to the queue');

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
  values ('WHATSAPP', pg_temp.wamid_hash('wamid.TEST-MISMATCH'),
          '00000000-0000-0000-0000-0000000005c3',
          '00000000-0000-0000-0000-0000000005f1')
$$, '23503', null, 'a Station cannot be paired with a foreign Organization on webhook_events');

select lives_ok($$
  insert into public.webhook_events (provider, external_id, company_id, organization_id)
  values ('WHATSAPP', pg_temp.wamid_hash('wamid.TEST-BOTHNULL'), null, null)
$$, 'company_id and organization_id may both be null before a number resolves');

-- Shape guard: webhook_events_done_shape ---------------------------------------
-- DONE is a claim about outcome and processed_at: finishing a decision means
-- recording why and when, held structurally rather than trusted. RECEIVED,
-- PROCESSING and FAILED alike have decided nothing yet, so a plain row with
-- neither must stay legal.

select throws_ok($$
  insert into public.webhook_events (provider, external_id, status)
  values ('WHATSAPP', pg_temp.wamid_hash('wamid.TEST-DONE-BARE'), 'DONE')
$$, '23514', null, 'DONE with no outcome and no processed_at is not a legal webhook_events row');

select lives_ok($$
  insert into public.webhook_events (provider, external_id)
  values ('WHATSAPP', pg_temp.wamid_hash('wamid.TEST-RECEIVED-PLAIN'))
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

-- Retention on the OUTBOX (design spec D9, corrected) ---------------------------
--
-- This table was a permanent, un-erasable store of listener phone numbers: to_phone
-- holds one in the clear and external_id holds the raw wamid Meta returns for the
-- reply, which decodes to bytes containing that same number (0058). Nothing pruned
-- either, and anonymize_member (0034) cannot reach this table -- it erases by
-- member_id and there is none here to join on -- so a listener who exercised
-- erasure kept their number here for ever. prune_outbox_messages is the fix, and
-- these are its rules.
--
-- Three roles apiece on the two prunes, the convention this block holds everywhere
-- else: they are SECURITY DEFINER writers over every tenant at once.

select has_function('public', 'prune_outbox_messages', array['interval'],
                    'the outbox has a retention function of its own');

select ok(not has_function_privilege('anon',
            'public.prune_outbox_messages(interval)', 'EXECUTE'),
          'anon may not prune the outbox');
select ok(not has_function_privilege('authenticated',
            'public.prune_outbox_messages(interval)', 'EXECUTE'),
          'authenticated may not prune the outbox');
select ok(has_function_privilege('service_role',
            'public.prune_outbox_messages(interval)', 'EXECUTE'),
          'and the retention job may');
select ok(not has_function_privilege('anon',
            'public.prune_webhook_payloads(interval)', 'EXECUTE'),
          'anon may not prune webhook payloads');
select ok(not has_function_privilege('authenticated',
            'public.prune_webhook_payloads(interval)', 'EXECUTE'),
          'authenticated may not prune webhook payloads');
select ok(has_function_privilege('service_role',
            'public.prune_webhook_payloads(interval)', 'EXECUTE'),
          'and the retention job may');

-- Five rows, one per state, laid out so that each half of the predicate is broken
-- by a different one: drop the age test and the recent SENT row goes; drop the
-- status test and the PENDING and SENDING rows go, and a reply that had not been
-- sent yet would have no recipient left to send it to.
insert into public.outbox_messages
  (id, provider, integration_id, organization_id, company_id, to_phone, body,
   dedupe_key, status, created_at, sent_at, external_id, claimed_at)
values
  ('00000000-0000-0000-0000-000000005e01', 'WHATSAPP',
   '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c1', '5511977770001', 'Pronto! Boa sorte!',
   'prune-sent-old:confirmation', 'SENT', now() - interval '40 days',
   now() - interval '40 days', 'wamid.REPLY-OLD', null),
  ('00000000-0000-0000-0000-000000005e02', 'WHATSAPP',
   '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c1', '5511977770002', 'Pronto! Boa sorte!',
   'prune-sent-new:confirmation', 'SENT', now(), now(), 'wamid.REPLY-NEW', null),
  ('00000000-0000-0000-0000-000000005e03', 'WHATSAPP',
   '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c1', '5511977770003', 'Pronto! Boa sorte!',
   'prune-failed-old:confirmation', 'FAILED', now() - interval '40 days',
   null, null, null),
  ('00000000-0000-0000-0000-000000005e04', 'WHATSAPP',
   '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c1', '5511977770004', 'Pronto! Boa sorte!',
   'prune-pending-old:confirmation', 'PENDING', now() - interval '40 days',
   null, null, null),
  ('00000000-0000-0000-0000-000000005e05', 'WHATSAPP',
   '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c1', '5511977770005', 'Pronto! Boa sorte!',
   'prune-sending-old:confirmation', 'SENDING', now() - interval '40 days',
   null, null, now() - interval '40 days');

select public.prune_outbox_messages('30 days');

-- The body stays on purpose: it names a promotion and says what happened, which
-- is a fact about a draw rather than about a person, and it is what an operator
-- asked "what were they actually told?" has left once the number is gone.
select is(
  (select jsonb_build_object('to_phone', to_phone, 'external_id', external_id,
                             'pruned', pruned_at is not null, 'body', body,
                             'status', status::text)
     from public.outbox_messages where id = '00000000-0000-0000-0000-000000005e01'),
  jsonb_build_object('to_phone', null, 'external_id', null, 'pruned', true,
                     'body', 'Pronto! Boa sorte!', 'status', 'SENT'),
  'a sent reply past the cut loses the recipient and the provider id, and keeps everything else');

select is(
  (select jsonb_build_object('to_phone', to_phone, 'pruned', pruned_at is not null)
     from public.outbox_messages where id = '00000000-0000-0000-0000-000000005e03'),
  jsonb_build_object('to_phone', null, 'pruned', true),
  'and so does one that permanently failed, which holds a number just as much');

select is(
  (select to_phone from public.outbox_messages
    where id = '00000000-0000-0000-0000-000000005e02'),
  '5511977770002', 'a recently sent reply is untouched');
select is(
  (select to_phone from public.outbox_messages
    where id = '00000000-0000-0000-0000-000000005e04'),
  '5511977770004',
  'a message still waiting to be sent keeps its recipient, however old: erasing it would make the reply undeliverable');
select is(
  (select to_phone from public.outbox_messages
    where id = '00000000-0000-0000-0000-000000005e05'),
  '5511977770005',
  'and so does one claimed and in flight, which the reclaim returns to PENDING rather than abandoning');

select is(
  (select count(*)::int from public.outbox_messages
    where id in ('00000000-0000-0000-0000-000000005e01',
                 '00000000-0000-0000-0000-000000005e03')),
  2, 'the pruned rows are kept, not deleted');

-- THE REASON THEY ARE KEPT. dedupe_key is what stops a reprocessed event sending a
-- second confirmation, and it carries nothing personal, so it survives the prune
-- and goes on refusing. A retention that deleted rows would hand every listener a
-- duplicate reply the first time an old event was re-run by hand.
select throws_ok($$
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key)
  values
    ('WHATSAPP', '00000000-0000-0000-0000-0000000005a1',
     '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     '5511977770001', 'Pronto! Boa sorte!', 'prune-sent-old:confirmation')
$$, '23505', null, 'a pruned row still refuses the confirmation it already sent');

-- to_phone became nullable FOR THE PRUNE and for nothing else, and
-- outbox_messages_retention_shape is what says so. Without it, "nullable" would
-- mean a reply could be enqueued with nobody to send it to.
select throws_ok($$
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, body, dedupe_key)
  values
    ('WHATSAPP', '00000000-0000-0000-0000-0000000005a1',
     '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     'ok', 'p1:no-recipient')
$$, '23514', null, 'a row nobody has pruned must still say who it is for');

-- And the matching half on outbox_messages_sent_shape: the prune is an EXEMPTION
-- from "SENT names the message Meta accepted", not the removal of it. A settle
-- write that recorded the status without the provider id must still be 23514.
select throws_ok($$
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body,
     dedupe_key, status, sent_at)
  values
    ('WHATSAPP', '00000000-0000-0000-0000-0000000005a1',
     '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     '11999998888', 'ok', 'p1:sent-unpruned', 'SENT', now())
$$, '23514', null, 'SENT with a sent_at, no provider id and no prune behind it is still refused');

select ok(
  'WHATSAPP' = any(enum_range(null::public.participation_source)::text[]),
  'a participation can have arrived by WhatsApp');

-- The private member-resolution cores (0061) -----------------------------------
-- EXECUTE for nobody is the guarantee: these are reachable only from inside a
-- SECURITY DEFINER body that has already checked its own gate.
--
-- All THREE roles, the shape every other private core in this repository is
-- pinned with (apply_inventory_movement, ensure_inventory_balance_row,
-- apply_participation and the promotion helpers, all in 02_permissions).
-- service_role is the role the WhatsApp worker holds; anon is the
-- UNAUTHENTICATED PostgREST role, and it is on this list because the regression
-- the convention exists to catch is a hand-written `grant execute ... to anon`
-- added by somebody debugging the bot's path. Nothing is reachable by anon
-- today, so this is coverage rather than a live hole -- but such a grant would
-- leave a two-role version of this block entirely green while exposing
-- apply_member_creation, an unchecked write, and apply_member_candidates, an
-- Organization-wide existence oracle with no visibility filter, straight to the
-- network.

select ok(not has_function_privilege('anon',
            'public.apply_member_candidates(uuid,text,text,text,text)', 'EXECUTE'),
          'anon may not call apply_member_candidates');
select ok(not has_function_privilege('authenticated',
            'public.apply_member_candidates(uuid,text,text,text,text)', 'EXECUTE'),
          'authenticated may not call apply_member_candidates');
select ok(not has_function_privilege('service_role',
            'public.apply_member_candidates(uuid,text,text,text,text)', 'EXECUTE'),
          'service_role may not call apply_member_candidates either');
select ok(not has_function_privilege('anon',
            'public.apply_member_lookup(uuid,text,text,text,text)', 'EXECUTE'),
          'anon may not call apply_member_lookup');
select ok(not has_function_privilege('authenticated',
            'public.apply_member_lookup(uuid,text,text,text,text)', 'EXECUTE'),
          'authenticated may not call apply_member_lookup');
select ok(not has_function_privilege('service_role',
            'public.apply_member_lookup(uuid,text,text,text,text)', 'EXECUTE'),
          'service_role may not call apply_member_lookup either');
select ok(not has_function_privilege('anon',
            'public.apply_member_creation(uuid,text,text,text,text,text,text,date,text,text,text,text,text,text,text,text,timestamptz,text,uuid)',
            'EXECUTE'),
          'anon may not call apply_member_creation');
select ok(not has_function_privilege('authenticated',
            'public.apply_member_creation(uuid,text,text,text,text,text,text,date,text,text,text,text,text,text,text,text,timestamptz,text,uuid)',
            'EXECUTE'),
          'authenticated may not call apply_member_creation');
select ok(not has_function_privilege('service_role',
            'public.apply_member_creation(uuid,text,text,text,text,text,text,date,text,text,text,text,text,text,text,text,timestamptz,text,uuid)',
            'EXECUTE'),
          'service_role may not call apply_member_creation either');
select ok(not has_function_privilege('anon',
            'public.apply_member_link(uuid,uuid,uuid,uuid)', 'EXECUTE'),
          'anon may not call apply_member_link');
select ok(not has_function_privilege('authenticated',
            'public.apply_member_link(uuid,uuid,uuid,uuid)', 'EXECUTE'),
          'authenticated may not call apply_member_link');
select ok(not has_function_privilege('service_role',
            'public.apply_member_link(uuid,uuid,uuid,uuid)', 'EXECUTE'),
          'service_role may not call apply_member_link either');

-- The public door still finds what it always found.
--
-- The fixture is stored in the spelling an operator types and searched for in
-- digits, so the assertion is about NORMALISATION and not merely about equality:
-- an implementation comparing m.phone = p_phone raw passes a digits-to-digits
-- version of this test identically, and fails this one.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000005d1', '00000000-0000-0000-0000-0000000005f1',
   'Ouvinte Cinco', '(11) 99999-7777');
select is(
  public.apply_member_lookup('00000000-0000-0000-0000-0000000005f1',
                             '11999997777', null, null, null),
  '00000000-0000-0000-0000-0000000005d1'::uuid,
  'the lookup core matches on the normalised phone');

-- Block 3 behaviour this migration preserves ------------------------------------
--
-- The three assertions below test 0033/0034, not 0061, and they are here rather
-- than in 02_permissions for one reason: 0061 is the migration that could have
-- broken them. Each covers a shipped behaviour that, when Task 5 was written,
-- had NO test anywhere in this repository -- pgTAP, isolation or unit -- and
-- each was a behaviour the plan for 0061 would have changed in silence. What
-- protected them was that one reader happened to look; these assertions are
-- what protects them next time.
--
-- All three were run against a deliberately reverted 0061 (void core, bare
-- `limit 1`, case-sensitive passport) and all three fail there. See the Task 5
-- report.
--
-- auth.uid() reads request.jwt.claims and does not care which database role is
-- current, so the claim alone is enough to give these calls a real actor. The
-- role is deliberately NOT switched to `authenticated`: none of the three is
-- about RLS, and every function they reach is SECURITY DEFINER and so bypasses
-- RLS in production anyway.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000005b2', 'owner-5a@example.test'),
  ('00000000-0000-0000-0000-0000000005b3', 'delegate-5a@example.test');
insert into public.organization_memberships (user_id, organization_id, role) values
  ('00000000-0000-0000-0000-0000000005b2', '00000000-0000-0000-0000-0000000005f1', 'owner');

-- The delegate holds members.view at Station 5a ONLY, never at Station 5a Two.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-0000000005f1',
   'Station 5a Viewer');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000005e1', 'members.view');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000005b3', '00000000-0000-0000-0000-0000000005c1',
   '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005e1');

-- 1. A pair already linked is REFUSED, not silently succeeded a second time.
--    src/app/(app)/members/actions.ts calls link_member_to_company
--    "idempotent-refusing, not idempotent-succeeding" in those words, and the
--    screen surfaces the 23505. The refusal is decided on whether a row was
--    actually written, which is why apply_member_link returns boolean and not
--    void: PERFORM of a void function sets FOUND to TRUE whatever the insert
--    underneath it did.
insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000000005d2', '00000000-0000-0000-0000-0000000005f1',
   'Ouvinte Vinculavel');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000005b2", "role": "authenticated"}';

-- The first link must succeed, or the refusal below would pass for the wrong
-- reason -- a link that never happened refuses the second call just as loudly.
select lives_ok($$
  select public.link_member_to_company(
    '00000000-0000-0000-0000-0000000005d2', '00000000-0000-0000-0000-0000000005c2')
$$, 'a listener can be linked to a Station they were not registered at');

select throws_ok($$
  select public.link_member_to_company(
    '00000000-0000-0000-0000-0000000005d2', '00000000-0000-0000-0000-0000000005c2')
$$, '23505', 'this listener is already linked to that station',
   'linking the same listener to the same Station twice is refused, not silently repeated');

-- 2. The split-identifier case: the phone matches a listener the caller CAN
--    reach, the e-mail matches a DIFFERENT listener they cannot, and both are
--    supplied in one call. 0033's `order by reachable desc, c.id` exists for
--    exactly this and had no test at all.
--
--    The unreachable listener is inserted FIRST and carries the LOWER id, so
--    every wrong pick -- the planner's arbitrary one, or a deliberate `order by
--    id` -- lands on it and answers 'elsewhere'. Only asking about reachability
--    can produce the assertion below.
insert into public.members (id, organization_id, full_name, email) values
  ('00000000-0000-0000-0000-0000000005d3', '00000000-0000-0000-0000-0000000005f1',
   'Ouvinte Fora de Alcance', 'split-elsewhere-5a@example.test');
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000005d4', '00000000-0000-0000-0000-0000000005f1',
   'Ouvinte Alcancavel', '11999995555');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000005d3', '00000000-0000-0000-0000-0000000005c2',
   '00000000-0000-0000-0000-0000000005f1'),
  ('00000000-0000-0000-0000-0000000005d4', '00000000-0000-0000-0000-0000000005c1',
   '00000000-0000-0000-0000-0000000005f1');

-- 3. The passport is matched case-insensitively, agreeing with
--    members_passport_unique (0031), which is built on
--    (organization_id, lower(passport)). A dedup narrower than its own unique
--    index finds nothing and then the index refuses the insert.
insert into public.members (id, organization_id, full_name, passport) values
  ('00000000-0000-0000-0000-0000000005d5', '00000000-0000-0000-0000-0000000005f1',
   'Ouvinte Com Passaporte', 'AB1234567');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000005d5', '00000000-0000-0000-0000-0000000005c1',
   '00000000-0000-0000-0000-0000000005f1');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000005b3", "role": "authenticated"}';

select is(
  public.find_member_by_identifier(
    '00000000-0000-0000-0000-0000000005f1',
    '11999995555', 'split-elsewhere-5a@example.test'),
  jsonb_build_object('outcome', 'visible',
                     'member_id', '00000000-0000-0000-0000-0000000005d4'),
  'when one identifier matches a reachable listener and another matches an unreachable one, the reachable one is the answer');

select is(
  public.apply_member_lookup('00000000-0000-0000-0000-0000000005f1',
                             null, null, null, 'ab1234567'),
  '00000000-0000-0000-0000-0000000005d5'::uuid,
  'the lookup core matches a passport regardless of case');

select is(
  public.find_member_by_identifier(
    '00000000-0000-0000-0000-0000000005f1', null, null, null, 'ab1234567'),
  jsonb_build_object('outcome', 'visible',
                     'member_id', '00000000-0000-0000-0000-0000000005d5'),
  'the public door resolves a passport in another case to the listener already registered, rather than inviting a duplicate');

reset request.jwt.claims;

-- ==============================================================================
-- The bot's door (0062) -- ingest_whatsapp_event and its two helpers
-- ==============================================================================
--
-- Every call below runs with NO jwt claim, which is the bot's own condition:
-- auth.uid() is null, apply_participation stamps created_by null, and the audit
-- rows carry actor_id null. That is how a bot-originated write is told from an
-- operator's, and it is why the door cannot be gated on has_permission.

-- Phone normalisation ----------------------------------------------------------

select is(public.whatsapp_local_phone('5511999998888'), '11999998888',
          'a Brazilian mobile loses its country code');
select is(public.whatsapp_local_phone('551133334444'), '1133334444',
          'a Brazilian landline loses its country code');
select is(public.whatsapp_local_phone('11999998888'), '11999998888',
          'a number already local is left alone');
select is(public.whatsapp_local_phone('351912345678'), '351912345678',
          'a non-Brazilian number is left whole');
-- All four arguments above are already digits, so a hand-rolled substr passes
-- every one of them. This is the case that only passes if the argument goes
-- through normalize_phone (0031) first -- which is the whole reason an inbound
-- number can be matched against members.phone_normalized at all.
select is(public.whatsapp_local_phone('+55 (11) 98888-7777'), '11988887777',
          'a number spelled the way a person writes it is normalised before the country code is stripped');

-- Who may open the door ---------------------------------------------------------
-- Three roles apiece, the shape every private core in this repository is pinned
-- with. The door itself is service_role and nobody else: it holds no
-- has_permission gate, so a grant to authenticated would be an unchecked write
-- path into participations. Its two helpers hold EXECUTE for nobody, because
-- they are reached only from inside its SECURITY DEFINER body -- and
-- whatsapp_reply_body in particular reads promotion names across every Station
-- in the installation.

select ok(not has_function_privilege('anon',
            'public.ingest_whatsapp_event(uuid,integer)', 'EXECUTE'),
          'anon may not run the bot door');
select ok(not has_function_privilege('authenticated',
            'public.ingest_whatsapp_event(uuid,integer)', 'EXECUTE'),
          'authenticated may not run the bot door');
select ok(has_function_privilege('service_role',
            'public.ingest_whatsapp_event(uuid,integer)', 'EXECUTE'),
          'service_role may run the bot door');

select ok(not has_function_privilege('anon',
            'public.finish_whatsapp_event(uuid,text,text,uuid)', 'EXECUTE'),
          'anon may not call finish_whatsapp_event');
select ok(not has_function_privilege('authenticated',
            'public.finish_whatsapp_event(uuid,text,text,uuid)', 'EXECUTE'),
          'authenticated may not call finish_whatsapp_event');
select ok(not has_function_privilege('service_role',
            'public.finish_whatsapp_event(uuid,text,text,uuid)', 'EXECUTE'),
          'service_role may not call finish_whatsapp_event either');

select ok(not has_function_privilege('anon',
            'public.whatsapp_reply_body(uuid,uuid,text)', 'EXECUTE'),
          'anon may not call whatsapp_reply_body');
select ok(not has_function_privilege('authenticated',
            'public.whatsapp_reply_body(uuid,uuid,text)', 'EXECUTE'),
          'authenticated may not call whatsapp_reply_body');
select ok(not has_function_privilege('service_role',
            'public.whatsapp_reply_body(uuid,uuid,text)', 'EXECUTE'),
          'service_role may not call whatsapp_reply_body either');

-- Pinned for the same reason as the other three, though it reads nothing and
-- leaks nothing: it is the one function in this migration that could be
-- re-granted without a test going red, and "no exposure today" is a fact about
-- today rather than a reason to leave a grant untested.
select ok(not has_function_privilege('anon',
            'public.whatsapp_local_phone(text)', 'EXECUTE'),
          'anon may not call whatsapp_local_phone');
select ok(not has_function_privilege('authenticated',
            'public.whatsapp_local_phone(text)', 'EXECUTE'),
          'authenticated may not call whatsapp_local_phone');
select ok(not has_function_privilege('service_role',
            'public.whatsapp_local_phone(text)', 'EXECUTE'),
          'service_role may not call whatsapp_local_phone either');

-- Fixtures for the door ----------------------------------------------------------
--
-- WHICH STATION EACH NUMBER SERVES, after everything above has run. This is not
-- the mapping the top of the file set up, and reading it off the first insert
-- would put every promotion below at a Station no message ever reaches:
--
--   '111111111111111' -> Station 5a TWO (5c2)   the original 5c1 row was
--                                               soft-deleted to prove the
--                                               unique indexes are partial
--   '222222222222222' -> Station 5a     (5c1)
--
-- The promotions therefore live at 5c2, and '222222222222222' is what the
-- cross-Station assertion sends to.

-- A number this installation serves but has NOT switched on. `enabled` is half
-- of what stands in for the permission gate, and without a row like this the
-- predicate could be deleted with every assertion still green.
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000005c4', '00000000-0000-0000-0000-0000000005f1',
   'Station 5a Four', 'America/Sao_Paulo');
insert into public.integrations
  (organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c4',
   'WHATSAPP', '333333333333333', false);

-- Every fixed window below is in the PAST, deliberately and permanently.
--
-- The defect this block is most afraid of is the promotion being matched on
-- now() while apply_participation is handed the message timestamp. A promotion
-- whose window happens to contain the moment the suite runs cannot tell the two
-- apart -- and a window written as "next month" when the brief was drafted
-- quietly becomes "this month", which is exactly what happened here. June 2026
-- is past for good, so `recorded` below can only be produced by judging the
-- message by its own clock.
--
-- Disney carries RULES TEXT (Block 19a): it is this file's main character,
-- reused by nearly every assertion below that expects a hashtag to resolve
-- into something an eligible listener can actually enter, so it has to be
-- one of the promotions D4's gate lets through. Cancelada does not need any
-- -- it is refused before rules is ever consulted.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, yes_button_label, no_button_label, rules)
values
  ('00000000-0000-0000-0000-000000000591', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Disney', '2026-06-01Z', '2026-06-30Z',
   true, '#EUQUERO', 'Quero!', 'Nao', 'Promocao valida para maiores de 18 anos.'),
  ('00000000-0000-0000-0000-000000000594', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Cancelada', '2026-06-01Z', '2026-06-30Z',
   true, '#CANCELADO', 'Quero!', 'Nao', null);

update public.promotions
   set cancelled_at = now(),
       cancelled_by = '00000000-0000-0000-0000-0000000005b1',
       cancellation_reason = 'the sponsor withdrew'
 where id = '00000000-0000-0000-0000-000000000594';

-- Repeatable, so TOO_SOON is reachable and the "next chance" sentence has
-- something to render. Cinema deliberately carries NO rules text -- it is
-- this file's Block 19a Group B fixture (D4): a Station with a live,
-- WhatsApp-only promotion nobody has published rules for yet, so its own
-- first message finishes no_rules rather than a link, while TOO_SOON below
-- still fires from the pre-check, which sits ahead of that gate and does
-- not care whether rules exists.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, min_hours_between_entries,
   whatsapp_enabled, hashtag, yes_button_label, no_button_label)
values
  ('00000000-0000-0000-0000-000000000592', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Cinema', '2026-06-01Z', '2026-06-30Z',
   true, 6, true, '#REPETE', 'Quero!', 'Nao');

-- Two promotions whose hashtags differ only by a trailing '!'. Both are legal:
-- promotions_hashtag_shape (0040) permits punctuation inside a stored hashtag,
-- and promotions_hashtag_no_overlap compares lower(hashtag), so '#vai!' and
-- '#vai' are different tags and do not overlap. They exist so that "the
-- hashtag is matched exactly" is a testable claim rather than a comment: a
-- message saying '#VAI!' means Grito and only Grito -- there is no fallback
-- left that could enter the listener into Sussurro instead. Grito carries
-- rules text so the exact-match claim below can still be proven against a
-- link's promotion_id; Sussurro is never actually matched by anything in
-- this file, so it needs none.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, yes_button_label, no_button_label, rules)
values
  ('00000000-0000-0000-0000-000000000595', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Grito', '2026-06-01Z', '2026-06-30Z',
   true, '#VAI!', 'Quero!', 'Nao', 'Regulamento do Grito.'),
  ('00000000-0000-0000-0000-000000000596', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Sussurro', '2026-06-01Z', '2026-06-30Z',
   true, '#VAI', 'Quero!', 'Nao', null);

-- The same pair again, but with the punctuated one ALREADY ENDED. This pins
-- what an exact match costs: a listener writing '#JA!' after Encerrada has
-- closed is refused outright, even though '#JA' (Aberta) is a live promotion
-- at the same Station right now -- '#JA' is simply a different tag, never
-- consulted, because there is no fallback left to consult it with. An earlier
-- version of this function entered that listener into Aberta instead; the
-- owner reversed it on 2026-08-01 (see the migration's own comment and the
-- design spec).
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, yes_button_label, no_button_label)
values
  ('00000000-0000-0000-0000-000000000597', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Encerrada', '2026-05-01Z', '2026-05-31Z',
   true, '#JA!', 'Quero!', 'Nao'),
  ('00000000-0000-0000-0000-000000000598', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Aberta', '2026-06-01Z', '2026-06-30Z',
   true, '#JA', 'Quero!', 'Nao');

-- A hashtag ending in an ACCENTED LETTER. It used to be the only shape that
-- could tell a Unicode-aware [[:alnum:]] from a C one, back when this function
-- trimmed trailing punctuation before matching. That dependency is gone along
-- with the trim -- exact match lowercases and compares as a plain string, so
-- this fixture now pins only that an accented hashtag matches when written
-- exactly, and stays silent (like any other) when it is not. Carries rules
-- text for the same reason Grito does: the claim is which promotion the
-- hashtag resolves to, provable only if the match is allowed to reach a link.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, yes_button_label, no_button_label, rules)
values
  ('00000000-0000-0000-0000-000000000599', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Cafezinho', '2026-06-01Z', '2026-06-30Z',
   true, '#CAFÉ', 'Quero!', 'Nao', 'Regulamento do Cafezinho.');

-- The one promotion anchored to the clock, and the only one that is: it is open
-- RIGHT NOW, so a message written a month ago must still be refused by it.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, yes_button_label, no_button_label)
values
  ('00000000-0000-0000-0000-000000000593', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Show de Agora',
   now() - interval '1 day', now() + interval '1 day',
   true, '#AGORA', 'Quero!', 'Nao');

-- A helper so each case below is one insert and one call.
--
-- It catches, rather than letting a raise escape, and that is not politeness.
-- The contradiction this file exists to catch -- the window judged by two
-- different clocks -- surfaces as apply_participation's 22023 against the very
-- promotion the match just accepted. A raise inside a bare `select is(...)`
-- aborts the whole file and reports nothing about which assertion was
-- responsible; turned into a value it is one named failure carrying the
-- SQLSTATE. No assertion below expects an outcome beginning 'RAISED', so
-- nothing is weakened by the catch.
create table pg_temp.ingest_log (wamid text primary key, result jsonb);

create or replace function pg_temp.ingest(
  p_wamid text, p_from text, p_text text, p_at timestamptz,
  p_number text default '111111111111111')
returns jsonb language plpgsql as $$
declare v_id uuid; v_result jsonb;
begin
  -- external_id is the HASH; the raw provider id goes in the payload, which is
  -- the column prune_webhook_payloads clears at thirty days. That split is the
  -- whole of I1: the recoverable value expires, the idempotency key does not.
  insert into public.webhook_events (provider, external_id, payload)
  values ('WHATSAPP', pg_temp.wamid_hash(p_wamid), jsonb_build_object(
    'metadata', jsonb_build_object('phone_number_id', p_number),
    'wamid', p_wamid,
    'from', p_from, 'profile_name', 'Ouvinte Bot',
    'timestamp', extract(epoch from p_at)::bigint::text,
    'text', p_text))
  returning id into v_id;

  begin
    v_result := public.ingest_whatsapp_event(v_id);
  exception when others then
    v_result := jsonb_build_object(
      'outcome', 'RAISED ' || sqlstate || ': ' || sqlerrm,
      'status', null, 'participation_id', null);
  end;

  insert into pg_temp.ingest_log (wamid, result) values (p_wamid, v_result);
  return v_result;
end $$;

-- The outbox row a given message produced, found through the dedupe_key SHAPE
-- 0059 documents ('<sha256 of the wamid>:confirmation'). That indirection is
-- the assertion: an implementation keying the row on the participation, the
-- event id, or the RAW provider id leaves every lookup below empty rather than
-- merely differently named.
create or replace function pg_temp.confirmation(p_wamid text)
returns public.outbox_messages language sql as $$
  select o.*
  from public.outbox_messages o
  where o.provider = 'WHATSAPP'
    and o.dedupe_key = pg_temp.wamid_hash(p_wamid) || ':confirmation';
$$;

-- The door: one message, decided end to end -------------------------------------

-- BLOCK 5b CHANGED THIS, and Block 19a changes it again, further in the same
-- direction. 5b's headline was that a hashtag no longer enters anybody
-- directly -- it opened a conversation, so the listener could say no and be
-- asked for whatever the promotion wanted. 19a's headline (design spec D1)
-- is that nothing about a song, a promotion or a listener's data is
-- collected over WhatsApp messages any more, full stop: the conversation
-- engine that used to ask those questions inside WhatsApp is retired, and
-- this function now answers a hashtag with a LINK into the web widget
-- instead, where 17c's rules screen does the asking. Every assertion in this
-- section is CONVERTED rather than deleted -- the routing it proves is
-- unchanged, and only what the door hands back at the end of it is not.
select is(pg_temp.ingest('wamid.A1', '5511988887777', 'quero participar #EUQUERO !!',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'link', 'a hashtag in a messy sentence resolves to a link rather than opening a conversation');

select is(
  (select count(*)::int from public.participations p
     join public.members m on m.id = p.member_id
    where p.promotion_id = '00000000-0000-0000-0000-000000000591'
      and m.phone_normalized = '11988887777'),
  0,
  'and writes NO entry: this function only ever hands back an intention now, and somebody who never follows the link has not participated, which is what makes an unfollowed link cost nothing');

select is(
  (select jsonb_build_object('purpose', result ->> 'purpose',
                             'promotion_id', (result ->> 'promotion_id')::uuid)
     from pg_temp.ingest_log where wamid = 'wamid.A1'),
  jsonb_build_object('purpose', 'PROMOTION',
                     'promotion_id', '00000000-0000-0000-0000-000000000591'::uuid),
  'what comes back names the promotion the hashtag actually matched, not a conversation''s first step');

-- The listener registered by A1 would finish this on the web -- or an operator
-- enters them by hand; the pre-check reads participations and where a row came
-- from is not its business. Everything below about a SECOND message needs a
-- first entry to be second to, and A1 no longer writes one.
insert into public.participations
  (promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
select '00000000-0000-0000-0000-000000000591', m.id,
       '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c2',
       false, 'VALID', 'WHATSAPP', '2026-06-10T12:00:00Z'
  from public.members m
 where m.organization_id = '00000000-0000-0000-0000-0000000005f1'
   and m.phone_normalized = '11988887777';
select is(pg_temp.ingest('wamid.A2', '5511988887777', '#EUQUERO',
                         '2026-06-10T13:00:00Z') ->> 'status',
          'DUPLICATE', 'the same person twice is a duplicate, not a second entry');
select is(
  (select count(*)::int from public.members
    where organization_id = '00000000-0000-0000-0000-0000000005f1'
      and phone_normalized = '11988887777'),
  1, 'the listener was registered once, without the country code');

-- The bot fills in the record Block 3 designed for it rather than inventing a
-- second one. first_contact_at is the MESSAGE's timestamp for the same reason
-- everything else here is, and it is write-once evidence behind the owner's
-- ruling (spec 7) that a listener who messages a Station has authorised the
-- reply -- so a bot that stamped it "now" would be recording consent on the
-- wrong date.
select is(
  (select jsonb_build_object('name', full_name,
                             'first_contact_at', first_contact_at,
                             'origin', first_contact_origin)
     from public.members
    where organization_id = '00000000-0000-0000-0000-0000000005f1'
      and phone_normalized = '11988887777'),
  jsonb_build_object('name', 'Ouvinte Bot',
                     'first_contact_at', '2026-06-10T12:00:00Z'::timestamptz,
                     'origin', 'WHATSAPP'),
  'a listener the bot registers carries the profile name, the moment of first contact and where it came from');

select is(pg_temp.ingest('wamid.A3', '5511988886666', 'bom dia',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'no_hashtag', 'a message with no hashtag is finished and silent');
select is(pg_temp.ingest('wamid.A4', '5511988886666', '#NADA',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'no_promotion', 'an unknown hashtag is finished and silent');
select is(pg_temp.ingest('wamid.A5', '5511988886666', '#EUQUERO',
                         '2026-07-10T12:00:00Z') ->> 'outcome',
          'outside_window', 'a message after the promotion closed says so');
select is(pg_temp.ingest('wamid.A6', '5511988886666', '#EUQUERO',
                         '2026-06-10T12:00:00Z', '999999999999999') ->> 'outcome',
          'no_integration', 'a message to a number we do not serve is finished');
select is(pg_temp.ingest('wamid.A7', '5511988886666', '#EUQUERO',
                         '2026-06-10T12:00:00Z', '333333333333333') ->> 'outcome',
          'no_integration', 'a message to a number we serve but have not switched on is finished');
-- Tenancy. The hashtag is matched within the Station the NUMBER resolved to, so
-- the same tag arriving at a sister Station is not this message's promotion --
-- without the company_id predicate this returns 'recorded' and enters a listener
-- into another Station's draw.
select is(pg_temp.ingest('wamid.A8', '5511988886666', '#EUQUERO',
                         '2026-06-10T12:00:00Z', '222222222222222') ->> 'outcome',
          'no_promotion', 'a hashtag belongs to one Station: the same tag arriving at a sister Station matches nothing');
select is(pg_temp.ingest('wamid.A9', '5511988886666', '#CANCELADO',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'promotion_cancelled', 'a cancelled promotion is told apart from one that never existed');

-- The hashtag, matched exactly -----------------------------------------------
--
-- Owner's ruling, 2026-08-01, reversing an earlier version of this function
-- (and of this file): the hashtag must be EXACT, differing only in upper/lower
-- case. A message carrying any extra character -- '!', '?', '.', anything --
-- does not enter the promotion. There is no second, punctuation-stripped
-- candidate tried when the exact one matches nothing.
--
-- THE REASONING ON THE OTHER SIDE, so this does not read as though the rule
-- was always exact: '#EUQUERO!!' is how somebody writes when they are
-- excited, which is the state this whole feature exists to produce, and D4's
-- silence leaves that listener with nothing and no way to learn why. An
-- earlier version of ingest_whatsapp_event answered that by retrying the same
-- token with trailing punctuation stripped, and a controller ruling -- not the
-- owner's, see the design spec and the block report -- kept that fallback
-- active even when the exact tag had a history of its own at the Station. The
-- owner weighed that against a stored hashtag ending in punctuation becoming
-- two ways to spell one promotion in a listener's head, and reversed it.

select is(pg_temp.ingest('wamid.P1', '5511988882222', 'AAAA quero!! #EUQUERO!!',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'no_promotion',
          'a hashtag with punctuation stuck to it now matches nothing -- the extracted tag is #euquero!!, which no promotion is stored as -- and that silence is the owner''s rule, not an accident');

select is(pg_temp.ingest('wamid.P2', '5511988882222', '#VAI!',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'link', 'a hashtag that legitimately ends in punctuation is matched when written exactly');

-- Which promotion it matched, read off the link the door handed back rather
-- than off a confirmation. More direct than the old assertion, not less: it
-- names the promotion the listener is about to be sent to accept rules for,
-- where the reply only named the one they had already been entered into.
select is(
  (select result ->> 'promotion_name'
     from pg_temp.ingest_log where wamid = 'wamid.P2'),
  'Grito',
  'it resolves to the promotion stored with the punctuation -- an exact match, and the only kind there is now');

-- What "exact" costs: a match against a promotion that has since ended is
-- refused, even though a differently-punctuated sibling is open right now.
-- '#JA!' (Encerrada) closed in May; '#JA' (Aberta) is a DIFFERENT tag and is
-- never consulted, because there is no fallback left to consult it with.
select is(pg_temp.ingest('wamid.P3', '5511988882222', '#JA!',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'outside_window',
          'a message naming a promotion exactly, after that promotion has ended, is refused -- it is not offered a live sibling spelled without the punctuation');

-- The accented hashtag: silent when punctuated, matched when exact. Trimming
-- used to depend on [[:alnum:]] being UNICODE-AWARE, a property of the
-- cluster's ctype that was never actually tested against production -- that
-- dependency is gone along with the trim. An exact match compares a
-- lowercased string byte-for-byte and does not care what the ctype thinks a
-- letter is.
select is(pg_temp.ingest('wamid.P4', '5511988882222', 'bora #CAFÉ!',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'no_promotion', 'an accented hashtag with punctuation stuck to it is silent too, same as any other');

select is(pg_temp.ingest('wamid.P4A', '5511988882222', 'bora #CAFÉ',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'link',
          'written exactly, the accented hashtag still matches -- the property worth pinning now that no ctype assumption is behind it');
select is(
  (select result ->> 'promotion_name'
     from pg_temp.ingest_log where wamid = 'wamid.P4A'),
  'Cafezinho',
  'and it resolves to the accented promotion');

-- Case is the one permitted variation, named by the owner explicitly, so it is
-- pinned by its own assertion rather than left implied by every case above
-- happening to match the case the fixture itself was stored in.
select is(pg_temp.ingest('wamid.P5', '5511988885555', '#euquero',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'link',
          'a hashtag in a different case from how it is stored still matches -- upper/lower is the one variation the exact rule permits');

-- A malformed payload is loud, not plausible -------------------------------------
--
-- `timestamp` absent (pg_temp.ingest with a null p_at writes a JSON null, which
-- ->> reads exactly as an absent key does). Left to itself v_when is NULL, every
-- comparison below it goes UNKNOWN rather than false, nothing matches, and the
-- diagnostic reports outside_window -- a malformed payload filed under DONE
-- wearing a reason an operator would believe. It raises instead, the same answer
-- a missing `from` gets, so the two kinds of route defect are not told apart by
-- which happens to survive to a silent outcome.

select is(pg_temp.ingest('wamid.X1', '5511988881111', '#EUQUERO', null) ->> 'outcome',
          'RAISED 22023: whatsapp payload carries no message timestamp',
          'a message that names a promotion and carries no timestamp raises rather than finishing with a plausible reason');
select is(
  (select status::text from public.webhook_events where external_id = pg_temp.wamid_hash('wamid.X1')),
  'RECEIVED',
  'and nothing about it is half-written: the event is left for the worker to park, not filed as decided');

-- The OTHER limb of the same payload contract, which used to be enforced only by
-- accident. `from` absent, and `from` present but carrying no digits: both
-- normalise to NULL through normalize_phone (0031), so apply_member_lookup --
-- which requires a non-null normalised phone -- matches nothing, and
-- apply_member_creation then REGISTERED A LISTENER WITH A NULL PHONE. That row is
-- real, is counted, is entered into the draw, and no later message from the same
-- person can ever dedupe against it, because members_phone_unique does not
-- constrain nulls. It failed at write time in neither direction, so nothing but
-- this guard would ever have said so.

select is(pg_temp.ingest('wamid.X2', null, '#EUQUERO', '2026-06-10T12:00:00Z') ->> 'outcome',
          'RAISED 22023: whatsapp payload carries no usable sender phone',
          'a message that names a promotion and carries no sender raises rather than entering nobody in particular');
select is(pg_temp.ingest('wamid.X3', 'abc', '#EUQUERO', '2026-06-10T12:00:00Z') ->> 'outcome',
          'RAISED 22023: whatsapp payload carries no usable sender phone',
          'and so does one whose sender carries no digits at all, which normalises to the same nothing');
select is(
  (select count(*)::int from public.members
    where organization_id = '00000000-0000-0000-0000-0000000005f1'
      and first_contact_origin = 'WHATSAPP'
      and phone_normalized is null),
  0, 'and neither of them left a phoneless listener behind');

-- A row whose payload prune_webhook_payloads has already emptied. The prune's own
-- predicate keeps this off the AUTOMATIC path -- it reaches only DONE and parked
-- rows, and the door declines a DONE one -- so what is left is an operator
-- un-parking a row older than the retention window. Unguarded it finds no
-- phone_number_id, misses the integration lookup and finishes DONE/no_integration:
-- a routing verdict recorded against a message whose content no longer exists,
-- indistinguishable from a real one.
create or replace function pg_temp.ingest_empty(p_wamid text)
returns text language plpgsql as $$
declare v_id uuid; v_out text;
begin
  insert into public.webhook_events (provider, external_id, payload)
  values ('WHATSAPP', pg_temp.wamid_hash(p_wamid), null)
  returning id into v_id;
  begin
    v_out := public.ingest_whatsapp_event(v_id) ->> 'outcome';
  exception when others then
    v_out := 'RAISED ' || sqlstate || ': ' || sqlerrm;
  end;
  return v_out;
end $$;

select is(pg_temp.ingest_empty('wamid.X4'),
          'RAISED 22023: whatsapp payload has been pruned and this event can no longer be decided',
          'an event whose payload has been pruned says so, instead of reporting a routing outcome it cannot have decided');

-- The message's own clock, not the server's --------------------------------------
--
-- '#AGORA' is open at this instant and the message is a month old. Matched on
-- now() the promotion is found, and apply_participation then refuses -- with
-- 22023 -- the very window that admitted it. Judged by the message, it is
-- simply outside_window and nobody is entered.

select is(pg_temp.ingest('wamid.T1', '5511988884444', '#AGORA',
                         now() - interval '30 days') ->> 'outcome',
          'outside_window',
          'a promotion open right now does not take an entry for a message written a month ago');

-- Read off A2 rather than A1: A1 resolves to a link and writes no entry, and
-- A2 is now the message this file has that does. The property is unchanged and
-- is the one that matters -- an event decided an hour late is still decided as
-- of when the person wrote.
select is(
  (select participated_at from public.participations
    where id = (select (result ->> 'participation_id')::uuid
                  from pg_temp.ingest_log where wamid = 'wamid.A2')),
  '2026-06-10T13:00:00Z'::timestamptz,
  'the entry is stamped with the message timestamp, not the moment it was processed');

-- What the event itself records --------------------------------------------------

-- A1 IS NOT FINISHED HERE ANY MORE, and that is the change with the sharpest
-- operational edge in this block. The link path leaves the event PROCESSING
-- and the caller closes it, through whatever Task 5 finishes the link path
-- with, once the code is minted and the message is enqueued -- so a worker
-- that dies in between leaves a claimed row the inbound reclaim frees five
-- minutes later rather than a message recorded as handled and answered by
-- nothing. This is the same division 0070 used for the conversation it
-- replaced (Block 19a, D7).
select is(
  (select jsonb_build_object('status', status::text, 'outcome', outcome,
                             'claimed', claimed_at is not null,
                             'processed_at_set', processed_at is not null)
     from public.webhook_events where external_id = pg_temp.wamid_hash('wamid.A1')),
  jsonb_build_object('status', 'PROCESSING', 'outcome', null,
                     'claimed', true, 'processed_at_set', false),
  'a message that resolved to a link is left claimed for the caller to finish, not filed as decided');

select is(
  (select jsonb_build_object('status', status::text, 'outcome', outcome,
                             'processed_at_set', processed_at is not null)
     from public.webhook_events where external_id = pg_temp.wamid_hash('wamid.A2')),
  jsonb_build_object('status', 'DONE', 'outcome', 'recorded', 'processed_at_set', true),
  'while an entry the door decided on its own is DONE and says both why and when');

-- '111111111111111' is live at 5c2 and archived at 5c1. An implementation that
-- ignored deleted_at could pick either row; this says which one is correct.
select is(
  (select jsonb_build_object('company', company_id, 'organization', organization_id,
                             'integration_set', integration_id is not null)
     from public.webhook_events where external_id = pg_temp.wamid_hash('wamid.A1')),
  jsonb_build_object('company', '00000000-0000-0000-0000-0000000005c2'::uuid,
                     'organization', '00000000-0000-0000-0000-0000000005f1'::uuid,
                     'integration_set', true),
  'the event is stamped with the Station its number resolved to, and it is the live row rather than the archived one');

-- The reply, in the same transaction as the entry ---------------------------------

select is((pg_temp.confirmation('wamid.A2')).to_phone, '5511988887777',
          'the reply is addressed to the number WhatsApp delivered, country code and all -- the local form is how we store a phone, not one WhatsApp can reach');

-- THE DOOR MUST NOT CONGRATULATE ANYBODY. 'Pronto! Você está participando' is
-- written once an entry actually exists, and this function never writes one
-- for a promotion match any more -- it hands back a link. What belongs here
-- is that half of the sentence: the message that resolved to a link enqueued
-- NOTHING under the confirmation key, so nobody is told they are in before
-- they have accepted the rules on the web.
select is((pg_temp.confirmation('wamid.A1')).id, null,
          'a message that only resolved to a link confirms no entry -- an entry does not exist yet');
select is((pg_temp.confirmation('wamid.A2')).body,
          'Você já está participando de Disney.',
          'a duplicate is told it is already in, not congratulated a second time');
select is(
  (select count(*)::int from public.outbox_messages where to_phone = '5511988886666'),
  0, 'a silent outcome enqueues nothing at all (design spec D4)');

-- TOO_SOON, and the clock the listener is told about ------------------------------
--
-- 12:00Z plus six hours is 18:00Z, which is 15:00 at the Station. The server
-- renders in UTC, so an implementation that forgets `at time zone` sends
-- somebody back three hours late and nothing else in this suite notices.

-- Cinema carries no rules text (this file's Block 19a D4 fixture, see the
-- promotion's own comment above): R1 is an eligible first message all the
-- same, so it reaches the rules gate rather than being turned away earlier,
-- and finishes no_rules with nothing sent.
select is(pg_temp.ingest('wamid.R1', '5511988883333', '#REPETE',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'no_rules', 'a repeatable promotion with no rules text yet finishes no_rules for the first eligible message too');
select is(
  (select count(*)::int from public.outbox_messages where to_phone = '5511988883333'),
  0, 'and sends nothing -- no_rules is as silent to the listener as no_promotion or outside_window');

-- What would have been R1's entry, on an ordinary web completion. Written
-- directly for the same reason as A1's above: the interval rule below has to
-- have an earlier entry to measure from, and the door itself never writes one
-- any more, whichever of link or no_rules it answers with.
insert into public.participations
  (promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
select '00000000-0000-0000-0000-000000000592', m.id,
       '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c2',
       true, 'VALID', 'WHATSAPP', '2026-06-10T12:00:00Z'
  from public.members m
 where m.organization_id = '00000000-0000-0000-0000-0000000005f1'
   and m.phone_normalized = '11988883333';
select is(pg_temp.ingest('wamid.R2', '5511988883333', '#REPETE',
                         '2026-06-10T13:00:00Z') ->> 'status',
          'TOO_SOON', 'a second entry inside the interval is recorded with the status that says so');
select is((pg_temp.confirmation('wamid.R2')).body,
          'Você já participou há pouco. Sua próxima chance é às 15:00.',
          'the next chance is told in the Station''s own timezone, not the server''s');

-- The reply copy: OVER_LIMIT, and the two fallbacks nothing above reaches ----------
--
-- VALID, DUPLICATE and TOO_SOON-with-a-known-next-chance are already pinned above,
-- through the confirmations the door itself produced (wamid.A1, wamid.A2, wamid.R2)
-- -- including the Station-timezone rendering, which R2 exercises directly. Nothing
-- above ever reaches OVER_LIMIT, and both fallbacks -- an uncapped promotion, and a
-- listener with no entry yet to measure an interval from -- are reachable but never
-- taken. All four are asserted directly against whatsapp_reply_body rather than
-- through the door: the function has no caller-identity check of its own, only a
-- revoke on the role, and pgTAP runs as a role the revoke does not bind.

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, yes_button_label, no_button_label,
   allow_multiple_entries, min_hours_between_entries, max_entries_per_member)
values
  ('00000000-0000-0000-0000-00000000059a', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Combo', '2026-06-01Z', '2026-06-30Z',
   true, '#COMBO', 'Quero!', 'Nao',
   true, 6, 3);

select is(
  public.whatsapp_reply_body('00000000-0000-0000-0000-00000000059a',
                             '00000000-0000-0000-0000-0000000005d1', 'OVER_LIMIT'),
  'Você já usou suas 3 chances nesta promoção.',
  'the ceiling is named when the promotion has one');

-- Disney (591) sets no ceiling, so the same status renders the fallback rather
-- than a sentence carrying a null.
select is(
  public.whatsapp_reply_body('00000000-0000-0000-0000-000000000591',
                             '00000000-0000-0000-0000-0000000005d1', 'OVER_LIMIT'),
  'Você já usou todas as suas chances nesta promoção.',
  'an uncapped promotion falls back rather than saying "suas null chances"');

-- Cinema (592) carries an interval, but 'Ouvinte Cinco' (5d1) has never entered
-- it, so there is no last participation to add that interval to.
select is(
  public.whatsapp_reply_body('00000000-0000-0000-0000-000000000592',
                             '00000000-0000-0000-0000-0000000005d1', 'TOO_SOON'),
  'Você já participou há pouco. Tente novamente mais tarde.',
  'an uncomputable next chance falls back rather than rendering a null time');

-- An outcome that is not one of the four is not copy this function owns.
select is(
  public.whatsapp_reply_body('00000000-0000-0000-0000-000000000591',
                             '00000000-0000-0000-0000-0000000005d1', 'SOMETHING'),
  null,
  'an unrecognised status renders nothing rather than a sentence');

-- Design spec D8: a listener the Organization already knows ------------------------
--
-- 'Ouvinte Alcancavel' (5d4) was registered above and linked to Station 5a
-- ONLY. The message arrives at Station 5a Two. apply_member_lookup is
-- Organization-scoped with no visibility filter (0061) precisely so the bot
-- finds them; the idempotent link is what lets them enter here. Registering a
-- second record instead would defeat the deduplication Block 3 exists for, and
-- 0031's per-Organization unique index on the phone would refuse it anyway.

select is(pg_temp.ingest('wamid.D1', '5511999995555', '#EUQUERO',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'link',
          'a listener registered at a sister Station is let in rather than turned away');
select is(
  (select count(*)::int from public.members
    where organization_id = '00000000-0000-0000-0000-0000000005f1'
      and phone_normalized = '11999995555'),
  1, 'and is not registered a second time');
select ok(
  exists (select 1 from public.member_company_links
           where member_id = '00000000-0000-0000-0000-0000000005d4'
             and company_id = '00000000-0000-0000-0000-0000000005c2'),
  'the Station they messaged is added to their reach');

-- The shape an OPERATOR typed, which nothing normalises ------------------------------
--
-- whatsapp_local_phone normalises what Meta sent. Nothing normalises what an
-- operator entered: members.phone_normalized is GENERATED from members.phone as
-- typed (0031), so a listener registered as "+55 (11) 98888-1111" is stored as
-- thirteen digits, the local-form lookup asks for eleven, and it misses. Before
-- the second lookup the bot registered a SECOND record for that listener on
-- their first message -- and on every first message of every listener entered
-- that way. It needs no unusual number and no ninth-digit change; it needs an
-- operator who typed the country code.
--
-- BOTH DIRECTIONS, because a fallback that REPLACED the local lookup instead of
-- following it would pass one of these and fail the other, and because the local
-- form must stay the preference: it is what a new listener is registered under.

insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000005d6', '00000000-0000-0000-0000-0000000005f1',
   'Ouvinte Local', '(11) 97777-2222'),
  ('00000000-0000-0000-0000-0000000005d7', '00000000-0000-0000-0000-0000000005f1',
   'Ouvinte Internacional', '+55 (11) 97777-1111');

select is(pg_temp.ingest('wamid.F1', '5511977772222', '#EUQUERO',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'link',
          'a listener stored in the local form is found from the number Meta delivered');
-- Read off the link rather than off an entry: the link names the listener it
-- was resolved for, and that is the same claim the participation's member_id
-- used to make one step later.
select is(
  (select (result ->> 'member_id')::uuid
     from pg_temp.ingest_log where wamid = 'wamid.F1'),
  '00000000-0000-0000-0000-0000000005d6'::uuid,
  'and the link is that listener''s own, not a new record''s');

select is(pg_temp.ingest('wamid.F2', '5511977771111', '#EUQUERO',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'link',
          'a listener an operator stored WITH the country code is found as well');
select is(
  (select (result ->> 'member_id')::uuid
     from pg_temp.ingest_log where wamid = 'wamid.F2'),
  '00000000-0000-0000-0000-0000000005d7'::uuid,
  'and it is theirs: without the second lookup this is a brand-new listener with the same phone in a different shape');
select is(
  (select count(*)::int from public.members
    where organization_id = '00000000-0000-0000-0000-0000000005f1'
      and phone_normalized in ('5511977771111', '11977771111')),
  1, 'so that person has exactly one record, in the shape the operator typed');

-- Reprocessing ---------------------------------------------------------------------
--
-- TWO mechanisms, not one, and an earlier version of this comment named only the
-- first while denying the second. The status predicate declines a DONE event, so
-- the automatic path never decides one twice. The unique dedupe_key covers the
-- case the predicate cannot -- an operator putting a finished row back by hand --
-- because it is keyed on the MESSAGE (`external_id || ':confirmation'`, 0062),
-- which is the same for every decision of the same event. It is NOT keyed on the
-- participation: the retired sentence said so, and a reader following it would
-- conclude the ON CONFLICT in 0062 is unreachable and free to delete. The block
-- at the very end of this file is that case, asserted.

-- A2 is DONE, which is what the claim predicate declines. (A1 would also come
-- back 'skipped' here, but for the other reason -- it is PROCESSING -- and an
-- assertion that cannot tell the two apart proves neither.)
select is(
  (select public.ingest_whatsapp_event(id) ->> 'outcome'
     from public.webhook_events where external_id = pg_temp.wamid_hash('wamid.A2')),
  'skipped',
  'an event already decided is not decided again');
select is(
  (select count(*)::int from public.participations p
     join public.members m on m.id = p.member_id
    where p.promotion_id = '00000000-0000-0000-0000-000000000591'
      and m.phone_normalized = '11988887777'),
  2, 'and the listener who sent it still has exactly two entries: the one standing in for their first message finishing on the web, and the duplicate A2 recorded');

-- No personal data in the audit trail (design spec D2) ------------------------------
--
-- Block 3's rule, and it is absolute. audit_logs is never pruned, whereas
-- webhook_events.payload -- where the phone and the profile name stay -- is
-- cleared after thirty days and is unreadable through any user-scoped client.
--
-- Asserted STRUCTURALLY rather than by grepping the serialised detail for a run
-- of digits. A substring test cannot distinguish a leaked phone from a uuid
-- that happens to contain the same digits -- a uuid's twelve-character final
-- block alone carries eleven consecutive decimal digits about half a percent of
-- the time -- so it would eventually go red for no reason and be disbelieved
-- when it finally went red for a real one. It also misses the likelier
-- regression: a contributor adding personal data under a key nobody thought to
-- grep for. The key SET is the thing to pin.

select is(
  (select count(*)::int from public.audit_logs
    where action = 'ingest_whatsapp_event' and detail ? 'from_phone'),
  0, 'no audit row of the bot door carries a from_phone key');

select is(
  (select array_agg(distinct k order by k)
     from public.audit_logs a, jsonb_object_keys(a.detail) k
    where a.action = 'ingest_whatsapp_event'),
  array['integration_id', 'member_id', 'outcome', 'participation_id',
        'promotion_id', 'wamid_sha256'],
  'across every outcome the audit detail carries exactly these six keys -- ids, the hashed message id and the reason, and nothing that describes a person');

-- The key set pins NAMES. This pins VALUES, and it is the assertion that
-- catches the leak the names cannot see: a raw provider message id written
-- under the honest-looking key 'wamid_sha256'.
--
-- A wamid decodes to bytes containing the counterparty's phone number, so a raw
-- one in audit_logs is a recoverable phone in a table that is never pruned --
-- the thing design spec D2 forbids in capitals, arriving by the one route D9
-- assumed was safe. Every wamid in this file begins 'wamid.'; a SHA-256 hex
-- digest and a uuid can contain neither that letter run nor the dot, so unlike
-- a digit-substring test this one cannot fire by chance.
select is(
  (select count(*)::int from public.audit_logs
    where action = 'ingest_whatsapp_event' and detail::text like '%wamid.%'),
  0, 'no audit row carries a raw provider message id, under any key');

-- A2 rather than A1: an audit row is written when an event is FINISHED, and A1
-- is not finished by this function any more.
select is(
  (select detail ->> 'wamid_sha256' from public.audit_logs
    where action = 'ingest_whatsapp_event'
      and target_id = (select id from public.webhook_events
                        where external_id = pg_temp.wamid_hash('wamid.A2'))),
  pg_temp.wamid_hash('wamid.A2'),
  'the audit row names the message it decided -- by its hash, which is the same value webhook_events carries, so support can trace one without opening the payload and without a recoverable phone being written down');

select is(
  (select (detail ->> 'participation_id')::uuid from public.audit_logs
    where action = 'ingest_whatsapp_event'
      and target_id = (select id from public.webhook_events
                        where external_id = pg_temp.wamid_hash('wamid.A2'))),
  (select (result ->> 'participation_id')::uuid
     from pg_temp.ingest_log where wamid = 'wamid.A2'),
  'and ties it to the entry it produced, which is the only link between a message and its participation');

-- And the message that resolved to a link has NO audit row at all yet, which
-- is the same fact as its event still being PROCESSING, asserted from the other
-- side: nothing has decided it.
select is(
  (select count(*)::int from public.audit_logs
    where action = 'ingest_whatsapp_event'
      and target_id = (select id from public.webhook_events
                        where external_id = pg_temp.wamid_hash('wamid.A1'))),
  0, 'a message left PROCESSING behind a link has not been decided, and writes no trail saying it was');

-- One message, one reply, however many times it is decided --------------------------
--
-- This is the assertion that would have caught the defect 0059's comment used to
-- describe. The claim predicate declines a DONE event, so getting here at all
-- takes an operator resetting the row by hand -- which also means clearing
-- outcome and processed_at, since webhook_events_done_shape forbids a non-DONE
-- row from carrying either. That operator is the case the unique dedupe_key
-- exists for, and it is the case a participation-keyed value cannot serve: the
-- second pass writes a SECOND participation (the row is a fact about the
-- attempt), so a participation-keyed value differs every time and the ON
-- CONFLICT never fires once.
--
-- Deliberately LAST in the file. It puts a third participation on the listener
-- and a second audit row on the event, both of which earlier assertions count.

-- A2 and not A1, because the assertion is about a REPLY being enqueued once and
-- A1 no longer produces one: the link path enqueues its own message from the
-- caller, under its own key, once a code is minted (Task 5).
update public.webhook_events
   set status = 'FAILED', outcome = null, processed_at = null
 where external_id = pg_temp.wamid_hash('wamid.A2');

-- The re-run must actually happen, or the count below would pass because
-- nothing ran rather than because nothing was enqueued twice.
select is(
  (select public.ingest_whatsapp_event(id) ->> 'outcome'
     from public.webhook_events where external_id = pg_temp.wamid_hash('wamid.A2')),
  'recorded',
  'an event put back by hand really is decided again');

select is(
  (select count(*)::int from public.outbox_messages
    where provider = 'WHATSAPP'
      and dedupe_key = pg_temp.wamid_hash('wamid.A2') || ':confirmation'),
  1, 'but the listener is answered once: the reply is keyed on the message, so deciding it twice enqueues one row');

select * from finish();
rollback;
