-- supabase/migrations/0114_prompt_context_overrides.sql

-- The Templates block, Task 7's other half: the overrides reach the engine.
--
-- 0109 grants service_role SELECT on station_message_templates and says in a
-- comment that this is "how the engine resolves them" — but nothing read the
-- table. The screens would have written rows that changed nothing a listener
-- ever saw, which is the same class of gap as the doors 0113 had to add: an
-- intention stated in a comment and never built.
--
-- BOTH context builders change, because there are two and they duplicate each
-- other: start_whatsapp_conversation (0070) assembles the context for the
-- first message of a conversation, and whatsapp_prompt_context (0071) for
-- every turn after it. 0071's header names that duplication and says "one home
-- for the query, called from both" — which is true of the QUESTIONS half only;
-- 0070 builds the promotion and questions itself. A change to one and not the
-- other would give a Station its own wording from the second message onward
-- and the code's default on the first, which is the hardest possible version
-- of this bug to notice.
--
-- Both are `create or replace` with unchanged argument lists and unchanged
-- return types, so neither is dropped and no ACL is lost — the trap 0111 had
-- to work around twice does not apply here.
--
-- THE COMMENT ON 0071 IS THE OTHER THING THIS MIGRATION CHANGES. It reads
-- "Field prompts are deliberately absent: they are copy with no per-promotion
-- override, and they live in TypeScript beside the rest of the listener-facing
-- strings." That reasoning was right and is now half wrong: there is still no
-- per-PROMOTION override, and the constants do still live in TypeScript — but
-- there is a per-STATION one, and a reader who trusted that sentence would
-- conclude this table is not consulted here. Both comments are rewritten
-- rather than left to mislead.

-- One shared expression, written out twice below rather than factored into a
-- helper function: both callers are `language sql` and STABLE, and a third
-- function would be a third thing to keep in step with an enum that grows.
--
-- Keys are the enum's own text, which is exactly what SystemMessageKey in
-- steps.ts derives from — so a key added to public.system_message_key arrives
-- here with no change, and fails to compile in SYSTEM_MESSAGE_DEFAULTS until
-- somebody writes the text that goes with it.
--
-- '{}' when the Station has overridden nothing, which is every Station until
-- somebody opens the Messages screen. An absent key is a valid state (D2) and
-- resolveSystemMessage answers it with the constant.

create or replace function public.whatsapp_prompt_context(p_promotion_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'promotion', (
      select jsonb_build_object(
        'name',           p.name,
        'callToAction',   p.call_to_action,
        'useArt',         p.use_art,
        'artUrl',         p.art_url,
        'yesButtonLabel', p.yes_button_label,
        'noButtonLabel',  p.no_button_label)
      from public.promotions p
      where p.id = p_promotion_id
    ),
    'questions', coalesce((
      select jsonb_object_agg(q.id::text, jsonb_build_object(
        'prompt',      q.prompt,
        'menuTitle',   q.menu_title,
        'buttonLabel', q.button_label,
        'options',     coalesce((
          select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label)
                           order by o.position)
          from public.promotion_question_options o
          where o.question_id = q.id), '[]'::jsonb)))
      from public.promotion_questions q
      where q.promotion_id = p_promotion_id), '{}'::jsonb),
    -- This Station's own wording, per text. Scoped by the PROMOTION's Station,
    -- never by anything the caller passes: a promotion belongs to one Station
    -- and its conversation speaks in that Station's voice.
    'systemMessages', coalesce((
      select jsonb_object_agg(t.key::text, t.body)
      from public.station_message_templates t
      where t.company_id = (
              select p.company_id from public.promotions p where p.id = p_promotion_id)
        and t.deleted_at is null), '{}'::jsonb)
  );
$$;

comment on function public.whatsapp_prompt_context(uuid) is
  'Everything the conversation''s prompts need and the engine may not fetch: the promotion''s name, art, call to action and button labels, every question with its options, and THIS STATION''S OWN WORDING for the ten system texts (0109). Read once per turn. Carries NO personal data -- it is what the Station wrote, never anything about the listener -- which is why service_role may call it directly while member-bearing reads stay inside SECURITY DEFINER bodies. The overrides are per STATION and PER TEXT: a Station that has overridden nothing yields an empty object, and one that has overridden a single prompt yields a single key, with the other nine resolving to the constants in engine.ts (D2).';

-- ---------------------------------------------------------------------------
-- The first message of a conversation, from 0070. Same addition, same reason:
-- half a fix here is a Station whose consent refusal speaks its own words and
-- whose first field prompt does not.
-- ---------------------------------------------------------------------------

create or replace function public.start_whatsapp_conversation(
  p_promotion_id  uuid,
  p_member_id     uuid,
  p_integration_id uuid,
  p_phone          text,
  p_window_seconds integer
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    -- VERBATIM FROM 0070, key for key and comment for comment. `create or
    -- replace` rewrites the whole body, so anything reconstructed from memory
    -- here silently replaces the real thing: the first draft of this migration
    -- named this object's phone key 'hashtag' and reordered three others,
    -- which store.ts would have rejected on the first message of every
    -- conversation. Only the systemMessages key at the bottom is new.
    --
    -- The state, in the shape src/lib/conversation/steps.ts declares and
    -- store.ts validates. camelCase throughout: this is a TypeScript document
    -- that happens to be built here, and the two sides are held together by
    -- that schema -- which caught this function's first draft naming the step
    -- keys question_id and question_kind.
    'conversation', jsonb_build_object(
      'integrationId', p_integration_id,
      'phone',         p_phone,
      'promotionId',   p_promotion_id,
      'memberId',      p_member_id,
      'steps',         public.whatsapp_conversation_steps(p_promotion_id, p_member_id),
      'cursor',        0,
      'answers',       jsonb_build_object('fields', jsonb_build_object(), 'questions', jsonb_build_array()),
      'reprompts',     0,
      -- Recomputed by the store on every save; here so the state is complete
      -- the moment it exists rather than briefly claiming a window it has not
      -- got.
      'expiresAt',     to_char(now() + make_interval(secs => p_window_seconds),
                               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),

    -- What the prompts need and the engine may not fetch. Field prompts are
    -- still not here as a per-PROMOTION setting and never will be; what IS
    -- here now is the Station's own wording, at the bottom.
    'promotion', (
      select jsonb_build_object(
        'name',           p.name,
        'callToAction',   p.call_to_action,
        'useArt',         p.use_art,
        'artUrl',         p.art_url,
        'yesButtonLabel', p.yes_button_label,
        'noButtonLabel',  p.no_button_label)
      from public.promotions p
      where p.id = p_promotion_id
    ),

    -- Keyed by question id, because that is how a step names one.
    'questions', coalesce((
      select jsonb_object_agg(q.id::text, jsonb_build_object(
        'prompt',      q.prompt,
        'menuTitle',   q.menu_title,
        'buttonLabel', q.button_label,
        'options',     coalesce((
          select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label)
                           order by o.position)
          from public.promotion_question_options o
          where o.question_id = q.id), '[]'::jsonb)))
      from public.promotion_questions q
      where q.promotion_id = p_promotion_id), '{}'::jsonb),

    -- The Station's own wording, identical to whatsapp_prompt_context's. The
    -- consent message is composed from the promotion above and is NOT one of
    -- the ten; what this carries for the first turn is the refusal a listener
    -- gets for pressing "Agora não", and the prompt for whichever step comes
    -- after consent.
    'systemMessages', coalesce((
      select jsonb_object_agg(t.key::text, t.body)
      from public.station_message_templates t
      where t.company_id = (
              select p.company_id from public.promotions p where p.id = p_promotion_id)
        and t.deleted_at is null), '{}'::jsonb)
  );
$$;

revoke execute on function public.start_whatsapp_conversation(uuid, uuid, uuid, text, integer) from public;

comment on function public.start_whatsapp_conversation(uuid, uuid, uuid, text, integer) is
  'The conversation a hashtag opens: the step list, the empty answers, and everything the prompts need, assembled in one read -- including this Station''s own wording for the ten system texts (0109), so the first turn speaks the same voice as every turn after it. It does NOT store the state and it does not check whether the listener may enter -- the store owns the first (design spec §4.4, so the Redis driver is reachable) and participation_status_for owns the second (0069, so one rule has one home). STABLE, which is the proof it writes nothing rather than a promise that it does not. PRIVATE: EXECUTE for nobody, called from inside ingest_whatsapp_event. The step keys are camelCase because this is a TypeScript document assembled in SQL, and store.ts validates it on arrival: the first draft of this function named them question_id and question_kind and the conversation would have failed on the first question of any promotion that had one.';
