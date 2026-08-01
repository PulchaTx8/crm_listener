-- supabase/migrations/0062_ingest_whatsapp_event.sql
--
-- The bot's door. It is the third entrance to apply_participation and the only
-- one not gated on has_permission: the worker runs as service_role, has no
-- auth.uid(), and there is no user whose permissions could be checked. What
-- stands in for the gate is the integrations row -- a message is ingested only
-- if it arrived at a number this installation serves and has switched on.
--
-- 0054's comment predicted this function: "Block 5 will have no choice about
-- recording what happened to a message it received."
--
-- This file is the first migration allowed to WRITE 'WHATSAPP' into
-- participation_source. 0060 added the value; ALTER TYPE ... ADD VALUE may run
-- inside a transaction but the value cannot be used until that transaction
-- commits, which is why the two are separate files and not one.

-- ---------------------------------------------------------------------------
-- 1. The sender, as this database stores phones.
--
-- Members store phones digits-only (normalize_phone, 0031), and an operator
-- types a local number: (11) 99999-8888 becomes 11999998888. WhatsApp delivers
-- the sender WITH the country code, 5511999998888. Matched raw, those never
-- meet, the unique index does not collide, and the bot registers a second
-- record for somebody Block 3 already knows -- the exact opposite of what the
-- dedup exists for.
--
-- Delegates to normalize_phone rather than stripping non-digits itself, for
-- the reason 0031's own comment gives: members.phone_normalized is GENERATED
-- from that function, so anything that re-derives the normalisation by hand can
-- drift from the column it is supposed to match.
--
-- Known limit, stated rather than discovered: this strips +55 only. A Brazilian
-- mobile that gained its ninth digit after the listener was registered still
-- reads as a different person, and so does any other country's numbering -- and
-- a twelve-digit foreign number that happens to begin 55 is stripped when it
-- should not be. Block 9's ETL reconciliation (L1) faces the same problem
-- against legacy data and is where a general answer belongs.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_local_phone(p_wa_phone text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when d is null then null
    -- 55 + 2-digit area code + 8 or 9 subscriber digits.
    when length(d) in (12, 13) and left(d, 2) = '55' then substr(d, 3)
    else d
  end
  from (select public.normalize_phone(p_wa_phone) as d) s;
$$;

revoke execute on function public.whatsapp_local_phone(text) from public;

comment on function public.whatsapp_local_phone(text) is
  'The sender of a WhatsApp message as this database stores phones. Strips a Brazilian country code so an inbound 5511999998888 matches a listener an operator registered as (11) 99999-8888 -- without this the bot duplicates every listener Block 3 already knows, because members.phone_normalized is digits-only and the two strings simply differ. Goes through normalize_phone (0031) rather than stripping non-digits itself, so it cannot drift from the generated column it has to match. Strips +55 only; the ninth-digit change, other countries, and a foreign twelve-digit number that happens to begin 55 are Block 9''s reconciliation problem (L1).';

-- ---------------------------------------------------------------------------
-- 2. The reply copy, and the only place it lives.
--
-- There is deliberately NO TypeScript copy of these strings. The reply has to
-- be enqueued inside the transaction that writes the entry (design spec D7), so
-- SQL is the only place that can render it, and a second copy in the worker
-- would be a second thing to keep in step with the first -- one rule with two
-- entrances, the shape Block 4b was returned for twice.
--
-- Portuguese, and the only Portuguese in this repository's SQL: it is copy read
-- by a listener on their phone, not an identifier, a message to an operator or
-- a comment.
--
-- Returns NULL for anything that is not one of apply_participation's four
-- statuses, and for a promotion that no longer exists. The caller MUST treat
-- null as "enqueue nothing": outbox_messages.body is NOT NULL with a non-blank
-- CHECK (0059), so passing a null body straight into the insert would turn
-- "say nothing" into 23502.
--
-- {hora} is rendered at the STATION's timezone (companies.timezone, 0003), not
-- the server's and not the listener's, which we do not know. The server runs
-- UTC; a next chance at 18:00Z read to a listener in Sao Paulo as "18:00" is
-- three hours wrong, and wrong in the direction that sends somebody back too
-- late.
--
-- The next chance is computed from the listener's last VALID entry plus the
-- promotion's interval -- data, never now(). apply_participation has ALREADY
-- written the TOO_SOON row by the time this is called, and that row is not
-- VALID, so it cannot be mistaken for the entry the clock runs from.
--
-- SECURITY INVOKER with EXECUTE for nobody, the shape every private core in
-- this repository takes (0054, 0061): it is only ever called from inside a
-- SECURITY DEFINER body that has already resolved its own Station, and making
-- it DEFINER would let a future GRANT turn it into a cross-tenant reader of
-- promotion names.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_reply_body(
  p_promotion_id uuid,
  p_member_id    uuid,
  p_status       text
)
returns text
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
begin
  select p.name, p.max_entries_per_member, p.min_hours_between_entries, c.timezone
    into v_name, v_ceiling, v_min_hours, v_timezone
  from public.promotions p
  join public.companies c on c.id = p.company_id
  where p.id = p_promotion_id;

  if not found then
    return null;
  end if;

  if p_status = 'VALID' then
    return format('Pronto! Você está participando de %s. Boa sorte!', v_name);

  elsif p_status = 'DUPLICATE' then
    return format('Você já está participando de %s.', v_name);

  elsif p_status = 'TOO_SOON' then
    if v_min_hours is not null then
      select max(participated_at) into v_last
      from public.participations
      where promotion_id = p_promotion_id
        and member_id = p_member_id
        and status = 'VALID';
    end if;

    -- Not computable when the promotion carries no interval, or when the
    -- listener has no VALID entry to measure from. Both are reachable: a
    -- promotion can be edited between the entry and the reply, and TOO_SOON is
    -- decided under a lock this function does not hold.
    if v_last is null then
      return 'Você já participou há pouco. Tente novamente mais tarde.';
    end if;

    v_next := to_char(
      (v_last + make_interval(hours => v_min_hours)) at time zone v_timezone,
      'HH24:MI');
    return format('Você já participou há pouco. Sua próxima chance é às %s.', v_next);

  elsif p_status = 'OVER_LIMIT' then
    if v_ceiling is null then
      return 'Você já usou todas as suas chances nesta promoção.';
    end if;
    return format('Você já usou suas %s chances nesta promoção.', v_ceiling);
  end if;

  return null;
end;
$$;

revoke execute on function public.whatsapp_reply_body(uuid, uuid, text) from public;

comment on function public.whatsapp_reply_body(uuid, uuid, text) is
  'The six sentences a listener may receive, and the single place they live. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from ingest_whatsapp_event. There is deliberately no TypeScript copy -- the reply is enqueued inside the transaction that writes the entry (design spec D7), so SQL is the only place that can render it and a second copy in the worker would be a second thing to keep in step with the first. Returns NULL for any status outside apply_participation''s four, and for a promotion that no longer exists; the caller must read null as "enqueue nothing", because outbox_messages.body is NOT NULL with a non-blank CHECK and a null would surface as 23502 instead of silence. The next-chance time is rendered at the STATION''s timezone (companies.timezone), not the server''s -- the server runs UTC and three hours of error sends a listener back too late -- and it is computed from the listener''s last VALID entry plus the promotion''s interval, which is data and never now().';

-- ---------------------------------------------------------------------------
-- 3. Finishing an event, and the audit row that goes with it.
--
-- webhook_events_done_shape (0058) makes DONE a claim about two other columns:
-- outcome and processed_at must be set WITH it, and no other status may carry
-- either. So this is the only place any of the three is written, and it writes
-- all three in one statement rather than leaving a window where the row is DONE
-- and not yet explained.
--
-- processed_at is now() and that is not a breach of the timestamp discipline
-- this file otherwise keeps: it records when we DECIDED, which really is now.
-- Everything decided ABOUT the message is judged by the message's own
-- timestamp; this column is the one honest use of the processing clock.
--
-- NO PHONE NUMBER, NAME OR OTHER PERSONAL DATA IN THE AUDIT DETAIL. That is
-- Block 3's rule and it is absolute. The detail carries ids and the HASHED
-- message id; the phone, the WhatsApp profile name and the raw provider id stay
-- in webhook_events.payload, which no user-scoped client can read (0058 has RLS
-- on and no policy) and which prune_webhook_payloads clears after 30 days
-- (design spec D9). audit_logs has no such pruning, which is exactly why
-- nothing personal may land in it.
--
-- The key is 'wamid_sha256' and not 'wamid', because the distinction is the
-- whole point: a wamid decodes to bytes containing the counterparty's phone
-- number, so a raw one here would be a recoverable phone in a table that is
-- never pruned. webhook_events.external_id is already the hash (0058) and this
-- copies it rather than deriving it, so the two cannot disagree. Naming the key
-- after the raw thing would invite the next reader to put the raw thing in it.
--
-- The promotion and the member are DERIVED from the participation rather than
-- passed in. That keeps this signature to the four things a caller actually
-- has at every one of its six call sites, and it cannot disagree with the row
-- it describes. The cost, stated: on the silent outcomes there is no
-- participation, so promotion_id and member_id are null even where the
-- diagnostic lookup identified a promotion. webhook_events.outcome carries the
-- reason for those, and the payload carries the message.
--
-- actor_id is null, and that is how a bot-originated write is told from an
-- operator's (0061). SECURITY INVOKER with EXECUTE for nobody.
-- ---------------------------------------------------------------------------
create or replace function public.finish_whatsapp_event(
  p_event_id uuid,
  p_outcome  text,
  p_status   text,
  p_part     uuid
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_wamid   text;
  v_integ   uuid;
  v_org     uuid;
  v_company uuid;
  v_promo   uuid;
  v_member  uuid;
begin
  update public.webhook_events
     set status = 'DONE',
         outcome = p_outcome,
         processed_at = now()
   where id = p_event_id
  returning external_id, integration_id, organization_id, company_id
       into v_wamid, v_integ, v_org, v_company;

  if p_part is not null then
    select promotion_id, member_id
      into v_promo, v_member
    from public.participations
    where id = p_part;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'ingest_whatsapp_event', 'webhook_events', p_event_id, v_org, v_company,
     jsonb_build_object(
       'integration_id',   v_integ,
       'wamid_sha256',     v_wamid,
       'promotion_id',     v_promo,
       'member_id',        v_member,
       -- Not in the brief's list, and added deliberately: without it nothing
       -- anywhere ties a message to the entry it produced. apply_participation
       -- writes its own audit row against the participation, so the two join on
       -- this key. It is an id and carries nothing personal.
       'participation_id', p_part,
       'outcome',          p_outcome));

  return jsonb_build_object(
    'outcome', p_outcome, 'status', p_status, 'participation_id', p_part);
end;
$$;

revoke execute on function public.finish_whatsapp_event(uuid, text, text, uuid) from public;

comment on function public.finish_whatsapp_event(uuid, text, text, uuid) is
  'Closes one inbound event and writes the trail for it. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from ingest_whatsapp_event, which reaches it as a SECURITY DEFINER body. The only writer of webhook_events.status = DONE, outcome and processed_at, and it writes all three in one statement because webhook_events_done_shape (0058) makes DONE a claim about the other two. processed_at is now() and is the one honest use of the processing clock -- it records when the decision was made, while everything decided ABOUT the message is judged by the message''s own timestamp. The audit row carries ids and the HASHED message id, under the key wamid_sha256, and NO PHONE, NAME OR OTHER PERSONAL DATA (Block 3''s rule): a raw wamid decodes to bytes containing the counterparty phone, so the phone, the profile name and the raw provider id all stay in webhook_events.payload, which has RLS on with no policy and which prune_webhook_payloads clears after 30 days, whereas audit_logs is never pruned. The hash is copied from webhook_events.external_id rather than derived, so the two cannot disagree. actor_id is null, which is how a bot-originated write is told from an operator''s. The promotion and the member are derived from the participation rather than passed, so they cannot disagree with the row they describe; on the silent outcomes there is no participation and both are null, with webhook_events.outcome carrying the reason instead.';

-- ---------------------------------------------------------------------------
-- 4. The door itself.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_whatsapp_event(p_event_id uuid)
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
  v_trim    text;
  v_tags    text[];
  v_promo   public.promotions%rowtype;
  v_diag    public.promotions%rowtype;
  v_member  uuid;
  v_result  jsonb;
  v_status  text;
  v_part    uuid;
  v_body    text;
  v_outcome text;
begin
  -- Two ticks must not take the same event. The loser skips rather than
  -- blocking: a blocked worker holds its transaction open for no gain, and the
  -- event will still be there next tick.
  --
  -- The status predicate is also what makes reprocessing safe. A DONE event is
  -- not picked up at all, which is the real reason a confirmation cannot be
  -- sent twice -- the unique dedupe_key below is a structural backstop, but it
  -- is keyed on the participation and a genuinely re-run event would produce a
  -- new one, so it is this line that holds the promise.
  select * into v_event
  from public.webhook_events
  where id = p_event_id and status in ('RECEIVED', 'FAILED')
  for update skip locked;

  if not found then
    return jsonb_build_object('outcome', 'skipped', 'status', null,
                              'participation_id', null);
  end if;

  -- claimed_at goes with the status, because webhook_events_claim_shape (0058)
  -- makes PROCESSING a claim about it -- the same pattern the DONE branch of
  -- webhook_events_done_shape takes with outcome and processed_at. It is the
  -- one timestamp the reclaim (0063) can honestly measure a claim's age
  -- against, and it is now() for the same reason processed_at is: it records
  -- when WE acted, not anything about the message.
  update public.webhook_events
     set status = 'PROCESSING', claimed_at = now()
   where id = v_event.id;

  -- The payload is the FLATTENED message the route writes, not Meta's envelope:
  -- one webhook_events row is one message (0058), and `from`, `text`,
  -- `profile_name` and `timestamp` are read straight off it. A payload whose
  -- `text` is present must carry `from` -- they are produced by the same
  -- flattening step, and a route that supplies one without the other is
  -- reporting its own defect rather than describing a real message.
  v_from    := v_event.payload ->> 'from';
  v_profile := nullif(btrim(coalesce(v_event.payload ->> 'profile_name', '')), '');
  v_text    := coalesce(v_event.payload ->> 'text', '');
  v_local   := public.whatsapp_local_phone(v_from);
  -- WhatsApp sends the message timestamp as epoch seconds, as a string. An
  -- UNPARSEABLE one raises here, out of the cast, as 22P02; an ABSENT one
  -- silently becomes NULL, and is caught below where it is first needed.
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

  -- The first hashtag in the message. A real one is "quero participar
  -- #EUQUERO !!", not a bare tag, and 0040 already constrains a stored hashtag
  -- to '^#[^[:space:]#]{1,39}$' -- the same shape, matched here against free
  -- text.
  v_tag := lower((regexp_match(v_text, '#[^[:space:]#]{1,39}'))[1]);

  if v_tag is null then
    return public.finish_whatsapp_event(v_event.id, 'no_hashtag', null, null);
  end if;

  -- A message that names a promotion and carries no timestamp cannot be decided
  -- at all: every rule from here down is measured against it, and a NULL does
  -- not fail those comparisons, it makes them UNKNOWN. Nothing matches, the
  -- diagnostic below then reports 'outside_window', and a malformed payload is
  -- filed in the DONE pile wearing a plausible reason -- the one place nobody
  -- will look for it.
  --
  -- Raised instead, so it lands in FAILED with something an operator can find.
  -- That is the same answer a missing `from` already gets, and the two must not
  -- be told apart by which one happens to survive as far as a silent outcome.
  --
  -- Placed HERE rather than beside the payload read, and for the same reason
  -- `from` is not checked there either: a delivery receipt carries neither a
  -- timestamp nor any text, and it must go on leaving quietly through
  -- no_hashtag above rather than filling the retry queue. The contract is
  -- "whenever `text` is present, `from` and `timestamp` are too"; the check
  -- sits at the point of use, which is the first line below that reads v_when.
  if v_when is null then
    raise log 'ingest_whatsapp_event: no timestamp on event % (wamid sha256 %)',
      v_event.id, v_event.external_id;
    raise exception 'whatsapp payload carries no message timestamp'
      using errcode = '22023';
  end if;

  -- "#EUQUERO!!" is not a mistype. It is how somebody writes when they are
  -- excited, which is the state this entire feature exists to produce -- and
  -- the token above swallows the punctuation, because '!' is neither
  -- whitespace nor '#'. Under design spec D4 that listener gets SILENCE and
  -- never learns why, on the block's headline path.
  --
  -- So there is a second candidate: the same token with TRAILING characters
  -- that are not a letter, a digit or an underscore removed. Nothing LEADING
  -- is stripped -- the '#' is the token, not decoration -- and nothing
  -- INTERIOR is, so '#a_b-c...' becomes '#a_b-c' and not '#a'.
  --
  -- [[:alnum:]] is expected to be UNICODE-AWARE, which is a property of the
  -- cluster and not of this file: it must keep an accented letter at the END of
  -- a tag, so '#CAFÉ!' trims to '#CAFÉ' and not to '#CAF'. Under a C ctype it
  -- would not, and the bot would quietly stop matching every hashtag ending in
  -- an accent. Pinned by an assertion in 06_whatsapp rather than assumed.
  --
  -- THE EXACT TOKEN STILL WINS, and the `order by` on both lookups below is
  -- what holds that -- it is load-bearing rather than cosmetic, and must not be
  -- dropped as redundant. promotions_hashtag_shape (0040) is UNTOUCHED and goes
  -- on permitting punctuation inside a stored hashtag, so '#VAI!' and '#VAI'
  -- can both be live promotions in one Station. A message saying '#VAI!' means
  -- the first of those; trimming it into the second would enter somebody in a
  -- draw they did not ask for. The trimmed form is a fallback and never a
  -- preference.
  --
  -- WHAT THAT ORDERING DOES *NOT* DO, stated because the paragraph above
  -- reasons only about the case it handles. "Exact wins" is a preference among
  -- candidates that are BOTH OPEN. It is not a rule that the exact tag's mere
  -- existence suppresses the fallback. So if '#VAI!' has ENDED and '#VAI' is
  -- open at the same Station, a listener writing '#VAI!' matches nothing
  -- exactly, falls through, and is entered into '#VAI' -- a draw they did not
  -- name, and told so by name in the reply they receive. Deliberate as of this
  -- writing and pinned by a fixture in 06_whatsapp, not incidental. The
  -- narrower rule -- suppress the fallback whenever the exact tag is known to
  -- this Station in ANY state -- was considered and is with the owner; its own
  -- cost is the mirror case, where a Station that ran '#VAI!' last year would
  -- answer this year's '#VAI' message with silence.
  v_trim := '#' || regexp_replace(substr(v_tag, 2), '[^[:alnum:]_]+$', '');
  if v_trim = v_tag or v_trim = '#' then
    v_trim := null;
  end if;
  v_tags := case when v_trim is null then array[v_tag] else array[v_tag, v_trim] end;

  -- EVERYTHING from here judges the message by ITS OWN timestamp, never by
  -- now(). An event reprocessed an hour later has to be decided as of when the
  -- person actually wrote -- which is what 4c's symmetric interval window was
  -- fixed to support, and what keeps apply_participation below from refusing a
  -- promotion this step just matched. Match on now() and the two clocks
  -- disagree: a promotion open at ingest time takes a month-old message, and
  -- apply_participation then raises 22023 against the very window that
  -- admitted it.
  --
  -- promotions_hashtag_no_overlap (0040) guarantees at most one row per EXACT
  -- hashtag here at any instant, including a past one; the limit and the order
  -- are what pick between the exact token and its trimmed fallback.
  -- whatsapp_enabled needs no predicate: promotions_whatsapp_shape makes a
  -- non-null hashtag imply it. company_id is the tenancy boundary -- a hashtag
  -- belongs to a Station, so the same tag at a sister Station is not this
  -- message's promotion.
  select * into v_promo
  from public.promotions
  where company_id = v_integ.company_id
    and lower(hashtag) = any(v_tags)
    and deleted_at is null
    and cancelled_at is null
    and v_when >= starts_at and v_when < ends_at
  order by (lower(hashtag) = v_tag) desc
  limit 1;

  if not found then
    -- One diagnostic lookup, ignoring window and cancellation, so an operator
    -- asked "why didn't it work?" gets three answers instead of one. All three
    -- are silent to the listener (design spec D4); the distinction is for the
    -- person who has to explain it. It considers both candidates for the same
    -- reason the match above does: a listener who wrote "#EUQUERO!!" against a
    -- closed promotion is outside_window, not no_promotion, and the operator
    -- explaining it deserves the true answer.
    select * into v_diag
    from public.promotions
    where company_id = v_integ.company_id
      and lower(hashtag) = any(v_tags)
      and deleted_at is null
    order by (lower(hashtag) = v_tag) desc, starts_at desc
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

  -- No visibility filter and none wanted: apply_member_lookup answers "does
  -- this Organization already know this person?", and it is Organization-scoped
  -- on purpose, so it will return a listener registered at a sister Station
  -- (0061). That is correct for dedup and is why the link below is idempotent.
  v_member := public.apply_member_lookup(
    v_integ.organization_id, v_local, null, null, null);

  if v_member is null then
    -- first_contact_at / first_contact_origin are write-once and are, in
    -- update_member's own words, "the evidence behind the owner's decision
    -- (spec 7) that a listener who messages a Station first has authorised the
    -- reply". The bot fills in the record Block 3 designed for it rather than
    -- inventing a second one, and first_contact_at is the MESSAGE's timestamp
    -- for the same reason everything else here is.
    --
    -- apply_member_creation performs no name validation and would accept a
    -- blank as a NULL full_name without complaint (0061). A listener the bot
    -- registered is a real person with a real record, and a nameless row is
    -- what an operator later has to explain, so the WhatsApp profile name is
    -- used when the sender published one and a neutral placeholder when they
    -- did not -- WhatsApp profile names are optional and frequently withheld.
    --
    -- CAUGHT, NOT LEFT TO RAISE. Two overlapping ticks meeting the same
    -- unknown number at once is not a contrived case -- 0063 calls exactly
    -- this "the NORMAL case under load" for the outbound side, and the same
    -- is true here. apply_member_creation has no ON CONFLICT of its own
    -- (0061): unlike apply_member_link, it is a plain INSERT wrapped in a
    -- handler that turns a genuine unique_violation into a raised 23505 --
    -- the right answer for create_member, an operator's door taking one row
    -- at a time, and the wrong one for two bot messages that met a stranger
    -- at the same instant. The loser here re-reads rather than re-raising:
    -- by the time this exception fires the winner has already COMMITTED (a
    -- second inserter blocks on the conflicting value until the first
    -- transaction resolves, and only raises once it has), so the same lookup
    -- that returned null a moment ago now finds the row. Only phone was
    -- supplied to apply_member_creation above, so the collision can only be
    -- phone_normalized, and the re-lookup is guaranteed to find it.
    --
    -- DEPENDS ON READ COMMITTED, stated rather than assumed, because the fix
    -- rests on it. The re-lookup sees the winner's row only because each
    -- statement inside PL/pgSQL takes a fresh snapshot under this
    -- repository's isolation level, which nothing here sets and which is
    -- Postgres' own default -- so this holds today. Under REPEATABLE READ the
    -- re-lookup would still run on the snapshot from BEFORE the winner
    -- committed and would return null; v_member would stay null;
    -- apply_participation would raise P0002 on it (0054, "listener not found
    -- in this station"); and the whole transaction, catch included, would
    -- abort and the event would retry. That is a DEGRADATION to the pre-fix
    -- behaviour, never a wrong write: participations.member_id is NOT NULL
    -- (0052), so there is no path from a null v_member to a stored row that
    -- names nobody. A future contributor who raises the isolation level
    -- inherits this degradation and should know it, which is why it is
    -- written here rather than left to be rediscovered.
    --
    -- Also depends on members_phone_unique (0031) and apply_member_candidates
    -- (0061, which apply_member_lookup is built on) agreeing EXACTLY on
    -- `deleted_at is null` -- both filter on it identically today. Were the
    -- index ever to count a soft-deleted row while the lookup went on
    -- skipping it, a real collision against a deleted member would raise
    -- here and the re-lookup would return null for that collision too.
    --
    -- LINKED, NOT ONLY LOOKED UP. The re-lookup can land in the SAME state
    -- the else branch below exists for: known to the Organization, not yet
    -- to THIS Station (design spec D8) -- reachable when two Stations of one
    -- Organization, each with its own integration, race on the same phone at
    -- once. The winner's apply_member_creation linked only its OWN Station;
    -- without this call the loser would hold a member id with no link here,
    -- and apply_participation below would raise P0002 for it -- a spurious
    -- FAILED event whose message does not describe what actually happened,
    -- self-healing only on the next retry once the lookup (now non-null)
    -- takes the else branch instead. Idempotent at the table (ON CONFLICT DO
    -- NOTHING, 0061), so calling it in the same-Station case too -- where the
    -- winner already holds this exact link -- costs nothing.
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
    -- Design spec D8: known to the Organization but not to this Station. Link
    -- and let them enter. Duplicating would defeat the dedup; refusing would
    -- turn a real listener away from a promotion they are eligible for. The
    -- core is idempotent and its boolean is deliberately ignored -- a listener
    -- already linked here is the ordinary case, not a refusal (0061).
    perform public.apply_member_link(
      v_member, v_integ.company_id, v_integ.organization_id, null);
  end if;

  v_result := public.apply_participation(
    v_promo.id, v_member, v_when, 'WHATSAPP', '[]'::jsonb);

  v_status := v_result ->> 'status';
  v_part   := (v_result ->> 'participation_id')::uuid;

  -- The reply, in the same transaction as the entry it announces (design spec
  -- D7), which is why there is no state where a listener is entered and never
  -- told. Addressed to v_from and NOT to v_local: the local form is how this
  -- database stores a phone, not a number WhatsApp can deliver to.
  --
  -- Guarded on a non-null body rather than inserted unconditionally.
  -- whatsapp_reply_body returns null for anything outside the four statuses,
  -- and outbox_messages.body is NOT NULL with a non-blank CHECK (0059) -- so an
  -- unguarded insert would turn "say nothing" into 23502 and fail the whole
  -- message over a reply it was never supposed to send.
  --
  -- KEYED ON THE MESSAGE, not on the participation, and this is the line that
  -- makes 0059's promise true. An operator who resets a finished event by hand
  -- gets a SECOND participation -- the row is a fact about the attempt and
  -- apply_participation records it -- but must not get a second reply. Keyed on
  -- the participation the value would differ every time and the ON CONFLICT
  -- below would never fire once; keyed on the message it fires exactly when the
  -- same message is decided twice, which is the only case it exists for.
  v_body := public.whatsapp_reply_body(v_promo.id, v_member, v_status);

  if v_body is not null then
    insert into public.outbox_messages
      (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key)
    values
      ('WHATSAPP', v_integ.id, v_integ.organization_id, v_integ.company_id,
       v_from, v_body, v_event.external_id || ':confirmation')
    -- sent_at and external_id are left unset: outbox_messages_sent_shape (0059)
    -- requires both null on any status but SENT, and this row is PENDING.
    on conflict (provider, dedupe_key) do nothing;
  end if;

  return public.finish_whatsapp_event(v_event.id, 'recorded', v_status, v_part);
end;
$$;

revoke execute on function public.ingest_whatsapp_event(uuid) from public;
grant execute on function public.ingest_whatsapp_event(uuid) to service_role;

comment on function public.ingest_whatsapp_event(uuid) is
  'One inbound message, decided end to end in one transaction: the Station from the number, the promotion from the hashtag, the listener from the phone, the entry through apply_participation, and the reply into the outbox. The third entrance to apply_participation and the only one not gated on has_permission -- the worker is service_role and there is no user to check, so the integrations row stands in for the gate: a message is ingested only if it arrived at a number this installation serves AND has switched on. Everything after that lookup is judged by the MESSAGE timestamp and never by now(), so a reprocessed event is decided as of when the person wrote; matching the promotion on now() instead makes the two clocks disagree and apply_participation then refuses, with 22023, the very window that admitted the message. The hashtag is matched on the token as written and then, only if that matches nothing, on the same token with trailing punctuation removed -- "#EUQUERO!!" is how somebody writes when they are excited, and the exact form still wins because a stored hashtag may legitimately end in punctuation -- though only among candidates that are OPEN, so a message naming an ENDED "#VAI!" is entered into an open "#VAI" rather than refused (see the body comment; the narrower rule is with the owner). A message that names a promotion and carries no usable timestamp RAISES rather than finishing, because a NULL there makes every rule below it UNKNOWN and the event would otherwise be filed as DONE with a plausible-looking reason. The reply commits with the entry (design spec D7), which is why there is no state where a listener is entered and never told; it is addressed to the number WhatsApp delivered rather than to the local form this database stores, and its dedupe_key follows webhook_events.external_id -- the SHA-256 of the wamid, never the raw id -- so a message decided twice is answered once even though the second pass writes a second participation. Takes the event FOR UPDATE SKIP LOCKED and only in status RECEIVED or FAILED: a second tick, or a re-run of a finished event, gets outcome "skipped" and writes nothing. Two concurrent messages from an UNKNOWN phone racing each other on member creation are resolved rather than one of them raising: apply_member_creation''s unique_violation is caught here and the loser re-resolves through apply_member_lookup, which the winner''s now-committed row satisfies -- two overlapping ticks meeting a stranger at once is the ordinary case under load (0063), not an exotic one, and apply_member_creation''s own refusal is correct for create_member''s single-row operator door and wrong for this one; the loser also links itself to its own Station in that same branch, since the winner''s apply_member_creation only linked its. Any OTHER raise leaves the whole transaction rolled back, including the move to PROCESSING, so the event returns to its previous status and is picked up again -- the worker is what decides whether to park it as FAILED. Writes its own audit row with no phone, name or other personal data in it (design spec D2); apply_participation writes its own about the participation, and the two join on participation_id.';

-- THE PAYLOAD CONTRACT, stated on the column that holds it, because the task
-- that BUILDS a payload (Task 11's webhook route) is the one that has to keep
-- it and this is where its author will look.
comment on column public.webhook_events.payload is
  'The inbound message, FLATTENED by the route -- not Meta''s envelope. ingest_whatsapp_event (0062) reads exactly five paths and no others: metadata->>phone_number_id, from, text, profile_name, and timestamp as EPOCH SECONDS IN A STRING. The route must ALSO write the RAW provider message id here, as `wamid`: the function never reads it, and it is stored here rather than in external_id -- which holds only its SHA-256 (0058) -- because a wamid decodes to bytes containing the counterparty phone, and this is the column that expires. It is the only place the raw id exists, and after thirty days it exists nowhere. One row is one message: Meta packs several into a single POST and idempotency is per message, so the route unpacks entry[].changes[].value.messages[] into one row each, hashing each id in NODE for the reason members.cpf_hash gives (0031). WHENEVER `text` IS PRESENT, `from` AND `timestamp` MUST BE TOO -- all three come out of the same flattening step, and a payload carrying one without the others is the route describing its own defect rather than a real message. Both absences RAISE, which parks the event as FAILED with a reason an operator can find, and that is deliberate: without a timestamp every rule after the integration lookup goes UNKNOWN rather than false, nothing matches, and the message would otherwise finish DONE reporting outside_window -- a plausible-looking reason for a malformed payload, filed in the one pile nobody searches. An unparseable timestamp raises out of the cast as 22P02; an absent one as 22023. A non-message event (a delivery receipt) is safe to store: it has no text, so it finishes as no_hashtag before either check is reached. Holds a phone number, a WhatsApp profile name and the raw provider message id, which is why this table has RLS on with no policy and why prune_webhook_payloads (design spec D9) nulls this column after thirty days while keeping the row -- and why external_id, which survives that, may hold only a hash.';

-- The outcome vocabulary, restated now that all six values have a call site.
-- 0058 named them before this function existed; nothing here adds to the list.
comment on column public.webhook_events.outcome is
  'Why this event finished. With status DONE it distinguishes recorded from no_integration, no_hashtag, no_promotion, promotion_cancelled and outside_window -- all six written by ingest_whatsapp_event (0062), all but the first silent to the listener (design spec D4), and all of which somebody will eventually have to explain. "skipped" is NOT one of them: an event the door declined to take is left exactly as it was and never reaches DONE.';
