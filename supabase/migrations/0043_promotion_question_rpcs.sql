-- supabase/migrations/0043_promotion_question_rpcs.sql
--
-- A question and its options are written in ONE call. They are one form on
-- screen, and splitting them would let a question exist for an instant with no
-- options at all, or still carrying the previous version's — the same reasoning
-- that keeps a role's two halves in one submission (Block 3c).

-- p_question_id comes last and defaults to null on purpose: omitting it is what
-- means "append a new question", which is the commoner call and the one whose
-- intent should read at the call site rather than as a bare null in the middle
-- of the arguments.
create or replace function public.save_promotion_question(
  p_promotion_id uuid,
  p_kind         public.promotion_question_kind,
  p_prompt       text,
  p_menu_title   text default null,
  p_button_label text default null,
  p_options      jsonb default '[]'::jsonb,
  p_question_id  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_company  uuid;
  v_id       uuid := p_question_id;
  v_prompt   text := nullif(btrim(coalesce(p_prompt, '')), '');
  v_menu     text := nullif(btrim(coalesce(p_menu_title, '')), '');
  v_button   text := nullif(btrim(coalesce(p_button_label, '')), '');
  v_options  jsonb := coalesce(p_options, '[]'::jsonb);
  v_count    integer := jsonb_array_length(v_options);
  v_correct  integer;
  v_position integer;
begin
  -- FOR UPDATE on the promotion, not the question: a new question has no row to
  -- lock, and the next position is read from its siblings. Holding the parent
  -- is what stops two concurrent adds picking the same number.
  select organization_id, company_id into v_org, v_company
  from public.promotions
  where id = p_promotion_id and deleted_at is null
    for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.edit', v_company) then
    raise log 'save_promotion_question denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.edit required' using errcode = '42501';
  end if;

  if v_prompt is null then
    raise exception 'the question needs a prompt' using errcode = '22023';
  end if;

  if jsonb_typeof(v_options) <> 'array' then
    raise exception 'options must be a list' using errcode = '22023';
  end if;

  select count(*) into v_correct
  from jsonb_array_elements(v_options) as o
  where coalesce((o ->> 'is_correct')::boolean, false);

  -- The three rules the schema cannot state. The first is the important one:
  -- a partial unique index forbids the SECOND right answer, and nothing can
  -- require a FIRST. This is the only place that rule exists, which is why it
  -- is checked before anything is written rather than after.
  if p_kind = 'QUIZ' and v_correct <> 1 then
    raise exception 'a quiz question needs exactly one right answer, and % were marked', v_correct
      using errcode = '22023';
  end if;

  if p_kind = 'ESSAY' and v_count > 0 then
    raise exception 'an essay question takes no options' using errcode = '22023';
  end if;

  if p_kind <> 'ESSAY' and v_count < 2 then
    raise exception 'a choice question needs at least two options, and % were given', v_count
      using errcode = '22023';
  end if;

  if v_id is null then
    select coalesce(max(position), 0) + 1 into v_position
    from public.promotion_questions
    where promotion_id = p_promotion_id;

    insert into public.promotion_questions
      (promotion_id, organization_id, company_id, position, kind, prompt,
       menu_title, button_label)
    values
      (p_promotion_id, v_org, v_company, v_position, p_kind, v_prompt,
       v_menu, v_button)
    returning id into v_id;
  else
    -- Options are replaced wholesale below, so they must go before the kind
    -- changes: an option row still marked correct would make a QUIZ-to-poll
    -- edit fail on the cascade, refusing an edit the operator has already
    -- corrected on screen.
    delete from public.promotion_question_options where question_id = v_id;

    update public.promotion_questions set
      kind         = p_kind,
      prompt       = v_prompt,
      menu_title   = v_menu,
      button_label = v_button,
      updated_at   = now()
    where id = v_id and promotion_id = p_promotion_id;

    if not found then
      raise exception 'question not found in this promotion: %', v_id using errcode = 'P0002';
    end if;
  end if;

  insert into public.promotion_question_options
    (question_id, kind, organization_id, company_id, position, label, is_correct)
  select
    v_id, p_kind, v_org, v_company, o.ordinality,
    btrim(o.value ->> 'label'),
    coalesce((o.value ->> 'is_correct')::boolean, false)
  from jsonb_array_elements(v_options) with ordinality as o(value, ordinality);

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_promotion_question', 'promotion_questions', v_id, v_org, v_company,
     jsonb_build_object('promotion_id', p_promotion_id, 'kind', p_kind, 'options', v_count));

  return v_id;
end;
$$;

comment on function public.save_promotion_question(uuid, public.promotion_question_kind, text, text, text, jsonb, uuid) is
  'Writes a question and its options in one call — they are one form, and splitting them would let a question exist with no options or with the previous version''s. A null p_question_id appends; a given one replaces, options included. Gated on promotions.edit. Holds "exactly one right answer on a QUIZ", which no index can express: an index forbids the second and nothing can require the first.';

create or replace function public.remove_promotion_question(p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor      uuid := auth.uid();
  v_org        uuid;
  v_company    uuid;
  v_promotion  uuid;
begin
  select q.organization_id, q.company_id, q.promotion_id
    into v_org, v_company, v_promotion
  from public.promotion_questions q
  join public.promotions p on p.id = q.promotion_id and p.deleted_at is null
  where q.id = p_question_id
    for update of q;

  if not found then
    raise exception 'question not found: %', p_question_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.edit', v_company) then
    raise log 'remove_promotion_question denied: actor=% question=%', v_actor, p_question_id;
    raise exception 'permission denied: promotions.edit required' using errcode = '42501';
  end if;

  delete from public.promotion_question_options where question_id = p_question_id;
  delete from public.promotion_questions        where id = p_question_id;

  -- Renumbering is deliberately not done. The remaining questions keep the
  -- numbers they had; a gap orders exactly as well as a dense sequence, and
  -- renumbering would rewrite rows nobody asked to touch.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'remove_promotion_question', 'promotion_questions', p_question_id,
     v_org, v_company, jsonb_build_object('promotion_id', v_promotion));
end;
$$;

comment on function public.remove_promotion_question(uuid) is
  'Deletes a question and its options outright — neither table carries deleted_at, because removal is only ever permitted while nothing points at the question (Block 4c enforces that). Gated on promotions.edit. Leaves the position gap rather than renumbering its siblings.';
