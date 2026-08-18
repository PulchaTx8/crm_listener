begin;
select plan(42);

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
-- 20-23. Block 20a, item 2, candidate (b): a question with alternatives and no
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

-- 20. THE ANCHOR. 21 and 22 below each pass if `widget_promotions` returns
--     '[]'::jsonb worth of promotions -- but they would ALSO pass if the call
--     errored instead: `-> 'promotions'` on an error payload (no such key) is
--     SQL NULL, jsonb_array_elements(NULL) yields zero rows, and a "count is
--     0" or a "does not contain this id" assertion is then true for the wrong
--     reason. This pins that the call actually answers this listener before
--     either of them is allowed to mean anything -- and it keeps meaning that
--     even if some later edit deletes this very assertion by accident, since
--     the plan count above would then be the thing that fails.
select is(
  (public.widget_promotions('pw_promostationa012345678',
                            '00000000-0000-0000-0000-000000000422') ->> 'ok'),
  'true', 'the list answers this listener at all -- what 20 and 21 rest on');

-- 21. The promotion is NOT offered. Same treatment, for the same reason, as a
--     promotion with no rules text (D3): a listener is not shown a door that
--     can only close on them.
select is(
  (select count(*) from jsonb_array_elements(
     public.widget_promotions('pw_promostationa012345678',
                              '00000000-0000-0000-0000-000000000422') -> 'promotions') e
    where (e ->> 'id') = '00000000-0000-0000-0000-000000000420'),
  0::bigint, 'a promotion whose only question has no alternatives is not offered');

-- 22. And nothing about it leaks into the payload by another route.
select is(
  (select public.widget_promotions('pw_promostationa012345678',
                                   '00000000-0000-0000-0000-000000000422')::text
     like '%00000000-0000-0000-0000-000000000421%'),
  false, 'and its question is absent from the payload entirely');

-- 23. And a submission against it -- from a crafted payload, or from a browser
--     that had the list open before the options were removed -- is refused as
--     closed rather than as the listener's fault.
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000422',
     '00000000-0000-0000-0000-000000000420', true,
     '{"city": "São Paulo"}'::jsonb, '[]'::jsonb) ->> 'reason'),
  'promotion_closed',
  'and a submission against it is refused as closed, not as the listener''s fault');

-- ---------------------------------------------------------------------------
-- 24-42. Block 29c, Task 9. The widget's marketing checkbox, carried through
-- the door's seventh parameter -- true, false, and omitted, all three
-- recorded rather than merely accepted -- plus the ACL a DROP + CREATE
-- migration (0234) had to reissue by hand.
--
-- A fresh promotion with no requested fields and no questions: the marketing
-- write is orthogonal to what a promotion asks, and the point of these
-- assertions is the consent row, not the entry mechanics 4-9 above already
-- cover.
-- ---------------------------------------------------------------------------
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, requested_fields, rules, web_enabled)
values
  ('00000000-0000-0000-0000-000000000430', '00000000-0000-0000-0000-000000000401',
   '00000000-0000-0000-0000-000000000402', 'Promo consentimento de marketing',
   now() - interval '1 day', now() + interval '7 days',
   false, '{}'::public.promotion_requested_field[],
   'Regulamento de uma promoção simples.', true),
  -- A SECOND promotion, needed to model a repeat participant honestly: a
  -- second entry against 430 by the same member would be refused
  -- already_entered before the consent logic ever runs (0171's own repeat
  -- guard, unchanged by 0234), which would prove nothing about the marketing
  -- write. Fix round 1, F23's own scenario is "ticks entering promotion A,
  -- does not re-tick entering promotion B" -- two promotions, on purpose.
  ('00000000-0000-0000-0000-000000000435', '00000000-0000-0000-0000-000000000401',
   '00000000-0000-0000-0000-000000000402', 'Promo consentimento de marketing 2',
   now() - interval '1 day', now() + interval '7 days',
   false, '{}'::public.promotion_requested_field[],
   'Regulamento de outra promoção simples.', true);

insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-000000000431', '00000000-0000-0000-0000-000000000401',
   'Marketing Yes Listener', '+5511999992221'),
  ('00000000-0000-0000-0000-000000000432', '00000000-0000-0000-0000-000000000401',
   'Marketing No Listener', '+5511999992222'),
  ('00000000-0000-0000-0000-000000000433', '00000000-0000-0000-0000-000000000401',
   'Marketing Omitted Listener', '+5511999992223'),
  -- Fix round 1, F23. Repeat participants -- the two arms a single-entry
  -- listener can never exercise.
  ('00000000-0000-0000-0000-000000000434', '00000000-0000-0000-0000-000000000401',
   'Marketing Override Listener', '+5511999992224'),
  ('00000000-0000-0000-0000-000000000436', '00000000-0000-0000-0000-000000000401',
   'Marketing Silent Listener', '+5511999992226');

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-000000000431', '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-000000000401'),
  ('00000000-0000-0000-0000-000000000432', '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-000000000401'),
  ('00000000-0000-0000-0000-000000000433', '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-000000000401'),
  ('00000000-0000-0000-0000-000000000434', '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-000000000401'),
  ('00000000-0000-0000-0000-000000000436', '00000000-0000-0000-0000-000000000402',
   '00000000-0000-0000-0000-000000000401');

-- 24-25. A ticked box: the entry succeeds and a granted row lands, stamped
-- with the door's own origin and the promotion it travelled with.
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000431',
     '00000000-0000-0000-0000-000000000430', true,
     '{}'::jsonb, '[]'::jsonb, true) ->> 'ok'),
  'true', 'entering with the marketing box ticked still succeeds');

select is(
  (select count(*) from public.member_consents
    where member_id = '00000000-0000-0000-0000-000000000431'
      and consent_type = 'whatsapp_marketing' and granted and origin = 'widget'
      and promotion_id = '00000000-0000-0000-0000-000000000430'),
  1::bigint, 'and a granted whatsapp_marketing row lands, stamped widget and the promotion');

-- 26-27. An UNTICKED box explicitly answered false: THE DECLINE IS RECORDED,
-- not omitted -- the same "asked, and said no" 0231's own conversation door
-- records for a Yes/No tap, and the reason this door does not simply skip
-- the insert when p_marketing_consent is false.
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000432',
     '00000000-0000-0000-0000-000000000430', true,
     '{}'::jsonb, '[]'::jsonb, false) ->> 'ok'),
  'true', 'entering with the marketing box explicitly unticked still succeeds');

select is(
  (select count(*) from public.member_consents
    where member_id = '00000000-0000-0000-0000-000000000432'
      and consent_type = 'whatsapp_marketing' and not granted and origin = 'widget'),
  1::bigint, 'and the decline is recorded rather than left as silence');

-- 28-29. The old SIX-argument call -- exactly what every assertion 4-23 above
-- already sends -- still succeeds, and the seventh parameter's default
-- answers the same as an explicit false: UNCHECKED IS THE DEFAULT, not merely
-- the widget's own initial React state.
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000433',
     '00000000-0000-0000-0000-000000000430', true,
     '{}'::jsonb, '[]'::jsonb) ->> 'ok'),
  'true', 'the pre-existing six-argument call is still accepted');

select is(
  (select count(*) from public.member_consents
    where member_id = '00000000-0000-0000-0000-000000000433'
      and consent_type = 'whatsapp_marketing' and not granted and origin = 'widget'),
  1::bigint, 'and the omitted seventh argument defaults to an explicit decline, not silence');

-- 30. Entering does not disturb the entry itself when the box is ticked: the
-- participation still carries source WEB regardless of what the marketing
-- checkbox says, because the two are unrelated facts about one submission.
select is(
  (select source::text from public.participations
    where member_id = '00000000-0000-0000-0000-000000000431'),
  'WEB', 'the entry itself is unaffected by the marketing checkbox');

-- 31-38. Fix round 1, F23 (Critical). THE THREE-WAY RULE, on a REPEAT participant --
-- the case a single-entry listener (431-433 above) cannot exercise, because
-- the rule only branches differently once a whatsapp_marketing row already
-- exists.
--
-- Member 434: declines on the first entry (arm B, no row yet -- proven again
-- here incidentally), then TICKS on a second entry against a DIFFERENT
-- promotion. Arm A says ticked always writes true, even over an existing
-- false row -- proven by a SECOND row landing (count 2, not 1) with a TRUE
-- row now among them, rather than the existing false row being left standing
-- or edited in place.
--
-- NOT AN ORDER-BY-granted_at CHECK: pgTAP wraps this whole file in one
-- transaction, so granted_at (default now()) is the SAME instant on every
-- row this file writes (0229's own R8 finding, in this block's ledger) --
-- 'order by granted_at desc' cannot tell the two rows apart, and the
-- eligibility function's own tiebreak (granted asc, deliberately restrictive)
-- would then read back false, not true. An EXISTS check for a true row is
-- what this arm can actually prove here.
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000434',
     '00000000-0000-0000-0000-000000000430', true,
     '{}'::jsonb, '[]'::jsonb, false) ->> 'ok'),
  'true', 'F23 setup: the first entry, unticked, still succeeds');

select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000434',
     '00000000-0000-0000-0000-000000000435', true,
     '{}'::jsonb, '[]'::jsonb, true) ->> 'ok'),
  'true', 'F23 arm A: a later TICKED entry against a different promotion still succeeds');

select is(
  (select count(*) from public.member_consents
    where member_id = '00000000-0000-0000-0000-000000000434'
      and consent_type = 'whatsapp_marketing'),
  2::bigint, 'F23 arm A: ticked writes a NEW row rather than being skipped, even though one already existed');

select ok(
  exists (
    select 1 from public.member_consents
     where member_id = '00000000-0000-0000-0000-000000000434'
       and consent_type = 'whatsapp_marketing'
       and granted),
  'F23 arm A: a true row now exists -- ticking wrote the override rather than being skipped because a decline was already on file');

-- Member 436: TICKS on the first entry (a granted row exists), then leaves
-- the box UNTICKED on a second entry against a different promotion. Arm C
-- says an unticked box writes NOTHING once a row exists -- proven by the row
-- count staying at 1 (no silent second row) AND the one row's own value
-- staying true (not flipped to false) -- the exact distinction the coordinator
-- asked this file to make between arms B and C.
select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000436',
     '00000000-0000-0000-0000-000000000430', true,
     '{}'::jsonb, '[]'::jsonb, true) ->> 'ok'),
  'true', 'F23 setup: the first entry, ticked, still succeeds');

select is(
  (select public.widget_enter_promotion(
     'pw_promostationa012345678', '00000000-0000-0000-0000-000000000436',
     '00000000-0000-0000-0000-000000000435', true,
     '{}'::jsonb, '[]'::jsonb, false) ->> 'ok'),
  'true', 'F23 arm C: a later UNTICKED entry against a different promotion still succeeds');

select is(
  (select count(*) from public.member_consents
    where member_id = '00000000-0000-0000-0000-000000000436'
      and consent_type = 'whatsapp_marketing'),
  1::bigint, 'F23 arm C: the unticked second entry wrote no new row -- silence, not a decline');

select is(
  (select granted from public.member_consents
    where member_id = '00000000-0000-0000-0000-000000000436'
      and consent_type = 'whatsapp_marketing'
    order by granted_at desc, granted asc limit 1),
  true, 'F23 arm C: the one row on file is still true -- an unticked repeat entry never revokes it');

-- 39-42. THE ACL A DROP DESTROYS. 0234 dropped this function to add the
-- parameter and had to reissue every grant by hand -- these assertions are
-- what would have caught a grant that vanished rather than a caller
-- discovering it as a permission error in production.
select ok(
  has_function_privilege('service_role',
    'public.widget_enter_promotion(text,uuid,uuid,boolean,jsonb,jsonb,boolean)', 'EXECUTE'),
  'service_role may still enter a promotion after the drop and recreate');

select ok(
  not has_function_privilege('anon',
    'public.widget_enter_promotion(text,uuid,uuid,boolean,jsonb,jsonb,boolean)', 'EXECUTE'),
  'anon may not -- the widget only ever calls through the service-role client');

select ok(
  not has_function_privilege('authenticated',
    'public.widget_enter_promotion(text,uuid,uuid,boolean,jsonb,jsonb,boolean)', 'EXECUTE'),
  'nor authenticated');

select ok(
  not has_function_privilege('public',
    'public.widget_enter_promotion(text,uuid,uuid,boolean,jsonb,jsonb,boolean)', 'EXECUTE'),
  'and PUBLIC holds nothing -- the DROP wiped the old ACL and 0234 reasserts it explicitly');

select * from finish();
rollback;
