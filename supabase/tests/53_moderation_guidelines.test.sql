begin;
select plan(16);

-- Block 24, item 5. The column, its shape, and the one thing about its door
-- that a reviewer would assume was a mistake: it writes while the promotion is
-- frozen, and save_promotion_question does not.

-- Structure ------------------------------------------------------------------

select has_column('public', 'promotion_questions', 'moderation_guidelines',
                  'a question can carry moderation guidelines');
select has_function('public', 'set_question_moderation_guidelines',
                    array['uuid', 'text'],
                    'the narrow door exists');

-- Every write to promotion_questions goes through a SECURITY DEFINER RPC. A
-- grant here would be a second, unaudited way to reach the column.
select ok(not has_table_privilege('authenticated', 'public.promotion_questions', 'UPDATE'),
          'authenticated may not update a question directly');

-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000024f1', 'Org 24 guidelines');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000024c1', '00000000-0000-0000-0000-0000000024f1',
   'Station 24 guidelines', 'America/Sao_Paulo');
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000000024e1', '00000000-0000-0000-0000-0000000024f1',
   '00000000-0000-0000-0000-0000000024c1', 'Promo 24', '2026-08-01Z', '2026-08-31Z');

-- A written answer and a quiz, so the ESSAY-only rule has both sides to be
-- tested against. The quiz carries the two list fields because
-- promotion_questions_list_fields requires them of every QUIZ — which is also
-- the constraint Block 24's D3 leaves standing while taking both off the screen.
insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt)
values
  ('00000000-0000-0000-0000-0000000024a1', '00000000-0000-0000-0000-0000000024e1',
   '00000000-0000-0000-0000-0000000024f1', '00000000-0000-0000-0000-0000000024c1',
   1, 'ESSAY', 'Why is this your song?');
insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt,
   menu_title, button_label)
values
  ('00000000-0000-0000-0000-0000000024a2', '00000000-0000-0000-0000-0000000024e1',
   '00000000-0000-0000-0000-0000000024f1', '00000000-0000-0000-0000-0000000024c1',
   2, 'QUIZ', 'Which country wins?', 'Escolha uma opção', 'Responder');
insert into public.promotion_question_options
  (question_id, kind, organization_id, company_id, position, label, is_correct)
values
  ('00000000-0000-0000-0000-0000000024a2', 'QUIZ', '00000000-0000-0000-0000-0000000024f1',
   '00000000-0000-0000-0000-0000000024c1', 1, 'Brazil', true),
  ('00000000-0000-0000-0000-0000000024a2', 'QUIZ', '00000000-0000-0000-0000-0000000024f1',
   '00000000-0000-0000-0000-0000000024c1', 2, 'Argentina', false);

-- The shape constraint ---------------------------------------------------------

-- 4: a Quiz has right answers rather than judgement calls, so it has nothing to
-- guide a reader with. Refused by the constraint, not only by the door.
select throws_ok(
  $$update public.promotion_questions
       set moderation_guidelines = 'be generous'
     where id = '00000000-0000-0000-0000-0000000024a2'$$,
  '23514', null, 'guidelines on a Quiz question are refused by the constraint');

prepare essay_guidelines as
  update public.promotion_questions
     set moderation_guidelines = 'Look for a story, not for spelling.'
   where id = '00000000-0000-0000-0000-0000000024a1';
select lives_ok('essay_guidelines', 'guidelines on a Poll question are legal');

-- Put it back, so the door below writes over a known state rather than over
-- whatever the assertion above happened to leave.
update public.promotion_questions
   set moderation_guidelines = null
 where id = '00000000-0000-0000-0000-0000000024a1';

-- The caller ------------------------------------------------------------------
-- A real role, role_permissions grant, auth.users row and company_membership --
-- never a platform_admin bypass, which would pass every gate below without
-- proving any of them.

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000002441', '00000000-0000-0000-0000-0000000024f1', 'Editor 24');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000002441', 'promotions.edit'),
  -- promotions.view too, so the reads below through this role's own connection
  -- are not cut by 0044's select policy: the row would be correct and this
  -- suite would report it absent.
  ('00000000-0000-0000-0000-000000002441', 'promotions.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000002442', 'guidelines-24@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000002442', '00000000-0000-0000-0000-0000000024c1',
   '00000000-0000-0000-0000-0000000024f1', '00000000-0000-0000-0000-000000002441');

-- A second user in the same Station holding promotions.view alone, for the
-- 42501 below. A caller with no membership at all would fail for the wrong
-- reason.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000002443', '00000000-0000-0000-0000-0000000024f1', 'Reader 24');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000002443', 'promotions.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000002444', 'guidelines-reader-24@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000002444', '00000000-0000-0000-0000-0000000024c1',
   '00000000-0000-0000-0000-0000000024f1', '00000000-0000-0000-0000-000000002443');

-- A listener and a participation, seeded HERE rather than beside the assertion
-- that needs them: everything below `set local role authenticated` runs as a
-- role holding no INSERT grant on any of these tables.
insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000000024d1', '00000000-0000-0000-0000-0000000024f1', 'Ouvinte 24');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000024d1', '00000000-0000-0000-0000-0000000024c1',
   '00000000-0000-0000-0000-0000000024f1');
insert into public.participations
  (promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-0000000024e1', '00000000-0000-0000-0000-0000000024d1',
   '00000000-0000-0000-0000-0000000024f1', '00000000-0000-0000-0000-0000000024c1', false,
   'VALID', 'MANUAL', '2026-08-05Z');

-- The door --------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000002444", "role": "authenticated"}';

-- 6: promotions.view is not enough. Permission before anything else.
select throws_ok(
  $$select public.set_question_moderation_guidelines(
      '00000000-0000-0000-0000-0000000024a1', 'anything')$$,
  '42501', null, 'a caller without promotions.edit is refused');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000002442", "role": "authenticated"}';

-- 7: the ordinary write.
select lives_ok(
  $$select public.set_question_moderation_guidelines(
      '00000000-0000-0000-0000-0000000024a1',
      'Look for a story. Ignore spelling.')$$,
  'a caller with promotions.edit writes the guidelines');

select is(
  (select moderation_guidelines from public.promotion_questions
    where id = '00000000-0000-0000-0000-0000000024a1'),
  'Look for a story. Ignore spelling.',
  'the guidelines are stored as written');

-- 9: THE ASSERTION THIS WHOLE DOOR EXISTS FOR.
--
-- The promotion above already has a participation, so 0055 refuses
-- save_promotion_question's REPLACE branch on the very same question — asserted
-- immediately below, so that this pair reads as one fact rather than two.
-- The guidelines are internal text no listener was ever shown, nothing points
-- at them, and the draw does not read them, so the freeze's reason does not
-- reach them; and the only moment anybody needs the field is while answers are
-- arriving, which is after the first participation by definition.
select lives_ok(
  $$select public.set_question_moderation_guidelines(
      '00000000-0000-0000-0000-0000000024a1',
      'Answers are arriving. Favour the ones that name a memory.')$$,
  'the guidelines are writable while the promotion is frozen by participations');

select throws_ok(
  $$select public.save_promotion_question(
      '00000000-0000-0000-0000-0000000024e1', 'ESSAY', 'Why is this your song?',
      null, null, '[]'::jsonb, '00000000-0000-0000-0000-0000000024a1')$$,
  '22023', null,
  'while save_promotion_question on the same question is refused — the freeze is intact');

select is(
  (select moderation_guidelines from public.promotion_questions
    where id = '00000000-0000-0000-0000-0000000024a1'),
  'Answers are arriving. Favour the ones that name a memory.',
  'the frozen write landed rather than merely not raising');

-- 12-13: blank is null, so a cleared box is "there is no guidance" rather than
-- guidance that is present and says nothing.
select lives_ok(
  $$select public.set_question_moderation_guidelines(
      '00000000-0000-0000-0000-0000000024a1', '   ')$$,
  'a blank submission is accepted');
select is(
  (select moderation_guidelines from public.promotion_questions
    where id = '00000000-0000-0000-0000-0000000024a1'),
  null,
  'a blank submission stores null rather than whitespace');

-- 14: a Quiz question, refused as a sentence rather than as a 23514 the
-- operator cannot read.
select throws_ok(
  $$select public.set_question_moderation_guidelines(
      '00000000-0000-0000-0000-0000000024a2', 'be generous')$$,
  '22023', null, 'a Quiz question is refused by the door with its own message');

-- 15: an unknown question, before any permission can be resolved from it.
select throws_ok(
  $$select public.set_question_moderation_guidelines(
      '00000000-0000-0000-0000-00000000dead', 'anything')$$,
  'P0002', null, 'an unknown question is P0002');

reset role;

-- 16: the audit row records THAT guidance changed, never the guidance. An audit
-- row is read by people who may hold audit.view and not promotions.view, and
-- copying the text into it would put the content somewhere its own permission
-- does not reach.
--
-- AFTER `reset role`, and that is not a convenience: audit_logs carries its own
-- select policy gated on audit.view (0138), which the editor above deliberately
-- does not hold — reading from inside that role would find nothing and report
-- the door as silent when it had in fact written three rows.
select ok(
  exists (
    select 1 from public.audit_logs
     where action = 'set_question_moderation_guidelines'
       and target_id = '00000000-0000-0000-0000-0000000024a1'
       and detail ? 'cleared'
       and detail::text not like '%memory%'
  ),
  'the audit row says whether guidance is present and never carries its text');

select * from finish();
rollback;
