-- supabase/migrations/0186_widget_promotions_require_options.sql

-- Block 20a, item 2. A promotion that cannot be completed is no longer
-- offered.
--
-- 0041 constrains the option rows that exist -- not ESSAY, correct only on
-- QUIZ, unique positions -- and cannot constrain how MANY there are, because a
-- CHECK may not count rows in another table. So a MULTIPLE_CHOICE or QUIZ
-- question with zero options is a legal promotion, 0173 answers '[]' for it,
-- and enter-promotion.tsx draws such a question as nothing at all -- which is
-- the right call there (a text box would trip participation_answers_shape,
-- 0052, on every answer) and leaves the listener tapping through a blank
-- screen into a refusal they cannot act on.
--
-- SAME TREATMENT AS A PROMOTION WITH NO RULES, and that is the argument: D3
-- already decided that a promotion the widget cannot present honestly is
-- absent rather than broken on screen. This is the second thing that makes a
-- promotion impossible to present, and it gets the same answer.
--
-- RESTATED IN THE DOOR, NOT TRUSTED FROM THE LIST -- the words are
-- widget_enter_promotion's own, about the two conditions it already restates.
-- A browser holding a list drawn before the options were deleted would
-- otherwise submit against a promotion this migration just hid.
--
-- WHATSAPP IS DELIBERATELY UNTOUCHED. The bot composes its buttons from the
-- question row when it sends the message, so an optionless question fails
-- there in a different place and in a different way; that door is not what the
-- owner reported and is not repaired here.

create or replace function public.widget_promotions(
  p_public_key text,
  p_member_id  uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v record;
begin
  select * into v from public.widget_listener_context(p_public_key, p_member_id);
  if v.o_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v.o_reason);
  end if;

  return jsonb_build_object(
    'ok', true,
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',              p.id,
               'name',            p.name,
               'rules',           p.rules,
               'art_url',         p.art_url,
               'thumb_url',       p.thumb_url,
               'steps',           public.whatsapp_conversation_steps(p.id, p_member_id),
               -- The alternatives, keyed by question so the panel can find the
               -- ones belonging to the step it is drawing. `is_correct` is NOT
               -- here and must never be: it is the answer sheet, and this
               -- payload is rendered in a browser the listener controls.
               'questions', coalesce((
                 select jsonb_object_agg(q.id::text, q.options)
                   from (
                     select q.id,
                            coalesce((
                              select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label)
                                               order by o.position)
                                from public.promotion_question_options o
                               where o.question_id = q.id), '[]'::jsonb) as options
                       from public.promotion_questions q
                      where q.promotion_id = p.id
                   ) q), '{}'::jsonb),
               'already_entered', exists (
                 select 1 from public.participations pa
                  where pa.promotion_id = p.id
                    and pa.member_id = p_member_id
                    and pa.status = 'VALID'))
             order by p.ends_at)
        from public.promotions p
       where p.company_id = v.o_company
         and p.deleted_at is null
         and p.cancelled_at is null
         and p.web_enabled
         and p.rules is not null
         and btrim(p.rules) <> ''
         and now() between p.starts_at and p.ends_at
         -- AND NOTHING IN IT THAT CANNOT BE ANSWERED. A question with
         -- alternatives and no alternative rows is a step the panel draws as
         -- nothing and the door below then counts as unanswered, so the
         -- promotion is withheld whole rather than offered as a walk that ends
         -- in a refusal.
         --
         -- ESSAY IS EXCLUDED ON PURPOSE, not overlooked: an open question has
         -- no options by design -- 0041 forbids them -- and catching it here
         -- would hide every promotion that asks anything in prose.
         and not exists (
           select 1
             from public.promotion_questions q
            where q.promotion_id = p.id
              and q.kind <> 'ESSAY'
              and not exists (
                select 1 from public.promotion_question_options o
                 where o.question_id = q.id))), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------

create or replace function public.widget_enter_promotion(
  p_public_key   text,
  p_member_id    uuid,
  p_promotion_id uuid,
  p_consent      boolean,
  p_fields       jsonb default '{}'::jsonb,
  p_answers      jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v         record;
  v_steps   jsonb;
  v_missing integer;
  v_result  jsonb;
  v_id      uuid;
  v_status  text;
begin
  select * into v from public.widget_listener_context(p_public_key, p_member_id);
  if v.o_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v.o_reason);
  end if;

  -- THE PROMOTION IS RESOLVED AGAINST THE STATION THE KEY NAMES. A caller
  -- handing us a promotion id from another Station gets the same answer as one
  -- naming a promotion that never existed.
  if not exists (
    select 1 from public.promotions p
     where p.id = p_promotion_id
       and p.company_id = v.o_company
       and p.deleted_at is null
       and p.cancelled_at is null
       -- The same three conditions the list applies, restated rather than
       -- trusted: a promotion unticked, emptied of its rules, or emptied of a
       -- question's alternatives between the list rendering and this
       -- submission must not be entered.
       and p.web_enabled
       and p.rules is not null
       and btrim(p.rules) <> ''
       and now() between p.starts_at and p.ends_at
       -- The third condition, added by 0186. Without it this door answers
       -- missing_answers for a question the listener was never shown --
       -- blaming the visitor for the configuration -- where promotion_closed
       -- is both true and actionable.
       and not exists (
         select 1
           from public.promotion_questions q
          where q.promotion_id = p.id
            and q.kind <> 'ESSAY'
            and not exists (
              select 1 from public.promotion_question_options o
               where o.question_id = q.id))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'promotion_closed');
  end if;

  -- DECLINING IS A REAL PATH, not an abandonment, and it is recorded in the
  -- same table the WhatsApp flow writes -- stamped with the door it came
  -- through, which is what the source column on that table is for.
  if not coalesce(p_consent, false) then
    insert into public.promotion_refusals
      (promotion_id, member_id, organization_id, company_id, source)
    values
      (p_promotion_id, p_member_id, v.o_org, v.o_company, 'WEB');

    return jsonb_build_object('ok', false, 'reason', 'refused');
  end if;

  -- THE STEP LIST IS RECOMPUTED HERE, and this is the assertion the block is
  -- built around: THE SCREEN IS NOT THE AUTHORITY ON WHAT TO ASK. A promotion
  -- edited while somebody had the widget open would otherwise write an entry
  -- answering questions it no longer asks -- and a crafted payload would skip
  -- whichever field it found inconvenient.
  v_steps := public.whatsapp_conversation_steps(p_promotion_id, p_member_id);

  select count(*) into v_missing
    from jsonb_array_elements(v_steps) s
   where (s ->> 'kind') = 'field'
     and nullif(btrim(coalesce(p_fields ->> (s ->> 'field'), '')), '') is null;

  if v_missing > 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_answers');
  end if;

  select count(*) into v_missing
    from jsonb_array_elements(v_steps) s
   where (s ->> 'kind') = 'question'
     and not exists (
       select 1 from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) a
        where (a ->> 'question_id') = (s ->> 'questionId'));

  if v_missing > 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_answers');
  end if;

  perform public.apply_member_field_values(p_member_id, coalesce(p_fields, '{}'::jsonb));

  -- THE DIVERGENCE, DELIBERATE AND RULED ON BY THE OWNER. 0071's
  -- complete_conversation records no consent at all when a listener agrees on
  -- WhatsApp; only a refusal is written. Here a rules text was displayed and
  -- agreed to, so there is something to record and 0032's `rules` consent type
  -- exists for exactly it. WhatsApp will record the same when that door is next
  -- worked on; until then the two differ, in writing.
  --
  -- recorded_by is null for the reason 0161 gives: a website visitor is not an
  -- auth.users row.
  insert into public.member_consents
    (organization_id, member_id, company_id, consent_type, granted, origin, recorded_by)
  values
    (v.o_org, p_member_id, v.o_company, 'rules', true, 'web-widget', null);

  -- The same core the operator's door and the import use, so the doors cannot
  -- come to disagree about what entering means.
  v_result := public.apply_participation(
    p_promotion_id, p_member_id, now(), 'WEB', coalesce(p_answers, '[]'::jsonb));

  v_status := v_result ->> 'status';
  v_id     := (v_result ->> 'participation_id')::uuid;

  -- apply_participation ANSWERS RATHER THAN RAISES for a repeat: 'DUPLICATE'
  -- when the promotion allows one entry and this listener already has it. That
  -- is a refusal to the visitor, not a success with an odd status, and the
  -- panel needs to say so.
  if v_status is distinct from 'VALID' then
    return jsonb_build_object('ok', false, 'reason', 'already_entered', 'status', v_status);
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'widget_enter_promotion', 'participations', v_id, v.o_org, v.o_company,
     jsonb_build_object('public_key', p_public_key, 'promotion_id', p_promotion_id));

  return jsonb_build_object('ok', true, 'participation_id', v_id, 'status', v_status);
end;
$$;

comment on function public.widget_promotions is
  'Block 17c. The Station''s live promotions as the widget shows them: name, rules, art, what this listener still has to answer, THE ALTERNATIVES for each question that has them, and whether they already have a valid entry. A promotion with no rules is absent (D3), and since 0186 so is one carrying a non-ESSAY question with no alternative rows -- the panel can only draw such a question as nothing, so the promotion is withheld rather than offered as a walk that ends in a refusal. ESSAY is excluded from that condition by design: an open question has no options and 0041 forbids them. is_correct is deliberately not returned -- it is the answer sheet, and this payload is rendered in a browser the listener controls. Refuses by the same names as every other widget door. Granted to service_role only.';

comment on function public.widget_enter_promotion is
  'Block 17c. Records an entry made from the Station''s own website. Refuses by name -- unknown_installation, unknown_listener, listener_anonymized, promotion_closed, missing_answers, already_entered, refused -- so the widget can say which happened. THE STEP LIST IS RECOMPUTED HERE rather than trusted from the payload: the screen is not the authority on what a promotion asks, and a promotion edited mid-walk would otherwise be answered wrongly. Since 0186 it restates THREE of the list''s conditions rather than two -- web_enabled, rules present, and no non-ESSAY question left without alternatives -- so a browser holding a list drawn before the options were deleted is answered promotion_closed rather than blamed with missing_answers for a question nobody could see. Declining writes promotion_refusals stamped WEB and nothing else. Agreeing writes a `rules` consent row, which is a deliberate divergence from complete_conversation (0071), which records none. Granted to service_role only.';

-- create or replace does not reset privileges, so neither statement below
-- changes anything today. They are restated for the reason 0171 states them:
-- the file that redefines a door should read as the whole truth about who may
-- open it.
revoke execute on function public.widget_promotions(text, uuid) from public;
revoke execute on function public.widget_enter_promotion(text, uuid, uuid, boolean, jsonb, jsonb) from public;

grant execute on function public.widget_promotions(text, uuid) to service_role;
grant execute on function public.widget_enter_promotion(text, uuid, uuid, boolean, jsonb, jsonb) to service_role;
