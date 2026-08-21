-- supabase/migrations/0267_whatsapp_fast_entry.sql

-- Block 30d, item 14 (D8, D9) and the last piece of item 1b (D4).
--
-- THREE CHANGES, ONE DOOR. ingest_whatsapp_event stops handing back a link
-- when the promotion and this listener between them leave nothing to ask; it
-- registers a listener under the same canonical telephone number every other
-- door has written since 0263; and both of its replies now travel through one
-- function that decides whether the sentence goes as an approved template or
-- as a session message.
--
-- EVERY BODY BELOW WAS DUMPED FROM THE LIVE DATABASE with
-- pg_get_functiondef and edited, never retyped from the migration that
-- introduced the function. ingest_whatsapp_event is live on 0179 and the three
-- doors at the foot of this file on 0263, both confirmed by dumping rather
-- than by reading the migration list. Re-deriving a body from an older file
-- silently reverts every repair made since and nothing turns red.
--
-- NO SIGNATURE MOVES. Every function here is a create-or-replace of an
-- existing signature or a wholly new name, so no ACL is dropped and no
-- overload is created (D4's own warning, and the Block 24 loss behind it). The
-- one new function's grants are stated with it.

-- ---------------------------------------------------------------------------
-- 1. Which envelope one reply travels in.
--
-- ONE RULE COVERS EVERY WAY A TEMPLATE CAN BE MISSING: the sentence goes as a
-- template when this Station has a live WhatsApp registration for the purpose
-- AND that registration's own body wants exactly the variables this function
-- computed; otherwise the same sentence goes as a session message.
--
-- The second half is not hypothetical, and it is not one case but two.
-- whatsapp_reply_body (0062) already carries a branch for a listener with no
-- computable next chance and one for a promotion with no ceiling: those two
-- sentences have no value to put in {{2}}, so the variable list is null and
-- there is nothing a two-placeholder template could render. And a registration
-- whose approved body uses a different number of placeholders than the purpose
-- was described with is a thing an operator can type on the Templates screen.
-- enqueue_whatsapp_outbound refuses both with 22023 (0111's variable-count
-- check, still the authority at send time).
--
-- PRE-VALIDATING HERE IS WHAT MAKES D9'S GUARANTEE TRUE, and that is this
-- function's reason for reading the registration's body at all. D9 says
-- "registration never depends on the reply". Without the check below that
-- sentence is FALSE, not merely unproven: on the fast path the participation
-- is already written when the reply is chosen, the raise happens inside the
-- same transaction, and the entry is rolled back -- so a template body an
-- operator typed with the wrong number of placeholders would destroy the very
-- entry it was meant to confirm, and the listener would be left with neither.
-- Measured, not argued: forcing the template branch with no registration makes
-- the door answer P0002 and the participation count drop to zero
-- (task-8-report.md, the second mutation).
--
-- So this function predicts the refusal and answers a session message instead
-- of provoking it. The listener gets the words either way; what cannot happen
-- is losing the entry over the envelope.
--
-- THE SESSION MESSAGE IS LEGITIMATE HERE AND ONLY HERE: the listener sent the
-- hashtag seconds earlier, so Meta's 24-hour window is open by their own act.
-- It is also what keeps every Station working on the day this ships, when none
-- of them has registered any of the four purposes 0266 added.
--
-- STABLE and SECURITY INVOKER with EXECUTE for nobody, the shape
-- whatsapp_reply_body already has and for its reason: it is called only from
-- inside SECURITY DEFINER bodies that have resolved their own Station, and
-- making it DEFINER would let a future GRANT turn it into a cross-tenant
-- reader of promotion names.
-- ---------------------------------------------------------------------------
create function public.whatsapp_reply_envelope(
  p_promotion_id uuid,
  p_member_id    uuid,
  p_status       text,
  p_company_id   uuid
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_name      text;
  v_ceiling   integer;
  v_min_hours integer;
  v_timezone  text;
  v_last      timestamptz;
  v_next      text;
  v_body      text;
  v_purpose   public.template_purpose;
  v_vars      jsonb;
  v_tpl_body  text;
  v_expected  integer;
begin
  select p.name, p.max_entries_per_member, p.min_hours_between_entries, c.timezone
    into v_name, v_ceiling, v_min_hours, v_timezone
  from public.promotions p
  join public.companies c on c.id = p.company_id
  where p.id = p_promotion_id;

  -- A promotion that no longer exists, exactly as 0062 answered it: a null
  -- body, which every caller reads as "enqueue nothing" because
  -- outbox_messages.body is NOT NULL with a non-blank CHECK.
  if not found then
    return jsonb_build_object('body', null, 'purpose', null, 'variables', '[]'::jsonb);
  end if;

  if p_status = 'VALID' then
    v_body    := format('Pronto! Você está participando de %s. Boa sorte!', v_name);
    v_purpose := 'PARTICIPATION_CONFIRMED';
    v_vars    := jsonb_build_array(v_name);

  elsif p_status = 'DUPLICATE' then
    v_body    := format('Você já está participando de %s.', v_name);
    v_purpose := 'PARTICIPATION_DUPLICATE';
    v_vars    := jsonb_build_array(v_name);

  elsif p_status = 'TOO_SOON' then
    if v_min_hours is not null then
      select max(participated_at) into v_last
      from public.participations
      where promotion_id = p_promotion_id
        and member_id = p_member_id
        and status = 'VALID';
    end if;

    v_purpose := 'PARTICIPATION_TOO_SOON';

    if v_last is null then
      -- 0062's own branch, kept word for word: not computable when the
      -- promotion carries no interval, or when the listener has no VALID entry
      -- to measure from. Both are reachable -- a promotion can be edited
      -- between the entry and the reply, and TOO_SOON is decided under a lock
      -- this function does not hold. THERE IS NO TIME TO PUT IN {{2}}, and the
      -- null variable list below is what sends this as a session message.
      v_body := 'Você já participou há pouco. Tente novamente mais tarde.';
      v_vars := null;
    else
      -- Rendered at the STATION's timezone, not the server's: the server runs
      -- UTC and three hours of error sends a listener back too late.
      --
      -- CAUGHT, AND FOR THE SAME REASON THE VARIABLE COUNT IS PRE-VALIDATED
      -- BELOW. `at time zone` raises 22023 -- "time zone \"X\" not
      -- recognized", the IDENTICAL sqlstate the variable-count check refuses
      -- with -- for a string that does not name a zone, and on the fast path
      -- ingest_whatsapp_event (0267) has already written the participation
      -- when it asks for this sentence. Uncaught, the reply would roll back
      -- the entry it exists to confirm, which is precisely what D9 promises
      -- cannot happen.
      --
      -- AND THE STRING IS REACHABLE, measured rather than assumed:
      -- companies.timezone is NOT NULL with a default of 'America/Sao_Paulo'
      -- and NO validity CHECK, add_company (0017) is the only function that
      -- writes it and inserts p_timezone raw, and addStationAction
      -- (admin/organizations/actions.ts) passes String(formData.get('timezone'))
      -- straight to that RPC with no zod parse. No RENDERED form carries the
      -- field -- station-form.tsx says name, timezone and status are
      -- deliberately absent -- so every Station created through a screen gets
      -- the default; but the door accepts whatever a platform admin posts, and
      -- the table holds no INSERT or UPDATE grant for authenticated or
      -- service_role, so that door is the only way in and it does not check.
      --
      -- THE FALLBACK IS A BRANCH THAT ALREADY EXISTS: an unusable zone
      -- degrades to the same sentence a listener gets when the next chance is
      -- not computable, with a null variable list, which the rule below sends
      -- as a session message. invalid_parameter_value only -- anything else
      -- still surfaces.
      begin
        v_next := to_char(
          (v_last + make_interval(hours => v_min_hours)) at time zone v_timezone,
          'HH24:MI');
      exception when invalid_parameter_value then
        v_next := null;
      end;

      if v_next is null then
        v_body := 'Você já participou há pouco. Tente novamente mais tarde.';
        v_vars := null;
      else
        v_body := format('Você já participou há pouco. Sua próxima chance é às %s.', v_next);
        v_vars := jsonb_build_array(v_name, v_next);
      end if;
    end if;

  elsif p_status = 'OVER_LIMIT' then
    v_purpose := 'PARTICIPATION_OVER_LIMIT';

    if v_ceiling is null then
      -- The same shape as the TOO_SOON branch above and for the same reason:
      -- no number to put in {{2}}.
      v_body := 'Você já usou todas as suas chances nesta promoção.';
      v_vars := null;
    else
      v_body := format('Você já usou suas %s chances nesta promoção.', v_ceiling);
      v_vars := jsonb_build_array(v_name, v_ceiling::text);
    end if;

  else
    -- Anything outside apply_participation's four statuses, answered the way
    -- 0062 answered it.
    return jsonb_build_object('body', null, 'purpose', null, 'variables', '[]'::jsonb);
  end if;

  -- THE RULE, and the one place it is decided. p_company_id null is a caller
  -- that has no Station to look a registration up for -- whatsapp_reply_body
  -- below is exactly that caller -- so it never gets a template.
  --
  -- The lookup is enqueue_whatsapp_outbound's own, predicate for predicate,
  -- CHANNEL INCLUDED: that door resolves the registration by
  -- (company, purpose, channel = 'WHATSAPP', not deleted) and raises P0002
  -- when it finds none, so a Station holding an EMAIL template for the same
  -- purpose must not be read here as a WhatsApp registration.
  if v_vars is not null and p_company_id is not null then
    select t.body into v_tpl_body
      from public.message_templates t
     where t.company_id = p_company_id
       and t.purpose = v_purpose
       and t.channel = 'WHATSAPP'
       and t.deleted_at is null;

    if found then
      -- 0111's expression, deliberately the same one: the highest {{n}} the
      -- APPROVED body uses. Read here to decide the envelope, and read again
      -- there to validate the send -- this one predicts, that one enforces.
      v_expected := coalesce((
        select max((regexp_matches[1])::integer)
        from regexp_matches(v_tpl_body, '\{\{(\d+)\}\}', 'g')
      ), 0);

      if v_expected = jsonb_array_length(v_vars) then
        return jsonb_build_object(
          'body', v_body, 'purpose', v_purpose::text, 'variables', v_vars);
      end if;
    end if;
  end if;

  return jsonb_build_object('body', v_body, 'purpose', null, 'variables', '[]'::jsonb);
end;
$$;

revoke execute on function public.whatsapp_reply_envelope(uuid, uuid, text, uuid) from public;

comment on function public.whatsapp_reply_envelope(uuid, uuid, text, uuid) is
  'Block 30d, D9. One reply, and the two questions about it answered together: WHICH SENTENCE a listener gets for a participation status, and WHICH ENVELOPE it travels in. Answers {body, purpose, variables} -- purpose null meaning "send this as a session message", and variables then empty, because a caller passing a purpose must pass the list that goes with it. The six sentences over apply_participation''s four statuses are the ones 0062 wrote and they live HERE now; whatsapp_reply_body is a wrapper over this function, so the next-chance clock and the ceiling are computed once rather than in two places that can drift. THE TEMPLATE IS CHOSEN ONLY WHEN IT CAN ACTUALLY BE SENT: a live WhatsApp registration for the purpose at that Station whose approved body wants exactly the variables computed here. Two sentences carry no variable list at all -- a TOO_SOON with no computable next chance, an OVER_LIMIT on a promotion with no ceiling -- and a registration can be typed with a different number of placeholders than the purpose was described with; enqueue_whatsapp_outbound (0111) refuses both with 22023. PRE-VALIDATING THAT HERE IS WHAT MAKES D9''S GUARANTEE ("registration never depends on the reply") TRUE RATHER THAN MERELY INTENDED: ingest_whatsapp_event (0267) takes the entry BEFORE it chooses the envelope, so the raise lands in the same transaction and rolls back the participation the reply existed to confirm -- proved by mutation, P0002 and a participation count of zero. Choosing an envelope may never destroy an entry. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from inside SECURITY DEFINER bodies that have already resolved their own Station.';

-- ---------------------------------------------------------------------------
-- 2. whatsapp_reply_body, now a wrapper.
--
-- The point of doing it this way. Writing the envelope BESIDE this function
-- would have put the next-chance clock and the ceiling in two places, and
-- 0062's header already states the rule this codebase keeps: one rule, one
-- entrance. PASSING A NULL COMPANY is what makes this answer a sentence and
-- never a template -- it has no Station to look a registration up for, and its
-- one live caller, complete_whatsapp_conversation (0071), wants the words.
--
-- ONE, not the two an earlier draft of this comment named. That draft measured
-- before this file rewrote the door in the section below: ingest_whatsapp_event
-- called this function then and calls the envelope now. A measurement taken
-- before your own change is not a measurement of the result. Re-measured after
-- it, against a database with this migration applied: pg_proc holds three
-- bodies mentioning the name and only complete_whatsapp_conversation actually
-- CALLS it -- enqueue_pickup_reminder (0112) and whatsapp_reply_envelope above
-- merely cite it in comments.
--
-- LANGUAGE CHANGES FROM plpgsql TO sql, which create-or-replace allows because
-- the signature and the return type do not move. Nothing else about it moves:
-- STABLE, SECURITY INVOKER, EXECUTE for nobody.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_reply_body(
  p_promotion_id uuid,
  p_member_id    uuid,
  p_status       text
)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select public.whatsapp_reply_envelope(
           p_promotion_id, p_member_id, p_status, null) ->> 'body';
$$;

revoke execute on function public.whatsapp_reply_body(uuid, uuid, text) from public;

comment on function public.whatsapp_reply_body(uuid, uuid, text) is
  'The six sentences a listener may receive, ADDRESSED THROUGH whatsapp_reply_envelope (0267) rather than written here: this is now a wrapper that asks the envelope for its body and discards the rest. It passes a NULL company on purpose, which is what makes it answer a sentence and never a template. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody. Its ONE live caller is complete_whatsapp_conversation (0071), measured against pg_proc AFTER 0267 rewrote the door rather than before it -- ingest_whatsapp_event called this function until this migration and calls whatsapp_reply_envelope now, so a count taken earlier in this same file would have been a count of the input. 0062''s "called only from ingest_whatsapp_event" was already false when 0071 shipped; matching `public.whatsapp_reply_body\s*\(` against pg_proc.prosrc separates the one real call from the two comments that merely name it (enqueue_pickup_reminder, 0112, and whatsapp_reply_envelope). There is deliberately no TypeScript copy: the reply is enqueued inside the transaction that writes the entry (design spec D7), so SQL is the only place that can render it. Returns NULL for any status outside apply_participation''s four and for a promotion that no longer exists; the caller must read null as "enqueue nothing", because outbox_messages.body is NOT NULL with a non-blank CHECK and a null would surface as 23502 instead of silence. The next-chance time is rendered at the STATION''s timezone (companies.timezone) and computed from the listener''s last VALID entry plus the promotion''s interval, which is data and never now().';


-- ---------------------------------------------------------------------------
-- 3. The door.
--
-- THE BODY BELOW IS 0179'S, dumped with pg_get_functiondef and confirmed
-- byte-identical to that migration's text before anything was changed. Four
-- things changed in it and nothing else did:
--
--   1. the listener is registered under international_phone's answer, and the
--      two lookups search canonical-then-local instead of local-then-delivered
--      (D4, and item 1b's last door);
--   2. the pre-check's reply stops writing outbox_messages by hand and goes
--      through enqueue_whatsapp_outbound like everything else (D9);
--   3. a new branch, AFTER no_rules AND BEFORE no_installation, takes the
--      entry when the recomputed step list holds no field and no question
--      (D8), and is gated on the tenant being live;
--   4. THE TWO GATES SWAPPED ORDER so that branch could sit between them:
--      no_rules now leads and no_installation now trails. Their bodies are
--      untouched; only their order and what each one covers moved, and each
--      says so where it sits;
--   5. v_body is gone and v_env, v_phone, v_country and v_tenant_live arrived.
--
-- WHAT DID NOT CHANGE, and is worth naming because the diff is long: the claim
-- FOR UPDATE SKIP LOCKED, the payload guards, the no_hashtag shape, the
-- three-hashtag match order, the diagnostic branch, THE BODY OF EITHER GATE
-- (item 4 moved them, it did not rewrite them), and the link intent's own
-- fields -- including 'phone', which stays the DELIVERED form for the reason
-- its comment gives at length.
-- ---------------------------------------------------------------------------
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
  -- blocked Organization could not reach anything past that gate. Moving the
  -- fast path above it (fix round 1) kept the first job and silently dropped
  -- the second, and the bypass was real: a suspended Station answered
  -- `recorded`, wrote the participation and enqueued the confirmation.
  -- Nothing the fast path calls reads either column, so nothing downstream
  -- would have caught it -- and 0164 calls this the ENDPOINT THAT SPENDS
  -- MONEY, because every send past here bills the Station whose subscription
  -- lapsed.
  --
  -- READ ON ITS OWN rather than joined into the integration select above,
  -- because PL/pgSQL refuses `select i.*, c.country into v_integ, v_country`
  -- outright: "record variable cannot be part of multiple-item INTO list" --
  -- the same refusal widget_verify_code (0263) records for its own row. The
  -- organizations join is the one v_install already makes, restated here
  -- rather than inferred, so the two cannot come to disagree about what a
  -- live tenant is.
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
  -- from the web is deliberate and already on the record: 0234's comment on
  -- widget_enter_promotion calls its own `rules` row "a deliberate divergence
  -- from complete_conversation (0071), which records none", and this door
  -- records none either.
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
  -- (their transitive callees, participation_status_for, apply_member_link and
  -- apply_member_creation, were checked the same way). The tables they do read
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
  -- blocked Organization could not reach any yes at all on this path. Sitting
  -- above the gate, this branch has to ask the question itself -- and it was
  -- PROVED it does not inherit it: a suspended Station with a live, ruled,
  -- nothing-left-to-ask promotion answered `recorded`, wrote the participation
  -- and enqueued the confirmation. Nothing this branch calls reads either
  -- column (checked in pg_proc.prosrc), so no function downstream would have
  -- refused it either.
  --
  -- coalesce(..., false), because a Station whose Organization row the join
  -- above could not match answers null, and a null tenant is not a live one.
  -- FALSE HERE MEANS FALL THROUGH, never a new outcome: a suspended tenant
  -- drops to the no_installation gate below and finishes exactly as it did
  -- before this branch existed, because that same join answers it no
  -- installation.
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
  'The bot''s door, and since Block 19a it answers with a LINK rather than opening a conversation. It claims the event FOR UPDATE SKIP LOCKED, resolves the Station and the hashtag, and matches it in ONE order: the Station''s live, uncancelled promotions first (D3), then its music_hashtag, then its service_hashtag -- first match wins, because a promotion''s tag is the specific word and the Station''s two are the general ones. v_install is resolved through the SAME join companies/organizations that mint_widget_link and widget_link_send_context use (0164, 0181): a suspended Station or a blocked Organization answers as no installation at all, everywhere in this block, not just downstream of here. THAT GATE WAS DOING TWO JOBS AND ADVERTISED ONE, and 0267''s fix round 1 nearly cost the second: it refuses a link that could not be minted, AND it was the only thing on the promotion path enforcing tenant liveness, because the three columns live in its join rather than in a test of their own. Moving the fast path above it took the first job with it and left the second behind -- proved live, a suspended Station answering `recorded`, writing the participation and enqueueing the send, on the path 0164 calls THE ENDPOINT THAT SPENDS MONEY. So the statement that reads this Station''s country now reads c.deleted_at, c.status and o.suspended_at beside it, and the fast path is gated on all three: a suspended tenant falls through to the same no_installation it always answered. The claim above is true again, and it is now true by a test rather than by an accident of ordering. Past that point the listener is resolved or registered through the CANONICAL-THEN-LOCAL lookup pair 0267 put in place of 0070''s local-then-delivered one -- this door registers under international_phone''s answer now, like every other door that writes a telephone number (D4, item 1b), and searches whatsapp_local_phone''s answer second for the listeners it registered before that -- with 0070''s unique_violation race unchanged beside it, and THEN, before rules is ever consulted: an attempt that could not become a VALID entry is recorded and answered exactly as 5a did, because a repeat or a spent ceiling is a fact about a message this Station received (0054, 4c) and has nothing to do with whether a promotion has rules text yet -- checking rules ahead of this would answer somebody who has already used their chances with silence, and their attempt would never reach the reports an operator reads (fix round 1). Only once the listener is confirmed able to enter does a matched promotion with no rules text finish as no_rules -- silently (D4): rules are the consent the web screen writes, and web_enabled is deliberately not tested, because sending the hashtag already is asking to take part. THE GATE ORDER IS no_rules, THEN THE FAST PATH, THEN no_installation, and 0267''s fix round 1 put it that way round: rules gate BOTH ways of saying yes, because the fast path takes an entry with no screen and no click and there is no later door to catch a promotion nobody has written rules for, while no_installation guards only the LINK -- it exists because widget_link_send_context cannot mint one without an installation, and nothing on the fast path calls it (checked against pg_proc.prosrc: no function that path reaches reads widget_installations). Gating an entry that needs no widget behind a widget would have killed this path at every freshly provisioned Station, since every Station starts with no installation -- creating one is a separate console act (0159). One observable consequence: a Station with no installation AND no rules text now answers no_rules where it answered no_installation before. MUSIC and MENU need no equivalent of the no_installation gate: their match is structurally impossible without v_install''s own columns populated, so an absent, disabled or now-dark Station''s general hashtag falls straight to the diagnostic branch and finishes no_promotion, silently, exactly as a promotion hashtag with no live installation now also does under its own name. A matched promotion that leaves NOTHING TO ASK OF THIS LISTENER -- no field and no question in the step list, recomputed here and consent never counted -- is entered on the spot and answered {outcome: recorded} with the participation''s status, its reply enqueued through whatsapp_reply_envelope (0267, D8 and D9), which is also how the pre-check''s reply is enqueued now; the test is on the PAIR, so a newcomer at a promotion with no quiz still gets the link, fills the form once, and enters immediately ever after. Anything else hands back {outcome: link, purpose, promotion_id, member_id, ...} for the caller to mint a code and send, and NEVER {outcome: conversation} -- this function starts no conversation any more. TWO PATHS LEAVE THE EVENT PROCESSING -- that one, and a message with no hashtag, which may be an answer to a question the bot asked and can only be told apart by looking in the conversation store the caller owns. Both are finished by the caller, through finish_whatsapp_turn for the no-hashtag path and by whatever Task 5 closes the link path with. That keeps the INBOUND arm of reclaim_stale_whatsapp_claims load-bearing: a worker that dies mid-decision leaves a claimed row that only the reclaim frees, five minutes later.';

-- ---------------------------------------------------------------------------
-- 4. Three comments that this migration made false, in the doors 0263 wrote
--    them in.
--
-- COMMENTS ONLY. The three bodies below are 0263's, dumped from the live
-- database and confirmed byte-identical to that file's text; the SEARCH each
-- one makes is untouched and must stay. What changed is what the comment
-- beside it claims: each said the WhatsApp bot "still" registers a listener
-- under the local form, which stops being true one section above this one, and
-- resolve_or_create_member's went further and named the condition for deleting
-- the branch -- a condition this migration meets while the branch must stay,
-- because the rows it reaches were written before today and are still there.
--
-- Two of them also named a function that has never existed: "ingest_link_intent"
-- is 0179's FILE name, and the only function that migration defines is
-- ingest_whatsapp_event. Checked against pg_proc, not against the file list.
--
-- A false comment is a defect of the same severity as false code, and a
-- comment this migration falsifies is this migration's to fix -- which is why
-- three functions that do not change behaviour are recreated here. The bodies
-- were not retyped: they were dumped, diffed and edited, so the only lines
-- that differ from what is live are the comment lines quoted above.
-- ---------------------------------------------------------------------------

-- 4a. resolve_or_create_member -- live on 0263.
create or replace function public.resolve_or_create_member(
  p_company_id      uuid,
  p_full_name       text,
  p_phone           text default null,
  p_email           text default null,
  p_cpf_hash        text default null,
  p_cpf_last_digits text default null,
  p_passport        text default null
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org     uuid;
  v_country text;
  v_phone   text;
  v_local   text;
  v_found   jsonb;
  v_id      uuid;
begin
  select organization_id, country into v_org, v_country
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Block 30d, item 1b. Sanitised HERE, at the door, and not inside
  -- apply_member_lookup or find_member_by_identifier: those functions resolve
  -- and never write, so a door that looked up the clean number and inserted
  -- the raw one would find the right listener and still store the wrong form
  -- -- the same split, one layer deeper. The country comes from the Station
  -- this door already resolved above.
  v_phone := public.international_phone(p_phone, v_country);

  v_found := public.find_member_by_identifier(
    v_org, v_phone, p_email, p_cpf_hash, p_passport);

  -- THE BOT'S FORMER SPELLING IS SEARCHED SECOND, and it is searched by name
  -- rather than by hoping the caller typed it. The bot's registration
  -- (apply_member_creation, in ingest_whatsapp_event) wrote the LOCAL form
  -- until 0267 and writes international_phone's answer since, so a listener
  -- whose first contact was a WhatsApp message BEFORE that migration is stored
  -- as 11988887777 while the search above looks for 5511988887777 and finds
  -- nothing -- and registering them again is exactly the split item 1b exists
  -- to stop.
  --
  -- ONE FUNCTION, NOT TWO: 0179 defines ingest_whatsapp_event and nothing
  -- else, so the "ingest_link_intent" this comment used to name beside it was
  -- that migration's FILE name and never a function -- checked against pg_proc
  -- rather than against the file name.
  --
  -- COMPUTED, NOT ECHOED, and the reason differs by door -- which is why this
  -- comment does not claim one reason for all of them.
  --
  -- AT THIS DOOR the earlier `v_phone is distinct from p_phone` guard was TRUE
  -- and its search really did run. Both real callers hand over keystrokes: the
  -- Participations manual form posts a bare <Input name="phone">
  -- (record-participation-form.tsx:264 -- no country-code composer, and
  -- src/schemas/participations.ts:50 only trims, caps at 40 and demands one
  -- digit), and import_participations feeds spreadsheet cells straight through.
  -- What was wrong there was not that the search never ran but WHAT it searched:
  -- an operator who typed the international form made the raw search look for
  -- the same number the canonical search had just looked for, so the bot's row
  -- was missed anyway. At widget_verify_code and api_record_music_request the
  -- guard was false outright, because their callers post the international form
  -- already.
  --
  -- whatsapp_local_phone(v_phone) answers both: it is the bot's own function
  -- applied to the canonical value, so it produces the bot's spelling whatever
  -- the caller typed. It subsumes the old search rather than replacing it --
  -- when the operator DID type the local form, v_local comes back as exactly
  -- the digits they typed -- and it additionally covers the case the old one
  -- could not reach.
  --
  -- NOT DELETED BY THE BOT WRITING THE CANONICAL FORM, which is the condition
  -- an earlier version of this comment named and 0267 has now met. The rows it
  -- reaches are already in the database, and 0262's repair reached only the
  -- listeners linked to a Station that carried a country. What deletes this
  -- branch is a sweep that leaves no local-form row behind.
  v_local := public.whatsapp_local_phone(v_phone);
  if v_found ->> 'outcome' = 'none'
     and v_local is distinct from public.normalize_phone(v_phone) then
    v_found := public.find_member_by_identifier(
      v_org, v_local, p_email, p_cpf_hash, p_passport);
  end if;

  if v_found ->> 'outcome' = 'visible' then
    return jsonb_build_object(
      'outcome', 'resolved', 'member_id', (v_found ->> 'member_id')::uuid);
  end if;

  if v_found ->> 'outcome' = 'elsewhere' then
    return jsonb_build_object('outcome', 'elsewhere');
  end if;

  v_id := public.create_member(
    p_company_id, p_full_name, v_phone, p_email,
    p_cpf_hash, p_cpf_last_digits, p_passport);

  return jsonb_build_object('outcome', 'created', 'member_id', v_id);
end;
$$;

-- 4b. widget_verify_code -- live on 0263.
create or replace function public.widget_verify_code(
  p_public_key text,
  p_phone      text,
  p_code_hash  text,
  p_name       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_install public.widget_installations;
  v_verif   public.widget_verifications;
  v_country text;
  v_phone   text;
  v_local   text;
  v_member  uuid;
  v_anon    boolean;
begin
  -- 1. Resolve the installation. Unknown, disabled, archived, suspended and
  -- blocked all answer the same refusal -- probing for a live key learns
  -- nothing here either, the same shape widget_frame_context already answers
  -- with for the same key. 0164 added the last two; `w.*` for the same reason
  -- widget_request_code's lookup gives.
  select w.* into v_install
    from public.widget_installations w
    join public.companies c
      on c.id = w.company_id
     and c.deleted_at is null
     and c.status = 'active'
    join public.organizations o
      on o.id = w.organization_id
     and o.suspended_at is null
   where w.public_key = p_public_key and w.enabled and w.deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_installation',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- Block 30d, item 1b. A SECOND READ OF A ROW THE JOIN ABOVE ALREADY TOUCHED,
  -- and it has to be: PL/pgSQL refuses `select w.*, c.country into v_install,
  -- v_country` outright -- "record variable cannot be part of multiple-item
  -- INTO list" -- and widening v_install to a bare `record` would rewrite every
  -- v_install reference below for the sake of one column read once per call.
  --
  -- ONE VALUE FOR EVERY THING THIS FUNCTION DOES WITH A NUMBER: the
  -- verification row it looks up in step 2, the listener it resolves in step 7,
  -- and the one it registers in step 8. widget_request_code above computes THE
  -- SAME expression from THE SAME installation's country and stores its answer,
  -- so the two calls agree by construction rather than by both being left raw.
  -- The ordinary case is unchanged -- the browser posts the same string twice
  -- and both canonicalise to the same value -- and the case that used to fail
  -- now works: a visitor who asks with 11 98888-7777 and enters with
  -- +55 11 98888-7777 matched nothing before and matches the row now.
  select c.country into v_country
    from public.companies c
   where c.id = v_install.company_id;

  v_phone := public.international_phone(p_phone, v_country);

  -- 2. The newest UNCONSUMED verification for this installation and phone.
  -- Newest, not merely "a matching one": a visitor who asks for a second
  -- code has abandoned the first, and only the latest is still meant to be
  -- typed back. consumed_at is null is the whole filter -- an expired but
  -- never-used row is still "the pending one" here, and step 3 below is what
  -- refuses it, so the reason reported is the true one rather than a generic
  -- "no such code".
  --
  -- FOR UPDATE, AND THIS IS WHAT MAKES THE CEILING A CEILING. Without this
  -- lock, N requests that arrive concurrently for the same row all execute
  -- their own step 2 select before any of them reaches step 5's update, so
  -- all N read the SAME pre-increment `attempts` and all N pass step 4's
  -- `attempts >= 5` check against it -- a ceiling of five sequential guesses,
  -- but no ceiling at all on however many an attacker can open at once. See
  -- 0161 for the full argument, including why this is a row lock rather than
  -- apply_participation's (0054) advisory lock.
  select * into v_verif
    from public.widget_verifications
   where installation_id = v_install.id
     and phone = v_phone
     and consumed_at is null
   order by created_at desc
   limit 1
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_pending_code',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- 3. Expired.
  if v_verif.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- 4. THE CEILING, CHECKED BEFORE THE HASH -- see 0161's header comment on
  -- this function for why the order is the entire control.
  if v_verif.attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- 5. The hash, compared only once the ceiling has already let this attempt
  -- through. A wrong guess counts against the ceiling and stops here; it
  -- does not touch consumed_at, so the row is still "the pending one" for
  -- the next attempt, counted or refused in its turn.
  if v_verif.code_hash <> p_code_hash then
    update public.widget_verifications
       set attempts = attempts + 1
     where id = v_verif.id;

    return jsonb_build_object('ok', false, 'reason', 'wrong_code',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- 6. The right code, spent. Stamped now, before the listener below is even
  -- looked up, so this exact code cannot be replayed regardless of what the
  -- remaining steps decide -- including the anonymised-listener refusal in
  -- step 7, which answers false but leaves the code burned all the same.
  update public.widget_verifications
     set consumed_at = now()
   where id = v_verif.id;

  -- 7. Resolved through the SAME core the WhatsApp bot (0062) and the
  -- Block 15 API door (0152) use -- nothing new decides who a listener is.
  -- v_phone, which is the one value this function uses for every question it
  -- asks about a number: the verification row in step 2, this lookup, and the
  -- registration in step 8. Not p_phone, and not a normalisation of it --
  -- apply_member_lookup normalises whatever it is handed through
  -- normalize_phone (0031) anyway, so what matters here is not the punctuation
  -- but WHICH NUMBER is asked about, and at a Station with a country the
  -- canonical one is a different number from the keystrokes.
  v_member := public.apply_member_lookup(v_install.organization_id, v_phone, null, null, null);

  -- And the bot's FORMER spelling second, for the reason
  -- resolve_or_create_member's own comment gives at length: until 0267,
  -- ingest_whatsapp_event registered a listener under the local form, and
  -- searching only the canonical one would hand a visitor the bot already
  -- knows -- knows from before that migration -- a second row. Computed with
  -- whatsapp_local_phone rather than echoing p_phone back, because the widget's
  -- own form has posted '+' || digits since 2026-08-10, commit 658174b
  -- (composePhone,
  -- identify-form.tsx:41) -- a guard comparing v_phone with p_phone would be
  -- false for every real visitor and this branch would never run. It resolves;
  -- it writes nothing, so a listener found by it keeps the phone the bot stored.
  v_local := public.whatsapp_local_phone(v_phone);
  if v_member is null and v_local is distinct from public.normalize_phone(v_phone) then
    v_member := public.apply_member_lookup(v_install.organization_id, v_local, null, null, null);
  end if;

  if v_member is not null then
    select m.anonymized_at is not null into v_anon
      from public.members m where m.id = v_member;

    -- 0034's erasure. Recording fresh activity -- a name, a Station link, a
    -- consent -- against somebody who exercised it is precisely what the
    -- erasure was for, the same refusal 0152 gives for the API door. NOT
    -- re-created under a new row either: that would be the same defect
    -- wearing a different id. Nothing past this point is written; the code
    -- stays consumed from step 6, which is what makes this a REFUSAL rather
    -- than a retryable failure -- the visitor cannot simply ask again.
    if v_anon then
      return jsonb_build_object('ok', false, 'reason', 'listener_anonymized',
                                'member_id', null, 'company_id', null,
                                'organization_id', null);
    end if;
  end if;

  -- 8. Not found: a name is required to register one -- there is no WhatsApp
  -- profile name to fall back on here, the way the bot (0062) does, because
  -- this visitor has never sent a WhatsApp message. p_first_contact_origin
  -- is 'web-widget' so an audience report can tell this listener's first
  -- contact apart from one who arrived over WhatsApp, the same distinction
  -- 0160's comment on member_consent_type draws for the consent row in step
  -- 10. p_actor is null -- see 0161's header comment on this function.
  if v_member is null then
    if nullif(trim(coalesce(p_name, '')), '') is null then
      return jsonb_build_object('ok', false, 'reason', 'name_required',
                                'member_id', null, 'company_id', null,
                                'organization_id', null);
    end if;

    v_member := public.apply_member_creation(
      v_install.company_id, p_name, v_phone, null, null, null, null, null,
      null, null, null, null, null, null, null, null,
      now(), 'web-widget', null);
  end if;

  -- 9. Idempotent at the table (0061, ON CONFLICT DO NOTHING): a returning
  -- visitor already linked to this Station costs nothing extra to call this
  -- again, and one already known to the Organization through a different
  -- Station is linked to this one for the first time. The boolean this core
  -- returns is deliberately ignored here, the same way the WhatsApp bot
  -- (0062) ignores it -- a listener already linked is the ordinary case for
  -- a repeat visitor, not a refusal.
  perform public.apply_member_link(v_member, v_install.company_id, v_install.organization_id, null);

  -- 10. The consent this whole door exists to produce: a name and a phone
  -- number, volunteered on this Station's own website rather than arriving
  -- over WhatsApp. origin = 'web-widget' is what lets an audit tell the two
  -- apart (0160). recorded_by is null for the same reason p_actor is -- see
  -- 0161's header comment on this function.
  insert into public.member_consents
    (organization_id, member_id, company_id, consent_type, granted, origin, recorded_by)
  values
    (v_install.organization_id, v_member, v_install.company_id,
     'identification', true, 'web-widget', null);

  -- 11. ok, with the three ids the caller needs and nothing else -- no name,
  -- no phone, echoing back exactly what widget_frame_context's minimalism
  -- already argues for the refusal branches above.
  return jsonb_build_object('ok', true, 'reason', null,
                            'member_id', v_member,
                            'company_id', v_install.company_id,
                            'organization_id', v_install.organization_id);
end;
$$;

-- 4c. api_record_music_request -- live on 0263.
create or replace function public.api_record_music_request(
  -- p_request_external_id and p_listener_name carry defaults and sit after
  -- p_phone, for the reason api_register_song's own comment gives: a parameter
  -- with no default is generated as REQUIRED, and both of these are optional --
  -- the listener's name only when the Station already knows the phone (D6).
  p_credential_id       uuid,
  p_company_id          uuid,
  p_org                 uuid,
  p_phone               text,
  p_request_external_id text        default null,
  p_listener_name       text        default null,
  p_show_name           text        default null,
  p_requested_at        timestamptz default null,
  p_song_external_id    text    default null,
  p_title               text    default null,
  p_artist_name         text    default null,
  p_label_name          text    default null,
  p_genre_name          text    default null,
  p_album_title         text    default null,
  p_nationality         public.music_nationality default null,
  p_vocal               public.music_vocal default null,
  p_duration_seconds    integer default null,
  p_isrc                text    default null,
  p_internal_code       text    default null,
  p_deezer_track_id     bigint  default null,
  p_deezer_album_id     bigint  default null,
  p_upc                 text    default null,
  p_cover_md5           text    default null,
  p_release_date        date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company    uuid;
  v_org        uuid;
  v_country    text;
  v_phone      text;
  v_local      text;
  v_scopes     text[];
  v_external   text := nullif(btrim(coalesce(p_request_external_id, '')), '');
  v_name       text := nullif(btrim(coalesce(p_listener_name, '')), '');
  v_show_name  text := nullif(btrim(coalesce(p_show_name, '')), '');
  v_member     uuid;
  v_member_new boolean := false;
  v_linked     boolean := false;
  v_anonymised boolean;
  v_show       uuid;
  v_song       jsonb;
  v_request    uuid;
  v_existing   public.music_requests%rowtype;
begin
  -- co.country joins Block 30d, item 1b, to a statement that was already
  -- joining companies for the archived/inactive gate. It is in the GROUP BY
  -- rather than wrapped in an aggregate because the group is one credential
  -- and therefore one Station: min(co.country) would answer the same value
  -- while suggesting there could be several.
  select c.company_id, c.organization_id,
         coalesce(array_agg(s.permission_code) filter (where s.permission_code is not null),
                  '{}'::text[]),
         co.country
    into v_company, v_org, v_scopes, v_country
  from public.api_credentials c
  left join public.api_credential_scopes s on s.credential_id = c.id
  join public.companies co
    on co.id = c.company_id and co.deleted_at is null and co.status = 'active'
  where c.id = p_credential_id
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now())
  group by c.company_id, c.organization_id, co.country;

  if not found or not ('music.request' = any(v_scopes)) then
    raise log 'api_record_music_request denied: credential=%', p_credential_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  -- The arguments are checked against the credential and never used, for the
  -- reason api_register_song gives above: a door that trusts a caller-supplied
  -- company_id is one bug in the route away from writing into another Station.
  if v_company <> p_company_id or v_org <> p_org then
    raise log 'api_record_music_request station mismatch: credential=% asked=%',
      p_credential_id, p_company_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  -- Block 30d, item 1b. AFTER the credential is resolved, because the country
  -- is the credential's OWN Station: p_company_id is never trusted here (see
  -- the station-mismatch check above), so it cannot be the thing asked for a
  -- country either.
  --
  -- The guard below tests v_phone rather than p_phone, and the two cannot
  -- disagree about it: international_phone answers null exactly when
  -- normalize_phone does, and normalize_phone of a non-null answer of its own
  -- is never null.
  v_phone := public.international_phone(p_phone, v_country);

  if public.normalize_phone(v_phone) is null then
    raise exception 'a listener must be identified by a phone number' using errcode = '22023';
  end if;

  -- IDEMPOTENCY FIRST, before anything is created. A retry must not register a
  -- listener or a song on its way to discovering that it already recorded this
  -- request -- which is exactly what would happen if this check sat lower down.
  if v_external is not null then
    select * into v_existing from public.music_requests
     where company_id = v_company and external_id = v_external and deleted_at is null;

    if found then
      return jsonb_build_object(
        'request_id', v_existing.id,
        'created', false,
        'song', jsonb_build_object('id', v_existing.song_id, 'created', false,
                                   'filled', '[]'::jsonb),
        'listener', jsonb_build_object('id', v_existing.member_id, 'created', false,
                                       'linked', true));
    end if;
  end if;

  -- v_phone, which is the one value this door uses for the guard above, this
  -- lookup and the registration below. Not p_phone, and the difference is not
  -- punctuation: both cores normalise whatever they are given, so what changes
  -- here is WHICH NUMBER is asked about -- at a Station with a country the
  -- canonical form is a different number from the digits that arrived.
  v_member := public.apply_member_lookup(v_org, v_phone, null, null, null);

  -- And the bot's FORMER spelling second, for the reason
  -- resolve_or_create_member's own comment gives at length: until 0267,
  -- ingest_whatsapp_event registered a listener under the local form, and a
  -- Station that ran both the bot and this API before that migration has one
  -- person in two rows unless this search finds them. Computed with
  -- whatsapp_local_phone rather
  -- than echoing p_phone back, because this endpoint's documented contract is
  -- already the international form (docs/API.md:147) -- a guard comparing
  -- v_phone with p_phone would be false for every caller following it, and this
  -- branch would never run.
  v_local := public.whatsapp_local_phone(v_phone);
  if v_member is null and v_local is distinct from public.normalize_phone(v_phone) then
    v_member := public.apply_member_lookup(v_org, v_local, null, null, null);
  end if;

  if v_member is not null then
    select m.anonymized_at is not null into v_anonymised
      from public.members m where m.id = v_member;

    -- 0034's erasure. Recording fresh activity against somebody who exercised
    -- it is precisely what that erasure was for, and create_music_request
    -- excludes them for the same reason. NOT recreated under a new row either:
    -- that would be the same defect wearing a different id.
    if v_anonymised then
      raise exception 'that listener has been anonymised' using errcode = '23514';
    end if;
  end if;

  if v_member is null then
    -- Design D6, the owner's ruling of 2026-08-09. The external application
    -- attends on WhatsApp and therefore holds the profile name; arriving
    -- without one is its bug, and this refuses rather than registering a
    -- nameless listener somebody has to clean up later.
    if v_name is null then
      raise exception 'a new listener must arrive with a name' using errcode = '22023';
    end if;
    if not ('members.create' = any(v_scopes)) then
      raise exception 'permission denied: members.create required' using errcode = '42501';
    end if;

    -- Every optional field is null, INCLUDING discovery_source and
    -- first_contact_origin. Those two are free text with a vocabulary the
    -- screens already read, and inventing a value here that no screen knows how
    -- to display would be worse than leaving the truth absent.
    v_member := public.apply_member_creation(
      v_company, v_name, v_phone, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null, null);
    v_member_new := true;
    v_linked     := true;
  else
    -- Known to the Organization already -- members are Organization-scoped
    -- (0031), so the same person entering at two of the group's Stations is one
    -- row. What has to be true is that THIS Station may see them.
    if not exists (select 1 from public.member_company_links
                    where member_id = v_member and company_id = v_company) then
      if not ('members.create' = any(v_scopes)) then
        raise exception 'permission denied: members.create required' using errcode = '42501';
      end if;
      v_linked := public.apply_member_link(v_member, v_company, v_org, null);
    end if;
  end if;

  -- The programme. RESOLVED, NEVER CREATED. `shows` is the one catalogue entity
  -- with no merge door -- 0098's table comment says so and names it as the
  -- deliberate gap -- so an API creating one from a typed name would breed
  -- duplicates with no cure. An unknown name is refused loudly rather than
  -- dropped in silence, which would record a request against no programme at
  -- all and look like it worked.
  if v_show_name is not null then
    select id into v_show from public.shows
     where company_id = v_company and deleted_at is null
       and lower(name) = lower(v_show_name)
     order by created_at limit 1;

    if not found then
      raise exception 'programme not found in this station: %', v_show_name
        using errcode = 'P0002';
    end if;
  end if;

  -- The song, by endpoint 1's rules exactly -- the same core, so the two
  -- endpoints cannot come to disagree about what registering a song means.
  v_song := public.apply_song_intake(
    v_company, v_org, null,
    p_song_external_id, p_title, p_artist_name, p_label_name, p_genre_name,
    p_album_title, p_nationality, p_vocal, p_duration_seconds, p_isrc,
    p_internal_code, p_deezer_track_id, p_deezer_album_id, p_upc,
    p_cover_md5, p_release_date);

  -- Checked AFTER the intake rather than before, because whether the song has
  -- to be created is not knowable until the ladder has been walked. The whole
  -- body is one transaction, so this refusal unwinds the song it is refusing.
  if (v_song ->> 'created')::boolean and not ('music.manage' = any(v_scopes)) then
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, show_id, channel,
     requested_at, external_id, created_by)
  values
    (v_org, v_company, v_member, (v_song ->> 'song_id')::uuid, v_show, 'API',
     coalesce(p_requested_at, now()), v_external, null)
  returning id into v_request;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'api_record_music_request', 'music_requests', v_request, v_org, v_company,
     jsonb_build_object('credential_id', p_credential_id,
                        'member_created', v_member_new,
                        'song', v_song, 'show_id', v_show));

  return jsonb_build_object(
    'request_id', v_request,
    'created', true,
    'song', v_song,
    'listener', jsonb_build_object('id', v_member, 'created', v_member_new,
                                   'linked', v_linked));
end;
$$;

-- The three ACLs, restated exactly as 0263 restated them and for the same
-- reason: every function above is a create-or-replace of a signature that did
-- not move, so nothing was dropped and nothing was lost -- checked against
-- pg_proc.proacl before and after, not assumed -- and stating them here is
-- what puts the list in front of a future drop-and-recreate. That is the shape
-- of the loss Block 24 took.
revoke execute on function public.resolve_or_create_member(uuid, text, text, text, text, text, text) from public;
grant execute on function public.resolve_or_create_member(uuid, text, text, text, text, text, text) to authenticated;

revoke execute on function public.widget_verify_code(text, text, text, text) from public;
grant execute on function public.widget_verify_code(text, text, text, text) to service_role;

revoke execute on function public.api_record_music_request(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, text, text, text, text, public.music_nationality, public.music_vocal, integer, text, text, bigint, bigint, text, text, date) from public;
grant execute on function public.api_record_music_request(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, text, text, text, text, public.music_nationality, public.music_vocal, integer, text, text, bigint, bigint, text, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 5. And the account international_phone keeps of who is wired to it.
-- ---------------------------------------------------------------------------

comment on function public.international_phone(text, text) is
  'One telephone number in the form this database already stores: a leading plus, then the country code, then the national number, and no other punctuation -- the shape every members.phone row in production already carries. Goes through normalize_phone (0031) for the comparison rather than stripping punctuation itself, so it cannot drift from members.phone_normalized, the generated column whose value decides who is who; that column drops the plus, so identity is unaffected by it. A LEADING PLUS ON THE ARGUMENT SHORT-CIRCUITS THE WHOLE RULE: it is the caller asserting the international form, so the digits are returned with their plus and no country rule is consulted. Without that, the length test decides using the STATION''s national range and cannot tell a foreign number from a local one -- at a Brazilian Station the eleven-digit +12125551234 would be read as national and answered as +5512125551234, and update_member would do it again on every save. IDEMPOTENT: running this over its own output returns the same string -- now by that first branch rather than by the length ranges -- which is what makes the 0262 repair safe to re-run. Returns the digits UNCHANGED AND UNPREFIXED when country_phone_rule has no row for the country and when the length matches neither range -- refusing would stop a listener registering because an administrator left a select empty, guessing would split one person into two rows, and a plus in front of a number whose country nobody established would be a claim this function has not earned. Block 30d, item 1b: 0263 wired the console (create_member, update_member), the spreadsheet (resolve_or_create_member, which import_participations calls once per row), the widget (widget_request_code and widget_verify_code together, so the row one writes is the row the other matches) and the external API (api_record_music_request) to this function, and 0267 wired the BOT (ingest_whatsapp_event -- the only function 0179 defines, whatever that migration''s file name says), which was the door 0263 named as the one it did not close. Every door that writes a telephone number now writes the same shape. THE SECOND SEARCH THOSE DOORS MAKE IS NOT OBSOLETE, and 0267 deliberately left it: resolve_or_create_member, widget_verify_code, api_record_music_request and withdraw_marketing_by_phone look for this function''s answer and then for whatsapp_local_phone''s, which is what reaches a listener the bot registered in the LOCAL form before 0267 -- rows 0262''s repair could only reach where the Station carried a country. The three doors that write without resolving search nothing.';
