begin;
select plan(13);

-- Block 6c: the filtered hat.
--
-- Fixtures live in the ...00c0xx range. 09_draws owns ...00a0xx-...00a3xx and
-- 10_delivery owns ...00b0xx-...00b4xx.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000c0f1', 'Org 6c hat');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0f1',
   'Station 6c hat', 'America/Sao_Paulo');

-- ---------------------------------------------------------------------------
-- A promotion with TWO quiz questions. Two rather than one on purpose: D6 says
-- correct means EVERY quiz question, and a fixture with one cannot tell that
-- apart from "correct means any".

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, min_hours_between_entries)
values
  ('00000000-0000-0000-0000-00000000c0e1', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', 'Quiz promo', now() - interval '2 days',
   now() + interval '1 day', true, 1);

insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
values
  ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1',
   1, 'QUIZ', 'Who recorded Garota de Ipanema?', 'Pick one', 'Answer'),
  ('00000000-0000-0000-0000-00000000c0a2', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1',
   2, 'QUIZ', 'In what year?', 'Pick one', 'Answer');

insert into public.promotion_question_options
  (id, question_id, kind, organization_id, company_id, position, label, is_correct)
values
  ('00000000-0000-0000-0000-00000000c111', '00000000-0000-0000-0000-00000000c0a1', 'QUIZ',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1', 1, 'Tom Jobim', true),
  ('00000000-0000-0000-0000-00000000c112', '00000000-0000-0000-0000-00000000c0a1', 'QUIZ',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1', 2, 'Joao Gilberto', false),
  ('00000000-0000-0000-0000-00000000c121', '00000000-0000-0000-0000-00000000c0a2', 'QUIZ',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1', 1, '1962', true),
  ('00000000-0000-0000-0000-00000000c122', '00000000-0000-0000-0000-00000000c0a2', 'QUIZ',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1', 2, '1970', false);

-- Four listeners, one participation each, one per case.
insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000c011', '00000000-0000-0000-0000-00000000c0f1', 'Both right'),
  ('00000000-0000-0000-0000-00000000c012', '00000000-0000-0000-0000-00000000c0f1', 'One wrong'),
  ('00000000-0000-0000-0000-00000000c013', '00000000-0000-0000-0000-00000000c0f1', 'One unanswered'),
  ('00000000-0000-0000-0000-00000000c014', '00000000-0000-0000-0000-00000000c0f1', 'Answered nothing');

insert into public.member_company_links (member_id, company_id, organization_id)
select id, '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0f1'
from public.members where organization_id = '00000000-0000-0000-0000-00000000c0f1';

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c011', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', true, 'VALID', 'MANUAL', now() - interval '5 hours'),
  ('00000000-0000-0000-0000-00000000c202', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c012', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', true, 'VALID', 'MANUAL', now() - interval '4 hours'),
  ('00000000-0000-0000-0000-00000000c203', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c013', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', true, 'VALID', 'MANUAL', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-00000000c204', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c014', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', true, 'VALID', 'MANUAL', now() - interval '2 hours');

insert into public.participation_answers
  (participation_id, promotion_id, question_id, kind, option_id, organization_id, company_id)
values
  -- Both right.
  ('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0a1', 'QUIZ', '00000000-0000-0000-0000-00000000c111',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1'),
  ('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0a2', 'QUIZ', '00000000-0000-0000-0000-00000000c121',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1'),
  -- First right, second wrong.
  ('00000000-0000-0000-0000-00000000c202', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0a1', 'QUIZ', '00000000-0000-0000-0000-00000000c111',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1'),
  ('00000000-0000-0000-0000-00000000c202', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0a2', 'QUIZ', '00000000-0000-0000-0000-00000000c122',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1'),
  -- First right, second never answered. THE case (D6).
  ('00000000-0000-0000-0000-00000000c203', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0a1', 'QUIZ', '00000000-0000-0000-0000-00000000c111',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1');
  -- c204 answered nothing at all.

create temporary table correctness as
select * from public.promotion_participation_correctness('00000000-0000-0000-0000-00000000c0e1');

select ok((select answered_correctly from correctness
            where participation_id = '00000000-0000-0000-0000-00000000c201'),
          'answering every quiz question correctly is answering correctly');

select ok(not (select answered_correctly from correctness
                where participation_id = '00000000-0000-0000-0000-00000000c202'),
          'getting the second one wrong is not: D6 means EVERY quiz question');

-- The term a mutation test exists for. An inner join would silently call this
-- participation correct, and every other case here would still pass.
select ok(not (select answered_correctly from correctness
                where participation_id = '00000000-0000-0000-0000-00000000c203'),
          'leaving a quiz question unanswered is not getting it right');

select ok(not (select answered_correctly from correctness
                where participation_id = '00000000-0000-0000-0000-00000000c204'),
          'and answering nothing at all is certainly not');

-- ---------------------------------------------------------------------------
-- A promotion with no quiz at all, and one whose only question is a poll.
--
-- Both return true for everybody: there is nothing to get wrong. The
-- alternative would make every draw on such a promotion demand the
-- wrong-answer permission, which would be absurd.

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-00000000c0e2', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', 'No quiz', now() - interval '2 days', now() + interval '1 day'),
  ('00000000-0000-0000-0000-00000000c0e3', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', 'Poll only', now() - interval '2 days', now() + interval '1 day');

insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
values
  ('00000000-0000-0000-0000-00000000c0a3', '00000000-0000-0000-0000-00000000c0e3',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1',
   1, 'MULTIPLE_CHOICE', 'Which do you prefer?', 'Pick one', 'Answer');

insert into public.promotion_question_options
  (id, question_id, kind, organization_id, company_id, position, label)
values
  ('00000000-0000-0000-0000-00000000c131', '00000000-0000-0000-0000-00000000c0a3', 'MULTIPLE_CHOICE',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1', 1, 'Rock'),
  ('00000000-0000-0000-0000-00000000c132', '00000000-0000-0000-0000-00000000c0a3', 'MULTIPLE_CHOICE',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1', 2, 'Samba');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000c205', '00000000-0000-0000-0000-00000000c0e2',
   '00000000-0000-0000-0000-00000000c011', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', false, 'VALID', 'MANUAL', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000c206', '00000000-0000-0000-0000-00000000c0e3',
   '00000000-0000-0000-0000-00000000c012', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', false, 'VALID', 'MANUAL', now() - interval '2 hours');

select ok((select answered_correctly from
            public.promotion_participation_correctness('00000000-0000-0000-0000-00000000c0e2')
            where participation_id = '00000000-0000-0000-0000-00000000c205'),
          'a promotion with no quiz has nothing to get wrong, so everybody is correct');

select ok((select answered_correctly from
            public.promotion_participation_correctness('00000000-0000-0000-0000-00000000c0e3')
            where participation_id = '00000000-0000-0000-0000-00000000c206'),
          'and a poll has no right answer to miss, even unanswered');

select is(
  (select count(*)::int from
    public.promotion_participation_correctness('00000000-0000-0000-0000-00000000c0e1')),
  4, 'every participation of the promotion gets a verdict, not only the answered ones');

select ok(not has_function_privilege('authenticated',
            'public.promotion_participation_correctness(uuid)', 'EXECUTE'),
          'the correctness rule is a private core, like every other rule body here');

select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'promotion_participation_correctness'
             and p.provolatile = 's'),
  'and it is stable: it reads rows and returns the same answer within a statement');

-- ---------------------------------------------------------------------------
-- Task 3: nobody wins twice in one promotion (D4, revising 6a's D2).
--
-- Winners are inserted by hand rather than through run_draw: what is under test
-- is who eligibility lets through, and driving the whole RPC would make a
-- failure here mean four different things.

insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', 'Bicycle 6c');
insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id) values
  ('00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1'),
  ('00000000-0000-0000-0000-00000000c0b2', '00000000-0000-0000-0000-00000000c0e2',
   '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1');

insert into public.draws
  (id, promotion_id, organization_id, company_id, seed, algorithm_version, entry_count)
values
  -- A completed draw of THIS promotion.
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1',
   repeat('c', 64), 1, 4),
  -- A completed draw of a DIFFERENT promotion.
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-00000000c0e2',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1',
   repeat('d', 64), 1, 1);

-- And one of this promotion that was cancelled. Its columns are set by hand
-- rather than through cancel_draw (0079), which needs a signed-in caller
-- holding draws.cancel -- and this case is about eligibility, not about who
-- may cancel.
-- draws_cancellation_shape wants all three facts or none, so the canceller has
-- to be a real user: a cancelled draw that cannot say who cancelled it is the
-- one thing that constraint exists to refuse.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000c0aa', 'hat-canceller@example.test');

insert into public.draws
  (id, promotion_id, organization_id, company_id, seed, algorithm_version, entry_count,
   status, cancelled_at, cancelled_by, cancellation_reason)
values
  ('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1',
   repeat('e', 64), 1, 4, 'CANCELLED', now(),
   '00000000-0000-0000-0000-00000000c0aa', 'drawn by mistake');

insert into public.winners
  (draw_id, company_id, promotion_prize_id, member_id, participation_id, awarded_rank, status)
values
  -- Won here, still awaiting pickup.
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000c011',
   '00000000-0000-0000-0000-00000000c201', 1, 'AWAITING_PICKUP'),
  -- Won here, and the prize came back to stock afterwards. They still won.
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000c014',
   '00000000-0000-0000-0000-00000000c204', 2, 'RETURNED'),
  -- Won a DIFFERENT promotion.
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0b2', '00000000-0000-0000-0000-00000000c012',
   '00000000-0000-0000-0000-00000000c205', 1, 'AWAITING_PICKUP'),
  -- Won a draw that was then cancelled: nothing was won.
  ('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000c013',
   '00000000-0000-0000-0000-00000000c203', 1, 'AWAITING_PICKUP');

create temporary table still_eligible as
select * from public.draw_eligible_participations('00000000-0000-0000-0000-00000000c0e1');

select ok(not exists (select 1 from still_eligible
                       where member_id = '00000000-0000-0000-0000-00000000c011'),
          'somebody who already won in this promotion is out of the next round');

select ok(exists (select 1 from still_eligible
                   where member_id = '00000000-0000-0000-0000-00000000c012'),
          'winning a DIFFERENT promotion takes nothing away here: the rule is per promotion');

select ok(exists (select 1 from still_eligible
                   where member_id = '00000000-0000-0000-0000-00000000c013'),
          'a cancelled draw undid itself, so its winner is eligible again');

select ok(not exists (select 1 from still_eligible
                       where member_id = '00000000-0000-0000-0000-00000000c014'),
          'a prize returned to stock does not un-win it: they won, and what happened next is another fact');

select * from finish();
rollback;
