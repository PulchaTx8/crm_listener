begin;
select plan(15);

-- Block 17c. The two doors behind the widget's second button.
--
-- Fixtures follow 41_widget_music_request.test.sql: one Organization, two
-- Stations with an installation each, a listener linked to the FIRST only --
-- which is what makes the cross-Station assertion mean anything.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000401', 'Org widget promo');

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000401',
   'Station widget promo A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-000000000403', '00000000-0000-0000-0000-000000000401',
   'Station widget promo B', 'America/Sao_Paulo');

insert into public.widget_installations
  (organization_id, company_id, public_key, enabled, allowed_origins)
values
  ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000402',
   'pw_promostationa012345678', true, array['https://a.radio.com.br']),
  ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000403',
   'pw_promostationb012345678', true, array['https://b.radio.com.br']);

insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-000000000404', '00000000-0000-0000-0000-000000000401',
   'Promo Listener', '+5511999996666');

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-000000000404', '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-000000000401');

-- THE ONE THAT SHOWS: ticked for the web (D1) AND carrying rules (D3), asking
-- for one field -- which the promotions_conversational_shape constraint now
-- allows on the strength of web_enabled alone, with no WhatsApp anywhere.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, requested_fields, rules, web_enabled)
values
  ('00000000-0000-0000-0000-000000000405', '00000000-0000-0000-0000-000000000401',
   '00000000-0000-0000-0000-000000000402', 'Promo com regulamento',
   now() - interval '1 day', now() + interval '7 days',
   false, array['city']::public.promotion_requested_field[],
   'Válido para maiores de 18 anos residentes no estado.', true);

-- Ticked for the web, but nobody has written the wording yet. Correctly
-- configured and correctly invisible.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, requested_fields, web_enabled)
values
  ('00000000-0000-0000-0000-000000000406', '00000000-0000-0000-0000-000000000401',
   '00000000-0000-0000-0000-000000000402', 'Promo sem regulamento',
   now() - interval '1 day', now() + interval '7 days',
   false, '{}'::public.promotion_requested_field[], true);

-- Has rules, ticked for the web, and ended yesterday.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, requested_fields, rules, web_enabled)
values
  ('00000000-0000-0000-0000-000000000407', '00000000-0000-0000-0000-000000000401',
   '00000000-0000-0000-0000-000000000402', 'Promo encerrada',
   now() - interval '10 days', now() - interval '1 day',
   false, '{}'::public.promotion_requested_field[],
   'Regulamento de promoção encerrada.', true);

-- THE OTHER HALF OF D1, and the reason two conditions are not one: rules
-- written, live, and simply not meant for the website. A design that treated
-- the rules text as the opt-in -- which this spec did until the constraint was
-- read -- would show this one.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, requested_fields, rules, web_enabled)
values
  ('00000000-0000-0000-0000-000000000408', '00000000-0000-0000-0000-000000000401',
   '00000000-0000-0000-0000-000000000402', 'Promo nao marcada para web',
   now() - interval '1 day', now() + interval '7 days',
   false, '{}'::public.promotion_requested_field[],
   'Regulamento de uma promoção que não vai para o site.', false);

-- ---------------------------------------------------------------------------
-- 1-3. The list.
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from jsonb_array_elements(
     public.widget_promotions('pw_promostationa012345678',
                              '00000000-0000-0000-0000-000000000404') -> 'promotions') p
    where p ->> 'id' = '00000000-0000-0000-0000-000000000405'),
  1::bigint, 'a live promotion with rules is listed');

select is(
  (select count(*) from jsonb_array_elements(
     public.widget_promotions('pw_promostationa012345678',
                              '00000000-0000-0000-0000-000000000404') -> 'promotions') p
    where p ->> 'id' in ('00000000-0000-0000-0000-000000000406',
                         '00000000-0000-0000-0000-000000000407',
                         '00000000-0000-0000-0000-000000000408')),
  0::bigint,
  'ticked-but-unwritten, closed, and written-but-unticked are all absent');

select is(
  (select public.widget_promotions('pw_promostationb012345678',
                                   '00000000-0000-0000-0000-000000000404') ->> 'reason'),
  'unknown_listener', 'the list does not answer about another Station''s listener');

-- ---------------------------------------------------------------------------
-- 4-9. Entering.
-- ---------------------------------------------------------------------------
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000404',
     '00000000-0000-0000-0000-000000000405', true,
     '{"city": "Santos"}'::jsonb, '[]'::jsonb) ->> 'ok'),
  'true', 'a listener who agrees and answers is entered');

select is(
  (select source::text from public.participations
    where member_id = '00000000-0000-0000-0000-000000000404'),
  'WEB', 'the entry carries source WEB');

-- 0129: a null actor does not mean "the system did it". A website visitor is
-- not an auth.users row and must not become one to give an insert a name.
select is(
  (select created_by from public.participations
    where member_id = '00000000-0000-0000-0000-000000000404'),
  null, 'the entry names no actor');

-- The divergence this block introduces on purpose: complete_conversation (0071)
-- records NO consent when a listener agrees on WhatsApp. Here there is a rules
-- text that was shown and agreed to, so there is something to record.
select is(
  (select count(*) from public.member_consents
    where member_id = '00000000-0000-0000-0000-000000000404'
      and consent_type = 'rules' and granted and origin = 'web-widget'),
  1::bigint, 'agreeing to the rules leaves a consent row');

select is(
  (select count(*) from public.member_field_confirmations
    where member_id = '00000000-0000-0000-0000-000000000404' and field = 'city'),
  1::bigint, 'the field the listener answered is confirmed');

select is(
  (select city from public.members where id = '00000000-0000-0000-0000-000000000404'),
  'Santos', 'the value reached the listener''s record');

-- ---------------------------------------------------------------------------
-- 10. THE ASSERTION THIS BLOCK IS BUILT AROUND. The door recomputes the step
--     list server-side; the screen is not the authority on what to ask.
-- ---------------------------------------------------------------------------
-- A LISTENER WHO HAS NOT ANSWERED YET, and that is not incidental: the step
-- list is per-listener state. Listener 404 gave `city` in assertion 4, so the
-- promotion no longer asks them for it and there is nothing left to skip --
-- the first draft of this assertion used them and got `already_entered`, which
-- is the door working correctly on a question the test was not asking.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-000000000410', '00000000-0000-0000-0000-000000000401',
   'Skipping Listener', '+5511999994444');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-000000000410', '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-000000000401');

select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000410',
     '00000000-0000-0000-0000-000000000405', true,
     '{}'::jsonb, '[]'::jsonb) ->> 'reason'),
  'missing_answers', 'a payload that skips a requested field is refused');

select is(
  (select count(*) from public.participations
    where member_id = '00000000-0000-0000-0000-000000000410'),
  0::bigint, 'and the refusal wrote no entry on the way out');

-- ---------------------------------------------------------------------------
-- 11-13. Refusing, closed, and the second entry.
-- ---------------------------------------------------------------------------
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000404',
     '00000000-0000-0000-0000-000000000407', true,
     '{}'::jsonb, '[]'::jsonb) ->> 'reason'),
  'promotion_closed', 'a promotion whose window has passed is refused');

select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000404',
     '00000000-0000-0000-0000-000000000405', true,
     '{"city": "Santos"}'::jsonb, '[]'::jsonb) ->> 'reason'),
  'already_entered', 'a second entry is refused when the promotion allows one');

-- Declining is a REAL PATH, not an abandonment: it writes the same refusal row
-- the WhatsApp flow writes, stamped with the door it came through.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-000000000409', '00000000-0000-0000-0000-000000000401',
   'Refusing Listener', '+5511999995555');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-000000000409', '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-000000000401');

-- TWO STATEMENTS, NOT ONE, and the first draft was one. Every subquery in a
-- single SELECT sees the same snapshot, so a count in the same statement as the
-- call cannot see the row that call inserted -- it read 0 and looked like the
-- door had written nothing.
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000409',
     '00000000-0000-0000-0000-000000000405', false,
     '{}'::jsonb, '[]'::jsonb) ->> 'reason'),
  'refused', 'declining is refused by name rather than silently dropped');

select is(
  (select count(*)::text from public.promotion_refusals
    where member_id = '00000000-0000-0000-0000-000000000409' and source = 'WEB') || ':' ||
  (select count(*)::text from public.participations
    where member_id = '00000000-0000-0000-0000-000000000409'),
  '1:0', 'and it wrote a refusal stamped WEB, and no participation');

select * from finish();
rollback;
