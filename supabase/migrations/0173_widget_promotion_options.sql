-- supabase/migrations/0173_widget_promotion_options.sql

-- Block 17c, first repair. The widget could not show a quiz's alternatives,
-- because nothing ever sent them.
--
-- whatsapp_conversation_steps (0066) answers `{kind, questionId, questionKind}`
-- and no options, which is right for the bot: WhatsApp renders its own buttons
-- from the row when it composes the message. A web panel has no such second
-- read, so it drew a text box for every question and a listener typed prose
-- into a quiz.
--
-- THE FAILURE WAS NOT COSMETIC. participation_answers_shape (0052) requires
-- option_id and a null answer_text for QUIZ and MULTIPLE_CHOICE, and the
-- opposite for ESSAY -- so the typed answer reached the insert, tripped the
-- check, and arrived at the visitor as "something went wrong".
--
-- The steps stay exactly as they are. This adds the options ALONGSIDE them,
-- because the step list is shared with the bot and widening it for one caller
-- is how two callers come to disagree about what a step is.

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
         and now() between p.starts_at and p.ends_at), '[]'::jsonb));
end;
$$;

comment on function public.widget_promotions is
  'Block 17c. The Station''s live promotions as the widget shows them: name, rules, art, what this listener still has to answer, THE ALTERNATIVES for each question that has them, and whether they already have a valid entry. A promotion with no rules is absent (D3). is_correct is deliberately not returned -- it is the answer sheet, and this payload is rendered in a browser the listener controls. Refuses by the same names as every other widget door. Granted to service_role only.';
