begin;
select plan(28);

-- Block 19a (D6). The two hashtags a Station configures, and the door that
-- writes them: set_service_hashtags. Fixtures follow 39_widget_installations
-- (one Organization, one Station, one installation) and 43_shows (a role that
-- actually holds the permission, checked inside the function's own body
-- rather than only by RLS).
--
-- THREE STATIONS. A holds the installation everything is written to. B holds
-- a live promotion whose hashtag exists only to prove assertion 7: a hashtag
-- belongs to a Station, so the same tag at B must never block a write at A.
-- C holds neither an installation nor a promotion -- it exists only to prove
-- assertion 9, that a Station nobody has configured a widget for is refused
-- rather than silently updating zero rows.
--
-- FOUR PROMOTIONS AT A. One live now (#EUQUERO), one already ENDED
-- (#ACABOU), and one that has NOT STARTED YET (#EMBREVE) -- fix round 1's
-- ruling on Finding 1: the clash predicate is `ends_at > now()`, so an ended
-- promotion no longer shadows a Station hashtag (0040's own trade, applied
-- here: forbidding reuse forever is worse than the collision it prevents) but
-- an unstarted one still does, because the day it opens it silently takes the
-- word. #SORTEIO belongs to Station B.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000601', 'Org service hashtags');

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-000000000601',
   'Station A hashtags', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-000000000601',
   'Station B hashtags', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-000000000604', '00000000-0000-0000-0000-000000000601',
   'Station C hashtags (no installation)', 'America/Sao_Paulo');

insert into public.widget_installations (id, organization_id, company_id, public_key) values
  ('00000000-0000-0000-0000-000000000606', '00000000-0000-0000-0000-000000000601',
   '00000000-0000-0000-0000-000000000602', 'pw_9999888877776666555544');

insert into public.promotions
  (organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
values
  -- Station A, live right now.
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000602',
   'Promo Station A live', now() - interval '1 day', now() + interval '30 days', true, '#EUQUERO'),
  -- Station A, ended weeks ago -- must NOT clash (Finding 1).
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000602',
   'Promo Station A ended', now() - interval '40 days', now() - interval '10 days', true, '#ACABOU'),
  -- Station A, opens next week -- must still clash (Finding 1's narrower ruling).
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000602',
   'Promo Station A future', now() + interval '10 days', now() + interval '40 days', true, '#EMBREVE'),
  -- Station B, live right now -- the tenancy fixture for assertion 7.
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000603',
   'Promo Station B live', now() - interval '1 day', now() + interval '30 days', true, '#SORTEIO');

-- A CALLER WITH templates.manage AT A AND AT C -- not at B, because no
-- assertion ever calls the door for B; B only supplies the "another
-- Station's" promotion assertion 7 needs.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000000607', '00000000-0000-0000-0000-000000000601', 'Templates Manager');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000000607', 'templates.manage');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000608', 'service-hashtags-probe@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000000608', '00000000-0000-0000-0000-000000000602',
   '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000607'),
  ('00000000-0000-0000-0000-000000000608', '00000000-0000-0000-0000-000000000604',
   '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000607');

-- A SECOND CALLER, holding templates.view ALONE at A and at C -- Task 8's
-- read door (0182, service_hashtags_for) is gated on that code, not on
-- templates.manage, and 608 above is the fixture that proves the two are not
-- interchangeable: 608 holds manage but never view.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000000610', '00000000-0000-0000-0000-000000000601', 'Templates Viewer');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000000610', 'templates.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000611', 'service-hashtags-viewer@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000000611', '00000000-0000-0000-0000-000000000602',
   '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000610'),
  ('00000000-0000-0000-0000-000000000611', '00000000-0000-0000-0000-000000000604',
   '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000610');

-- ---------------------------------------------------------------------------
-- 2. No session yet, so has_permission is false and the door refuses before
--    touching a row -- the same shape 39_widget_installations proves for
--    upsert_widget_installation. Run first, deliberately: every assertion
--    after this one needs the authorized session, and this is the one
--    assertion that needs its absence.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#Teste', '#Teste2')
$$, '42501', null, 'a caller without templates.manage is refused');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000608", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- 1. The ordinary write. Both columns land, in one call.
-- ---------------------------------------------------------------------------
select public.set_service_hashtags(
  '00000000-0000-0000-0000-000000000602', '#Testando', '#Ajuda');

-- RLS on widget_installations is on with NO POLICY (0159's own comment), so
-- reading the row back to check it -- rather than through a door, since this
-- task creates none -- has to happen outside the `authenticated` role, the
-- same way 39_widget_installations reads the table directly only after a
-- `reset role`.
reset role;

select is(
  (select coalesce(music_hashtag, '<null>') || ':' || coalesce(service_hashtag, '<null>')
     from public.widget_installations
    where company_id = '00000000-0000-0000-0000-000000000602'),
  '#Testando:#Ajuda',
  'set_service_hashtags writes both columns');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000608", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- 3-4. Fix round 1, Finding 2. The CHECK constraints still exist (assertion
--      below this pair proves they still fire for a writer that bypasses the
--      door), but the door validates first and raises its own readable
--      22023 -- Task 8's screen has nothing usable to show for a raw
--      "violates check constraint widget_installations_hashtag_shape".
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', 'SemCerquilha', '#Ajuda2')
$$, '22023', null, 'a hashtag not matching the shape is refused, with a readable sentence');

select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#Igual', '#IGUAL')
$$, '22023', null, 'the two hashtags being equal, ignoring case, is refused, with a readable sentence');

-- ---------------------------------------------------------------------------
-- The backstop. A writer that is not this door -- a migration, a console
-- tool nobody has built yet -- still meets widget_installations_hashtag_shape
-- head-on: a direct UPDATE, no session, and the native 23514 the door no
-- longer lets an operator see.
-- ---------------------------------------------------------------------------
reset role;

select throws_ok($$
  update public.widget_installations
     set music_hashtag = 'NoHash'
   where company_id = '00000000-0000-0000-0000-000000000602'
$$, '23514', null, 'and the CHECK constraint still bites a direct write that bypasses the door');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000608", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- Finding 3. '' is "clear this field", the same as it already was before
-- this fix round -- the new shape validation must not turn an empty string
-- into a bad-shape refusal, because nullif() folds it to NULL before either
-- check runs.
-- ---------------------------------------------------------------------------
select public.set_service_hashtags(
  '00000000-0000-0000-0000-000000000602', '', '#Valido');

reset role;

select is(
  (select coalesce(music_hashtag, '<null>') || ':' || coalesce(service_hashtag, '<null>')
     from public.widget_installations
    where company_id = '00000000-0000-0000-0000-000000000602'),
  '<null>:#Valido',
  'an empty string clears music_hashtag rather than being refused as a bad shape');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000608", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- 5-6. A LIVE promotion's hashtag wins the match (D3), so a Station hashtag
--      equal to one would never answer. Refused by the function's own
--      explicit raise, hence 22023 -- and refused whichever case it is typed
--      in, because the promotion above was stored as '#EUQUERO'.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#EUQUERO', '#Outro')
$$, '22023', null, 'a hashtag equal to a LIVE promotion''s hashtag at that Station is refused');

select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#Euquero', '#Outro2')
$$, '22023', null, 'and the comparison ignores case');

-- ---------------------------------------------------------------------------
-- Fix round 1, Finding 1. #ACABOU ended ten days ago: ingest_whatsapp_event
-- (0062) only ever matches a promotion inside its own window, so an ended
-- one can never have shadowed the Station's hashtag, and refusing it would
-- forbid reusing the word forever -- exactly what 0040 already refused for
-- promotion-vs-promotion.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#ACABOU', '#Extra')
$$, 'a hashtag equal to an ENDED promotion''s hashtag is accepted');

-- ---------------------------------------------------------------------------
-- Fix round 1, Finding 1's narrower ruling. #EMBREVE opens in ten days: it
-- has not started, but the day it does it takes the tag, and the Station's
-- hashtag would go quiet with nothing on any screen saying why -- so this
-- still clashes even though the promotion is not live YET.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#EMBREVE', '#Extra2')
$$, '22023', null, 'a hashtag equal to a promotion that has not started yet is refused');

-- ---------------------------------------------------------------------------
-- 7. A hashtag belongs to a Station. #SORTEIO is Station B's live promotion,
--    scoped out of the clash query by company_id, so Station A may use it.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#SORTEIO', '#Premio')
$$, 'a hashtag equal to a promotion''s at another Station is accepted');

-- ---------------------------------------------------------------------------
-- 8. NULL clears a column. A known baseline is written first so this
--    assertion does not depend on whatever the previous one happened to
--    leave behind; service_hashtag is then passed back UNCHANGED to prove
--    clearing music_hashtag is not treated as a collision with the value
--    already sitting in the row it is writing to.
-- ---------------------------------------------------------------------------
select public.set_service_hashtags(
  '00000000-0000-0000-0000-000000000602', '#Base', '#BaseService');

select public.set_service_hashtags(
  '00000000-0000-0000-0000-000000000602', null, '#BaseService');

reset role;

select is(
  (select coalesce(music_hashtag, '<null>') || ':' || coalesce(service_hashtag, '<null>')
     from public.widget_installations
    where company_id = '00000000-0000-0000-0000-000000000602'),
  '<null>:#BaseService',
  'null clears a column, and clearing is not a collision with itself');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000608", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- 9. Station C holds templates.manage for this same caller and NO
--    installation row. The UPDATE matches nothing; the door raises P0002
--    rather than reporting success over zero rows written.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000604', '#Novo', '#Novo2')
$$, 'P0002', null, 'a Station with no installation is refused, not a silent no-op');

reset role;

-- ---------------------------------------------------------------------------
-- Task 8 (0182). service_hashtags_for, the read door Task 8's screen calls
-- because widget_installations carries RLS with no policy and its ACL
-- revoked (0159): nothing outside a SECURITY DEFINER body may read these two
-- columns, not even the service client.
-- ---------------------------------------------------------------------------

-- A known state to read back, written by 608 (templates.manage). Neither
-- word clashes with any promotion this file has inserted.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000608", "role": "authenticated"}';

select public.set_service_hashtags(
  '00000000-0000-0000-0000-000000000602', '#Musica', '#Atendimento');

-- templates.manage is not templates.view: 608 holds only the former (role
-- 607's sole code) at A, and the read door refuses it exactly the way the
-- write door refuses a caller holding neither.
select throws_ok($$
  select public.service_hashtags_for('00000000-0000-0000-0000-000000000602')
$$, '42501', null, 'a caller holding templates.manage but not templates.view is refused by the read door');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000611", "role": "authenticated"}';

-- And returns exactly what set_service_hashtags wrote, for a caller who
-- holds templates.view.
select is(
  public.service_hashtags_for('00000000-0000-0000-0000-000000000602'),
  jsonb_build_object('installed', true, 'music', '#Musica', 'service', '#Atendimento'),
  'service_hashtags_for returns what set_service_hashtags wrote');

-- Station C: 611 holds templates.view there too, and there is no
-- installation row at all -- installed:false, not an error, which is the
-- state Task 8's screen renders as the two fields disabled with the reason.
select is(
  public.service_hashtags_for('00000000-0000-0000-0000-000000000604'),
  jsonb_build_object('installed', false, 'music', null, 'service', null),
  'service_hashtags_for answers installed:false for a Station with no installation');

reset role;

-- ---------------------------------------------------------------------------
-- 10-14. Block 19a, Task 3 (D3): ingest_whatsapp_event (0179) answers a
-- hashtag with a LINK rather than opening a conversation. Fixtures below give
-- Station A a live integration, both service hashtags switched on, and a
-- second promotion carrying rules text; assertions 11-14 exercise the ingest
-- door itself, not this file's own set_service_hashtags.
-- ---------------------------------------------------------------------------

-- The installation defaults to enabled = false (0159): nobody has "switched
-- on" the widget yet, which is exactly the state every assertion above ran
-- in. The ingest's music/service match requires it, the same way its
-- WhatsApp match already requires integrations.enabled.
update public.widget_installations
   set enabled = true
 where id = '00000000-0000-0000-0000-000000000606';

insert into public.integrations
  (organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000602',
   'WHATSAPP', '444444444444444', true);

-- A LIVE promotion carrying rules text, so it can finish as a link (D4)
-- rather than no_rules -- and web_enabled is left at its default FALSE,
-- which is the exact case assertion 13 exists to pin: sending the hashtag is
-- asking to take part, whether or not the widget's own list would ever have
-- shown it.
--
-- IT ASKS FOR ONE FIELD, and that is Block 30d (D8, 0267) rather than
-- decoration: a promotion with nothing left to ask of the listener is now
-- ENTERED the moment the hashtag arrives, answering `recorded` and carrying no
-- purpose or promotion_id at all -- so without a requested field the assertion
-- below would stop testing the match order it was written for. `city` and not
-- `full_name`, because apply_member_creation fills full_name from the WhatsApp
-- profile name and a newcomer would satisfy that one immediately. The fast
-- path itself is covered by supabase/tests/73_fast_entry.test.sql.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, rules, requested_fields)
values
  ('00000000-0000-0000-0000-000000000609', '00000000-0000-0000-0000-000000000601',
   '00000000-0000-0000-0000-000000000602', 'Promo Station A com regras',
   now() - interval '1 day', now() + interval '30 days',
   true, '#GANHEJA', 'Regulamento completo desta promocao.', '{city}');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000608", "role": "authenticated"}';

select public.set_service_hashtags(
  '00000000-0000-0000-0000-000000000602', '#TOCAAGORA', '#MENUAJUDA');

reset role;

-- A helper so each case below is one call, following 06_whatsapp's own
-- pg_temp.ingest: the INSERT has to live inside a function body, because a
-- WITH containing a data-modifying statement is refused outside the top
-- level of a query, and `select is(...)` makes this one an argument, not a
-- top level.
create or replace function pg_temp.ingest_hashtag(
  p_wamid text, p_from text, p_text text)
returns jsonb language plpgsql as $$
declare v_id uuid;
begin
  insert into public.webhook_events (provider, external_id, payload)
  values ('WHATSAPP', encode(sha256(convert_to(p_wamid, 'UTF8')), 'hex'),
    jsonb_build_object(
      'metadata',     jsonb_build_object('phone_number_id', '444444444444444'),
      'from',         p_from, 'profile_name', 'Ouvinte Hashtag',
      'timestamp',    extract(epoch from now())::bigint::text,
      'text',         p_text))
  returning id into v_id;

  return public.ingest_whatsapp_event(v_id);
end $$;

-- ---------------------------------------------------------------------------
-- 11. The music hashtag, matched only after every live promotion has missed.
-- ---------------------------------------------------------------------------
select is(
  (select jsonb_build_object('outcome', r ->> 'outcome', 'purpose', r ->> 'purpose')
     from (select pg_temp.ingest_hashtag(
             'wamid.SVC-MUSIC', '5511977776001', '#TOCAAGORA') as r) s),
  jsonb_build_object('outcome', 'link', 'purpose', 'MUSIC'),
  'a message carrying the music hashtag returns outcome link with purpose MUSIC');

-- ---------------------------------------------------------------------------
-- 11b. Carried from an earlier review. `phone` on a link intent must be the
-- phone AS WHATSAPP DELIVERED IT -- with the country code -- and never the
-- LOCAL form whatsapp_local_phone strips it to for member lookups. D7's own
-- contract (src/lib/conversation/store.ts) keys every live conversation row
-- on the delivered form, so a caller that read the local form here would
-- miss that row for essentially every Brazilian number -- the one
-- population whose local and delivered forms actually differ -- and hand a
-- listener mid-conversation a link instead of having their answer read.
-- Fix round 1's Critical finding was exactly this field silently reverting
-- to the local form (0179's own comment on the 'link' branch tells the full
-- story); until now only a TypeScript test guarded the contract, one layer
-- above where it can actually revert.
-- ---------------------------------------------------------------------------
select is(
  (select r ->> 'phone'
     from (select pg_temp.ingest_hashtag(
             'wamid.SVC-PHONE', '5511977776005', '#TOCAAGORA') as r) s),
  '5511977776005',
  'a link intent''s phone is the DELIVERED form (with the country code), never the local form the conversation store is not keyed on');

-- ---------------------------------------------------------------------------
-- 12. The service hashtag, matched last of the three (D3).
-- ---------------------------------------------------------------------------
select is(
  (select r ->> 'purpose'
     from (select pg_temp.ingest_hashtag(
             'wamid.SVC-MENU', '5511977776002', '#MENUAJUDA') as r) s),
  'MENU',
  'a message carrying the service hashtag returns purpose MENU');

-- ---------------------------------------------------------------------------
-- 13. A LIVE promotion's hashtag still wins the match ahead of both Station
--     hashtags, and names its own promotion -- even though web_enabled is
--     FALSE on this fixture (D4): web_enabled governs only the widget's own
--     list, not whether the hashtag itself answers.
-- ---------------------------------------------------------------------------
select is(
  (select jsonb_build_object('outcome', r ->> 'outcome', 'purpose', r ->> 'purpose',
                             'promotion_id', (r ->> 'promotion_id')::uuid)
     from (select pg_temp.ingest_hashtag(
             'wamid.SVC-PROMO', '5511977776003', '#GANHEJA') as r) s),
  jsonb_build_object('outcome', 'link', 'purpose', 'PROMOTION',
                     'promotion_id', '00000000-0000-0000-0000-000000000609'::uuid),
  'a message carrying a LIVE promotion''s hashtag returns purpose PROMOTION with that promotion''s id, even though web_enabled is false (D4)');

-- ---------------------------------------------------------------------------
-- 14. A matched promotion with no rules text finishes as no_rules and sends
--     no link -- #EUQUERO (assertion 1's own fixture) never had rules
--     written, which is the ordinary state for a promotion 17c never touched.
-- ---------------------------------------------------------------------------
select is(
  (select jsonb_build_object('outcome', r ->> 'outcome', 'has_link', r ? 'purpose')
     from (select pg_temp.ingest_hashtag(
             'wamid.SVC-NORULES', '5511977776004', '#EUQUERO') as r) s),
  jsonb_build_object('outcome', 'no_rules', 'has_link', false),
  'a promotion with no rules text returns outcome no_rules, and no link');

-- ---------------------------------------------------------------------------
-- 15-21. Final review fix wave, Important #1. Before this fix, a promotion
-- hashtag matched with no live installation to answer through anyway
-- reached outcome 'link' -- widget_link_send_context then raised P0002,
-- sendServiceLink rethrew, and the event burned all six retry rungs and
-- parked FAILED, for a configuration (a Station with WhatsApp and a
-- hashtagged promotion but no widget installation) that is the ORDINARY
-- starting state, not an exotic one. MUSIC and MENU were already safe from
-- an ABSENT or a DISABLED installation -- their match is structurally
-- impossible without v_install's own columns populated -- but not from a
-- SUSPENDED Station: the ingest's own v_install lookup carried no join to
-- companies/organizations before this fix, so a still-enabled row was found
-- anyway and a general hashtag reached 'link' too. All three states are
-- proven here, for all three hashtags, and every one of the nine
-- combinations answers silently with a named outcome, never 'link'.
-- ---------------------------------------------------------------------------

-- Station D: no widget_installations row at all -- the state every Station
-- starts in, since creating one is a separate console act (0159).
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000612', '00000000-0000-0000-0000-000000000601',
   'Station D hashtags (absent installation)', 'America/Sao_Paulo');

insert into public.integrations
  (organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000612',
   'WHATSAPP', '444444444444446', true);

-- IT ASKS FOR ONE FIELD, and that is what makes the assertion below about the
-- no_installation gate at all. Since Block 30d (D8, 0267, fix round 1) the
-- fast path sits ABOVE that gate, because the gate exists for the LINK and the
-- fast path mints none: a listener with nothing left to answer is entered here
-- and never reaches it. What still needs the widget -- a promotion asking for
-- a field this listener has not got -- is what still meets it, and that is the
-- case this fixture is for. `city` and not `full_name`, because
-- apply_member_creation fills full_name from the WhatsApp profile name and a
-- newcomer would satisfy that one on arrival. The entering-without-an-
-- installation half is covered by supabase/tests/73_fast_entry.test.sql.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, rules, requested_fields)
values
  ('00000000-0000-0000-0000-000000000613', '00000000-0000-0000-0000-000000000601',
   '00000000-0000-0000-0000-000000000612', 'Promo Station D sem widget',
   now() - interval '1 day', now() + interval '30 days',
   true, '#SEMWIDGET', 'Regulamento da promocao sem widget.', '{city}');

-- A second helper, taking the phone_number_id as an argument: Station D's
-- integration is a different row from Station A's, and pg_temp.ingest_hashtag
-- above hard-codes A's.
create or replace function pg_temp.ingest_hashtag_at(
  p_number text, p_wamid text, p_from text, p_text text)
returns jsonb language plpgsql as $$
declare v_id uuid;
begin
  insert into public.webhook_events (provider, external_id, payload)
  values ('WHATSAPP', encode(sha256(convert_to(p_wamid, 'UTF8')), 'hex'),
    jsonb_build_object(
      'metadata',     jsonb_build_object('phone_number_id', p_number),
      'from',         p_from, 'profile_name', 'Ouvinte Hashtag',
      'timestamp',    extract(epoch from now())::bigint::text,
      'text',         p_text))
  returning id into v_id;

  return public.ingest_whatsapp_event(v_id);
end $$;

-- 15. Absent installation, a live promotion's own hashtag: no_installation,
--     never the 'link' outcome that used to reach widget_link_send_context
--     and park the event.
select is(
  (select r ->> 'outcome'
     from (select pg_temp.ingest_hashtag_at(
             '444444444444446', 'wamid.D-PROMO', '5511977776010', '#SEMWIDGET') as r) s),
  'no_installation',
  'a live promotion''s hashtag at a Station with no widget installation at all answers no_installation, not link');

-- 16. Absent installation, a word that names no promotion: falls through to
--     the diagnostic exactly as it did before this fix -- MUSIC and MENU
--     were never reachable here in the first place.
select is(
  (select r ->> 'outcome'
     from (select pg_temp.ingest_hashtag_at(
             '444444444444446', 'wamid.D-GENERIC', '5511977776011', '#QUALQUERCOISA') as r) s),
  'no_promotion',
  'a non-promotion hashtag at a Station with no installation at all falls through silently, unchanged by this fix');

-- Station A's own installation, DISABLED. #GANHEJA (609) is still live and
-- still carries rules; #TOCAAGORA/#MENUAJUDA are still stored on the row,
-- just unreachable while enabled is false.
update public.widget_installations
   set enabled = false
 where id = '00000000-0000-0000-0000-000000000606';

-- 17. Disabled installation, the promotion hashtag: no_installation.
select is(
  (select r ->> 'outcome'
     from (select pg_temp.ingest_hashtag(
             'wamid.DIS-PROMO', '5511977776012', '#GANHEJA') as r) s),
  'no_installation',
  'a live promotion''s hashtag at a Station whose installation is disabled answers no_installation');

-- 18. Disabled installation, the music hashtag: no_promotion, exactly as
--     spec section 7 promises -- structurally unreachable, before and after
--     this fix.
select is(
  (select r ->> 'outcome'
     from (select pg_temp.ingest_hashtag(
             'wamid.DIS-MUSIC', '5511977776013', '#TOCAAGORA') as r) s),
  'no_promotion',
  'the music hashtag at a Station whose installation is disabled falls through to no_promotion, silently');

-- Station A's installation, RE-ENABLED, and the Station itself SUSPENDED --
-- the state the ingest's own v_install lookup could not previously tell
-- apart from a live one: enabled stayed true, and nothing joined companies
-- before this fix, so this is the one row of the three states above that a
-- fix scoped only to the PROMOTION branch would not have covered for MUSIC
-- and MENU.
update public.widget_installations
   set enabled = true
 where id = '00000000-0000-0000-0000-000000000606';
update public.companies
   set status = 'suspended'
 where id = '00000000-0000-0000-0000-000000000602';

-- 19. Suspended Station, the promotion hashtag: no_installation.
select is(
  (select r ->> 'outcome'
     from (select pg_temp.ingest_hashtag(
             'wamid.SUSP-PROMO', '5511977776014', '#GANHEJA') as r) s),
  'no_installation',
  'a live promotion''s hashtag at a SUSPENDED Station answers no_installation, not link');

-- 20. Suspended Station, the music hashtag: no_promotion -- reachable ONLY
--     because of this fix's join to companies; before it, v_install was
--     found anyway (enabled stayed true) and this hashtag reached 'link'.
select is(
  (select r ->> 'outcome'
     from (select pg_temp.ingest_hashtag(
             'wamid.SUSP-MUSIC', '5511977776015', '#TOCAAGORA') as r) s),
  'no_promotion',
  'the music hashtag at a SUSPENDED Station falls through to no_promotion, silently, now that v_install joins companies');

-- 21. Suspended Station, the service hashtag: same answer, same reason.
select is(
  (select r ->> 'outcome'
     from (select pg_temp.ingest_hashtag(
             'wamid.SUSP-MENU', '5511977776016', '#MENUAJUDA') as r) s),
  'no_promotion',
  'the service hashtag at a SUSPENDED Station falls through to no_promotion, silently, now that v_install joins companies');

-- Left active: nothing after this point in the file depends on Station A
-- being suspended, and leaving it so would be an accident of test order
-- rather than a decision.
update public.companies
   set status = 'active'
 where id = '00000000-0000-0000-0000-000000000602';

select * from finish();
rollback;
