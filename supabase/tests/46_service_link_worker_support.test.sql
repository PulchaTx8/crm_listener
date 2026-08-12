begin;
select plan(13);

-- Block 19a, Task 5, fix round 1 (Important #3). 0181 shipped a SECURITY
-- DEFINER door and widened a privilege whitelist with no pgTAP assertion of
-- its own -- it is in no plan and Task 9 only runs suites, so nothing later
-- in this block would ever have covered it. This file is that coverage:
-- widget_link_send_context's grant and its four refusal causes (unknown, no
-- installation, suspended Station, blocked Organization -- 0164), the shape
-- of its answer, and finish_whatsapp_turn's two new outcomes.

-- ---------------------------------------------------------------------------
-- Fixtures. A fresh company per refusal cause, following 44_service_hashtags
-- and 45_widget_link_tokens: each scenario is its own row, so flipping one
-- company's status cannot bleed into another assertion run later in the same
-- transaction.
-- ---------------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000900', 'Org service link support'),
  ('00000000-0000-0000-0000-000000000910', 'Org service link support (blocked)');

-- suspended_by AND suspension_reason travel with the timestamp:
-- organizations_block_shape (0154) requires the pair, the same fixture shape
-- 40_widget_verification.test.sql:368-375 uses to block an Organization.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000913', 'service-link-blocker@example.test');

update public.organizations
   set suspended_at      = now(),
       suspended_by      = '00000000-0000-0000-0000-000000000913',
       suspension_reason = 'blocked for 46_service_link_worker_support fixtures'
 where id = '00000000-0000-0000-0000-000000000910';

insert into public.companies (id, organization_id, name, timezone, status) values
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000900',
   'Station A (active, has installation)', 'America/Sao_Paulo', 'active'),
  ('00000000-0000-0000-0000-000000000903', '00000000-0000-0000-0000-000000000900',
   'Station B (active, no installation)', 'America/Sao_Paulo', 'active'),
  ('00000000-0000-0000-0000-000000000904', '00000000-0000-0000-0000-000000000900',
   'Station C (active, installation disabled)', 'America/Sao_Paulo', 'active'),
  ('00000000-0000-0000-0000-000000000906', '00000000-0000-0000-0000-000000000900',
   'Station D (suspended)', 'America/Sao_Paulo', 'suspended'),
  ('00000000-0000-0000-0000-000000000911', '00000000-0000-0000-0000-000000000910',
   'Station E (active, but its Organization is blocked)', 'America/Sao_Paulo', 'active');

insert into public.widget_installations (id, organization_id, company_id, public_key, enabled) values
  ('00000000-0000-0000-0000-000000000902', '00000000-0000-0000-0000-000000000900',
   '00000000-0000-0000-0000-000000000901', 'pw_9010000011112222333344', true),
  ('00000000-0000-0000-0000-000000000905', '00000000-0000-0000-0000-000000000900',
   '00000000-0000-0000-0000-000000000904', 'pw_9040000011112222333344', false),
  ('00000000-0000-0000-0000-000000000907', '00000000-0000-0000-0000-000000000900',
   '00000000-0000-0000-0000-000000000906', 'pw_9060000011112222333344', true),
  ('00000000-0000-0000-0000-000000000912', '00000000-0000-0000-0000-000000000910',
   '00000000-0000-0000-0000-000000000911', 'pw_9120000011112222333344', true);

-- ---------------------------------------------------------------------------
-- 1-3. The grant. Same shape 08_conversation.test.sql:597-609 already pins
-- for finish_whatsapp_turn: a positive for service_role, negatives for the
-- two roles that must never reach a door built around a listener's own
-- Station.
-- ---------------------------------------------------------------------------
select ok(not has_function_privilege('anon',
            'public.widget_link_send_context(uuid)', 'EXECUTE'),
          'an anonymous visitor may not resolve a Station''s public key this way');

select ok(not has_function_privilege('authenticated',
            'public.widget_link_send_context(uuid)', 'EXECUTE'),
          'nor may a signed-in operator: this door belongs to the worker');

select ok(has_function_privilege('service_role',
            'public.widget_link_send_context(uuid)', 'EXECUTE'),
          'the worker may call it');

-- ---------------------------------------------------------------------------
-- 4. Unknown company / no installation at all.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select public.widget_link_send_context('00000000-0000-0000-0000-000000000903')$$,
  'P0002', 'this Station has no live widget installation',
  'a company with no installation at all refuses P0002');

-- ---------------------------------------------------------------------------
-- 5. An installation that exists but was switched off.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select public.widget_link_send_context('00000000-0000-0000-0000-000000000904')$$,
  'P0002', 'this Station has no live widget installation',
  'a disabled installation refuses the same way');

-- ---------------------------------------------------------------------------
-- 6. Fix round 1 (Important #5, 0164): a SUSPENDED Station, installation
-- enabled and all.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select public.widget_link_send_context('00000000-0000-0000-0000-000000000906')$$,
  'P0002', 'this Station has no live widget installation',
  'a SUSPENDED Station refuses too, even with an enabled installation');

-- ---------------------------------------------------------------------------
-- 7. Fix round 1 (Important #5, 0164): a BLOCKED Organization.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select public.widget_link_send_context('00000000-0000-0000-0000-000000000911')$$,
  'P0002', 'this Station has no live widget installation',
  'and so does a BLOCKED Organization, even for a Station of its own that is active');

-- ---------------------------------------------------------------------------
-- 8-9. The answer's shape: the live installation's own public_key, and this
-- Station's own wording for ONLY the text it overrode (D2's per-text rule --
-- the same property 18_templates.test.sql:754-760 already pins for
-- whatsapp_prompt_context).
-- ---------------------------------------------------------------------------
insert into public.station_message_templates (organization_id, company_id, key, body) values
  ('00000000-0000-0000-0000-000000000900', '00000000-0000-0000-0000-000000000901',
   'LINK_MUSIC', 'Bora pedir agora!');

select is(
  public.widget_link_send_context('00000000-0000-0000-0000-000000000901') ->> 'publicKey',
  'pw_9010000011112222333344',
  'the answer carries the live installation''s own public_key');

select is(
  public.widget_link_send_context('00000000-0000-0000-0000-000000000901') -> 'systemMessages',
  '{"LINK_MUSIC": "Bora pedir agora!"}'::jsonb,
  'and ONLY the text this Station overrode -- not LINK_MENU or LINK_PROMOTION, which it never touched');

-- ---------------------------------------------------------------------------
-- 10-13. finish_whatsapp_turn's two new outcomes (fix round 1's own whitelist
-- widening). A minimal real event per outcome, not just "does not throw":
-- proving the row actually lands DONE with that outcome is what
-- 08_conversation.test.sql's own throws_ok assertion for the REFUSED case
-- cannot show for the ACCEPTED ones.
-- ---------------------------------------------------------------------------
-- webhook_events_claim_shape requires claimed_at whenever status is
-- PROCESSING, the shape ingest_whatsapp_event's own claim leaves a row in.
insert into public.webhook_events (id, provider, external_id, status, claimed_at) values
  ('00000000-0000-0000-0000-00000000a001', 'WHATSAPP', repeat('a', 64), 'PROCESSING', now()),
  ('00000000-0000-0000-0000-00000000a002', 'WHATSAPP', repeat('b', 64), 'PROCESSING', now());

select is(
  public.finish_whatsapp_turn('00000000-0000-0000-0000-00000000a001', 'link_sent') ->> 'outcome',
  'link_sent',
  'finish_whatsapp_turn now accepts link_sent');

select is(
  (select status::text from public.webhook_events
    where id = '00000000-0000-0000-0000-00000000a001'),
  'DONE',
  'and actually closes the event DONE with it, not just returning without an error');

select is(
  public.finish_whatsapp_turn('00000000-0000-0000-0000-00000000a002', 'already_answered') ->> 'outcome',
  'already_answered',
  'and now accepts already_answered');

select is(
  (select status::text from public.webhook_events
    where id = '00000000-0000-0000-0000-00000000a002'),
  'DONE',
  'closing that event DONE too');

select * from finish();
rollback;
