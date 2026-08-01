-- supabase/migrations/0066_conversation_rpcs.sql
--
-- Block 5b, Task 2: which steps a given listener still has to answer for a
-- given promotion. Nothing calls this yet -- a later task computes it once,
-- at the moment the hashtag arrives, and walks the list turn by turn.
--
-- member_field_value, the eight-way promotion_requested_field-to-members-column
-- mapping this function's `stale` CTE calls below, lives in 0065 -- moved there
-- ahead of backfill_member_field_confirmations, its other caller, once the
-- backfill stopped hand-writing an equivalent VALUES list and started calling
-- it instead. See that function's own comment for the mapping itself and the
-- reasoning; nothing here repeats it.

-- ---------------------------------------------------------------------------
-- The step list, computed ONCE when the hashtag arrives (design spec D7).
-- Recomputing it per message would cost a round trip per turn and would let a
-- field that was fresh at the start expire mid-conversation; computing it once
-- also means editing a promotion does not change a conversation somebody is
-- already having.
--
-- Per requested field: empty is asked whatever the validity says. A filled
-- field is asked when data_validity_months is not null AND the field's last
-- confirmation (or -infinity, for a field never confirmed) is older than that
-- many months -- so a null data_validity_months excludes every filled field,
-- even one never confirmed, and 0 includes every requested field, because
-- "older than zero months" is true of anything that happened before this
-- instant. The comparison is a strict `<`: a field confirmed EXACTLY
-- data_validity_months ago is still within the window, matching the spec
-- table's "confirmed within data_validity_months" (inclusive of the boundary
-- itself). Fields come out in promotion_requested_field's OWN declared order
-- (0040), not the order an operator ticked them -- the owner was asked whether
-- a field would ever need settings of its own and said no, which is what
-- makes the list a column rather than a table (spec D6). Questions follow, in
-- `position` order.
--
-- PRIVATE: SECURITY INVOKER, EXECUTE for nobody, called only from inside a
-- SECURITY DEFINER body -- the shape apply_participation (0054) established.
-- ---------------------------------------------------------------------------
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
                            'question_id', q.id,
                            'question_kind', q.kind) order by q.position)
                     from public.promotion_questions q
                    where q.promotion_id = p_promotion_id), '[]'::jsonb);
$$;

revoke execute on function public.whatsapp_conversation_steps(uuid, uuid) from public;

comment on function public.whatsapp_conversation_steps(uuid, uuid) is
  'The ordered list of steps this listener still has to answer for this promotion: consent, then every stale or empty requested field in promotion_requested_field''s own declared order (0040), then every question in position order. Computed ONCE per conversation (design spec D7) -- recomputing per message would cost a round trip per turn and would let a field fresh at the start expire mid-conversation, and editing a promotion mid-conversation would otherwise change what a listener already talking to the bot is asked. member_field_value (0065) supplies the eight-way field mapping. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from inside a SECURITY DEFINER body -- the shape apply_participation (0054) established.';
