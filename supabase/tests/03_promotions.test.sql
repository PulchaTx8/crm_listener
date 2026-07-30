begin;
select plan(37);

-- Structure ------------------------------------------------------------------

select has_table('public', 'promotions', 'promotions exists');
select has_type('public', 'promotion_requested_field', 'the requested-field enum exists');

select is(relrowsecurity, true, 'RLS enabled on promotions')
  from pg_class where oid = 'public.promotions'::regclass;

-- Every write goes through a SECURITY DEFINER RPC. A grant here would be a
-- second, unaudited way to open a promotion to the audience.
select ok(not has_table_privilege('authenticated', 'public.promotions', 'INSERT'),
          'authenticated may not insert a promotion directly');
select ok(not has_table_privilege('service_role', 'public.promotions', 'UPDATE'),
          'service_role may not update a promotion directly');

-- A permission is born beside the feature it guards; these appear in the role
-- editor without that screen being touched.
select is(
  (select count(*)::int from public.permissions where code like 'promotions.%'),
  5, 'five promotion permissions are catalogued');

-- Fixtures -------------------------------------------------------------------
-- No auth user is seeded: created_by is nullable and nothing below sets it.
-- Adding one would be scenery the assertions never read.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000b1', 'Org pgTAP');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1',
   'Station pgTAP', 'America/Sao_Paulo');

prepare legal as
  insert into public.promotions
    (organization_id, company_id, name, starts_at, ends_at)
  values
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
     'Baseline', '2026-08-01Z', '2026-08-31Z');
select lives_ok('legal', 'a promotion with only a name and a window is legal');

-- One case per row of the design spec's table of guarantees (§4) -------------

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Inverted', '2026-08-31Z', '2026-08-01Z')$$,
  '23514', null, 'an inverted window is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'No hashtag', '2026-09-01Z', '2026-09-30Z', true)$$,
  '23514', null, 'WhatsApp enabled without a hashtag is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled, hashtag)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Tab 2 while off', '2026-09-01Z', '2026-09-30Z', false, '#NOPE')$$,
  '23514', null, 'a hashtag with WhatsApp disabled is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled, requested_fields)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Fields while off', '2026-09-01Z', '2026-09-30Z', false,
            array['full_name']::public.promotion_requested_field[])$$,
  '23514', null, 'requested fields with WhatsApp disabled are refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled, hashtag, requested_fields)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Dup fields', '2026-09-01Z', '2026-09-30Z', true, '#DUP',
            array['city','city']::public.promotion_requested_field[])$$,
  '23514', null, 'the same requested field twice is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled, hashtag, use_art)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Art without url', '2026-09-01Z', '2026-09-30Z', true, '#ART', true)$$,
  '23514', null, 'use_art without a url is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled, hashtag, use_art, art_url)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Http art', '2026-09-01Z', '2026-09-30Z', true, '#HTTP', true,
            'http://example.test/banner.jpg')$$,
  '23514', null, 'an http art url is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   allow_multiple_entries)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Repeat no interval', '2026-09-01Z', '2026-09-30Z', true)$$,
  '23514', null, 'repetition without an interval is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   min_hours_between_entries)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Interval no repeat', '2026-09-01Z', '2026-09-30Z', 24)$$,
  '23514', null, 'an interval without repetition is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   cancelled_at)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Half cancelled', '2026-09-01Z', '2026-09-30Z', now())$$,
  '23514', null, 'a cancellation without author and reason is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   deleted_at)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Half archived', '2026-09-01Z', '2026-09-30Z', now())$$,
  '23514', null, 'an archive without an author is refused');

-- The hashtag exclusion constraint -------------------------------------------
-- Three cases, and the middle one is what distinguishes this constraint from
-- an ordinary unique index: mutate tstzrange's bounds to '[]' and only that
-- case goes red.

insert into public.promotions
  (organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
values
  ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
   'First', '2026-10-01Z', '2026-10-31Z', true, '#EUQUERO');

select throws_ok(
  $$insert into public.promotions
      (organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Overlapping', '2026-10-15Z', '2026-11-15Z', true, '#EUQUERO')$$,
  '23P01', null, 'an overlapping window with the same hashtag is refused');

select throws_ok(
  $$insert into public.promotions
      (organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Case', '2026-10-15Z', '2026-11-15Z', true, '#euquero')$$,
  '23P01', null, 'the same hashtag in another case is refused');

prepare touching as
  insert into public.promotions
    (organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
          'Touching', '2026-10-31Z', '2026-11-30Z', true, '#EUQUERO');
select lives_ok('touching',
  'a window that starts exactly when the other ends is accepted');

-- The site integration code, unique per Station while live -------------------

insert into public.promotions
  (organization_id, company_id, name, starts_at, ends_at, site_integration_code)
values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
        'Coded', '2027-01-01Z', '2027-01-31Z', 4242);

select throws_ok(
  $$insert into public.promotions
      (organization_id, company_id, name, starts_at, ends_at, site_integration_code)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Coded twice', '2027-02-01Z', '2027-02-28Z', 4242)$$,
  '23505', null, 'a duplicate site integration code is refused');

-- The loose end 0032 left behind ---------------------------------------------
-- A real Member is inserted first on purpose. With a random member_id this
-- would raise 23503 from member_consents_member_org_fk and pass for a reason
-- that has nothing to do with promotions — the assertion would survive the
-- foreign key being missing entirely.

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'pgTAP Member');

select throws_ok(
  $$insert into public.member_consents
      (organization_id, member_id, company_id, consent_type, granted, promotion_id)
    values ('00000000-0000-0000-0000-0000000000b1',
            '00000000-0000-0000-0000-0000000000f1',
            '00000000-0000-0000-0000-0000000000c1', 'rules', true,
            '00000000-0000-0000-0000-00000000dead')$$,
  '23503', null, 'a consent naming a promotion that does not exist is refused');

-- The quiz --------------------------------------------------------------------

select has_table('public', 'promotion_questions', 'promotion_questions exists');
select has_table('public', 'promotion_question_options', 'promotion_question_options exists');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values ('00000000-0000-0000-0000-0000000000d1',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
        'Quiz host', '2027-03-01Z', '2027-03-31Z');

prepare essay as
  insert into public.promotion_questions
    (id, promotion_id, organization_id, company_id, position, kind, prompt)
  values ('00000000-0000-0000-0000-0000000000e1',
          '00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
          1, 'ESSAY', 'Tell us why you listen');
select lives_ok('essay', 'an essay question needs no menu or button title');

select throws_ok(
  $$insert into public.promotion_questions
      (promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
    values ('00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            2, 'ESSAY', 'Why?', 'Choose', 'Options')$$,
  '23514', null, 'an essay question may not carry a menu title');

select throws_ok(
  $$insert into public.promotion_questions
      (promotion_id, organization_id, company_id, position, kind, prompt)
    values ('00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            3, 'QUIZ', 'Who wins?')$$,
  '23514', null, 'a choice question without a menu title is refused');

select throws_ok(
  $$insert into public.promotion_question_options
      (question_id, kind, company_id, organization_id, position, label)
    values ('00000000-0000-0000-0000-0000000000e1', 'ESSAY',
            '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1',
            1, 'Nope')$$,
  '23514', null, 'an option may not hang off an essay question');

insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
values ('00000000-0000-0000-0000-0000000000e2',
        '00000000-0000-0000-0000-0000000000d1',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
        4, 'MULTIPLE_CHOICE', 'Favourite genre?', 'Choose', 'Options');

select throws_ok(
  $$insert into public.promotion_question_options
      (question_id, kind, company_id, organization_id, position, label, is_correct)
    values ('00000000-0000-0000-0000-0000000000e2', 'MULTIPLE_CHOICE',
            '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1',
            1, 'Rock', true)$$,
  '23514', null, 'a poll may not have a right answer');

insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
values ('00000000-0000-0000-0000-0000000000e3',
        '00000000-0000-0000-0000-0000000000d1',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
        5, 'QUIZ', 'Which country wins the 2026 World Cup?', 'Choose', 'Options');
insert into public.promotion_question_options
  (question_id, kind, company_id, organization_id, position, label, is_correct)
values ('00000000-0000-0000-0000-0000000000e3', 'QUIZ',
        '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1',
        1, 'Brazil', true);

select throws_ok(
  $$insert into public.promotion_question_options
      (question_id, kind, company_id, organization_id, position, label, is_correct)
    values ('00000000-0000-0000-0000-0000000000e3', 'QUIZ',
            '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1',
            2, 'Argentina', true)$$,
  '23505', null, 'a second right answer in one question is refused');

-- The error code is pinned on purpose. Drop the ON UPDATE CASCADE from the
-- options' foreign key and this still fails — but with 23503 instead of 23514,
-- so the assertion goes red rather than passing for a reason that has nothing
-- to do with the rule it is meant to protect.
select throws_ok(
  $$update public.promotion_questions set kind = 'MULTIPLE_CHOICE'
     where id = '00000000-0000-0000-0000-0000000000e3'$$,
  '23514', null, 'a quiz with a right answer cannot become a poll');

select throws_ok(
  $$insert into public.promotion_questions
      (promotion_id, organization_id, company_id, position, kind, prompt)
    values ('00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            1, 'ESSAY', 'Duplicate position')$$,
  '23505', null, 'two questions may not share a position');

-- Reads and grants ------------------------------------------------------------

select ok(has_table_privilege('authenticated', 'public.promotions', 'SELECT'),
          'authenticated may read promotions, subject to policy');
select ok(not has_table_privilege('authenticated', 'public.promotion_questions', 'INSERT'),
          'authenticated may not insert a question directly');
select is(relrowsecurity, true, 'RLS enabled on promotion_questions')
  from pg_class where oid = 'public.promotion_questions'::regclass;

-- Fails closed with no session in play, and doubles as a canary: the function
-- is `language sql`, so a body referencing a dropped column errors at plan
-- time — calling it at all is what proves it still resolves.
select is(public.is_owner_of_company(gen_random_uuid()), false,
          'is_owner_of_company fails closed with no session');

select * from finish();
rollback;
