-- supabase/migrations/0197_question_moderation_guidelines.sql

-- Block 24, item 5: what a Poll question tells the person READING the answers.
--
-- A Quiz has a right answer, and `is_correct` is where that lives. A Poll has
-- listeners writing sentences, and somebody sitting down afterwards to read
-- three hundred of them with no idea what the promotion was actually looking
-- for. That guidance is what this column carries.
--
-- IT IS INTERNAL, AND THAT IS A REQUIREMENT RATHER THAN A DESCRIPTION. No
-- listener is ever shown it. It is deliberately absent from every prompt
-- context (`0070`, `0071`, `0114` build theirs field by field and this is not
-- among them), from the widget's reads, and from the public API. The question's
-- `prompt` is what a listener sees; this is what a reader sees.

alter table public.promotion_questions
  add column moderation_guidelines text;

-- ESSAY ONLY, and enforced rather than assumed. A Quiz question has right
-- answers rather than judgement calls, so guidance on one would be guidance
-- nobody reads — and a nullable column with no such constraint eventually holds
-- a value nobody can interpret, which is the argument `0193` makes for its own
-- three checks and `0045` made before it.
--
-- MULTIPLE_CHOICE is on the forbidden side with QUIZ. It is deprecated (the
-- operator cannot choose it any more; `quiz-tab.tsx` says why it cannot be
-- deleted either), it also picks from options rather than collecting writing,
-- and admitting it here would be widening a rule for a kind nobody can create.
alter table public.promotion_questions
  add constraint promotion_questions_guidelines_shape check (
    kind = 'ESSAY' or moderation_guidelines is null
  );

comment on column public.promotion_questions.moderation_guidelines is
  'What a Poll question tells whoever reads its answers. INTERNAL: never sent to a listener, never part of a prompt context, never returned by a widget or API read. ESSAY only, by promotion_questions_guidelines_shape, which promotion_questions_retire_guidelines keeps true across a change of kind.';

-- WHAT THE CONSTRAINT ABOVE WOULD OTHERWISE BREAK.
--
-- save_promotion_question's REPLACE branch (0055) is an UPDATE that sets kind,
-- prompt, menu_title, button_label and updated_at — and nothing else, because
-- nothing else existed when it was written. So an operator turning a Poll that
-- carries guidelines into a Quiz would have the row fail
-- promotion_questions_guidelines_shape: kind becomes QUIZ, the guidelines stay,
-- and the check refuses an edit the operator has every right to make. It would
-- arrive as a 23514, which maps to InternalError and reaches them as "Could not
-- save" with nothing to act on.
--
-- A trigger rather than the two alternatives:
--
--   * Widening save_promotion_question means recreating a long function that
--     0055 already rewrote once — the defect this repository has shipped three
--     times, where a recreation from the original migration silently reverts
--     every fix made since.
--   * Clearing the guidelines from the caller first means the screen ordering
--     two writes to keep one invariant, and a second caller one day not knowing
--     to.
--
-- NULLING RATHER THAN REFUSING IS THE HONEST SEMANTICS, not a convenience:
-- guidance for reading written answers is meaningless on a question that has
-- stopped collecting writing. Turning a Poll into a Quiz retires the guidance
-- with it, exactly as it already retires the written answers' whole shape.
create function public.promotion_questions_retire_guidelines()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.kind <> 'ESSAY' then
    new.moderation_guidelines := null;
  end if;
  return new;
end;
$$;

comment on function public.promotion_questions_retire_guidelines() is
  'Keeps promotion_questions_guidelines_shape true across a change of kind. Guidance for reading written answers is meaningless on a question that no longer collects writing, so turning a Poll into a Quiz retires it rather than refusing the edit. Exists because save_promotion_question (0055) updates a fixed column list that predates this column.';

create trigger promotion_questions_retire_guidelines
  before insert or update on public.promotion_questions
  for each row execute function public.promotion_questions_retire_guidelines();

-- THE DOOR, AND WHY IT IS ITS OWN DOOR RATHER THAN A PARAMETER ON
-- save_promotion_question.
--
-- `0055` refuses that function's REPLACE branch outright once ANY participation
-- exists on the promotion, and the reason is exact: rewording an option — or
-- moving is_correct onto a different one — would leave every
-- participation_answers row pointing at text the person never read, and the draw
-- derives correctness by reading exactly that option back.
--
-- None of that reaches these guidelines. They are not shown to a listener, so no
-- answer was given in reliance on them; nothing points at them; the draw does
-- not read them. And the field is USELESS under that freeze, because the only
-- moment anybody needs it is while answers are arriving — which is, by
-- definition, after the first participation.
--
-- So the freeze does not apply here, and the way to say that without weakening
-- it for everything else is a second door that writes this column and nothing
-- else. Widening save_promotion_question would also have meant recreating a long
-- function that `0055` already rewrote once, which is the defect this repository
-- has shipped three times (`0113`, Block 17b, Block 17c): a recreation from the
-- original migration silently reverts every fix made since.
create function public.set_question_moderation_guidelines(
  p_question_id  uuid,
  p_guidelines   text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor      uuid := auth.uid();
  v_org        uuid;
  v_company    uuid;
  v_kind       public.promotion_question_kind;
  v_promotion  uuid;
  -- Blank stores null. An operator clearing the box means "there is no
  -- guidance", and a row holding '   ' would render as guidance that is there
  -- and says nothing.
  v_text       text := nullif(btrim(coalesce(p_guidelines, '')), '');
begin
  -- The join to promotions is what carries the archived-promotion rule, exactly
  -- as remove_promotion_question's own read does: a question whose promotion has
  -- been archived is not editable through this door either.
  select q.organization_id, q.company_id, q.kind, q.promotion_id
    into v_org, v_company, v_kind, v_promotion
  from public.promotion_questions q
  join public.promotions p on p.id = q.promotion_id and p.deleted_at is null
  where q.id = p_question_id
    for update of q;

  if not found then
    raise exception 'question not found: %', p_question_id using errcode = 'P0002';
  end if;

  -- Permission before existence of anything else, the house order.
  if not public.has_permission('promotions.edit', v_company) then
    raise log 'set_question_moderation_guidelines denied: actor=% question=%', v_actor, p_question_id;
    raise exception 'permission denied: promotions.edit required' using errcode = '42501';
  end if;

  -- The check constraint would refuse this too, as a 23514 that reaches the
  -- operator as a generic "Could not save". Said here first, so the refusal
  -- arrives as a sentence — the same reason every door in this schema restates
  -- a constraint it could have left to Postgres.
  if v_kind <> 'ESSAY' then
    raise exception 'only a Poll question has moderation guidelines' using errcode = '22023';
  end if;

  -- DELIBERATELY NO PARTICIPATION CHECK. See this file's header.
  update public.promotion_questions
     set moderation_guidelines = v_text,
         updated_at            = now()
   where id = p_question_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'set_question_moderation_guidelines', 'promotion_questions', p_question_id,
     v_org, v_company,
     -- The TEXT IS NOT LOGGED, only whether there is any. An audit row is read
     -- by people who may hold audit.view and not promotions.view, and copying
     -- the guidance into it would put the content somewhere its own permission
     -- does not reach.
     jsonb_build_object('promotion_id', v_promotion, 'cleared', v_text is null));
end;
$$;

comment on function public.set_question_moderation_guidelines(uuid, text) is
  'Writes a Poll question''s internal moderation guidelines and nothing else. Gated on promotions.edit. Refuses a non-ESSAY question with 22023 and an archived promotion''s question with P0002. UNAFFECTED BY THE PARTICIPATION FREEZE 0055 applies to save_promotion_question, and that is the reason this door exists: the guidelines are never shown to a listener, nothing points at them, and the draw does not read them — so no answer can be invalidated by changing them, while the only moment anybody needs the field is after the first participation. Blank stores null. The audit row records whether guidance is present, never the guidance itself.';

revoke execute on function public.set_question_moderation_guidelines(uuid, text) from public;
grant execute on function public.set_question_moderation_guidelines(uuid, text) to authenticated;
