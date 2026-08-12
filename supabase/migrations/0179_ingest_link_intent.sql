-- Block 19a, Task 3. The hashtag stops opening a conversation inside WhatsApp
-- and starts addressing a door: a promotion still owns its own word first,
-- but a Station's two general hashtags -- music and service -- now answer
-- too, and every match becomes a link intent handed back to the caller
-- rather than a conversation begun here.
--
-- THE LIVE BODY BELOW IS 0070'S, extracted by script (the brief's Step 1)
-- rather than retyped from memory or copied forward from 0062, the function's
-- birth migration. 0062's body is not what shipped -- 0070 replaced it -- and
-- retyping either would have silently reverted every guard 0070 added, the
-- way 0168 once reverted 0163's public-key pin. Only the decision AFTER the
-- hashtag is extracted has changed; the payload guards, the two member
-- lookups and the p_pre <> 'VALID' branch are untouched, down to their
-- comments.
create or replace function public.ingest_whatsapp_event(
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
  v_install public.widget_installations%rowtype;
  v_member  uuid;
  v_result  jsonb;
  v_status  text;
  v_part    uuid;
  v_body    text;
  v_outcome text;
  v_purpose text;
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

  -- D3. Three hashtags, one order: the Station's live promotions, then its
  -- music hashtag, then its service hashtag. First match wins.
  --
  -- Promotions first because a promotion's hashtag is the specific word and the
  -- Station's two are the general ones, and because that is the order that was
  -- already true before this block -- reversing it would silently retire
  -- hashtags customers have printed on flyers.
  select * into v_promo
  from public.promotions
  where company_id = v_integ.company_id
    and lower(hashtag) = v_tag
    and deleted_at is null
    and cancelled_at is null
    and v_when >= starts_at and v_when < ends_at
  limit 1;

  -- Final review, Important #1. Joins companies and organizations, the same
  -- way 0164's fix wave already made mint_widget_link and
  -- widget_link_send_context do (0181): "a live installation" has to mean
  -- the same thing here that it means downstream, or the two disagree and
  -- the disagreement parks an event. Without this join a SUSPENDED Station's
  -- or a BLOCKED Organization's still-enabled row was found here anyway, a
  -- hashtag matched, and the event reached the 'link' outcome below only to
  -- fail two steps later at widget_link_send_context -- the identical
  -- regression the PROMOTION gate a few lines down exists to close, just for
  -- MUSIC and MENU, which were believed structurally safe from it and were
  -- not.
  select w.* into v_install
  from public.widget_installations w
  join public.companies c
    on c.id = w.company_id
   and c.deleted_at is null
   and c.status = 'active'
  join public.organizations o
    on o.id = w.organization_id
   and o.suspended_at is null
  where w.company_id = v_integ.company_id
    and w.enabled
    and w.deleted_at is null;

  if v_promo.id is not null then
    v_purpose := 'PROMOTION';
  elsif v_install.music_hashtag is not null
        and lower(v_install.music_hashtag) = v_tag then
    v_purpose := 'MUSIC';
  elsif v_install.service_hashtag is not null
        and lower(v_install.service_hashtag) = v_tag then
    v_purpose := 'MENU';
  else
    -- The diagnostic of 0070 is kept exactly as it was: three answers for the
    -- operator asked "why didn't it work?", all silent to the listener.
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

  -- The listener, resolved or registered, exactly as before. (Keep 0070's two
  -- lookups and its unique_violation branch verbatim -- the second lookup is
  -- the one that stops a duplicate listener on every first message from a
  -- number an operator typed with a country code.)
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

  -- Reached for every purpose, not only PROMOTION: when v_promo stayed null (a
  -- MUSIC or MENU match), participation_status_for finds no promotion row and
  -- returns VALID by its own contract (0069: "a promotion id that names
  -- nothing returns VALID... it is not a validation door"), so the branch
  -- below only ever fires for an actual promotion.
  --
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

  -- D4. RULES ARE THE CONSENT the listener accepts on the screen, and 17c
  -- writes that row. A promotion with none cannot be entered on the web at
  -- all, so answering with a link would be sending somebody to a door that
  -- refuses them. web_enabled is deliberately NOT tested: sending the hashtag
  -- IS asking to take part, and the flag governs only the widget's list.
  --
  -- CHECKED HERE, AFTER THE PRE-CHECK, and not a moment sooner (fix round 1:
  -- the first draft of this migration checked it immediately on the match,
  -- ahead of the listener even being resolved, and that silently killed the
  -- repeat/ceiling reply for every promotion that had no rules text yet). A
  -- repeat, an early return and a spent ceiling are FACTS ABOUT A MESSAGE THIS
  -- STATION RECEIVED (0054's ruling, and 4c's before it) and have nothing to
  -- do with whether a rules text exists -- checking rules first would answer
  -- a listener who has already used their chances with silence instead, and
  -- their attempt would vanish from the reports an operator reads. Rules
  -- matter only at the moment this function would hand somebody a link to a
  -- screen that asks them to accept them, which is exactly this moment and no
  -- earlier. Guarded on v_promo.id, not v_purpose, for the same reason the
  -- pre-check above needs no guard of its own: a MUSIC or MENU match never
  -- populates v_promo, so this never fires for either.
  -- Final review, Important #1. A promotion's hashtag can match with no live
  -- installation to answer through -- unlike MUSIC and MENU, whose match is
  -- structurally impossible without one, because the elsif chain above tests
  -- v_install's own columns. Every Station starts in exactly this state:
  -- creating a widget installation is a separate console act (0159), so a
  -- Station with a WhatsApp integration and a hashtagged, ruled promotion but
  -- no installation yet is the ORDINARY case, not an exotic one. Without this
  -- gate v_purpose stayed 'PROMOTION' regardless, the function reached the
  -- 'link' outcome below, widget_link_send_context raised P0002, sendServiceLink
  -- rethrew, and the event burned all six retry rungs and parked FAILED --
  -- for a configuration that used to open a conversation and answer fine.
  --
  -- GATED HERE, BESIDE no_rules, and not folded into the diagnostic branch
  -- above: v_diag there would find the very promotion v_promo already found
  -- (same filters, minus the window) and misreport outside_window for a
  -- promotion that is, in fact, live right now -- the wrong cause for the
  -- right symptom. no_installation is its own named outcome so the two are
  -- never confused reading webhook_events, the same reasoning no_rules
  -- already states for itself two lines below.
  if v_promo.id is not null and v_install.id is null then
    return public.finish_whatsapp_event(v_event.id, 'no_installation', null, null);
  end if;

  if v_promo.id is not null and (v_promo.rules is null or btrim(v_promo.rules) = '') then
    return public.finish_whatsapp_event(v_event.id, 'no_rules', null, null);
  end if;

  -- THE EVENT STAYS PROCESSING, and nothing is sent from here. What goes back
  -- is an intention: mint a code, build a URL that only Node knows the host of,
  -- and enqueue one message. That is the same division 0070 already used for a
  -- conversation, and it is what lets D7's bridge live in one place -- the
  -- caller checks for a live conversation first, and a listener mid-answer is
  -- never handed a link that would abandon what they already typed.
  -- 'phone' IS THE DELIVERED FORM, v_from -- the same value the two sibling
  -- intents this function already returns use for their own 'phone' field
  -- (0070:244, the no_hashtag shape a few lines above this one, and
  -- 0070:365, the retired 'conversation' shape this branch replaced). Fix
  -- round 1's Critical finding: the first cut of this branch returned
  -- v_local (the LOCAL form, country code stripped) under 'phone' and v_from
  -- under a second field, 'to_phone' -- the one field, in the one intent out
  -- of three, that disagreed with the store's own contract
  -- (src/lib/conversation/store.ts: "keyed on the phone as WhatsApp
  -- delivered it"). Every live conversation row is written under the
  -- delivered form; a caller that keyed its lookup on this field using the
  -- local form missed the row for essentially every Brazilian listener (the
  -- one population whose delivered and local forms actually differ), so a
  -- listener mid-conversation was handed a link instead of having their
  -- answer read -- exactly what D7 exists to prevent. There is now ONE
  -- field, ONE meaning, the same in all three intents this function can
  -- return; 'to_phone' is gone rather than kept alongside a corrected
  -- 'phone', because a second field carrying the same value a caller could
  -- reach for by mistake is the same trap with a smaller blast radius.
  return jsonb_build_object(
    'outcome',        'link',
    'event_id',       v_event.id,
    'integration_id', v_integ.id,
    'company_id',     v_integ.company_id,
    'phone',          v_from,
    'member_id',      v_member,
    'purpose',        v_purpose,
    'promotion_id',   v_promo.id,
    'promotion_name', v_promo.name,
    'dedupe_prefix',  v_event.external_id);
end;
$$;

revoke execute on function public.ingest_whatsapp_event(uuid, integer) from public;
grant execute on function public.ingest_whatsapp_event(uuid, integer) to service_role;

comment on function public.ingest_whatsapp_event(uuid, integer) is
  'The bot''s door, and since Block 19a it answers with a LINK rather than opening a conversation. It claims the event FOR UPDATE SKIP LOCKED, resolves the Station and the hashtag, and matches it in ONE order: the Station''s live, uncancelled promotions first (D3), then its music_hashtag, then its service_hashtag -- first match wins, because a promotion''s tag is the specific word and the Station''s two are the general ones. v_install is resolved through the SAME join companies/organizations that mint_widget_link and widget_link_send_context use (0164, 0181): a suspended Station or a blocked Organization answers as no installation at all, everywhere in this block, not just downstream of here. Past that point the listener is resolved or registered exactly as 0070 left it (the local-then-delivered lookup pair, and the unique_violation race), and THEN, before rules is ever consulted: an attempt that could not become a VALID entry is recorded and answered exactly as 5a did, because a repeat or a spent ceiling is a fact about a message this Station received (0054, 4c) and has nothing to do with whether a promotion has rules text yet -- checking rules ahead of this would answer somebody who has already used their chances with silence, and their attempt would never reach the reports an operator reads (fix round 1). Only once the listener is confirmed able to enter does a matched promotion with no live installation finish as no_installation (final review: every Station starts in exactly that state, since creating one is a separate console act, 0159) or, past that, with no rules text finish as no_rules -- both send nothing (D4): rules are the consent the web screen writes, and web_enabled is deliberately not tested, because sending the hashtag already is asking to take part. MUSIC and MENU need no equivalent of the no_installation gate: their match is structurally impossible without v_install''s own columns populated, so an absent, disabled or now-dark Station''s general hashtag falls straight to the diagnostic branch and finishes no_promotion, silently, exactly as a promotion hashtag with no live installation now also does under its own name. Anything else hands back {outcome: link, purpose, promotion_id, member_id, ...} for the caller to mint a code and send, and NEVER {outcome: conversation} -- this function starts no conversation any more. TWO PATHS LEAVE THE EVENT PROCESSING -- that one, and a message with no hashtag, which may be an answer to a question the bot asked and can only be told apart by looking in the conversation store the caller owns. Both are finished by the caller, through finish_whatsapp_turn for the no-hashtag path and by whatever Task 5 closes the link path with. That keeps the INBOUND arm of reclaim_stale_whatsapp_claims load-bearing: a worker that dies mid-decision leaves a claimed row that only the reclaim frees, five minutes later.';
