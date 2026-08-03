-- Block 6c, Task 2: whether somebody got the quiz right.
--
-- 0052_participations.sql:172 said this would exist, on participation_answers:
--
--   "What the person answered, not whether they were right. Block 6 derives
--    correctness at draw time by joining promotion_question_options.is_correct;
--    storing a flag here would be a second place telling the same truth, and
--    Block 4a's D9 freeze -- no option may be reworded once somebody has chosen
--    it -- is what makes deriving it safe."
--
-- Block 4c wrote that instruction and Block 6a did not follow it: the draw
-- filtered on status, on the listener being alive and unblocked, and never once
-- looked at an answer. On a promotion with a question, the bicycle could go to
-- somebody who got it wrong.
--
-- ONE HOME, because two readers are coming: the participants list filters on
-- it (0090), and run_draw decides a permission by it (0078). The discipline
-- participation_status_for (0069) already holds for the entry rules.

create function public.promotion_participation_correctness(p_promotion_id uuid)
returns table (participation_id uuid, answered_correctly boolean)
language sql
stable
set search_path = pg_catalog, public
as $$
  select p.id,
         not exists (
           -- One row per QUIZ question this participation did NOT get right.
           --
           -- The LEFT JOIN on participation_answers is the whole of D6 and the
           -- reason this function is not two lines shorter: a question nobody
           -- answered produces a row here with a null option, coalesce turns
           -- that into "not correct", and the participation fails. An INNER
           -- join would drop the unanswered question from consideration
           -- entirely and quietly call the participation correct -- and every
           -- other case in 11_filtered_hat.test.sql passes either way, which is
           -- exactly why that file mutation-tests this join.
           --
           -- Not answering is not getting it right.
           select 1
           from public.promotion_questions q
           left join public.participation_answers a
             on a.participation_id = p.id and a.question_id = q.id
           left join public.promotion_question_options o
             on o.id = a.option_id
           where q.promotion_id = p_promotion_id
             -- MULTIPLE_CHOICE and ESSAY have no right answer to miss: 0041
             -- refuses is_correct on anything but a QUIZ, so a poll cannot make
             -- anybody wrong.
             and q.kind = 'QUIZ'
             and coalesce(o.is_correct, false) = false
         )
  from public.participations p
  where p.promotion_id = p_promotion_id;
$$;

comment on function public.promotion_participation_correctness(uuid) is
  'Whether each participation of a promotion answered its quiz correctly: true when EVERY question of kind QUIZ was answered with an option carrying is_correct. A question left UNANSWERED counts as not correct -- not answering is not getting it right -- which is what the left join to participation_answers buys and what an inner join would silently reverse. A promotion with no QUIZ question returns true for everybody, because there is nothing to get wrong and the alternative would make every draw on such a promotion demand the wrong-answer permission. THE ONE HOME of this rule (0052''s own comment predicted it, a block early): the participants list filters on it and run_draw decides draws.include_wrong_answers by it. Safe to derive rather than store because Block 4a''s D9 freeze forbids rewording an option once somebody has chosen it. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody.';

revoke execute on function public.promotion_participation_correctness(uuid) from public;

-- ---------------------------------------------------------------------------
-- Does this hat hold anybody who answered wrongly?
--
-- THE DERIVATION D7 rests on. With the hat supplied as ids there is no filter
-- on the wire to gate a permission with, and a label the browser sends is not a
-- gate: a caller could claim "everybody" and send only wrong answerers. So the
-- question is asked of the hat itself, and there is nothing to forge.
--
-- Two readers, one definition: run_draw checks it to decide whether
-- draws.include_wrong_answers is required, and apply_draw stores the answer on
-- the draw. Called twice per draw rather than threaded through a seventh
-- parameter -- it is `stable` and runs once per draw, and a parameter that can
-- disagree with the thing it describes is worse than a second scan.
--
-- Null or empty ids mean the whole eligible set, which is what "no filter"
-- looks like from here: on a promotion with a quiz that hat DOES contain wrong
-- answerers, and needing the permission for it is the consequence the spec
-- states out loud (D7).

create function public.draw_hat_has_wrong_answers(
  p_promotion_id      uuid,
  p_participation_ids uuid[]
)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.draw_eligible_participations(p_promotion_id) e
    join public.promotion_participation_correctness(p_promotion_id) c
      on c.participation_id = e.participation_id
    where not c.answered_correctly
      and (p_participation_ids is null
           or array_length(p_participation_ids, 1) is null
           or e.participation_id = any(p_participation_ids))
  );
$$;

comment on function public.draw_hat_has_wrong_answers(uuid, uuid[]) is
  'Whether the hat about to be drawn holds anybody who answered the quiz wrongly. Asked of the HAT rather than of a declared filter, which is the whole of D7: the browser supplies the participation ids, so there is no verifiable statement of intent on the wire and a label it sent would be a gate anybody could walk around. Read by run_draw to decide whether draws.include_wrong_answers is required and by apply_draw to record it. Null ids mean the whole eligible set -- which on a promotion with a quiz does contain wrong answerers, so drawing without filtering needs the permission too. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody.';

revoke execute on function public.draw_hat_has_wrong_answers(uuid, uuid[]) from public;
