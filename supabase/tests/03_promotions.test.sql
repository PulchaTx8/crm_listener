begin;
select plan(57);

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
  6, 'six promotion permissions are catalogued');

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

-- The promotions module's whole RPC surface, its reachability pinned as a grant
-- rather than left to the guard inside each body. 0042's four and 0043's two
-- held the default PUBLIC EXECUTE from 4a until 0050 revoked it; they always
-- refused anon on has_permission, so nothing was ever reachable, but a refusal
-- that lives only in the first `if` of a body is one refactor away from not
-- being there. These pairs are what make that regression fail here instead of
-- in production. Same shape 02_permissions.test.sql uses for
-- ensure_inventory_balance_row and apply_inventory_movement.
--
-- EVERY RPC of the feature, not a subset, and in ONE place. The first pass at
-- this closed 0042's four and left 0043's two open, which is a surface that
-- looks audited and is not. Block 4b then shipped four more — 0049's two writes
-- and 0051's two reads — and pinned none of them, which is the same hole again
-- and was caught by the branch review rather than by anything here. Splitting
-- the grid by migration is exactly how both gaps happened, so 4b's four are
-- listed below beside 4a's six rather than in 04_promotion_prizes.test.sql: a
-- reader asking "which promotion RPCs can which role reach" has one list to
-- read, and an RPC arriving without a pair here is the thing this block of
-- assertions exists to make obvious.
--
-- The two reads are here for the same reason the writes are, and they need it
-- more rather than less: both are SECURITY DEFINER (0051) and run past RLS
-- entirely, so a stray grant on either is a direct read into another Station's
-- prize names and figures, restrained only by the has_permission call in the
-- body.
select ok(
  not has_function_privilege('anon', 'public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[])', 'EXECUTE'),
  'anon may not call create_promotion');
select ok(
  has_function_privilege('authenticated', 'public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[])', 'EXECUTE'),
  'authenticated may call create_promotion');

select ok(
  not has_function_privilege('anon', 'public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[])', 'EXECUTE'),
  'anon may not call update_promotion');
select ok(
  has_function_privilege('authenticated', 'public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[])', 'EXECUTE'),
  'authenticated may call update_promotion');

select ok(
  not has_function_privilege('anon', 'public.cancel_promotion(uuid, text)', 'EXECUTE'),
  'anon may not call cancel_promotion');
select ok(
  has_function_privilege('authenticated', 'public.cancel_promotion(uuid, text)', 'EXECUTE'),
  'authenticated may call cancel_promotion');

-- The one of the four that moves stock as of 0050, which is why the grant was
-- closed in that migration rather than left for a later block.
select ok(
  not has_function_privilege('anon', 'public.archive_promotion(uuid)', 'EXECUTE'),
  'anon may not call archive_promotion');
select ok(
  has_function_privilege('authenticated', 'public.archive_promotion(uuid)', 'EXECUTE'),
  'authenticated may call archive_promotion');

-- 0043's two, which carry neither a revoke nor a grant of their own and so held
-- the same PUBLIC EXECUTE until 0050.
select ok(
  not has_function_privilege('anon', 'public.save_promotion_question(uuid, public.promotion_question_kind, text, text, text, jsonb, uuid)', 'EXECUTE'),
  'anon may not call save_promotion_question');
select ok(
  has_function_privilege('authenticated', 'public.save_promotion_question(uuid, public.promotion_question_kind, text, text, text, jsonb, uuid)', 'EXECUTE'),
  'authenticated may call save_promotion_question');

select ok(
  not has_function_privilege('anon', 'public.remove_promotion_question(uuid)', 'EXECUTE'),
  'anon may not call remove_promotion_question');
select ok(
  has_function_privilege('authenticated', 'public.remove_promotion_question(uuid)', 'EXECUTE'),
  'authenticated may call remove_promotion_question');

-- Block 4b's two write RPCs (0049). Both move stock, and both gate on
-- promotions.prizes inside a SECURITY DEFINER body — which is the shape whose
-- only structural backstop is the pair below.
select ok(
  not has_function_privilege('anon', 'public.link_prize_to_promotion(uuid, uuid, integer, text)', 'EXECUTE'),
  'anon may not call link_prize_to_promotion');
select ok(
  has_function_privilege('authenticated', 'public.link_prize_to_promotion(uuid, uuid, integer, text)', 'EXECUTE'),
  'authenticated may call link_prize_to_promotion');

select ok(
  not has_function_privilege('anon', 'public.unlink_prize_from_promotion(uuid, uuid, integer, text)', 'EXECUTE'),
  'anon may not call unlink_prize_from_promotion');
select ok(
  has_function_privilege('authenticated', 'public.unlink_prize_from_promotion(uuid, uuid, integer, text)', 'EXECUTE'),
  'authenticated may call unlink_prize_from_promotion');

-- Block 4b's two read RPCs (0051), both SECURITY DEFINER and therefore past
-- every policy. They gate on different codes on purpose — list_promotion_prizes
-- on promotions.view, list_linkable_prizes on promotions.prizes, because
-- showing somebody the Station's whole stock is not something reading a
-- promotion should carry with it — and neither distinction survives a grant to
-- anon, which is what these four pin.
select ok(
  not has_function_privilege('anon', 'public.list_promotion_prizes(uuid)', 'EXECUTE'),
  'anon may not call list_promotion_prizes');
select ok(
  has_function_privilege('authenticated', 'public.list_promotion_prizes(uuid)', 'EXECUTE'),
  'authenticated may call list_promotion_prizes');

select ok(
  not has_function_privilege('anon', 'public.list_linkable_prizes(uuid, text)', 'EXECUTE'),
  'anon may not call list_linkable_prizes');
select ok(
  has_function_privilege('authenticated', 'public.list_linkable_prizes(uuid, text)', 'EXECUTE'),
  'authenticated may call list_linkable_prizes');

select * from finish();
rollback;
