-- supabase/migrations/0271_suspended_station_gate.sql

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
  v_phone   text;
  v_country text;
  v_tenant_live boolean;
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
  v_env     jsonb;
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

  -- Block 30d, D4. THE NUMBER THIS DOOR REGISTERS A LISTENER UNDER IS THE
  -- CANONICAL ONE -- international_phone's answer, the same form 0263 wired
  -- every other door that writes a telephone number to. This door was the one
  -- it left out, and it is why the eight listeners 0262 had to repair were all
  -- first_contact_origin = 'WHATSAPP': that repair fixed the rows that existed
  -- and nothing stopped the ninth. This stops the ninth.
  --
  -- THE DELIVERED FORM IS NOT ALREADY CANONICAL, near as it looks: Meta
  -- delivers 5511988887777 and international_phone answers +5511988887777,
  -- because the plus is part of the shape members.phone carries (0260).
  -- phone_normalized drops it again, so who is who does not move -- only the
  -- spelling stored does.
  --
  -- THE COUNTRY IS THIS STATION'S, read from the integration this event has
  -- already matched, and never guessed from the number: 55 opens both Brazil's
  -- country code and Santa Maria's area code, which is the whole of 0260's
  -- header. A Station with NO country gets international_phone's digits
  -- unchanged, which for a WhatsApp sender means the DELIVERED digits --
  -- 5511988887777, country code and all.
  --
  -- THAT IS A CHANGE AT SUCH A STATION, and an earlier draft of this comment
  -- denied it by saying such a Station "stores exactly what it stores today".
  -- It does not: this door used to store whatsapp_local_phone's answer, so a
  -- Brazilian mobile went in as 11988887777 and now goes in as 5511988887777.
  -- What is unchanged at a country-less Station is what INTERNATIONAL_PHONE
  -- does -- it places no prefix it has not earned -- not what this door
  -- stores. supabase/tests/06_whatsapp.test.sql moves six phone_normalized
  -- literals exactly that way, at a Station whose fixtures carry no country.
  --
  -- AND THE TENANT'S OWN LIVENESS, in the same statement, because the fast
  -- path below needs it and no longer inherits it. THE no_installation GATE
  -- WAS DOING TWO JOBS AND ADVERTISED ONE: v_install is resolved through a
  -- join carrying c.deleted_at is null, c.status = 'active' and
  -- o.suspended_at is null, so until this migration a suspended Station or a
  -- blocked Organization could not reach anything PAST THAT GATE. Past that
  -- gate, and no further back: the pre-check branch above it has recorded a
  -- participation and enqueued a reply at a suspended Station since 0179, and
  -- still does -- see this file's report, which names the one clause that
  -- would close it. What follows is about the fast path only.
  --
  -- Moving the fast path above the gate (fix round 1) kept the first job and
  -- silently dropped the second, and the bypass was real: a suspended Station
  -- answered `recorded`, wrote the participation and enqueued the
  -- confirmation. None of the three columns is read by anything the fast path
  -- calls, so nothing downstream would have caught it.
  --
  -- THE ANALOGY, NOT A QUOTATION: 0164 applies "THIS IS THE ENDPOINT THAT
  -- SPENDS MONEY" to widget_request_code, its Door 2, whose own comment coins
  -- the phrase. This door is a different one, and the economics are the same
  -- shape -- every send past here makes Meta bill the Station whose
  -- subscription lapsed, which is what 0164's header calls "the same class of
  -- door with the same consequence, plus a bill".
  --
  -- READ ON ITS OWN rather than joined into the integration select above,
  -- because PL/pgSQL refuses `select i.*, c.country into v_integ, v_country`
  -- outright: "record variable cannot be part of multiple-item INTO list" --
  -- the same refusal widget_verify_code (0263) records for its own row.
  --
  -- THE ORGANIZATIONS JOIN REACHES THE SAME ROW v_install's does, by a
  -- different path: that one joins o.id = w.organization_id, off the
  -- installation, and this one joins o.id = c.organization_id, off the
  -- Station. They cannot disagree because widget_installations_company_org_fk
  -- is composite -- FOREIGN KEY (company_id, organization_id) REFERENCES
  -- companies(id, organization_id) -- so an installation's organization_id is
  -- always its own company's. The constraint is what makes this equivalent,
  -- not the shape of the two queries, and a schema that dropped it would need
  -- this comment reread.
  select c.country,
         c.deleted_at is null and c.status = 'active' and o.suspended_at is null
    into v_country, v_tenant_live
    from public.companies c
    join public.organizations o on o.id = c.organization_id
   where c.id = v_integ.company_id;

  v_phone := public.international_phone(v_from, v_country);

  -- The bot's FORMER spelling, kept for the second search below and never for
  -- a write. Computed from v_phone, which is the identical expression the four
  -- doors 0263 gave a second search compute, and never from v_from: v_from is
  -- left to the two places that need the form Meta delivered -- the 'phone'
  -- field of a link intent, which is what the conversation store is keyed on
  -- (19a's Critical), and the number an outbound reply is addressed to.
  v_local := public.whatsapp_local_phone(v_phone);

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

  if v_phone is null then
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

  -- P1. THE TENANT'S LIVENESS, TESTED ONCE, FOR ALL THREE HASHTAGS.
  --
  -- v_tenant_live was already computed above and, until this migration, was read
  -- in exactly one place: the fast path, far below. MUSIC and MENU never needed
  -- it, because neither can match without v_install, whose select joins
  -- companies and organizations on the same three columns. THE PROMOTION SELECT
  -- BELOW HAS NO SUCH JOIN -- it reads public.promotions straight off
  -- company_id -- so a suspended Station or a blocked Organization reached the
  -- listener resolution, the pre-check, and the outbox. 0267's own comment names
  -- that hole and says it is not closed there. This is the clause it says would
  -- close it.
  --
  -- WHAT THE HOLE WAS, measured against the tree without this migration rather
  -- than taken from 0267's account of it, and it has TWO SHAPES that a single
  -- fixture cannot show:
  --
  --   A STRANGER'S first message registered the listener into the lapsed
  --   Station and stopped there, answering no_installation. The entry was
  --   spared because a first-timer passes the pre-check and leaves by the link
  --   path, which needs an installation it cannot have.
  --
  --   A REPEAT listener's message went through the PRE-CHECK, which sits above
  --   every gate: it recorded the attempt, enqueued the reply telling them when
  --   their next chance is, and the door answered `recorded`. At a Station whose
  --   subscription had lapsed. That send is the bill 0164's header is about.
  --
  -- Both are pinned in 06_whatsapp, and an earlier draft of this comment claimed
  -- the outcome was never wrong -- true of the stranger, false of the repeat,
  -- and it was the fixture that was narrow rather than the defect. Neither shape
  -- is an outcome to correct: both are work done before the refusal, and only a
  -- gate ABOVE that work closes them.
  --
  -- PLACED HERE rather than beside the promotion select, so a dead tenant gives
  -- ONE answer whatever hashtag arrives, instead of tenant_inactive for a
  -- promotion and no_promotion for the other two. And placed BELOW the two
  -- raises above rather than over them: a payload the route mangled is the route
  -- describing its own defect, and suspending a Station must not silence that.
  --
  -- NOT PLACED ABOVE THE no_hashtag BRANCH either. That branch deliberately
  -- leaves the event PROCESSING for a caller that may hold the conversation
  -- outside this database, and answering it from here would finish a row the
  -- caller still owns.
  --
  -- A NEW OUTCOME rather than a reused one. webhook_events.outcome is plain text
  -- with no CHECK on its values (0058), and src/services/whatsapp.ts
  -- special-cases only 'link' and 'no_hashtag', so nothing downstream has to
  -- learn this word. Reusing no_installation -- the answer it gave by accident
  -- before -- would have recorded, in the one column built to answer "why didn't
  -- it work?", that a missing widget was the reason, when the widget is beside
  -- the point and the Station simply is not live. The listener's experience is
  -- identical either way: silence, design spec D4.
  if not coalesce(v_tenant_live, false) then
    return public.finish_whatsapp_event(v_event.id, 'tenant_inactive', null, null);
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

  -- The listener, resolved or registered. STILL TWO LOOKUPS and still 0070's
  -- unique_violation branch; what Block 30d changes is WHICH two numbers are
  -- searched, in which order, and which one is written.
  --
  -- CANONICAL FIRST, THE BOT'S FORMER SPELLING SECOND, which is the order 0263
  -- gave withdraw_marketing_by_phone and the three doors that resolve before
  -- they write. The pair reaches the same two numbers 0070's pair reached:
  -- apply_member_lookup normalises whatever it is handed, so asking about
  -- v_phone is asking about exactly the digits v_from carries. Nobody
  -- reachable before this migration is unreachable after it -- only the order
  -- moved, and it moved because 0262 put the listeners this door has to find
  -- into the international form.
  --
  -- THE SECOND SEARCH IS NOT DEAD CODE now that the write below is canonical.
  -- It finds a listener THIS door registered before today, under
  -- whatsapp_local_phone's answer; those rows stay in the database until
  -- something repairs them, and 0262's repair reached only the ones linked to
  -- a Station that carried a country.
  v_member := public.apply_member_lookup(
    v_integ.organization_id, v_phone, null, null, null);

  if v_member is null and v_local is distinct from public.normalize_phone(v_phone) then
    v_member := public.apply_member_lookup(
      v_integ.organization_id, v_local, null, null, null);
  end if;

  if v_member is null then
    begin
      v_member := public.apply_member_creation(
        v_integ.company_id, coalesce(v_profile, 'Ouvinte WhatsApp'), v_phone,
        null, null, null, null, null, null, null, null, null, null, null, null,
        null, v_when, 'WHATSAPP', null);
    exception
      when unique_violation then
        -- v_phone, not v_local: the violation is on phone_normalized, so the
        -- row that beat this one to the insert carries the digits v_phone
        -- carries. Looking the race up under a spelling this door no longer
        -- writes would answer null, and apply_member_link below would be
        -- handed a null listener.
        v_member := public.apply_member_lookup(
          v_integ.organization_id, v_phone, null, null, null);
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
    -- before it). The decision is 5a's and so is the dedupe key; what Block
    -- 30d changed under it is only how the reply reaches outbox_messages.
    v_result := public.apply_participation(
      v_promo.id, v_member, v_when, 'WHATSAPP', '[]'::jsonb);

    v_status := v_result ->> 'status';
    v_part   := (v_result ->> 'participation_id')::uuid;

    -- Block 30d, D9. THE HAND-WRITTEN INSERT IS GONE FROM THIS BRANCH. It
    -- wrote outbox_messages itself because that was the only way to send a
    -- plain sentence when 0062 wrote it; enqueue_whatsapp_outbound (0224)
    -- reaches the same row through the same dedupe key and additionally
    -- resolves this Station's own registration, so this reply and the
    -- confirmation below now obey one rule instead of two. The columns it
    -- fills that the hand-written insert did not are the template triple --
    -- all three left null for a session message, which is one of the two
    -- shapes outbox_messages_template_shape permits -- and
    -- template_otp_button, which that constraint does not mention at all. That
    -- column is NOT NULL with a DEFAULT of false, so the hand-written insert
    -- got false by omitting it and enqueue_whatsapp_outbound gets false by
    -- coalescing the unpopulated template row -- the same value by two routes,
    -- and the constraint is what enforces neither. A plain text reply sends no
    -- OTP button either way.
    v_env := public.whatsapp_reply_envelope(
               v_promo.id, v_member, v_status, v_integ.company_id);

    if v_env ->> 'body' is not null then
      perform public.enqueue_whatsapp_outbound(
        v_integ.id, v_from, v_env ->> 'body', null,
        v_event.external_id || ':confirmation',
        (v_env ->> 'purpose')::public.template_purpose,
        v_env -> 'variables');
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
  -- matter only at the moment this function would enter somebody, or hand
  -- them a link to the screen that asks them to accept the rules -- which is
  -- exactly this moment and no earlier. (Block 30d added the first of those
  -- two. The fast path below takes an entry with no screen at all, so this
  -- gate is now also what stops a promotion whose rules nobody has written
  -- from taking one.) Guarded on v_promo.id, not v_purpose, for the same
  -- reason the pre-check above needs no guard of its own: a MUSIC or MENU
  -- match never populates v_promo, so this never fires for either.
  --
  -- AND NOW AHEAD OF BOTH WAYS THIS FUNCTION CAN SAY YES (Block 30d, fix
  -- round 1). This gate used to sit BELOW no_installation, back when a link
  -- was the only yes there was. The fast path below enters a listener with no
  -- screen and no click at all, which makes rules matter MORE there and not
  -- less: they are the consent that listener never clicks, and past this line
  -- there is no later door to catch a promotion whose rules nobody has
  -- written. A promotion with no rules text still sends nothing, whichever of
  -- the two ways below would otherwise have followed.
  --
  -- THE REORDERING CHANGES ONE OBSERVABLE THING and it is worth naming: a
  -- Station with no installation AND a promotion with no rules text now
  -- answers no_rules where it used to answer no_installation. Both are silent
  -- to the listener and both exist for the operator asking "why didn't it
  -- work?"; the one naming the promotion's own missing text is the better
  -- answer of the two, because it is the half that Station can fix without a
  -- separate console act.
  if v_promo.id is not null and (v_promo.rules is null or btrim(v_promo.rules) = '') then
    return public.finish_whatsapp_event(v_event.id, 'no_rules', null, null);
  end if;

  -- Block 30d, D8. NOTHING LEFT TO ASK MEANS THE ENTRY IS TAKEN NOW. The
  -- listener gets a confirmation instead of a link into a form that would ask
  -- them nothing and then enter them anyway.
  --
  -- THE TEST IS ON THE RECOMPUTED STEP LIST, so it is a question about the
  -- PAIR (promotion, listener) and never about the promotion alone: a
  -- promotion with no quiz still asks a newcomer for the fields it declares,
  -- and since 19a this bot cannot ask a question over WhatsApp at all. So a
  -- newcomer is still handed the link, fills the form once, and every entry
  -- after that is immediate. Recomputed here rather than read from anything a
  -- caller sent, which is 0171's rule and this block does not weaken it.
  --
  -- 'consent' IS NOT COUNTED, and it is the first step of every list
  -- whatsapp_conversation_steps can build. Sending the hashtag IS asking to
  -- take part -- the rules gate above says exactly that about web_enabled --
  -- and this door has never written a member_consents row. The divergence
  -- from the web is deliberate and on the record at both ends:
  -- widget_enter_promotion calls its own `rules` row a deliberate divergence
  -- from the doors that record none, and since 0268 it names THIS one among
  -- them by number rather than only complete_conversation (0071). Read that
  -- claim off the live function (pg_get_functiondef) rather than off 0234,
  -- whose wording 0268 replaced.
  --
  -- PLACED ABOVE THE no_installation GATE AND BELOW no_rules, and both halves
  -- of that are deliberate. The first cut of this migration sat below both,
  -- and the owner reversed it in fix round 1.
  --
  -- ABOVE no_installation, BECAUSE THAT GATE EXISTS FOR THE LINK AND THIS PATH
  -- MINTS NONE. What raises P0002 without an installation is
  -- widget_link_send_context, and nothing below this line calls it. The five
  -- functions this branch reaches are apply_participation,
  -- whatsapp_conversation_steps, whatsapp_reply_envelope,
  -- enqueue_whatsapp_outbound and finish_whatsapp_event, and NOT ONE OF THEM
  -- READS widget_installations -- which is the claim that matters and the one
  -- that was checked, `prosrc like '%widget_installation%'` over all five
  -- (participation_status_for, apply_member_link and apply_member_creation
  -- were checked the same way -- not because this branch reaches them, which
  -- it does not: the door calls all three ABOVE it, on the way here. They are
  -- in the check because a listener arriving at this branch has already been
  -- through them, so an installation read hiding in one of them would be an
  -- installation read on this path). The tables they do read
  -- are promotions, companies, message_templates, participations,
  -- member_company_links, integrations, webhook_events and audit_logs among
  -- others; that list is illustrative and a future edit need not keep it
  -- complete, whereas the widget_installations claim is load-bearing and a
  -- future edit must. The reply needs only the WhatsApp integration this
  -- function resolved at the top.
  --
  -- Gating a path that needs no widget behind a widget's existence would have
  -- been an arbitrary coupling, and it would have bitten hardest exactly where
  -- it must not: the gate's own comment below records that EVERY Station
  -- starts with no installation, because creating one is a separate console
  -- act (0159). The fast path would have been dead on arrival at every freshly
  -- provisioned Station -- which is the owner's item 14 read backwards, since
  -- that item asks for the configured hashtag to register the listener
  -- immediately, WITHOUT sending a widget link.
  --
  -- BELOW no_rules, because rules are the consent this listener never clicks.
  -- Entering somebody into a promotion whose rules nobody has written would
  -- take an agreement to a text that does not exist, and this branch is the
  -- one place in the codebase where an entry happens with no screen at all.
  --
  -- WHAT FALLS THROUGH still meets the installation gate unchanged: a listener
  -- with something left to answer needs the widget, and the widget needs an
  -- installation.
  --
  -- AND THE TENANT MUST BE LIVE, which is the half of no_installation's job
  -- this branch would otherwise have escaped. That gate resolves v_install
  -- through a join carrying c.deleted_at is null, c.status = 'active' and
  -- o.suspended_at is null, so before fix round 1 a suspended Station or a
  -- blocked Organization could not reach anything PAST THAT GATE.
  --
  -- PAST THAT GATE IS THE WHOLE OF THE CLAIM, and this comment said "any yes
  -- at all" until fix round 3 corrected it. The pre-check branch sits ABOVE
  -- both gates and always has (0179): at a suspended Station it still records
  -- a participation and still enqueues a reply, and so does the member
  -- resolution above it, which links a listener into a blocked Organization.
  -- Neither is this task's to close -- the report says what closing them would
  -- cost and which lines change -- but a reader must not be told this path was
  -- ever fully protected. It was protected past that gate.
  --
  -- Sitting above the gate, this branch has to ask the question itself -- and
  -- it was PROVED it does not inherit it: a suspended Station with a live,
  -- ruled, nothing-left-to-ask promotion answered `recorded`, wrote the
  -- participation and enqueued the confirmation. None of the three columns is
  -- read by anything this branch calls (checked in pg_proc.prosrc), so no
  -- function downstream would have refused it either.
  --
  -- coalesce(..., false), because a Station whose Organization row the join
  -- above could not match answers null, and a null tenant is not a live one.
  -- FALSE HERE MEANS FALL THROUGH, never an outcome of its own: a suspended
  -- tenant drops past this branch and finishes on one of the two gates, which
  -- is where it finished before this branch existed. WHICH of the two can
  -- differ, and only in one case: a suspended Station whose promotion ALSO has
  -- no rules text answered no_installation under 0179 and answers no_rules
  -- now, because fix round 1 put no_rules first. Both are silent to the
  -- listener and both write nothing; the outcome an operator reads changes,
  -- and this file's own no_rules comment says why that is the better of the
  -- two answers.
  if v_promo.id is not null
     and coalesce(v_tenant_live, false)
     and not exists (
       select 1
         from jsonb_array_elements(
                public.whatsapp_conversation_steps(v_promo.id, v_member)) as s
        where s ->> 'kind' in ('field', 'question'))
  then
    -- THE ENTRY IS WRITTEN BEFORE THE REPLY IS CHOSEN, and nothing about which
    -- envelope carries the sentence may undo it. That is why the envelope
    -- refuses a template it cannot fill rather than letting
    -- enqueue_whatsapp_outbound raise 22023 (0111) inside this transaction,
    -- and why enqueue answering null needs no branch here: it is a dedupe hit,
    -- which 0071's own comment calls success rather than conflict.
    v_result := public.apply_participation(
      v_promo.id, v_member, v_when, 'WHATSAPP', '[]'::jsonb);

    v_status := v_result ->> 'status';
    v_part   := (v_result ->> 'participation_id')::uuid;
    v_env    := public.whatsapp_reply_envelope(
                  v_promo.id, v_member, v_status, v_integ.company_id);

    if v_env ->> 'body' is not null then
      perform public.enqueue_whatsapp_outbound(
        v_integ.id, v_from, v_env ->> 'body', null,
        v_event.external_id || ':confirmation',
        (v_env ->> 'purpose')::public.template_purpose,
        v_env -> 'variables');
    end if;

    return public.finish_whatsapp_event(v_event.id, 'recorded', v_status, v_part);
  end if;

  -- Final review, Important #1 (0179), AND NOW THE LAST GATE RATHER THAN THE
  -- FIRST OF TWO. A promotion's hashtag can match with no live installation to
  -- answer through -- unlike MUSIC and MENU, whose match is structurally
  -- impossible without one, because the elsif chain above tests v_install's own
  -- columns. Every Station starts in exactly this state: creating a widget
  -- installation is a separate console act (0159), so a Station with a WhatsApp
  -- integration and a hashtagged, ruled promotion but no installation yet is
  -- the ORDINARY case, not an exotic one. Without this gate v_purpose stayed
  -- 'PROMOTION' regardless, the function reached the 'link' outcome below,
  -- widget_link_send_context raised P0002, sendServiceLink rethrew, and the
  -- event burned all six retry rungs and parked FAILED -- for a configuration
  -- that used to open a conversation and answer fine.
  --
  -- IT NOW GUARDS ONLY THE LINK, which is all it ever described. Everything it
  -- protects is downstream of this line: minting a code and building a URL. A
  -- listener with nothing left to answer was entered above and never arrives
  -- here, so the ORDINARY case the paragraph above names -- a Station whose
  -- widget nobody has switched on yet -- now answers that listener instead of
  -- falling silent at them.
  --
  -- NOT FOLDED INTO THE DIAGNOSTIC BRANCH above: v_diag there would find the
  -- very promotion v_promo already found (same filters, minus the window) and
  -- misreport outside_window for a promotion that is, in fact, live right now
  -- -- the wrong cause for the right symptom. no_installation is its own named
  -- outcome so the two are never confused reading webhook_events, the same
  -- reasoning no_rules states for itself above.
  if v_promo.id is not null and v_install.id is null then
    return public.finish_whatsapp_event(v_event.id, 'no_installation', null, null);
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
  'The bot''s door, and since Block 19a it answers with a LINK rather than opening a conversation. It claims the event FOR UPDATE SKIP LOCKED, resolves the Station and the hashtag, and matches it in ONE order: the Station''s live, uncancelled promotions first (D3), then its music_hashtag, then its service_hashtag -- first match wins, because a promotion''s tag is the specific word and the Station''s two are the general ones. v_install is resolved through the SAME join companies/organizations that mint_widget_link and widget_link_send_context use (0164, 0181): a suspended Station or a blocked Organization answers as no installation at all, everywhere in this block, not just downstream of here. THAT GATE WAS DOING TWO JOBS AND ADVERTISED ONE, and 0267''s fix round 1 nearly cost the second: it refuses a link that could not be minted, AND it was the only thing enforcing tenant liveness ON EVERYTHING PAST IT, because the three columns live in its join rather than in a test of their own. 0271 CLOSED THAT, and measured it on the way: the tenant''s liveness is now tested once, above all three hashtag matches, so a dead tenant finishes tenant_inactive having written nothing at all. Until then the pre-check branch and the member resolution sat ABOVE both gates and had since 0179, and what that cost has two shapes. A STRANGER''s first message registered the listener and stopped, answering no_installation, the entry spared because a first-timer leaves by a link path that needs an installation the lapsed Station cannot have. A REPEAT listener went through the PRE-CHECK, which sits above every gate: the attempt recorded, the next-chance reply enqueued, and the door answering `recorded` -- at a Station whose subscription had lapsed, which is the send 0164''s header is about. 06_whatsapp pins both shapes. Moving the fast path above the gate took the first job with it and left the second behind -- proved live, a suspended Station answering `recorded`, writing the participation and enqueueing the send. 0164 applies "THIS IS THE ENDPOINT THAT SPENDS MONEY" to widget_request_code rather than to this door, and the analogy is exact even though the citation would not be: 0164''s own header calls the widget "the same class of door with the same consequence, plus a bill", and a send from here bills the same lapsed Station the same way. So the statement that reads this Station''s country now reads c.deleted_at, c.status and o.suspended_at beside it, and the fast path is gated on all three: a suspended tenant falls through to the same no_installation it always answered. The claim above is true again, and it is now true by a test rather than by an accident of ordering. Past that point the listener is resolved or registered through the CANONICAL-THEN-LOCAL lookup pair 0267 put in place of 0070''s local-then-delivered one -- this door registers under international_phone''s answer now, like every other door that writes a telephone number (D4, item 1b), and searches whatsapp_local_phone''s answer second for the listeners it registered before that -- with 0070''s unique_violation race unchanged beside it, and THEN, before rules is ever consulted: an attempt that could not become a VALID entry is recorded and answered exactly as 5a did, because a repeat or a spent ceiling is a fact about a message this Station received (0054, 4c) and has nothing to do with whether a promotion has rules text yet -- checking rules ahead of this would answer somebody who has already used their chances with silence, and their attempt would never reach the reports an operator reads (fix round 1). Only once the listener is confirmed able to enter does a matched promotion with no rules text finish as no_rules -- silently (D4): rules are the consent the web screen writes, and web_enabled is deliberately not tested, because sending the hashtag already is asking to take part. THE GATE ORDER IS no_rules, THEN THE FAST PATH, THEN no_installation, and 0267''s fix round 1 put it that way round: rules gate BOTH ways of saying yes, because the fast path takes an entry with no screen and no click and there is no later door to catch a promotion nobody has written rules for, while no_installation guards only the LINK -- it exists because widget_link_send_context cannot mint one without an installation, and nothing on the fast path calls it (checked against pg_proc.prosrc: no function that path reaches reads widget_installations). Gating an entry that needs no widget behind a widget would have killed this path at every freshly provisioned Station, since every Station starts with no installation -- creating one is a separate console act (0159). One observable consequence: a Station with no installation AND no rules text now answers no_rules where it answered no_installation before. MUSIC and MENU need no equivalent of the no_installation gate: their match is structurally impossible without v_install''s own columns populated, so an absent, disabled or now-dark Station''s general hashtag falls straight to the diagnostic branch and finishes no_promotion, silently, exactly as a promotion hashtag with no live installation now also does under its own name. A matched promotion that leaves NOTHING TO ASK OF THIS LISTENER -- no field and no question in the step list, recomputed here and consent never counted -- is entered on the spot and answered {outcome: recorded} with the participation''s status, its reply enqueued through whatsapp_reply_envelope (0267, D8 and D9), which is also how the pre-check''s reply is enqueued now; the test is on the PAIR, so a newcomer at a promotion with no quiz still gets the link, fills the form once, and enters immediately ever after. Anything else hands back {outcome: link, purpose, promotion_id, member_id, ...} for the caller to mint a code and send, and NEVER {outcome: conversation} -- this function starts no conversation any more. TWO PATHS LEAVE THE EVENT PROCESSING -- that one, and a message with no hashtag, which may be an answer to a question the bot asked and can only be told apart by looking in the conversation store the caller owns. Both are finished by the caller, through finish_whatsapp_turn for the no-hashtag path and by whatever Task 5 closes the link path with. That keeps the INBOUND arm of reclaim_stale_whatsapp_claims load-bearing: a worker that dies mid-decision leaves a claimed row that only the reclaim frees, five minutes later.';

-- ---------------------------------------------------------------------------
-- The outcome column gains a seventh word. Re-issued whole rather than edited
-- where 0058 wrote it, which is the rule for every merged migration here.
-- ---------------------------------------------------------------------------
comment on column public.webhook_events.outcome is
  'Why this event finished. With status DONE it distinguishes recorded from no_integration, no_hashtag, no_promotion, promotion_cancelled, outside_window and -- since 0271 -- tenant_inactive, which is a suspended Station or a blocked Organization refusing every hashtag before a listener is registered, a participation recorded or a reply enqueued. All but the first are silent to the listener (design spec D4), and all of them are things somebody will eventually have to explain. "skipped" is NOT one of them: an event the door declined to take is left exactly as it was and never reaches DONE.';
