-- Block 5b, Task 8. The end of a conversation, and the two doors the worker
-- needs to get there.

-- ---------------------------------------------------------------------------
-- 1. The prompts, read once per turn.
--
-- start_whatsapp_conversation carries this on the first message; every later
-- turn needs it again, because the engine is a pure function and may not fetch
-- anything itself. One home for the query, called from both.
-- ---------------------------------------------------------------------------
create function public.whatsapp_prompt_context(p_promotion_id uuid)
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
      where q.promotion_id = p_promotion_id), '{}'::jsonb)
  );
$$;

revoke execute on function public.whatsapp_prompt_context(uuid) from public;
grant execute on function public.whatsapp_prompt_context(uuid) to service_role;

comment on function public.whatsapp_prompt_context(uuid) is
  'Everything the conversation''s prompts need and the engine may not fetch: the promotion''s name, art, call to action and button labels, and every question with its options. Read once per turn. Carries NO personal data -- it is what the Station wrote, never anything about the listener -- which is why service_role may call it directly while member-bearing reads stay inside SECURITY DEFINER bodies. Field prompts are deliberately absent: they are copy with no per-promotion override, and they live in TypeScript beside the rest of the listener-facing strings.';

-- ---------------------------------------------------------------------------
-- 2. Enqueueing what the engine decided to send.
--
-- outbox_messages grants service_role SELECT and UPDATE and no INSERT (0059):
-- the queue is written from inside SECURITY DEFINER bodies so that every row in
-- it was put there by a rule rather than by whoever holds the key. The
-- conversation needs to enqueue from Node -- the engine decides which message,
-- and the engine is TypeScript -- so it gets a door, not a grant.
-- ---------------------------------------------------------------------------
create function public.enqueue_whatsapp_outbound(
  p_integration_id uuid,
  p_to_phone       text,
  p_body           text,
  p_interactive    jsonb,
  p_dedupe_key     text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_integ public.integrations%rowtype;
  v_id    uuid;
begin
  select * into v_integ
  from public.integrations
  where id = p_integration_id and enabled and deleted_at is null;

  if not found then
    raise exception 'integration not found or switched off: %', p_integration_id
      using errcode = 'P0002';
  end if;

  -- The tenancy columns come from the INTEGRATION and are never passed in: a
  -- caller that could name its own organization_id could enqueue a message
  -- billed to, and read by, another Station.
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body,
     interactive, dedupe_key)
  values
    ('WHATSAPP', v_integ.id, v_integ.organization_id, v_integ.company_id,
     p_to_phone, p_body, p_interactive, p_dedupe_key)
  -- Keyed on the message that provoked it, so a turn re-run after a crash
  -- enqueues nothing new. Returning null then, rather than raising: the caller
  -- is retrying something that already happened, which is success.
  on conflict (provider, dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.enqueue_whatsapp_outbound(uuid, text, text, jsonb, text) from public;
grant execute on function public.enqueue_whatsapp_outbound(uuid, text, text, jsonb, text) to service_role;

comment on function public.enqueue_whatsapp_outbound(uuid, text, text, jsonb, text) is
  'Puts one message on the outbound queue on behalf of the conversation engine, which lives in TypeScript and therefore cannot be inside a SECURITY DEFINER body of its own. The organization and the Station are taken from the integration rather than from the caller, so nobody can enqueue a message against a Station they do not hold. Returns null when the dedupe key already exists, which is a turn being re-run after a crash and is success, not a conflict.';

-- ---------------------------------------------------------------------------
-- 3. The end of the conversation: everything lands together, or nothing does.
--
-- FOUR writes, not five. Clearing the conversation state is NOT one of them:
-- the state belongs to the store, which may not be this database (design spec
-- §4.4). The caller clears it after this commits, and a clear that fails leaves
-- the state on the final step, where the listener's next message re-runs this
-- and apply_participation answers DUPLICATE -- the at-least-once §4.3 commits
-- to.
-- ---------------------------------------------------------------------------
create function public.complete_whatsapp_conversation(
  p_event_id       uuid,
  p_integration_id uuid,
  p_promotion_id   uuid,
  p_member_id      uuid,
  p_to_phone       text,
  -- The listener's answers: {"city": "Canoas", ...}. `cpf` arrives ALREADY
  -- HASHED -- 0031's rule is that the raw number never appears in an argument,
  -- because arguments land in query logs and backups -- and `age` as an ISO
  -- date the engine has already validated.
  p_fields         jsonb,
  -- [{"questionId": ..., "optionId": ..., "answerText": ...}], the state's own
  -- shape, mapped to apply_participation's below.
  p_questions      jsonb,
  -- THE LAST MESSAGE'S timestamp, not the first. Somebody who starts at 14:00
  -- and finishes at 14:20 on a promotion that closed at 14:10 is refused;
  -- judging by the opening message would make the closing moment mean nothing.
  p_completed_at   timestamptz,
  p_dedupe_key     text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org     uuid;
  v_result  jsonb;
  v_status  text;
  v_part    uuid;
  v_body    text;
begin
  select organization_id into v_org from public.members where id = p_member_id;
  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  -- (1) THE VALUES ONTO THE RECORD. The eight-way mapping is written out here
  -- rather than derived, and this is the SECOND of the two places that carry it
  -- -- member_field_value (0065) reads, this writes, and a ninth requested
  -- field is an edit to both. They are named in each other's comments for that
  -- reason. coalesce so an unanswered field is left alone rather than blanked:
  -- the step list only contains what was asked, but a conversation abandoned
  -- and re-run could carry fewer answers than the record already holds.
  update public.members m set
    full_name        = coalesce(nullif(btrim(p_fields ->> 'full_name'), ''), m.full_name),
    address_line     = coalesce(nullif(btrim(p_fields ->> 'address'), ''), m.address_line),
    city             = coalesce(nullif(btrim(p_fields ->> 'city'), ''), m.city),
    neighbourhood    = coalesce(nullif(btrim(p_fields ->> 'neighbourhood'), ''), m.neighbourhood),
    birth_date       = coalesce((nullif(btrim(p_fields ->> 'age'), ''))::date, m.birth_date),
    cpf_hash         = coalesce(nullif(btrim(p_fields ->> 'cpf'), ''), m.cpf_hash),
    passport         = coalesce(nullif(btrim(p_fields ->> 'passport'), ''), m.passport),
    discovery_source = coalesce(nullif(btrim(p_fields ->> 'discovery_source'), ''), m.discovery_source),
    updated_at       = now()
  where m.id = p_member_id;

  -- (2) ONE CONFIRMATION PER FIELD THE LISTENER ACTUALLY ANSWERED, stamped now
  -- rather than with the message's own time: the confirmation records when we
  -- were told, and a listener answering a question put to them a minute ago is
  -- telling us now. Only the fields in p_fields -- a field the promotion did
  -- not ask about is not confirmed by a conversation that never mentioned it.
  insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at)
  select p_member_id, v_org, k::public.promotion_requested_field, now()
  from jsonb_object_keys(coalesce(p_fields, '{}'::jsonb)) k
  on conflict (member_id, field) do update set confirmed_at = excluded.confirmed_at;

  -- (3) THE ENTRY, through the same core the operator's door and the import use.
  v_result := public.apply_participation(
    p_promotion_id, p_member_id, p_completed_at, 'WHATSAPP',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'question_id', a ->> 'questionId',
        'option_id',   a ->> 'optionId',
        'answer_text', a ->> 'answerText'))
      from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) a), '[]'::jsonb));

  v_status := v_result ->> 'status';
  v_part   := (v_result ->> 'participation_id')::uuid;

  -- (4) THE REPLY, in the same transaction as the entry it announces, which is
  -- why there is no state in which somebody is entered and never told.
  v_body := public.whatsapp_reply_body(p_promotion_id, p_member_id, v_status);
  if v_body is not null then
    perform public.enqueue_whatsapp_outbound(
      p_integration_id, p_to_phone, v_body, null, p_dedupe_key);
  end if;

  -- And the message that completed it is finished here rather than by the
  -- caller, so the entry and the closing of the message that produced it cannot
  -- disagree -- which is also why 'recorded' is not in finish_whatsapp_turn's
  -- whitelist.
  perform public.finish_whatsapp_event(p_event_id, 'recorded', v_status, v_part);

  return jsonb_build_object('status', v_status, 'participation_id', v_part);
end;
$$;

revoke execute on function public.complete_whatsapp_conversation(uuid, uuid, uuid, uuid, text, jsonb, jsonb, timestamptz, text) from public;
grant execute on function public.complete_whatsapp_conversation(uuid, uuid, uuid, uuid, text, jsonb, jsonb, timestamptz, text) to service_role;

comment on function public.complete_whatsapp_conversation(uuid, uuid, uuid, uuid, text, jsonb, jsonb, timestamptz, text) is
  'The end of a conversation, in one transaction: the answers onto the listener''s record, a confirmation per field they answered, the entry through apply_participation, the reply, and the closing of the message that completed it. All of it or none of it -- an answer naming a question from another promotion is refused by apply_participation and nothing above it survives, which is what stops a record being updated for an entry that was never written. The conversation state is NOT cleared here: it belongs to the store, which may be Redis, and the caller clears it once this has committed. cpf arrives hashed (0031: the raw number never appears in an argument) and age as a date the engine has validated. The entry is judged by the LAST message''s timestamp, because a conversation begun inside the window and finished outside it is outside it.';

-- ---------------------------------------------------------------------------
-- 4. No, and it is written down.
--
-- Not a participation and not a fifth status: Block 4c's ruling holds, and a
-- refusal recorded as an entry-shaped row would let the draw's "VALID only"
-- filter go on looking complete while hiding a different kind of fact.
-- Recording it is what lets a Station measure refusal against abandonment, and
-- is the basis for not pestering somebody who said no.
-- ---------------------------------------------------------------------------
create function public.record_whatsapp_refusal(
  p_event_id       uuid,
  p_integration_id uuid,
  p_promotion_id   uuid,
  p_member_id      uuid,
  p_to_phone       text,
  p_body           text,
  p_refused_at     timestamptz,
  p_dedupe_key     text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org     uuid;
  v_company uuid;
  v_id      uuid;
begin
  select organization_id, company_id into v_org, v_company
  from public.promotions where id = p_promotion_id;
  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  insert into public.promotion_refusals
    (promotion_id, member_id, organization_id, company_id, refused_at, source)
  values
    (p_promotion_id, p_member_id, v_org, v_company, p_refused_at, 'WHATSAPP')
  returning id into v_id;

  if p_body is not null then
    perform public.enqueue_whatsapp_outbound(
      p_integration_id, p_to_phone, p_body, null, p_dedupe_key);
  end if;

  perform public.finish_whatsapp_turn(p_event_id, 'refused');

  return v_id;
end;
$$;

revoke execute on function public.record_whatsapp_refusal(uuid, uuid, uuid, uuid, text, text, timestamptz, text) from public;
grant execute on function public.record_whatsapp_refusal(uuid, uuid, uuid, uuid, text, text, timestamptz, text) to service_role;

comment on function public.record_whatsapp_refusal(uuid, uuid, uuid, uuid, text, text, timestamptz, text) is
  'Somebody pressed No: the refusal, the goodbye, and the closing of the message, in one transaction. In a table of its own rather than as a participation, because a refusal is not a bad entry -- inventing a fifth participation_status would make the draw''s "VALID only" filter go on looking complete while hiding another kind of fact entirely (Block 4c''s ruling). Repeat refusals are allowed to accumulate: how often somebody declines is the measurement this table exists for. The conversation state is cleared by the caller, for the same reason as in complete_whatsapp_conversation.';
