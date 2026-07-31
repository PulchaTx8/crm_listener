begin;
select plan(32);

-- Structure ------------------------------------------------------------------

select has_table('public', 'participations', 'participations exists');
select has_table('public', 'participation_answers', 'participation_answers exists');
select has_type('public', 'participation_status', 'the status enum exists');
select has_type('public', 'participation_source', 'the source enum exists');
select has_column('public', 'promotions', 'max_entries_per_member',
                  'a promotion can cap entries per person');

select is(relrowsecurity, true, 'RLS enabled on participations')
  from pg_class where oid = 'public.participations'::regclass;
select is(relrowsecurity, true, 'RLS enabled on participation_answers')
  from pg_class where oid = 'public.participation_answers'::regclass;

select ok(not has_table_privilege('authenticated', 'public.participations', 'INSERT'),
          'authenticated may not record a participation directly');

select is(
  (select count(*)::int from public.permissions where module = 'participations'),
  3, 'three participation permissions are catalogued');

-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000004f1', 'Org 4c');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000004f1',
   'Station 4c', 'America/Sao_Paulo');
insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-0000000004f1', 'Ouvinte Um'),
  ('00000000-0000-0000-0000-0000000004d9', '00000000-0000-0000-0000-0000000004f1', 'Ouvinte Sem Vinculo');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-0000000004c1',
   '00000000-0000-0000-0000-0000000004f1');

-- min_hours_between_entries is set in the same statement as
-- allow_multiple_entries for Repeatable, not by a follow-up UPDATE: 0040's
-- promotions_repetition_shape is a plain CHECK, not deferrable, so a row that
-- says allow_multiple_entries = true with no interval is refused at the INSERT
-- itself and there would be no row left for an UPDATE to reach.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, allow_multiple_entries,
   min_hours_between_entries)
values
  ('00000000-0000-0000-0000-0000000004e1', '00000000-0000-0000-0000-0000000004f1',
   '00000000-0000-0000-0000-0000000004c1', 'Once only', '2026-08-01Z', '2026-08-31Z', false, null),
  ('00000000-0000-0000-0000-0000000004e2', '00000000-0000-0000-0000-0000000004f1',
   '00000000-0000-0000-0000-0000000004c1', 'Repeatable', '2026-08-01Z', '2026-08-31Z', true, 6);

-- The ceiling ----------------------------------------------------------------

select throws_ok(
  $$update public.promotions set max_entries_per_member = 5
     where id = '00000000-0000-0000-0000-0000000004e1'$$,
  '23514', null, 'a ceiling on a promotion that forbids repeats is refused');

select throws_ok(
  $$update public.promotions set max_entries_per_member = 1
     where id = '00000000-0000-0000-0000-0000000004e2'$$,
  '23514', null, 'a ceiling of one is refused — that is what forbidding repeats already says');

prepare ceiling as
  update public.promotions set max_entries_per_member = 5
   where id = '00000000-0000-0000-0000-0000000004e2';
select lives_ok('ceiling', 'a ceiling of two or more on a repeatable promotion is legal');

-- The participation proves its Station and its listener ----------------------

prepare first_entry as
  insert into public.participations
    (promotion_id, member_id, organization_id, company_id, allows_multiple,
     status, source, participated_at)
  values ('00000000-0000-0000-0000-0000000004e1',
          '00000000-0000-0000-0000-0000000004d1',
          '00000000-0000-0000-0000-0000000004f1',
          '00000000-0000-0000-0000-0000000004c1', false,
          'VALID', 'MANUAL', '2026-08-05Z');
select lives_ok('first_entry', 'a participation for a linked listener is legal');

-- member_company_links is keyed on exactly this pair, so one constraint proves
-- both that the listener exists and that this Station has them. A key to
-- members (id, organization_id) would prove only the Organization.
select throws_ok(
  $$insert into public.participations
      (promotion_id, member_id, organization_id, company_id, allows_multiple,
       status, source, participated_at)
    values ('00000000-0000-0000-0000-0000000004e1',
            '00000000-0000-0000-0000-0000000004d9',
            '00000000-0000-0000-0000-0000000004f1',
            '00000000-0000-0000-0000-0000000004c1', false,
            'VALID', 'MANUAL', '2026-08-05Z')$$,
  '23503', null, 'a listener this Station is not linked to cannot participate');

-- The one-per-person index ---------------------------------------------------

select throws_ok(
  $$insert into public.participations
      (promotion_id, member_id, organization_id, company_id, allows_multiple,
       status, source, participated_at)
    values ('00000000-0000-0000-0000-0000000004e1',
            '00000000-0000-0000-0000-0000000004d1',
            '00000000-0000-0000-0000-0000000004f1',
            '00000000-0000-0000-0000-0000000004c1', false,
            'VALID', 'MANUAL', '2026-08-06Z')$$,
  '23505', null, 'a second VALID entry is refused where the promotion forbids repeats');

-- The index counts only VALID, which is what lets a refusal be recorded rather
-- than thrown away. Drop `status = 'VALID'` from its predicate and this case
-- goes red while the one above stays green.
prepare refused_beside_it as
  insert into public.participations
    (promotion_id, member_id, organization_id, company_id, allows_multiple,
     status, source, participated_at)
  values ('00000000-0000-0000-0000-0000000004e1',
          '00000000-0000-0000-0000-0000000004d1',
          '00000000-0000-0000-0000-0000000004f1',
          '00000000-0000-0000-0000-0000000004c1', false,
          'DUPLICATE', 'MANUAL', '2026-08-06Z');
select lives_ok('refused_beside_it',
  'a DUPLICATE may sit beside the VALID one it was refused for');

-- And the same pair repeats freely where the promotion allows it.
prepare repeat_ok as
  insert into public.participations
    (promotion_id, member_id, organization_id, company_id, allows_multiple,
     status, source, participated_at)
  values ('00000000-0000-0000-0000-0000000004e2',
          '00000000-0000-0000-0000-0000000004d1',
          '00000000-0000-0000-0000-0000000004f1',
          '00000000-0000-0000-0000-0000000004c1', true,
          'VALID', 'MANUAL', '2026-08-07Z');
select lives_ok('repeat_ok', 'a repeatable promotion takes the same listener twice');

-- The denormalised flag cannot drift, and turning repeats off is refused
-- while the data already breaks the rule. Same shape as 0041's "a quiz with a
-- right answer cannot become a poll".
select throws_ok(
  $$insert into public.participations
      (promotion_id, member_id, organization_id, company_id, allows_multiple,
       status, source, participated_at)
    values ('00000000-0000-0000-0000-0000000004e2',
            '00000000-0000-0000-0000-0000000004d1',
            '00000000-0000-0000-0000-0000000004f1',
            '00000000-0000-0000-0000-0000000004c1', false,
            'VALID', 'MANUAL', '2026-08-08Z')$$,
  '23503', null, 'a participation may not claim a repeat rule its promotion does not have');

insert into public.participations
  (promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values ('00000000-0000-0000-0000-0000000004e2',
        '00000000-0000-0000-0000-0000000004d1',
        '00000000-0000-0000-0000-0000000004f1',
        '00000000-0000-0000-0000-0000000004c1', true,
        'VALID', 'MANUAL', '2026-08-09Z');

-- max_entries_per_member is cleared in the same statement, not left at the 5
-- the earlier "ceiling" case set: promotions_entry_ceiling_shape refuses a
-- ceiling on a promotion that does not allow repeats, so leaving it at 5 here
-- would trip that CHECK on the row itself before the cascade below ever runs,
-- and the assertion would be pinning the wrong SQLSTATE for the wrong reason.
select throws_ok(
  $$update public.promotions
       set allow_multiple_entries = false, min_hours_between_entries = null,
           max_entries_per_member = null
     where id = '00000000-0000-0000-0000-0000000004e2'$$,
  '23505', null,
  'repeats cannot be turned off while one listener already has two valid entries');

-- Answers --------------------------------------------------------------------

insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt,
   menu_title, button_label)
values ('00000000-0000-0000-0000-0000000004a1',
        '00000000-0000-0000-0000-0000000004e1',
        '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004c1',
        1, 'QUIZ', 'Quem ganha?', 'Escolha', 'Opções'),
       ('00000000-0000-0000-0000-0000000004a2',
        '00000000-0000-0000-0000-0000000004e1',
        '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004c1',
        2, 'ESSAY', 'Por que você ouve?', null, null);
insert into public.promotion_question_options
  (id, question_id, kind, company_id, organization_id, position, label, is_correct)
values ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004a1',
        'QUIZ', '00000000-0000-0000-0000-0000000004c1',
        '00000000-0000-0000-0000-0000000004f1', 1, 'Brasil', true);

prepare quiz_answer as
  insert into public.participation_answers
    (participation_id, promotion_id, question_id, kind, option_id,
     organization_id, company_id)
  select p.id, '00000000-0000-0000-0000-0000000004e1',
         '00000000-0000-0000-0000-0000000004a1', 'QUIZ',
         '00000000-0000-0000-0000-0000000004b1',
         '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004c1'
  from public.participations p
  where p.promotion_id = '00000000-0000-0000-0000-0000000004e1' and p.status = 'VALID';
select lives_ok('quiz_answer', 'a quiz answer naming its own option is legal');

select throws_ok(
  $$insert into public.participation_answers
      (participation_id, promotion_id, question_id, kind, answer_text,
       organization_id, company_id)
    select p.id, '00000000-0000-0000-0000-0000000004e1',
           '00000000-0000-0000-0000-0000000004a1', 'QUIZ', 'Brasil',
           '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004c1'
    from public.participations p
    where p.promotion_id = '00000000-0000-0000-0000-0000000004e1' and p.status = 'VALID'$$,
  '23514', null, 'a quiz answer may not be free text');

select throws_ok(
  $$insert into public.participation_answers
      (participation_id, promotion_id, question_id, kind, option_id,
       organization_id, company_id)
    select p.id, '00000000-0000-0000-0000-0000000004e1',
           '00000000-0000-0000-0000-0000000004a2', 'ESSAY',
           '00000000-0000-0000-0000-0000000004b1',
           '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004c1'
    from public.participations p
    where p.promotion_id = '00000000-0000-0000-0000-0000000004e1' and p.status = 'VALID'$$,
  '23514', null, 'an essay answer may not name an option');

-- The option belongs to the question, structurally rather than by check.
insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt,
   menu_title, button_label)
values ('00000000-0000-0000-0000-0000000004a3',
        '00000000-0000-0000-0000-0000000004e1',
        '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004c1',
        3, 'QUIZ', 'Outra?', 'Escolha', 'Opções');
select throws_ok(
  $$insert into public.participation_answers
      (participation_id, promotion_id, question_id, kind, option_id,
       organization_id, company_id)
    select p.id, '00000000-0000-0000-0000-0000000004e1',
           '00000000-0000-0000-0000-0000000004a3', 'QUIZ',
           '00000000-0000-0000-0000-0000000004b1',
           '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004c1'
    from public.participations p
    where p.promotion_id = '00000000-0000-0000-0000-0000000004e1' and p.status = 'VALID'$$,
  '23503', null, 'an answer may not name an option from another question');

select throws_ok(
  $$insert into public.participation_answers
      (participation_id, promotion_id, question_id, kind, option_id,
       organization_id, company_id)
    select p.id, '00000000-0000-0000-0000-0000000004e1',
           '00000000-0000-0000-0000-0000000004a1', 'QUIZ',
           '00000000-0000-0000-0000-0000000004b1',
           '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004c1'
    from public.participations p
    where p.promotion_id = '00000000-0000-0000-0000-0000000004e1' and p.status = 'VALID'$$,
  '23505', null, 'one answer per question per participation');

-- The read gate --------------------------------------------------------------

select ok(has_table_privilege('authenticated', 'public.participations', 'SELECT'),
          'authenticated may read participations, subject to policy');
select ok(has_table_privilege('service_role', 'public.participation_answers', 'SELECT'),
          'service_role may read answers — BYPASSRLS is not a grant');
select ok(not has_table_privilege('service_role', 'public.participations', 'TRUNCATE'),
          'service_role may not truncate participations');
select ok(not has_table_privilege('service_role', 'public.participation_answers', 'TRUNCATE'),
          'service_role may not truncate answers');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'participations'),
  1, 'participations carries exactly one policy, and it is a read policy');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'participation_answers'),
  1, 'participation_answers carries exactly one policy, and it is a read policy');

-- Fails closed against a row that exists. The claim names a user with no
-- membership anywhere, and the fixtures above left real participations and real
-- ANSWERS behind, so a zero here is a denial and not an empty table.
--
-- Two views, not one, and the second is the one that had no proof anywhere.
-- Until this fix round `participation_answers` was covered by the policy COUNT
-- above and by nothing else in this repository — rewrite 0053's second policy
-- `using (true)` and every gate stayed green, on the table that holds listeners'
-- free-text answers. The one live read of it (tests/isolation/participations
-- .test.ts) is by a delegate who holds participations.view, so it can only ever
-- show the permitted direction. The stranger is the denied one.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000004ff", "role": "authenticated"}';

create temporary view stranger_participations as
  select id from public.participations;

create temporary view stranger_participation_answers as
  select id from public.participation_answers;

reset role;
select is(
  (select count(*)::int from stranger_participations),
  0, 'a caller holding participations.view nowhere reads no participations at all');

-- Asserted against a table that is NOT empty: the `quiz_answer` fixture above
-- ran under lives_ok and left a row. Without that, a zero here would be the
-- empty-set trap rather than a denial, which is the shape this suite has been
-- caught by before.
select is(
  (select count(*)::int from stranger_participation_answers),
  0, 'a caller holding participations.view nowhere reads no answers either');

select * from finish();
rollback;
