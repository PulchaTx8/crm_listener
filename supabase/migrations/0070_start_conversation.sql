-- Block 5b, Task 7d. The hashtag stops being an entry and becomes an opening
-- question.
--
-- THE HEADLINE BEHAVIOUR OF BLOCK 5a CHANGES HERE, deliberately: no message
-- enters anybody directly any more. Every promotion that exists today takes one
-- more message than it did, because the listener has to be able to say no and to
-- be asked for whatever the promotion wants.

-- ---------------------------------------------------------------------------
-- 1. The conversation, assembled but NOT stored.
--
-- It returns the state; it does not write it. The state's home is the
-- ConversationStore (design spec §4.4, amended 2026-08-02) -- Postgres today,
-- Redis when a Station's volume justifies it -- and a function that inserted
-- into whatsapp_conversations here would start conversations in one store while
-- every later turn looked for them in the other. That version of this file was
-- written and thrown away; this comment is what stops it coming back.
--
-- STABLE, and that is the proof rather than a hint: it cannot write.
-- ---------------------------------------------------------------------------
create function public.start_whatsapp_conversation(
  p_promotion_id   uuid,
  p_member_id      uuid,
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

    -- What the prompts need and the engine may not fetch. Field prompts are NOT
    -- here: they are copy, they live in TypeScript beside the other listener-
    -- facing strings, and a promotion has no per-field wording to override them.
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
      where q.promotion_id = p_promotion_id), '{}'::jsonb)
  );
$$;

revoke execute on function public.start_whatsapp_conversation(uuid, uuid, uuid, text, integer) from public;

comment on function public.start_whatsapp_conversation(uuid, uuid, uuid, text, integer) is
  'The conversation a hashtag opens: the step list, the empty answers, and everything the prompts need, assembled in one read. It does NOT store the state and it does not check whether the listener may enter -- the store owns the first (design spec §4.4, so the Redis driver is reachable) and participation_status_for owns the second (0069, so one rule has one home). STABLE, which is the proof it writes nothing rather than a promise that it does not. PRIVATE: EXECUTE for nobody, called from inside ingest_whatsapp_event. The step keys are camelCase because this is a TypeScript document assembled in SQL, and store.ts validates it on arrival: the first draft of this function named them question_id and question_kind and the conversation would have failed on the first question of any promotion that had one.';

-- ---------------------------------------------------------------------------
-- 2. The door the worker closes an event through.
--
-- finish_whatsapp_event is private and stays private: its whole contract is
-- that ingest_whatsapp_event is the only thing that decides an event. But a
-- conversation turn is decided in Node -- that is what makes the engine
-- testable with nothing running -- so the worker needs a way to say "this
-- message is dealt with" that does not hand it the ability to write any outcome
-- it likes.
--
-- Hence a door with a whitelist. The outcomes that carry a participation are
-- NOT in it: those are written by complete_whatsapp_conversation inside the
-- transaction that creates the entry, so the entry and the closing of the
-- message that produced it cannot disagree.
-- ---------------------------------------------------------------------------
create function public.finish_whatsapp_turn(p_event_id uuid, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_outcome not in ('conversation', 'conversation_turn', 'refused',
                       'abandoned', 'no_conversation') then
    raise exception 'not an outcome a turn may write: %', p_outcome
      using errcode = '22023';
  end if;

  return public.finish_whatsapp_event(p_event_id, p_outcome, null, null);
end;
$$;

revoke execute on function public.finish_whatsapp_turn(uuid, text) from public;
grant execute on function public.finish_whatsapp_turn(uuid, text) to service_role;

comment on function public.finish_whatsapp_turn(uuid, text) is
  'Closes an inbound event whose decision was taken in Node: a conversation opened, a turn taken, a refusal, an abandonment, or a message from somebody who is not mid-conversation. The whitelist is the point -- an outcome carrying a participation is written by complete_whatsapp_conversation inside the transaction that writes the entry, so the two cannot disagree, and this door cannot be used to claim one happened. Everything else about the row is finish_whatsapp_event''s (0062), which stays private.';

-- ---------------------------------------------------------------------------
-- 3. The divert.
--
-- Two paths through this function now leave the event PROCESSING and hand the
-- decision back to the caller, and that is a real change to how this system
-- fails. Until today no path committed a row in PROCESSING, and the inbound arm
-- of reclaim_stale_whatsapp_claims (0063) called itself insurance in its own
-- comment. It is load-bearing from here: a worker that dies between this
-- function returning and the turn being finished leaves a claimed row that only
-- the reclaim will free, five minutes later.
--
-- The alternative -- finishing the event here and letting the turn happen after
-- it is DONE -- loses the message outright if the worker dies in the same
-- window, and a listener whose hashtag was recorded as handled and answered by
-- nothing has no way to tell and no way to retry except to send it again.
-- Delay, recovered automatically, beats silence.
-- ---------------------------------------------------------------------------
-- The one-argument version is DROPPED rather than left beside this one. A
-- default parameter makes a new signature, not a replacement: both would exist,
-- and every existing call site -- every pgTAP case, the worker's own RPC -- would
-- become "function is not unique" the moment this migration ran.
drop function if exists public.ingest_whatsapp_event(uuid);

create function public.ingest_whatsapp_event(
  p_event_id       uuid,
  p_window_seconds integer default 1800
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event   public.webhook_events%rowtype;
  v_integ   public.integrations%rowtype;
  v_from    text;
  v_local   text;
  v_profile text;
  v_text    text;
  v_when    timestamptz;
  v_tag     text;
  v_promo   public.promotions%rowtype;
  v_diag    public.promotions%rowtype;
  v_member  uuid;
  v_result  jsonb;
  v_status  text;
  v_part    uuid;
  v_body    text;
  v_outcome text;
  v_pre     public.participation_status;
begin
  select * into v_event
  from public.webhook_events
  where id = p_event_id and status in ('RECEIVED', 'FAILED')
  for update skip locked;

  if not found then
    return jsonb_build_object('outcome', 'skipped', 'status', null,
                              'participation_id', null);
  end if;

  update public.webhook_events
     set status = 'PROCESSING', claimed_at = now()
   where id = v_event.id;

  if v_event.payload is null then
    raise log 'ingest_whatsapp_event: payload already pruned on event % (wamid sha256 %)',
      v_event.id, v_event.external_id;
    raise exception 'whatsapp payload has been pruned and this event can no longer be decided'
      using errcode = '22023';
  end if;

  v_from    := v_event.payload ->> 'from';
  v_profile := nullif(btrim(coalesce(v_event.payload ->> 'profile_name', '')), '');
  v_text    := coalesce(v_event.payload ->> 'text', '');
  v_local   := public.whatsapp_local_phone(v_from);
  v_when    := to_timestamp((v_event.payload ->> 'timestamp')::bigint);

  select * into v_integ
  from public.integrations
  where provider = 'WHATSAPP'
    and phone_number_id = v_event.payload -> 'metadata' ->> 'phone_number_id'
    and enabled
    and deleted_at is null;

  if not found then
    return public.finish_whatsapp_event(v_event.id, 'no_integration', null, null);
  end if;

  update public.webhook_events
     set integration_id = v_integ.id,
         organization_id = v_integ.organization_id,
         company_id = v_integ.company_id
   where id = v_event.id;

  v_tag := lower((regexp_match(v_text, '#[^[:space:]#]{1,39}'))[1]);

  -- NO HASHTAG, AND THIS BRANCH NO LONGER ENDS THE MESSAGE. It used to be the
  -- end of a delivery receipt or somebody saying hello; it is now also every
  -- answer a listener gives, because an answer carries no hashtag and a button
  -- press carries no text at all. Whether this message is an answer depends on
  -- whether a conversation is alive for (integration, phone) -- a question only
  -- the caller can ask, because the state may not be in this database.
  --
  -- So the event is left PROCESSING and the caller decides. It finishes the row
  -- through finish_whatsapp_turn with outcome no_conversation when nobody was
  -- mid-conversation, which is the silence design spec D4 and D10 both ask for.
  if v_tag is null then
    return jsonb_build_object(
      'outcome',          'no_hashtag',
      'status',           null,
      'participation_id', null,
      'event_id',         v_event.id,
      'external_id',      v_event.external_id,
      'integration_id',   v_integ.id,
      'phone',            v_from,
      'reply',            v_event.payload -> 'reply',
      'text',             v_text,
      'received_at',      v_when);
  end if;

  if v_local is null then
    raise log 'ingest_whatsapp_event: no usable sender on event % (wamid sha256 %)',
      v_event.id, v_event.external_id;
    raise exception 'whatsapp payload carries no usable sender phone'
      using errcode = '22023';
  end if;

  if v_when is null then
    raise log 'ingest_whatsapp_event: no timestamp on event % (wamid sha256 %)',
      v_event.id, v_event.external_id;
    raise exception 'whatsapp payload carries no message timestamp'
      using errcode = '22023';
  end if;

  select * into v_promo
  from public.promotions
  where company_id = v_integ.company_id
    and lower(hashtag) = v_tag
    and deleted_at is null
    and cancelled_at is null
    and v_when >= starts_at and v_when < ends_at
  limit 1;

  if not found then
    select * into v_diag
    from public.promotions
    where company_id = v_integ.company_id
      and lower(hashtag) = v_tag
      and deleted_at is null
    order by starts_at desc
    limit 1;

    if not found then
      v_outcome := 'no_promotion';
    elsif v_diag.cancelled_at is not null then
      v_outcome := 'promotion_cancelled';
    else
      v_outcome := 'outside_window';
    end if;
    return public.finish_whatsapp_event(v_event.id, v_outcome, null, null);
  end if;

  v_member := public.apply_member_lookup(
    v_integ.organization_id, v_local, null, null, null);

  if v_member is null and v_from is distinct from v_local then
    v_member := public.apply_member_lookup(
      v_integ.organization_id, v_from, null, null, null);
  end if;

  if v_member is null then
    begin
      v_member := public.apply_member_creation(
        v_integ.company_id, coalesce(v_profile, 'Ouvinte WhatsApp'), v_local,
        null, null, null, null, null, null, null, null, null, null, null, null,
        null, v_when, 'WHATSAPP', null);
    exception
      when unique_violation then
        v_member := public.apply_member_lookup(
          v_integ.organization_id, v_local, null, null, null);
        perform public.apply_member_link(
          v_member, v_integ.company_id, v_integ.organization_id, null);
    end;
  else
    perform public.apply_member_link(
      v_member, v_integ.company_id, v_integ.organization_id, null);
  end if;

  -- D8, THE PRE-CHECK. Asked here so that somebody who has already used their
  -- chances is told now, rather than after answering five questions. It is
  -- ADVISORY: the listener may enter through another door while the
  -- conversation is happening, and the write at the end is the truth.
  v_pre := public.participation_status_for(v_promo.id, v_member, v_when);

  if v_pre <> 'VALID' then
    -- Not a refusal and not silence: the attempt is RECORDED, exactly as Block
    -- 5a records it, because a repeat, an early return and a spent ceiling are
    -- facts about a message this Station received (0054's ruling, and 4c's
    -- before it). This path is 5a unchanged, down to the dedupe key.
    v_result := public.apply_participation(
      v_promo.id, v_member, v_when, 'WHATSAPP', '[]'::jsonb);

    v_status := v_result ->> 'status';
    v_part   := (v_result ->> 'participation_id')::uuid;
    v_body   := public.whatsapp_reply_body(v_promo.id, v_member, v_status);

    if v_body is not null then
      insert into public.outbox_messages
        (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key)
      values
        ('WHATSAPP', v_integ.id, v_integ.organization_id, v_integ.company_id,
         v_from, v_body, v_event.external_id || ':confirmation')
      on conflict (provider, dedupe_key) do nothing;
    end if;

    return public.finish_whatsapp_event(v_event.id, 'recorded', v_status, v_part);
  end if;

  -- THE ENTRY IS NOT WRITTEN HERE ANY MORE. What goes back is a conversation
  -- ready to be stored and a consent message ready to be sent, and the event
  -- stays PROCESSING until the caller has done both. Somebody who never answers
  -- has no participation, which is what makes an unfinished conversation cost
  -- nothing and mean nothing.
  return jsonb_build_object(
    'outcome',          'conversation',
    'status',           null,
    'participation_id', null,
    'event_id',         v_event.id,
    -- The hashed message id, which is what every dedupe key in this block is
    -- built from: '<sha256 of the wamid>:<what it is>' (0059). Keyed on the
    -- MESSAGE, so a turn re-run after a crash enqueues one message and not two.
    -- The HASH and never the raw id -- a wamid decodes to bytes carrying the
    -- counterparty's phone.
    'external_id',      v_event.external_id,
    'integration_id',   v_integ.id,
    'phone',            v_from,
    'received_at',      v_when,
    'start',            public.start_whatsapp_conversation(
                          v_promo.id, v_member, v_integ.id, v_from, p_window_seconds));
end;
$$;

revoke execute on function public.ingest_whatsapp_event(uuid, integer) from public;
grant execute on function public.ingest_whatsapp_event(uuid, integer) to service_role;

comment on function public.ingest_whatsapp_event(uuid, integer) is
  'The bot''s door, and since Block 5b it opens a conversation rather than writing an entry. It claims the event FOR UPDATE SKIP LOCKED, resolves the Station, the promotion and the listener, and then: an attempt that could not become a VALID entry is recorded and answered exactly as 5a did, because a repeat or a spent ceiling is a fact about a message this Station received; anything else hands back a conversation for the caller to store and a consent message for it to enqueue. TWO PATHS LEAVE THE EVENT PROCESSING -- that one, and a message with no hashtag, which may be an answer to a question the bot asked and can only be told apart by looking in the conversation store the caller owns. Both are finished by the caller through finish_whatsapp_turn. That makes the INBOUND arm of reclaim_stale_whatsapp_claims load-bearing for the first time: a worker that dies mid-turn leaves a claimed row that only the reclaim frees. Finishing the event here instead would lose the message outright in the same crash, and a listener told nothing has no way to know they should send the hashtag again.';
