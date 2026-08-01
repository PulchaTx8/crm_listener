begin;
select plan(47);

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

select * from finish();
rollback;
