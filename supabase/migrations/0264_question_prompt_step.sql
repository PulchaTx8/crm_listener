-- supabase/migrations/0264_question_prompt_step.sql

-- Block 30d, item 1a, D1. whatsapp_conversation_steps (0066) built a question
-- step as {kind, questionId, questionKind} -- the alternatives' shape, never
-- the question's own words. promotion_questions.prompt (0041, not null, a
-- non-blank CHECK since the same migration) never left the database, so the
-- widget drew a list of alternatives under nothing at all.
--
-- THE STEP GAINS ONE KEY. Copied forward from the live body (0066 is still
-- live; nothing between it and here redefined this function), with 'prompt',
-- q.prompt added to the question branch and nothing else touched.
--
-- BOTH CALLERS GET IT FOR FREE. widget_promotions (0186:57) passes this
-- function's answer straight through into 'steps', and widget_enter_promotion
-- (0234:121) recomputes the same call to restate what it is willing to accept
-- an answer for -- neither reads the question branch by key, so neither needs
-- editing.

create or replace function public.whatsapp_conversation_steps(
  p_promotion_id uuid,
  p_member_id    uuid
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  with promo as (
    select requested_fields, data_validity_months
    from public.promotions where id = p_promotion_id
  ),
  wanted as (
    select u.field
    from promo, unnest(promo.requested_fields) as u(field)
  ),
  -- A native Postgres enum sorts by its DECLARATION order, not alphabetically
  -- (promotion_requested_field, 0040) -- so `order by field` below already is
  -- "the enum's own order" with no array_position/enum_range needed to compute
  -- an ordinal by hand.
  stale as (
    select w.field
    from wanted w
    cross join promo
    where
      -- Empty is asked whatever the validity says.
      public.member_field_value(p_member_id, w.field) is null
      or (
        promo.data_validity_months is not null
        and coalesce(
              (select c.confirmed_at from public.member_field_confirmations c
                where c.member_id = p_member_id and c.field = w.field),
              '-infinity'::timestamptz
            ) < now() - make_interval(months => promo.data_validity_months)
      )
  )
  select jsonb_build_array(jsonb_build_object('kind', 'consent'))
      || coalesce((select jsonb_agg(jsonb_build_object('kind', 'field', 'field', field) order by field)
                     from stale),
                  '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object(
                            'kind', 'question',
                            'questionId', q.id,
                            'questionKind', q.kind,
                            'prompt', q.prompt) order by q.position)
                     from public.promotion_questions q
                    where q.promotion_id = p_promotion_id), '[]'::jsonb);
$$;

-- create or replace does not reset privileges, so neither statement below
-- changes anything today. Restated for the reason 0171 states them: the file
-- that redefines a door should read as the whole truth about who may open it.
revoke execute on function public.whatsapp_conversation_steps(uuid, uuid) from public;

comment on function public.whatsapp_conversation_steps(uuid, uuid) is
  'The ordered list of steps this listener still has to answer for this promotion: consent, then every stale or empty requested field in promotion_requested_field''s own declared order (0040), then every question in position order, each carrying its own prompt (0264) alongside the alternatives'' shape. Computed ONCE per conversation (design spec D7) -- recomputing per message would cost a round trip per turn and would let a field fresh at the start expire mid-conversation, and editing a promotion mid-conversation would otherwise change what a listener already talking to the bot is asked. member_field_value (0065) supplies the eight-way field mapping. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from inside a SECURITY DEFINER body -- the shape apply_participation (0054) established.';
