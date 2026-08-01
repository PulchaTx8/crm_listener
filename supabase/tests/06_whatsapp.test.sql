begin;
select plan(91);

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
            'public.ingest_whatsapp_event(uuid)', 'EXECUTE'),
          'anon may not run the bot door');
select ok(not has_function_privilege('authenticated',
            'public.ingest_whatsapp_event(uuid)', 'EXECUTE'),
          'authenticated may not run the bot door');
select ok(has_function_privilege('service_role',
            'public.ingest_whatsapp_event(uuid)', 'EXECUTE'),
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
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, yes_button_label, no_button_label)
values
  ('00000000-0000-0000-0000-000000000591', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Disney', '2026-06-01Z', '2026-06-30Z',
   true, '#EUQUERO', 'Quero!', 'Nao'),
  ('00000000-0000-0000-0000-000000000594', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Cancelada', '2026-06-01Z', '2026-06-30Z',
   true, '#CANCELADO', 'Quero!', 'Nao');

update public.promotions
   set cancelled_at = now(),
       cancelled_by = '00000000-0000-0000-0000-0000000005b1',
       cancellation_reason = 'the sponsor withdrew'
 where id = '00000000-0000-0000-0000-000000000594';

-- Repeatable, so TOO_SOON is reachable and the "next chance" sentence has
-- something to render.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, min_hours_between_entries,
   whatsapp_enabled, hashtag, yes_button_label, no_button_label)
values
  ('00000000-0000-0000-0000-000000000592', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c2', 'Cinema', '2026-06-01Z', '2026-06-30Z',
   true, 6, true, '#REPETE', 'Quero!', 'Nao');

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
  insert into public.webhook_events (provider, external_id, payload)
  values ('WHATSAPP', p_wamid, jsonb_build_object(
    'metadata', jsonb_build_object('phone_number_id', p_number),
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
-- 0059 documents ('<participation_id>:confirmation'). That indirection is the
-- assertion: an implementation keying the row on the wamid or the event id
-- leaves every lookup below empty rather than merely differently named.
create or replace function pg_temp.confirmation(p_wamid text)
returns public.outbox_messages language sql as $$
  select o.*
  from public.outbox_messages o
  join pg_temp.ingest_log l
    on o.dedupe_key = (l.result ->> 'participation_id') || ':confirmation'
  where l.wamid = p_wamid;
$$;

-- The door: one message, decided end to end -------------------------------------

select is(pg_temp.ingest('wamid.A1', '5511988887777', 'quero participar #EUQUERO !!',
                         '2026-06-10T12:00:00Z') ->> 'outcome',
          'recorded', 'a hashtag in a messy sentence is recorded');
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

select is(
  (select participated_at from public.participations
    where id = (select (result ->> 'participation_id')::uuid
                  from pg_temp.ingest_log where wamid = 'wamid.A1')),
  '2026-06-10T12:00:00Z'::timestamptz,
  'the entry is stamped with the message timestamp, not the moment it was processed');

-- What the event itself records --------------------------------------------------

select is(
  (select jsonb_build_object('status', status::text, 'outcome', outcome,
                             'processed_at_set', processed_at is not null)
     from public.webhook_events where external_id = 'wamid.A1'),
  jsonb_build_object('status', 'DONE', 'outcome', 'recorded', 'processed_at_set', true),
  'a decided event is DONE and says both why and when');

-- '111111111111111' is live at 5c2 and archived at 5c1. An implementation that
-- ignored deleted_at could pick either row; this says which one is correct.
select is(
  (select jsonb_build_object('company', company_id, 'organization', organization_id,
                             'integration_set', integration_id is not null)
     from public.webhook_events where external_id = 'wamid.A1'),
  jsonb_build_object('company', '00000000-0000-0000-0000-0000000005c2'::uuid,
                     'organization', '00000000-0000-0000-0000-0000000005f1'::uuid,
                     'integration_set', true),
  'the event is stamped with the Station its number resolved to, and it is the live row rather than the archived one');

-- The reply, in the same transaction as the entry ---------------------------------

select is((pg_temp.confirmation('wamid.A1')).to_phone, '5511988887777',
          'the reply is addressed to the number WhatsApp delivered, country code and all -- the local form is how we store a phone, not one WhatsApp can reach');
select is((pg_temp.confirmation('wamid.A1')).body,
          'Pronto! Você está participando de Disney. Boa sorte!',
          'a recorded entry is confirmed by name');
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

select is(pg_temp.ingest('wamid.R1', '5511988883333', '#REPETE',
                         '2026-06-10T12:00:00Z') ->> 'status',
          'VALID', 'a repeatable promotion takes the first entry');
select is(pg_temp.ingest('wamid.R2', '5511988883333', '#REPETE',
                         '2026-06-10T13:00:00Z') ->> 'status',
          'TOO_SOON', 'a second entry inside the interval is recorded with the status that says so');
select is((pg_temp.confirmation('wamid.R2')).body,
          'Você já participou há pouco. Sua próxima chance é às 15:00.',
          'the next chance is told in the Station''s own timezone, not the server''s');

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
          'recorded',
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

-- Reprocessing ---------------------------------------------------------------------
--
-- The status predicate is what actually holds the promise, not the unique
-- dedupe_key: a genuinely re-run event would produce a NEW participation and so
-- a new key. An event already DONE is never taken.

select is(
  (select public.ingest_whatsapp_event(id) ->> 'outcome'
     from public.webhook_events where external_id = 'wamid.A1'),
  'skipped',
  'an event already decided is not decided again');
select is(
  (select count(*)::int from public.participations p
     join public.members m on m.id = p.member_id
    where p.promotion_id = '00000000-0000-0000-0000-000000000591'
      and m.phone_normalized = '11988887777'),
  2, 'and the listener who sent it still has exactly the two entries A1 and A2 wrote');

-- No personal data in the audit trail (design spec D2) ------------------------------
--
-- Block 3's rule, and it is absolute. audit_logs is never pruned, whereas
-- webhook_events.payload -- where the phone and the profile name stay -- is
-- cleared after thirty days and is unreadable through any user-scoped client.
-- Every sender above shares the run '98888', and every payload carries the
-- profile name 'Ouvinte Bot'.

select is(
  (select count(*)::int from public.audit_logs
    where action = 'ingest_whatsapp_event'
      and (detail::text like '%98888%' or detail::text like '%Ouvinte Bot%')),
  0, 'no phone number and no WhatsApp profile name reaches audit_logs');

select is(
  (select detail ->> 'wamid' from public.audit_logs
    where action = 'ingest_whatsapp_event'
      and target_id = (select id from public.webhook_events
                        where external_id = 'wamid.A1')),
  'wamid.A1',
  'the audit row names the message it decided, so support can trace one without opening the payload');

select is(
  (select (detail ->> 'participation_id')::uuid from public.audit_logs
    where action = 'ingest_whatsapp_event'
      and target_id = (select id from public.webhook_events
                        where external_id = 'wamid.A1')),
  (select (result ->> 'participation_id')::uuid
     from pg_temp.ingest_log where wamid = 'wamid.A1'),
  'and ties it to the entry it produced, which is the only link between a message and its participation');

select * from finish();
rollback;
