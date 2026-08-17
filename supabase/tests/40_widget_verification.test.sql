begin;
select plan(32);

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
  (organization_id, company_id, purpose, channel, internal_name, name, language, body, variables)
values
  ('00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000202',
   'WEB_VERIFICATION', 'WHATSAPP', 'web_verification', 'web_verification', 'pt_BR',
   'Seu codigo e {{1}}.', array['VERIFICATION_CODE']::public.template_variable[]);

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

-- The ceiling, and what it is actually for. A six-digit code is 10^6, so
-- guessing is only expensive if guessing is limited -- which is the whole
-- reason there is no constant-time comparison anywhere near this (0148's
-- credentials.ts comment gives the general argument; this is the sharp case).
select is(
  public.widget_verify_code('pw_enabledkey012345678901', '+5511999998888',
                            repeat('b', 64)) ->> 'reason',
  'wrong_code', 'a wrong code is refused');

select is(
  (select attempts from public.widget_verifications
    where phone = '+5511999998888' order by created_at desc limit 1),
  1, 'and the attempt is counted');

select lives_ok($$
  select public.widget_verify_code('pw_enabledkey012345678901', '+5511999998888',
                                   repeat('b', 64))
    from generate_series(1, 4)$$,
  'four more wrong guesses are survivable');

select is(
  public.widget_verify_code('pw_enabledkey012345678901', '+5511999998888',
                            repeat('a', 64)) ->> 'reason',
  'too_many_attempts', 'and the RIGHT code is refused once the ceiling is hit');

-- A fresh verification, to prove the happy path and the listener it creates.
select public.widget_request_code('pw_enabledkey012345678901', '+5511999997777',
                                  repeat('c', 64), '654321');

select is(
  public.widget_verify_code('pw_enabledkey012345678901', '+5511999997777',
                            repeat('c', 64), 'Maria Silva') ->> 'ok',
  'true', 'the right code identifies the visitor');

-- Resolved through the 0061 cores, the same three the WhatsApp door and the
-- Block 15 API door use. Nothing new decides who a listener is.
select is(
  (select count(*) from public.member_company_links l
     join public.members m on m.id = l.member_id
    where m.phone_normalized = public.normalize_phone('+5511999997777')
      and l.company_id = '00000000-0000-0000-0000-000000000202'),
  1::bigint, 'the listener exists and is linked to this Station');

select is(
  (select count(*) from public.member_consents c
     join public.members m on m.id = c.member_id
    where m.phone_normalized = public.normalize_phone('+5511999997777')
      and c.consent_type = 'identification'
      and c.origin = 'web-widget'),
  1::bigint, 'and their consent to being identified is on the record');

-- ---------------------------------------------------------------------------
-- THE EXPIRED CODE. Spec Sec.9 names it as one of the six proofs this file owes
-- and it was not asserted anywhere in the repository -- 0161's step 3 could
-- have been deleted and every gate would still have gone green.
--
-- The clock is moved rather than waited on: the TTL is ten minutes and a pgTAP
-- file cannot sleep for it. `expires_at` is an ordinary column, so pushing it
-- an hour into the past is the same state the ten-minute default reaches on
-- its own, reached immediately.
-- ---------------------------------------------------------------------------
select public.widget_request_code('pw_enabledkey012345678901', '+5511999996666',
                                  repeat('d', 64), '111111');

update public.widget_verifications
   set expires_at = now() - interval '1 hour'
 where phone = '+5511999996666';

select is(
  public.widget_verify_code('pw_enabledkey012345678901', '+5511999996666',
                            repeat('d', 64), 'Late Visitor') ->> 'reason',
  'expired', 'a code past its expiry is refused, by name');

-- THE RIGHT hash was presented above, which is what makes this assertion mean
-- something: the expiry is checked in step 3, BEFORE the comparison in step 5,
-- so a correct code that arrived too late identifies nobody. Reversing those
-- two steps would leave this listener created and this case still passing on
-- the reason string alone.
select is(
  (select count(*) from public.members
    where organization_id = '00000000-0000-0000-0000-000000000201'
      and phone_normalized = public.normalize_phone('+5511999996666')),
  0::bigint, 'and nobody was identified by it');

-- ---------------------------------------------------------------------------
-- THE ANONYMISED LISTENER. The other of spec Sec.9's six that nothing asserted:
-- `listener_anonymized` appeared in no test in this repository at all.
-- 0161's step 7 calls it "precisely what the erasure was for", which is the
-- LGPD claim this product makes in docs/SECURITY.md.
--
-- anonymized_at IS SET DIRECTLY, the convention 09_draws and 20_dashboards
-- already use for this column, and here it is more than a convention:
-- anonymize_member (0034, rewritten in 0087) nulls `phone` along with every
-- other identifier, so a listener erased through the product's own door can no
-- longer be FOUND by apply_member_candidates at all and would take the
-- "unknown visitor" path instead. That makes step 7 a guard against a member
-- row carrying anonymized_at with identifiers still on it -- a partial erasure,
-- a hand-repaired row, a future door that scrubs less -- rather than a branch
-- the erasure door reaches today. Which is exactly why it needs a test: it is
-- unreachable from the outside, so nothing but this would notice its removal.
-- ---------------------------------------------------------------------------
update public.members
   set anonymized_at = now()
 where organization_id = '00000000-0000-0000-0000-000000000201'
   and phone_normalized = public.normalize_phone('+5511999997777');

select public.widget_request_code('pw_enabledkey012345678901', '+5511999997777',
                                  repeat('e', 64), '222222');

select is(
  public.widget_verify_code('pw_enabledkey012345678901', '+5511999997777',
                            repeat('e', 64), 'Maria Silva') ->> 'reason',
  'listener_anonymized', 'a listener who exercised erasure is refused, not recreated');

-- Burned anyway, and that is the sharp half. Step 6 stamps consumed_at BEFORE
-- the listener is even looked up, so this refusal is not a retryable failure:
-- the visitor cannot simply present the same six digits again.
-- Named by its digest rather than by the phone: the happy path above already
-- spent one code for this number, so counting every consumed row for it would
-- pass whether this refusal burned anything or not.
select is(
  (select count(*) from public.widget_verifications
    where phone = '+5511999997777'
      and code_hash = repeat('e', 64)
      and consumed_at is not null),
  1::bigint, 'and the code is spent all the same, so it cannot be replayed');

-- Nothing past step 7 ran. The consent count is still the ONE the happy path
-- wrote above -- a second row here would mean fresh activity recorded against
-- somebody who asked to be forgotten, which is the whole thing the branch
-- exists to prevent.
select is(
  (select count(*) from public.member_consents c
     join public.members m on m.id = c.member_id
    where m.anonymized_at is not null
      and c.consent_type = 'identification'),
  1::bigint, 'and no fresh consent was recorded against them');

-- ---------------------------------------------------------------------------
-- widget_frame_context's THIRD refusal cause. Its comment promises one answer
-- for an unknown key, a disabled installation and an ARCHIVED one; the first
-- two are asserted above and the third was not, so `deleted_at is null` could
-- have been dropped from the lookup unnoticed -- and an archived installation
-- that still frames is a hole nothing on any screen would show.
-- ---------------------------------------------------------------------------
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000209', '00000000-0000-0000-0000-000000000201',
   'Station widget verify archived', 'America/Sao_Paulo');
insert into public.widget_installations
  (id, organization_id, company_id, public_key, enabled, allowed_origins, deleted_at)
values
  ('00000000-0000-0000-0000-000000000210',
   '00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000209',
   'pw_archivedkey01234567890', true, array['https://archived.radio.com.br'], now());

select is(
  public.widget_frame_context('pw_archivedkey01234567890'),
  jsonb_build_object('found', false, 'origins', '[]'::jsonb),
  'and so does an archived installation, enabled though it still reads');

-- ---------------------------------------------------------------------------
-- 0164. THE SUSPENDED STATION, and the BLOCKED ORGANIZATION after it.
--
-- Station 000...202 has been answering every door in this file, so suspending
-- it now is a before/after on one fixture rather than a new one: everything
-- else about it -- the installation, the enabled integration, the registered
-- template -- is exactly what it was three assertions ago, so the only thing
-- these refusals can be about is the subscription.
--
-- The column is written directly rather than through suspend_company (0007):
-- that door is gated on a platform-admin session this file has none of, and
-- the doors under test read the COLUMN. 37_organization_blocking.test.sql
-- makes the same split -- it proves block_organization's gate and nothing
-- about what the flag then does.
-- ---------------------------------------------------------------------------
update public.companies
   set status = 'suspended'
 where id = '00000000-0000-0000-0000-000000000202';

select is(
  public.widget_frame_context('pw_enabledkey012345678901'),
  jsonb_build_object('found', false, 'origins', '[]'::jsonb),
  'a suspended Station stops being framable, with no installation edit at all');

-- THE ONE THAT COSTS MONEY. widget_request_code is the endpoint whose own
-- comment says so: every call past it makes Meta bill this Station, which is
-- the Station that stopped paying.
select is(
  public.widget_request_code('pw_enabledkey012345678901', '+5511999995555',
                             repeat('f', 64), '333333') ->> 'reason',
  'unknown_installation', 'and it cannot spend the money it stopped paying for');

select is(
  public.widget_verify_code('pw_enabledkey012345678901', '+5511999995555',
                            repeat('f', 64), 'Suspended Visitor') ->> 'reason',
  'unknown_installation', 'and identifies nobody either');

-- THE CONTROL, without which the three above would pass just as well against a
-- typo in the public key. Nothing is restored except the subscription.
update public.companies
   set status = 'active'
 where id = '00000000-0000-0000-0000-000000000202';

select is(
  public.widget_frame_context('pw_enabledkey012345678901') ->> 'found',
  'true', 'and it comes back the moment the subscription does');

-- Block 16's lock, one level up. suspend_company does not touch this column and
-- block_organization does not touch companies.status, so the two conditions are
-- genuinely independent and each needs its own case.
--
-- suspended_by AND suspension_reason travel with the timestamp because
-- organizations_block_shape (0154) requires the pair -- "a block with no author
-- is a block nobody can be asked about afterwards" -- so a bare `set
-- suspended_at = now()` is refused by the schema, which is what
-- block_organization (0156) writes all three for.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000211', 'widget-blocker@example.test');

update public.organizations
   set suspended_at      = now(),
       suspended_by      = '00000000-0000-0000-0000-000000000211',
       suspension_reason = 'blocked while a widget was live'
 where id = '00000000-0000-0000-0000-000000000201';

select is(
  public.widget_frame_context('pw_enabledkey012345678901'),
  jsonb_build_object('found', false, 'origins', '[]'::jsonb),
  'a blocked Organization stops its Stations being framed');

select is(
  public.widget_request_code('pw_enabledkey012345678901', '+5511999994444',
                             repeat('0', 64), '444444') ->> 'reason',
  'unknown_installation', 'and cannot send a code');

-- The one that is not about money: steps 8, 9 and 10 WRITE. Without this join
-- a blocked Organization went on gaining listeners, links and consents after
-- somebody deliberately blocked it.
select is(
  public.widget_verify_code('pw_enabledkey012345678901', '+5511999994444',
                            repeat('0', 64), 'Blocked Visitor') ->> 'reason',
  'unknown_installation', 'and cannot gain a listener while it is blocked');

select * from finish();
rollback;
