begin;
select plan(12);

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000201', 'Org widget verify');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000201',
   'Station widget verify', 'America/Sao_Paulo');
-- A second Station in the same Org: widget_installations_company_unique (0159)
-- is one installation per Station, so the disabled fixture below needs a
-- Station of its own rather than sharing 000...202 with the enabled one.
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000205', '00000000-0000-0000-0000-000000000201',
   'Station widget verify disabled', 'America/Sao_Paulo');
insert into public.widget_installations
  (id, organization_id, company_id, public_key, enabled, allowed_origins)
values
  ('00000000-0000-0000-0000-000000000203',
   '00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000202',
   'pw_enabledkey012345678901', true, array['https://radio.com.br']);
insert into public.widget_installations
  (id, organization_id, company_id, public_key, enabled, allowed_origins)
values
  ('00000000-0000-0000-0000-000000000204',
   '00000000-0000-0000-0000-000000000201',
   (select id from public.companies where name = 'Station widget verify disabled'),
   'pw_disabledkey01234567890', false, array['https://off.radio.com.br']);

select has_table('public', 'widget_verifications', 'the verification table exists');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'widget_verifications'),
  0::bigint, 'RLS on, no policy, like every other table holding a digest');

-- A raw code where a digest belongs is refused BY SHAPE, the backstop
-- api_credentials_hash_shape (0148) and webhook_events.external_id (0058)
-- already use.
select throws_ok($$
  insert into public.widget_verifications
    (organization_id, company_id, installation_id, phone, code_hash, expires_at)
  values ('00000000-0000-0000-0000-000000000201',
          '00000000-0000-0000-0000-000000000202',
          '00000000-0000-0000-0000-000000000203',
          '+5511999998888', '123456', now() + interval '10 minutes')$$,
  '23514', null, 'a six-digit code written where a sha256 belongs is refused');

-- The Edge middleware asks this, with the anon key, on a document request.
select is(
  public.widget_frame_context('pw_enabledkey012345678901'),
  jsonb_build_object('found', true, 'origins', jsonb_build_array('https://radio.com.br')),
  'an enabled key answers with its origins');

-- THE REFUSAL IS THE DEFAULT BRANCH. A disabled installation, an unknown key
-- and a deleted one all reach the same answer, and the middleware turns that
-- into frame-ancestors 'none' plus a 404.
select is(
  public.widget_frame_context('pw_disabledkey01234567890'),
  jsonb_build_object('found', false, 'origins', '[]'::jsonb),
  'a disabled installation answers as if it did not exist');

select is(
  public.widget_frame_context('pw_nosuchkey0123456789012'),
  jsonb_build_object('found', false, 'origins', '[]'::jsonb),
  'and so does a key nobody ever issued');

-- D5 rejected a session table because it would carry a retention obligation.
-- A verifications table that holds a phone number and is never swept is that
-- same obligation, unmet.
select ok(
  (select prosrc from pg_proc where proname = 'sweep_retention')
    like '%widget_verifications%',
  'the retention sweep deletes verification rows too');

-- A Station with no WhatsApp integration cannot send anything, and saying so
-- here is what stops the console showing an enabled widget that silently never
-- delivers a code.
select is(
  public.widget_request_code('pw_enabledkey012345678901', '+5511999998888',
                             repeat('a', 64), '123456') ->> 'reason',
  'no_integration', 'without a WhatsApp integration the door refuses, by name');

-- A Station of its own (widget_installations_company_unique, 0159, is one
-- installation per Station) with an integration that EXISTS but is switched
-- off. The door's own comment on this lookup says the two collapse to the
-- same reason on purpose; this is what proves it rather than just asserting
-- the fixture-free case above.
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000206', '00000000-0000-0000-0000-000000000201',
   'Station widget verify integration disabled', 'America/Sao_Paulo');
insert into public.widget_installations
  (id, organization_id, company_id, public_key, enabled, allowed_origins)
values
  ('00000000-0000-0000-0000-000000000207',
   '00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000206',
   'pw_intdisabledkey01234567', true, array['https://radio-int-disabled.com.br']);
insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, waba_id, display_phone_number, enabled)
values
  ('00000000-0000-0000-0000-000000000208',
   '00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000206',
   'WHATSAPP', '111222444', '444555777', '+551130000001', false);

select is(
  public.widget_request_code('pw_intdisabledkey01234567', '+5511999998888',
                             repeat('a', 64), '123456') ->> 'reason',
  'no_integration', 'and a switched-off integration answers exactly like an absent one');

-- enabled explicitly true: it defaults to false (0057, "a half-configured row
-- cannot start taking traffic"), and enqueue_whatsapp_outbound refuses a
-- disabled integration outright ("integration not found or switched off"),
-- which the door being tested does not itself pre-check.
insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, waba_id, display_phone_number, enabled)
values
  ('00000000-0000-0000-0000-000000000205',
   '00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000202',
   'WHATSAPP', '111222333', '444555666', '+551130000000', true);

select is(
  public.widget_request_code('pw_enabledkey012345678901', '+5511999998888',
                             repeat('a', 64), '123456') ->> 'reason',
  'no_template', 'and without an approved template it still refuses, differently');

insert into public.message_templates
  (organization_id, company_id, purpose, name, language, body, variables)
values
  ('00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000202',
   'WEB_VERIFICATION', 'web_verification', 'pt_BR',
   'Seu codigo e {{1}}.', '["code"]'::jsonb);

select is(
  public.widget_request_code('pw_enabledkey012345678901', '+5511999998888',
                             repeat('a', 64), '123456') ->> 'ok',
  'true', 'with both in place the code is enqueued');

-- The message left through the outbox rather than from the request path (D8):
-- outbox_messages already carries the dedupe key that collapses a double click,
-- already has the retention story for a phone number in the clear, and already
-- retries.
select is(
  (select count(*) from public.outbox_messages
    where template_name = 'web_verification'),
  1::bigint, 'and it left as a template row on the existing outbox');

select * from finish();
rollback;
