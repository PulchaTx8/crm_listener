begin;
select plan(22);

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

-- ---------------------------------------------------------------------------
-- Block 17c, first repair. THE TWO SHAPES OF AN ANSWER.
--
-- participation_answers_shape (0052) wants option_id and a null answer_text for
-- a question with alternatives, and the exact opposite for an open one. Nothing
-- here asserted that before, which is how a panel that typed prose into a quiz
-- reached a listener.
-- ---------------------------------------------------------------------------
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, requested_fields, rules, web_enabled)
values
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-000000000401',
   '00000000-0000-0000-0000-000000000402', 'Promo com quiz e enquete',
   now() - interval '1 day', now() + interval '7 days',
   -- Single entry: promotions_repetition_shape wants an interval alongside
   -- allow_multiple_entries, and this promotion has no use for either.
   false, '{}'::public.promotion_requested_field[],
   'Regulamento da promoção com perguntas.', true);

-- menu_title and button_label are required for a question WITH alternatives and
-- forbidden on an open one (promotion_questions_list_fields). Both are objects
-- of a WhatsApp list message, and the schema requires them even on a promotion
-- that only converses on the web -- a one-door assumption like the one 0171
-- undid for art and requested fields, left standing here on purpose: it is a
-- separate change with its own screen to fix, not a passenger on this repair.
insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt,
   menu_title, button_label)
values
  ('00000000-0000-0000-0000-000000000412', '00000000-0000-0000-0000-000000000411',
   '00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000402',
   1, 'QUIZ', 'Qual é a capital do estado?', 'Escolha uma', 'Responder'),
  ('00000000-0000-0000-0000-000000000413', '00000000-0000-0000-0000-000000000411',
   '00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000402',
   2, 'ESSAY', 'O que você quer mandar para a gente?', null, null);

-- `kind` is carried on the option too, not only on its question: 0041 keeps it
-- here so is_correct can be constrained per kind without a join.
insert into public.promotion_question_options
  (id, question_id, kind, organization_id, company_id, position, label, is_correct)
values
  ('00000000-0000-0000-0000-000000000414', '00000000-0000-0000-0000-000000000412',
   'QUIZ', '00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000402',
   1, 'São Paulo', true),
  ('00000000-0000-0000-0000-000000000415', '00000000-0000-0000-0000-000000000412',
   'QUIZ', '00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000402',
   2, 'Santos', false);

-- THE ALTERNATIVES REACH THE WIDGET, which is the whole repair.
select is(
  (select jsonb_array_length(
     (select p -> 'questions' -> '00000000-0000-0000-0000-000000000412'
        from jsonb_array_elements(
          public.widget_promotions('pw_promostationa012345678',
                                   '00000000-0000-0000-0000-000000000404') -> 'promotions') p
       where p ->> 'id' = '00000000-0000-0000-0000-000000000411'))),
  2, 'a quiz question carries its two alternatives to the widget');

-- THE ANSWER SHEET DOES NOT. is_correct in a payload the listener's own browser
-- renders would hand them the answer.
select is(
  (select (public.widget_promotions('pw_promostationa012345678',
                                    '00000000-0000-0000-0000-000000000404'))::text
     like '%is_correct%'),
  false, 'and never carries which alternative is the right one');

select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000404',
     '00000000-0000-0000-0000-000000000411', true, '{}'::jsonb,
     jsonb_build_array(
       jsonb_build_object('question_id', '00000000-0000-0000-0000-000000000412',
                          'option_id', '00000000-0000-0000-0000-000000000415'),
       jsonb_build_object('question_id', '00000000-0000-0000-0000-000000000413',
                          'answer_text', 'Alpha FM'))) ->> 'ok'),
  'true', 'a chosen alternative and a written answer are both recorded');

-- The shape each kind actually landed in.
select is(
  (select count(*) from public.participation_answers
    where promotion_id = '00000000-0000-0000-0000-000000000411'
      and ((kind = 'QUIZ' and option_id is not null and answer_text is null)
        or (kind = 'ESSAY' and answer_text is not null and option_id is null))),
  2::bigint, 'each answer landed in the shape its kind requires');

-- ---------------------------------------------------------------------------
-- 20-22. Block 20a, item 2, candidate (b): a question with alternatives and no
--        alternatives in it.
--
-- 0041 constrains the option rows that exist -- not ESSAY, correct only on
-- QUIZ, unique positions -- and says nothing about how many there must be,
-- because a CHECK cannot count rows in another table. So a promotion can carry
-- a MULTIPLE_CHOICE question with zero options, and 0173 answers '[]' for it.
--
-- The panel draws that question as NOTHING (enter-promotion.tsx's Question, on
-- the grounds that an empty screen beats a text box whose every answer trips
-- participation_answers_shape). The listener taps through a blank screen, and
-- the door counts a step the payload cannot answer.
--
-- These three described the defect before 0186 closed it. They now describe
-- the repair: the promotion is absent, its question is absent with it, and a
-- submission against it is refused as closed rather than as the listener's
-- fault.
-- ---------------------------------------------------------------------------
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, requested_fields, rules, web_enabled)
values
  ('00000000-0000-0000-0000-000000000420', '00000000-0000-0000-0000-000000000401',
   '00000000-0000-0000-0000-000000000402', 'Promo com pergunta sem alternativas',
   now() - interval '1 day', now() + interval '7 days',
   false, array['city']::public.promotion_requested_field[],
   'Válido para maiores de 18 anos.', true);

-- MULTIPLE_CHOICE, and deliberately no promotion_question_options rows.
-- menu_title/button_label are required for ANY non-ESSAY question
-- (promotion_questions_list_fields, 0041) regardless of how many options it
-- has -- they are WhatsApp list-message fields, not evidence either way for
-- this candidate -- so they are supplied here purely to make the row legal,
-- the same way the QUIZ fixture above already does.
insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt,
   menu_title, button_label)
values
  ('00000000-0000-0000-0000-000000000421', '00000000-0000-0000-0000-000000000420',
   '00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000402',
   1, 'MULTIPLE_CHOICE', 'Qual a sua rádio favorita?', 'Escolha uma', 'Responder');

insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-000000000422', '00000000-0000-0000-0000-000000000401',
   'Optionless Listener', '+5511999993333');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-000000000422', '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-000000000401');

-- 20. The promotion is NOT offered. Same treatment, for the same reason, as a
--     promotion with no rules text (D3): a listener is not shown a door that
--     can only close on them.
select is(
  (select count(*) from jsonb_array_elements(
     public.widget_promotions('pw_promostationa012345678',
                              '00000000-0000-0000-0000-000000000422') -> 'promotions') e
    where (e ->> 'id') = '00000000-0000-0000-0000-000000000420'),
  0::bigint, 'a promotion whose only question has no alternatives is not offered');

-- 21. And nothing about it leaks into the payload by another route.
select is(
  (select public.widget_promotions('pw_promostationa012345678',
                                   '00000000-0000-0000-0000-000000000422')::text
     like '%00000000-0000-0000-0000-000000000421%'),
  false, 'and its question is absent from the payload entirely');

-- 22. And a submission against it -- from a crafted payload, or from a browser
--     that had the list open before the options were removed -- is refused as
--     closed rather than as the listener's fault.
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000422',
     '00000000-0000-0000-0000-000000000420', true,
     '{"city": "São Paulo"}'::jsonb, '[]'::jsonb) ->> 'reason'),
  'promotion_closed',
  'and a submission against it is refused as closed, not as the listener''s fault');

select * from finish();
rollback;
