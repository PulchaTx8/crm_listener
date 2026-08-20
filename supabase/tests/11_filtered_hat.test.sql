begin;
select plan(44);

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
  (id, promotion_id, organization_id, company_id, seed, algorithm_version, entry_count, offered_count)
values
  -- A completed draw of THIS promotion.
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1',
   repeat('c', 64), 1, 4, 4),
  -- A completed draw of a DIFFERENT promotion.
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-00000000c0e2',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1',
   repeat('d', 64), 1, 1, 1);

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
   offered_count, status, cancelled_at, cancelled_by, cancellation_reason)
values
  ('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-00000000c0e1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1',
   repeat('e', 64), 1, 4, 4, 'CANCELLED', now(),
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

-- ---------------------------------------------------------------------------
-- Task 4: the hat comes from the screen.
--
-- A fresh promotion per case, because the one above now has winners in it and
-- a failure here should name one rule.

create function pg_temp.seed_quiz_promotion(
  p_label   text,
  p_right   integer,
  p_wrong   integer,
  p_units   integer default 1,
  p_quiz    boolean default true
)
returns uuid
language plpgsql
as $$
declare
  v_org    uuid := '00000000-0000-0000-0000-00000000c0f1';
  v_co     uuid := '00000000-0000-0000-0000-00000000c0c1';
  v_prize  uuid := gen_random_uuid();
  v_promo  uuid := gen_random_uuid();
  v_link   uuid := gen_random_uuid();
  v_q      uuid := gen_random_uuid();
  v_ok     uuid := gen_random_uuid();
  v_bad    uuid := gen_random_uuid();
  v_member uuid;
  v_part   uuid;
  i integer;
begin
  insert into public.prizes (id, organization_id, company_id, name)
  values (v_prize, v_org, v_co, p_label || ' prize');
  insert into public.inventory_balances (company_id, prize_id, organization_id, available)
  values (v_co, v_prize, v_org, greatest(p_units, 1));
  insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at)
  values (v_promo, v_org, v_co, p_label, now() - interval '2 days', now() + interval '1 day');
  insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
  values (v_link, v_promo, v_prize, v_org, v_co);
  perform public.apply_inventory_movement(
    v_co, v_prize, 'PROMOTION_LINK'::public.inventory_movement_type, p_units,
    'available'::public.inventory_bucket, 'linked'::public.inventory_bucket, null, null, v_link);

  if p_quiz then
    insert into public.promotion_questions
      (id, promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
    values (v_q, v_promo, v_org, v_co, 1, 'QUIZ', p_label || '?', 'Pick', 'Answer');
    insert into public.promotion_question_options
      (id, question_id, kind, organization_id, company_id, position, label, is_correct)
    values (v_ok,  v_q, 'QUIZ', v_org, v_co, 1, 'Right', true),
           (v_bad, v_q, 'QUIZ', v_org, v_co, 2, 'Wrong', false);
  end if;

  for i in 1..(p_right + p_wrong) loop
    v_member := gen_random_uuid();
    v_part   := gen_random_uuid();
    insert into public.members (id, organization_id, full_name)
    values (v_member, v_org, p_label || ' listener ' || i);
    insert into public.member_company_links (member_id, company_id, organization_id)
    values (v_member, v_co, v_org);
    insert into public.participations
      (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
       status, source, participated_at)
    values (v_part, v_promo, v_member, v_org, v_co, false, 'VALID', 'MANUAL',
            now() - make_interval(hours => i));
    if p_quiz then
      insert into public.participation_answers
        (participation_id, promotion_id, question_id, kind, option_id, organization_id, company_id)
      values (v_part, v_promo, v_q, 'QUIZ',
              case when i <= p_right then v_ok else v_bad end, v_org, v_co);
    end if;
  end loop;

  return v_promo;
end;
$$;

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000c401', '00000000-0000-0000-0000-00000000c0f1', 'Draw plain'),
  ('00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-00000000c0f1', 'Draw chief');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000c401', 'promotions.view'),
  ('00000000-0000-0000-0000-00000000c401', 'draws.execute'),
  ('00000000-0000-0000-0000-00000000c402', 'promotions.view'),
  ('00000000-0000-0000-0000-00000000c402', 'draws.execute'),
  ('00000000-0000-0000-0000-00000000c402', 'draws.include_wrong_answers');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000c403', 'hat-plain@example.test'),
  ('00000000-0000-0000-0000-00000000c404', 'hat-chief@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000c403', '00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c401'),
  ('00000000-0000-0000-0000-00000000c404', '00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c402');

select is(
  (select count(*)::int from public.permissions where code = 'draws.include_wrong_answers'),
  1, 'the wrong-answer permission is in the catalogue');

create temporary table hat_promos as
select pg_temp.seed_quiz_promotion('Subset', 3, 2)          as subset,
       pg_temp.seed_quiz_promotion('Everybody', 2, 0)       as everybody,
       pg_temp.seed_quiz_promotion('Stranger', 2, 0)        as stranger,
       pg_temp.seed_quiz_promotion('Wrong hat', 1, 2)       as wrong_hat,
       pg_temp.seed_quiz_promotion('Wrong allowed', 1, 2)   as wrong_allowed,
       pg_temp.seed_quiz_promotion('No quiz', 2, 0, 1, false) as no_quiz;
grant select on hat_promos to authenticated;

-- Handy views of who is who, computed the way the screen would.
create temporary table correct_of as
select h.subset as promo, c.participation_id
from hat_promos h, public.promotion_participation_correctness(h.subset) c
where c.answered_correctly;
grant select on correct_of to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c403", "role": "authenticated"}';

-- A hat of the three correct answerers out of five participants.
create temporary table subset_draw as
select public.run_draw(
  (select subset from hat_promos), null,
  (select array_agg(participation_id) from correct_of)) as draw_id;

select is(
  (select count(*)::int from public.draw_entries e join subset_draw d on d.draw_id = e.draw_id),
  3, 'the hat is exactly the list the operator sent, not everybody eligible');

select is(
  (select offered_count from public.draws d join subset_draw s on s.draw_id = d.id),
  3, 'and offered_count records how many were on the list');

select ok(
  (select not included_wrong_answers from public.draws d join subset_draw s on s.draw_id = d.id),
  'a hat of only correct answerers is recorded as one');

-- No list at all: everybody eligible, and offered_count says so.
create temporary table everybody_draw as
select public.run_draw((select everybody from hat_promos), null, null) as draw_id;

select is(
  (select offered_count from public.draws d join everybody_draw e on e.draw_id = d.id),
  (select entry_count from public.draws d join everybody_draw e on e.draw_id = d.id),
  'drawing without a list offers everybody, and the two counts agree');

-- The refusals -----------------------------------------------------------------

select throws_ok(
  format($$select public.run_draw(%L::uuid, null, array[%L::uuid])$$,
         (select stranger from hat_promos),
         (select participation_id from correct_of limit 1)),
  '22023', null, 'a participation from another promotion refuses the whole draw');

select throws_ok(
  format($$select public.run_draw(%L::uuid, null, array[%L::uuid])$$,
         '00000000-0000-0000-0000-00000000c0e1',
         '00000000-0000-0000-0000-00000000c201'),
  '22023', null, 'and so does one belonging to somebody who already won here');

-- The permission, derived from the hat rather than from any label -------------

select throws_ok(
  format($$select public.run_draw(%L::uuid, null, null)$$, (select wrong_hat from hat_promos)),
  '42501', null,
  'a hat holding somebody who answered wrongly needs the chief, even with no filter at all');

select lives_ok(
  format($$select public.run_draw(%L::uuid, null, null)$$, (select no_quiz from hat_promos)),
  'a promotion with no quiz never asks for it: there is nothing to get wrong');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c404", "role": "authenticated"}';

create temporary table wrong_draw as
select public.run_draw((select wrong_allowed from hat_promos), null, null) as draw_id;

select ok(
  (select included_wrong_answers from public.draws d join wrong_draw w on w.draw_id = d.id),
  'the chief may draw it, and the draw records that the hat held wrong answers');

reset role;

-- ---------------------------------------------------------------------------
-- Task 5: the participants list, as one function.
--
-- The two new filters are the point of the change, but the keyset and the
-- search worked BEFORE it and are being re-expressed in SQL. Testing only what
-- is new would let this rewrite quietly regress the part nobody asked to
-- change, so both are walked directly.

select set_config('request.jwt.claims', null, true);

-- A listener with a findable name, phone and document, in a promotion of its
-- own so the paging assertions below count a known number of rows.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, min_hours_between_entries)
values
  ('00000000-0000-0000-0000-00000000c0e5', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', 'Listing promo', now() - interval '9 days',
   now() + interval '1 day', true, 1);

insert into public.members (id, organization_id, full_name, phone, cpf_last_digits) values
  ('00000000-0000-0000-0000-00000000c021', '00000000-0000-0000-0000-00000000c0f1',
   'Findable Person', '+55 11 98888-7777', '321');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-00000000c021', '00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0f1');

-- Five entries, one per day, so a page of two has a boundary to walk.
insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
select ('00000000-0000-0000-0000-00000000c3' || lpad(g::text, 2, '0'))::uuid,
       '00000000-0000-0000-0000-00000000c0e5', '00000000-0000-0000-0000-00000000c021',
       '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c0c1',
       true, 'VALID', 'MANUAL', now() - make_interval(days => g)
from generate_series(1, 5) as g;

-- Two operators: one who may read the audience, one who may not.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000c405', '00000000-0000-0000-0000-00000000c0f1', 'List with names'),
  ('00000000-0000-0000-0000-00000000c406', '00000000-0000-0000-0000-00000000c0f1', 'List without names');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000c405', 'participations.view'),
  ('00000000-0000-0000-0000-00000000c405', 'promotions.view'),
  ('00000000-0000-0000-0000-00000000c405', 'members.view'),
  ('00000000-0000-0000-0000-00000000c406', 'participations.view'),
  ('00000000-0000-0000-0000-00000000c406', 'promotions.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000c407', 'list-names@example.test'),
  ('00000000-0000-0000-0000-00000000c408', 'list-nonames@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000c407', '00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c405'),
  ('00000000-0000-0000-0000-00000000c408', '00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c406');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c407", "role": "authenticated"}';

-- The keyset, forwards ------------------------------------------------------

create temporary table page_one as
select * from public.list_participations(
  '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e5',
  null, null, null, null, null, null, null, null, null, false, 2);

select is((select count(*)::int from page_one), 2, 'a page of two returns two rows');
select is((select distinct total_count::int from page_one), 5,
          'and the total counts the whole filtered set, not the page');
-- Newest first, said as something that can be wrong: every row on this page is
-- more recent than every row that did not make it.
select is(
  (select array_agg(id order by participated_at desc) from page_one),
  array['00000000-0000-0000-0000-00000000c301'::uuid,
        '00000000-0000-0000-0000-00000000c302'::uuid],
  'the first page holds the two newest entries, in order');

create temporary table page_two as
select * from public.list_participations(
  '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e5',
  null, null, null, null, null, null, null,
  (select min(participated_at) from page_one),
  (select id from page_one order by participated_at limit 1),
  false, 2);

select is((select count(*)::int from page_two), 2, 'the next page returns the next two');
select ok(not exists (select 1 from page_two t2 join page_one t1 on t1.id = t2.id),
          'and no row appears on both pages: the cursor compares what it orders by');

-- The keyset, backwards -----------------------------------------------------

create temporary table walked_back as
select * from public.list_participations(
  '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e5',
  null, null, null, null, null, null, null,
  (select max(participated_at) from page_two),
  (select id from page_two order by participated_at desc limit 1),
  true, 2);

select ok(exists (select 1 from walked_back w join page_one p on p.id = w.id),
          'walking back from page two lands on page one again');

-- The search ----------------------------------------------------------------

select is(
  (select count(*)::int from public.list_participations(
     '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e5',
     null, null, null, null, 'Findable', null, null, null, null, false, 50)),
  5, 'a search by name finds the entries');

select is(
  (select count(*)::int from public.list_participations(
     '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e5',
     null, null, null, null, '98888', null, null, null, null, false, 50)),
  5, 'a search by phone digits finds them too');

select is(
  (select count(*)::int from public.list_participations(
     '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e5',
     null, null, null, null, '321', null, null, null, null, false, 50)),
  5, 'and so does the document''s last digits');

-- The two new filters -------------------------------------------------------

select is(
  (select count(*)::int from public.list_participations(
     '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e1',
     null, null, null, null, null, true, null, null, null, false, 50)),
  1, 'filtering to correct answerers returns only the one who got both right');

select is(
  (select count(*)::int from public.list_participations(
     '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e1',
     null, null, null, null, null, false, null, null, null, false, 50)),
  3, 'and filtering to the others returns the three who did not');

-- D5: the two AND rather than widen. Somebody who answered correctly but chose
-- a different option for the named question is absent from both together.
select is(
  (select count(*)::int from public.list_participations(
     '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e1',
     null, null, null, null, null, true, '00000000-0000-0000-0000-00000000c122',
     null, null, false, 50)),
  0, 'correct AND chose the wrong option is nobody, because the filters add');

select ok(
  (select bool_or(already_won) from public.list_participations(
     '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e1',
     null, null, null, null, null, null, null, null, null, false, 50)),
  'the list says who has already won here, so a row that vanishes next round is accounted for');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c408", "role": "authenticated"}';

-- Without members.view: the list still lists, the names do not come, and a
-- search returns nothing rather than matching a field this caller cannot read.
select ok(
  (select count(*) = 5 and bool_and(listener_name is null)
     from public.list_participations(
       '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e5',
       null, null, null, null, null, null, null, null, null, false, 50)),
  'a caller without members.view sees every row and no name');

select is(
  (select count(*)::int from public.list_participations(
     '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e5',
     null, null, null, null, 'Findable', null, null, null, null, false, 50)),
  0, 'and their search returns nothing, because searching a field you may not read is an oracle');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000004ff", "role": "authenticated"}';

select throws_ok($$
  select * from public.list_participations('00000000-0000-0000-0000-00000000c0c1')
$$, '42501', null, 'a stranger to the Station reads no list at all');

reset role;

-- The term the rewrite nearly lost. 0053's policy reads
--   has_permission('participations.view', company_id)
--   and promotion_id in (select id from public.promotions)
-- and that second half is not decoration: public.promotions is itself behind
-- RLS, so the policy silently required promotions.view too. A SECURITY DEFINER
-- function gating on participations.view alone would be MORE permissive than
-- the query it replaced.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000c409', '00000000-0000-0000-0000-00000000c0f1', 'Participations only');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000c409', 'participations.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000c40a', 'participations-only@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000c40a', '00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c409');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c40a", "role": "authenticated"}';

select throws_ok($$
  select * from public.list_participations('00000000-0000-0000-0000-00000000c0c1')
$$, '42501', null,
  'participations.view without promotions.view reads nothing, exactly as 0053''s policy already refused');

reset role;

-- ---------------------------------------------------------------------------
-- The OTHER term the rewrite lost, found by tests/isolation rather than here.
--
-- 0044's promotions policy is `deleted_at is null or is_owner_of_company(...)`,
-- and 0053's participations policy inherited it for nothing through the
-- `promotion_id in (select id from public.promotions)` sub-select. A SECURITY
-- DEFINER function inherits nothing, so an archived promotion's entries listed
-- for everybody until 0090 restated the rule.
--
-- Both halves, because the exclusion alone would be satisfied by hiding an
-- archived promotion from the owner too -- and the owner is precisely who 0044
-- keeps it visible for.

-- The owner of the Organization, inserted first because an archived promotion
-- has to name who archived it (promotions_archival_shape, 0040) and because the
-- second half of this section reads as them.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000c40b', 'hat-owner@example.test');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000c0f1', '00000000-0000-0000-0000-00000000c40b', 'owner');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, deleted_at, deleted_by)
values
  ('00000000-0000-0000-0000-00000000c0e9', '00000000-0000-0000-0000-00000000c0f1',
   '00000000-0000-0000-0000-00000000c0c1', 'Archived promo', now() - interval '9 days',
   now() - interval '1 day', now(), '00000000-0000-0000-0000-00000000c40b');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000c309', '00000000-0000-0000-0000-00000000c0e9',
   '00000000-0000-0000-0000-00000000c021', '00000000-0000-0000-0000-00000000c0f1',
   -- false, matching this promotion's own allow_multiple_entries: the composite
   -- foreign key participations_allows_multiple_fk carries the flag so the
   -- one-per-member unique index can be partial on it (0052).
   '00000000-0000-0000-0000-00000000c0c1', false, 'VALID', 'MANUAL', now() - interval '6 hours');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c407", "role": "authenticated"}';

select is(
  (select count(*)::int from public.list_participations(
     '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e9',
     null, null, null, null, null, null, null, null, null, false, 50)),
  0,
  'a delegate reads no entry of an archived promotion, however directly they ask for it');

select ok(
  not exists (
    select 1 from public.list_participations(
      '00000000-0000-0000-0000-00000000c0c1',
      null, null, null, null, null, null, null, null, null, null, false, 200) r
    where r.id = '00000000-0000-0000-0000-00000000c309'),
  'and it is absent from the Station''s list as a whole, not merely un-navigable');

reset role;

-- And the owner, for whom an archived row is still readable: they are the one
-- who resolves discrepancies, and cannot do it blind (0044).
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c40b", "role": "authenticated"}';

select is(
  (select count(*)::int from public.list_participations(
     '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0e9',
     null, null, null, null, null, null, null, null, null, false, 50)),
  1,
  'the Organization''s owner still reads it, which is what 0044 keeps the row visible for');

reset role;

-- Block 30a D1's structural pin, mirroring 51_music_request_triage.test.sql's
-- own idiom for list_music_requests -- its assertion 18, the
-- pg_get_function_result probe, named here rather than by a line number that
-- Task 8 already found gone stale once: asked of the function's RESULT shape
-- rather than of a row, because a column that was removed cannot be selected
-- to prove its own absence -- the query would fail to parse rather than fail
-- an assertion, and a parse error is not a test result. The
-- populated/withheld pair itself needs a REAL second user
-- with a REAL, narrower grant, which is exactly why this file leaves that
-- half to tests/isolation/participations.test.ts -- this assertion is the
-- cheap, always-on half: the whole number has no column to travel through
-- at all, whoever is asking.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'list_participations'
      and pg_get_function_result(p.oid) like '%listener_phone_last4%'
      and pg_get_function_result(p.oid) not like '%listener_phone text%'),
  1, 'list_participations offers four digits and no whole-number column at all');

select * from finish();
rollback;
