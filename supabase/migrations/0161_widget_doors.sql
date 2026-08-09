-- supabase/migrations/0161_widget_doors.sql

-- Block 17a, spec §6. The verification code, and the four doors the widget
-- reaches the database through.
--
-- THE WIDGET SESSION IS THE SUBJECT, not a borrowed auth.uid(). This is the
-- same principle Block 15's D1 argued for the API key, and it is here for the
-- same reason: a visitor on a radio station's website is not a member of
-- anything, has no role, and must never appear on the Team screen.

create table public.widget_verifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  installation_id uuid not null references public.widget_installations (id) on delete cascade,
  -- Stored as given and normalised by the doors through normalize_phone (0031),
  -- so this can never disagree with members.phone_normalized, which is
  -- GENERATED from the same function.
  phone           text not null,
  code_hash       text not null,
  attempts        integer not null default 0,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  created_at      timestamptz not null default now(),

  constraint widget_verifications_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  -- The shape check that refuses a RAW code written where a digest belongs.
  -- A backstop, not a licence to relax the Node side: the code is hashed before
  -- it is passed, because an RPC argument lands in query logs and in backups --
  -- the rule the WhatsApp webhook already follows for the wamid.
  constraint widget_verifications_hash_shape
    check (code_hash ~ '^[0-9a-f]{64}$'),

  constraint widget_verifications_attempts_floor
    check (attempts >= 0)
);

create index widget_verifications_lookup_idx
  on public.widget_verifications (installation_id, phone, created_at desc);

comment on table public.widget_verifications is
  'One six-digit code sent to one telephone number for one installation. RLS on, no policy, reachable only from the SECURITY DEFINER doors below. Rows are not deleted on use -- consumed_at is stamped instead, so "was this number verified, and when" survives the session that used it. HOLDS A PHONE NUMBER, so sweep_retention (0131) is extended to delete it at 30 days: design D5 rejected a session table precisely because it would carry a retention obligation, and this table carrying one unswept would be that same hole with a different name.';

alter table public.widget_verifications enable row level security;
revoke all on public.widget_verifications from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Door 1: what the Edge middleware asks before it renders the page.
--
-- GRANTED TO anon, which is the first SECURITY DEFINER body in this schema that
-- is. It is written to the standard that implies: it takes a public key and it
-- returns an origin list and a boolean. No Station name, no id, no count, no
-- error that distinguishes the three ways of not existing. What somebody can
-- learn by guessing keys is which keys exist -- which is exactly what a key in
-- an iframe src already tells them.
-- ---------------------------------------------------------------------------
create function public.widget_frame_context(p_public_key text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select jsonb_build_object(
              'found', true,
              'origins', to_jsonb(w.allowed_origins))
       from public.widget_installations w
      where w.public_key = p_public_key
        and w.enabled
        and w.deleted_at is null),
    jsonb_build_object('found', false, 'origins', '[]'::jsonb));
$$;

revoke execute on function public.widget_frame_context(text) from public;
grant execute on function public.widget_frame_context(text) to anon, service_role;

comment on function public.widget_frame_context(text) is
  'The origins one installation may be framed by, for the Edge middleware to build frame-ancestors from. Answers {"found": false, "origins": []} for an unknown key, a disabled installation and an archived one alike -- one answer for three causes, so probing learns nothing, and so the caller has exactly one refusal branch to get right. GRANTED TO anon deliberately (spec §4.3): the middleware holds the anon key and runs before any session exists.';

-- ---------------------------------------------------------------------------
-- Door 2: mint a verification. The CODE ITSELF NEVER ARRIVES HERE -- only its
-- SHA-256, hashed in Node. An RPC argument lands in query logs and in backups,
-- which is the rule the WhatsApp webhook already follows for the wamid, and it
-- matters more for six digits than for a 256-bit token: a code in a log is a
-- code somebody can still use for the next ten minutes.
--
-- p_code_plain IS THE ONE DELIBERATE EXCEPTION to that same rule, bounded
-- rather than a crack in it, and this comment exists so nobody "fixes" it back
-- into a hash. The rule protects the STORED credential -- widget_verifications
-- holds only the SHA-256 (widget_verifications_hash_shape, above), so a
-- database dump yields no usable code -- and that property is kept whole here
-- too. The plaintext exists in exactly one place, outbox_messages.template_variables,
-- reachable only by service_role and by nobody through PostgREST, pruned by
-- sweep_retention's 180-day outbox_messages sweep same as the rest of that
-- row, and worthless ten minutes after issue or after one use, whichever comes
-- first. That is a different risk class from an API key with no expiry, which
-- is why credentials.ts's comment (src/lib/api/credentials.ts:26-30) and this
-- one reach different answers for what looks like the same rule. It has to
-- travel as an argument because the message is sent by the worker draining
-- outbox_messages, itself inside the database -- the six digits have to
-- arrive there somehow, and an RPC argument is how every other row in that
-- table gets built too.
--
-- THE REFUSALS ARE NAMED, and that is what the console tab reads to warn an
-- operator (spec §5). "It did not work" would leave a Station enabled and
-- silent, with the failure surfacing to a listener staring at an empty box.
-- ---------------------------------------------------------------------------
create function public.widget_request_code(
  p_public_key   text,
  p_phone        text,
  p_code_hash    text,
  p_code_plain   text,
  p_ttl_seconds  integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_install     public.widget_installations;
  v_integration uuid;
  v_template    public.message_templates;
  v_id          uuid;
  v_outbox_id   uuid;
begin
  select * into v_install
    from public.widget_installations
   where public_key = p_public_key and enabled and deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_installation',
                              'verification_id', null);
  end if;

  -- `and enabled`: an operator who switches WhatsApp off temporarily leaves a
  -- row this lookup would otherwise FIND, which would then reach
  -- enqueue_whatsapp_outbound and hit its own check (0111) -- an unhandled
  -- P0002 exception surfacing to the caller instead of one of this
  -- function's named answers, which is exactly the failure naming the
  -- reasons exists to prevent (see the header comment above).
  --
  -- STILL 'no_integration', not a fifth reason: absent and switched-off are
  -- one answer here on purpose. Both put the operator on the same screen with
  -- the same next step -- go configure or re-enable WhatsApp for this Station
  -- -- and a distinction that changes nothing about what anybody does next
  -- would still need a fifth string translated into three locales to say so.
  select id into v_integration
    from public.integrations
   where company_id = v_install.company_id
     and provider = 'WHATSAPP'
     and enabled
     and deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_integration',
                              'verification_id', null);
  end if;

  select * into v_template
    from public.message_templates
   where company_id = v_install.company_id
     and purpose = 'WEB_VERIFICATION'
     and deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_template',
                              'verification_id', null);
  end if;

  insert into public.widget_verifications
    (organization_id, company_id, installation_id, phone, code_hash, expires_at)
  values
    (v_install.organization_id, v_install.company_id, v_install.id,
     p_phone, p_code_hash,
     now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;

  -- The dedupe key is the VERIFICATION, not the phone: two codes legitimately
  -- requested a minute apart are two messages, and collapsing them on the
  -- number would silently drop the second -- leaving a visitor typing a code
  -- that was superseded.
  --
  -- p_body is null, ON PURPOSE, not a placeholder for the masked text. When
  -- p_template_purpose is given, 0111's enqueue_whatsapp_outbound ignores its
  -- p_body argument entirely and renders `body` itself from p_template_variables
  -- (D6: "rendering happens HERE and only here", so the audit copy can never
  -- disagree with what was actually sent) -- so any value passed here would be
  -- silently discarded, and passing null says so instead of hiding it behind a
  -- value that looks used.
  v_outbox_id := public.enqueue_whatsapp_outbound(
    v_integration,
    p_phone,
    null,
    null,
    v_id::text || ':widget-verification',
    'WEB_VERIFICATION',
    -- THE ONLY PLACE THE SIX DIGITS EXIST outside the visitor's handset.
    -- sendTemplate (src/services/whatsapp.ts) builds Meta's template
    -- parameters from THIS column, not from `body` -- so this is also the
    -- value that actually reaches the phone. See the header comment on this
    -- function for why the raw value is an argument here when it is
    -- forbidden everywhere else in this codebase.
    jsonb_build_array(p_code_plain));

  if v_outbox_id is not null then
    -- enqueue_whatsapp_outbound just wrote `body` as the template rendered
    -- WITH THE LIVE CODE, because D6 renders body and template_variables from
    -- the same source on purpose so they cannot drift for an ordinary send.
    -- A verification code is not an ordinary send: `body` is never pruned
    -- (0059's comment on the column is explicit that this is deliberate, so
    -- an operator can still answer "what were they told" after retention has
    -- taken the phone number), which means a live code left in it would
    -- outlive every mechanism meant to expire the code itself. Overwritten
    -- here, in the SAME transaction as the insert above -- Postgres has no
    -- dirty-read isolation level at all, at any setting, so no concurrent
    -- reader can see the row until this function's transaction commits, by
    -- which point `body` already holds the masked text and the unmasked
    -- value this statement replaces was never visible to anybody and never
    -- durable. jsonb_build_array(p_code_plain) alone remains as the one place
    -- the six digits live in the database, exactly as the header comment
    -- above requires.
    update public.outbox_messages
       set body = replace(v_template.body, '{{1}}', '******')
     where id = v_outbox_id;
  end if;

  return jsonb_build_object('ok', true, 'reason', null, 'verification_id', v_id);
end;
$$;

revoke execute on function public.widget_request_code(text, text, text, text, integer) from public;
grant execute on function public.widget_request_code(text, text, text, text, integer) to service_role;

comment on function public.widget_request_code(text, text, text, text, integer) is
  'Mints a verification row and enqueues the WhatsApp code that proves the phone typed into a Station''s widget is reachable. Refuses by NAME -- unknown_installation, no_integration, no_template -- rather than one generic failure, because the console tab (spec §5) reads the reason to tell an operator why an enabled widget is silent. no_integration covers an absent integration AND a switched-off one, on purpose -- see the comment on the lookup above for why a fifth reason is not worth adding. Does not rate-limit: spec §6.3''s limits are keyed by IP as well as by phone, and the database has no idea what an IP is, so that lives in the server action''s PostgresRateLimiter instead (Task 10). p_code_plain is the one deliberate, bounded exception to this codebase''s rule that a raw secret never travels as an RPC argument -- see the header comment above this function for the full reasoning, and do not "fix" it into a hash. `body` on the outbox row this leaves is overwritten to the MASKED text immediately after enqueue_whatsapp_outbound writes it live: 0111''s D6 renders body from the same template_variables that carry the real code, which is correct for an ordinary template send and wrong for a code that must not outlive its own ten-minute expiry in a column 0059 never prunes.';

-- ---------------------------------------------------------------------------
-- The retention sweep, extended for one more table.
--
-- create or replace, IN A NEW FILE, because both 0131 and 0133 are shipped and
-- migrations are append-only.
--
-- REPRODUCES 0133, NOT 0131. 0131 is the procedure's original shape, but 0133
-- (Block 11b, D5) already replaced it once, wrapping every delete with
-- job_started/job_succeeded stamps into job_health and a v_counters jsonb
-- instead of a Postgres log nobody read. That is the version live before this
-- migration runs, and the one this file must extend -- reproducing 0131's
-- `raise notice` body instead would silently drop the job_health stamp, which
-- is exactly the kind of regression tests/isolation/job-health.test.ts exists
-- to catch (it calls this procedure for real and asserts the exact set of
-- counter keys, which is why that file gains `widget_verifications` in the
-- same commit as this one).
--
-- NEITHER `security definer` NOR `set search_path`: Postgres refuses
-- transaction control (the `commit` below) inside either, so every reference
-- here is schema-qualified by hand instead.
--
-- NO EXCEPTION HANDLER: a PL/pgSQL block with one opens a subtransaction, and a
-- `commit` inside a subtransaction raises "cannot commit while a
-- subtransaction is active". 0131's header records that a version WITH
-- handlers deleted nothing at all, every night, silently. Dropping them means a
-- failing table aborts the ones after it until tomorrow rather than every
-- table waiting for ever.
--
-- The cron.schedule call is NOT repeated: the job already exists and points at
-- this procedure by name, so replacing the body is the whole change.
create or replace procedure public.sweep_retention()
language plpgsql
as $$
declare
  v_deleted  integer;
  v_total    integer := 0;
  v_counters jsonb   := '{}'::jsonb;
begin
  perform public.job_started('retention-sweep');
  commit;

  -- 1. webhook_events, 90 days. The most sensitive and the highest volume:
  -- Meta's raw payload, whole. Its only use is reprocessing a failed
  -- ingestion, which happens within hours -- so ninety days is already
  -- generous rather than tight.
  --
  -- Every terminal state, INCLUDING FAILED: a webhook that could not be
  -- processed in ninety days will not be processed, and keeping a listener's
  -- message text for ever because the code that should have read it had a bug
  -- is not a retention policy, it is an accident.
  delete from public.webhook_events
   where received_at < now() - interval '90 days'
     and status in ('DONE', 'FAILED');
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('webhook_events', v_deleted);

  -- 2. outbox_messages, 180 days. What was said to a listener, and when.
  -- Terminal states only -- a PENDING row is work not yet done, however old,
  -- and deleting it would silently drop a message somebody is waiting for.
  delete from public.outbox_messages
   where created_at < now() - interval '180 days'
     and status in ('SENT', 'FAILED');
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('outbox_messages', v_deleted);

  -- 3. whatsapp_conversations, 180 days after they expired. `expires_at` is
  -- when the conversation window closed, so this is 180 days past the end of
  -- the conversation and not past its start.
  delete from public.whatsapp_conversations
   where expires_at < now() - interval '180 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('whatsapp_conversations', v_deleted);

  -- 4. contact_requests, 365 days. A visitor's name, e-mail, phone and message
  -- from the PUBLIC form -- personal data belonging to somebody who is not a
  -- customer and never became one. A year is long enough to follow up and far
  -- longer than anybody does.
  delete from public.contact_requests
   where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('contact_requests', v_deleted);

  -- 5-7. Operational leftovers, 30 days. No personal data in any of them;
  -- swept for size rather than for law, and listed here so nobody has to
  -- wonder later whether their absence was deliberate. widget_verifications
  -- (8, below) is the exception -- it is 30 days for LAW, not size.
  delete from public.rate_limit_counters
   where reset_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('rate_limit_counters', v_deleted);

  delete from public.whatsapp_conversation_leases
   where claimed_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('whatsapp_conversation_leases', v_deleted);

  -- processed_at NOT NULL only: an unprocessed row is an erasure this
  -- installation still owes somebody, and 0087 is explicit that it has NO
  -- give-up threshold for exactly that reason. Sweeping one by age would
  -- silently discharge a legal obligation, which is the one thing that table
  -- exists to prevent.
  delete from public.storage_erasure_queue
   where processed_at is not null
     and processed_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('storage_erasure_queue', v_deleted);

  -- 8. widget_verifications, 30 days. Block 17a. A telephone number typed
  -- into a Station's website, hashed code and all -- design D5 rejected a
  -- session table for a visitor precisely because it would carry a retention
  -- obligation, and this table is that obligation, met the same way the seven
  -- above already are. Age only: a verified number's CONSENT record lives in
  -- member_consents (0032, append-only) and is untouched by this sweep, which
  -- deletes only the code and its digest.
  delete from public.widget_verifications
   where created_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('widget_verifications', v_deleted);

  -- Where the counters go. Still NO audit row per deleted record,
  -- deliberately: one per deleted webhook_events row would write more rows
  -- than the sweep removed, into the one table this procedure promises never
  -- to sweep.
  perform public.job_succeeded(
    'retention-sweep',
    v_counters || jsonb_build_object('total', v_total));
  commit;
end;
$$;

comment on procedure public.sweep_retention() is
  'Requirement N7. Deletes data whose retention period has expired: webhook_events at 90 days (Meta''s raw payload, the most sensitive thing this installation stores), outbox_messages and whatsapp_conversations at 180, contact_requests at 365, widget_verifications (Block 17a, a telephone number typed on a Station''s website) and three operational tables at 30. Commits per table so one failure does not roll back the rest, every night, for ever. DOES NOT TOUCH audit_logs -- kept for ever, because it is the proof that erasures happened -- nor any business record: those are what a radio must prove afterwards, and personal data inside them is removed by anonymize_member (0034), which is subject-driven rather than age-driven. Block 11b: reports what it deleted into job_health instead of into a Postgres log nobody reads.';

-- ---------------------------------------------------------------------------
-- Door 3: prove the code, and become a listener. THE SUBJECT IS THE PHONE
-- NUMBER, not a session, for the same reason the header comment on this file
-- gives: a visitor who proves a phone number is reachable is not a member of
-- anything and has no role, and must never appear on the Team screen.
--
-- THE CEILING IS CHECKED BEFORE THE HASH IS COMPARED (step 4 before step 5,
-- below), and that order is the whole point of this function. A six-digit
-- code is only 10^6 combinations, and the ceiling together with the
-- ten-minute expiry (checked in step 3) are the WHOLE of what makes guessing
-- expensive -- which is also why there is no constant-time comparison
-- anywhere near this (0148's credentials.ts comment gives the general
-- argument against timing leaks on a STRONG secret; a six-digit code has no
-- timing budget worth defending, only an attempt budget, and that budget is
-- the point). Comparing the hash first and counting attempts second would let
-- a burned row -- one that has already spent its five guesses -- be unlocked
-- by finally guessing right on attempt six, which defeats the ceiling
-- entirely: a search bounded at five that is still allowed to succeed on the
-- sixth try was never bounded at all.
--
-- p_actor / recorded_by ARE NULL THROUGHOUT -- into apply_member_lookup (which
-- takes none), into apply_member_creation, into apply_member_link, and into
-- the member_consents insert below. audit_logs.actor_id has been nullable
-- since 0004 for exactly this class of caller, and 0129 states in writing
-- that a null there does NOT mean "the system did it" -- it means the caller
-- was never eligible to hold an auth.users id to begin with. A visitor typing
-- a phone number into a Station's public website is not a member of anything
-- and has no session; the rejected alternative is the one 0148 already
-- rejected for the API credential and this file's header rejects for the
-- widget session itself -- binding the visitor to a throwaway auth.users row
-- just so some insert has someone to name would put them on the Team screen
-- as if they were a person.
-- ---------------------------------------------------------------------------
create function public.widget_verify_code(
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
  v_member  uuid;
  v_anon    boolean;
begin
  -- 1. Resolve the installation. Unknown, disabled and archived all answer
  -- the same refusal -- probing for a live key learns nothing here either,
  -- the same shape widget_frame_context already answers with for the same
  -- key.
  select * into v_install
    from public.widget_installations
   where public_key = p_public_key and enabled and deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_installation',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- 2. The newest UNCONSUMED verification for this installation and phone.
  -- Newest, not merely "a matching one": a visitor who asks for a second
  -- code has abandoned the first, and only the latest is still meant to be
  -- typed back. consumed_at is null is the whole filter -- an expired but
  -- never-used row is still "the pending one" here, and step 3 below is what
  -- refuses it, so the reason reported is the true one rather than a generic
  -- "no such code".
  select * into v_verif
    from public.widget_verifications
   where installation_id = v_install.id
     and phone = p_phone
     and consumed_at is null
   order by created_at desc
   limit 1;

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

  -- 4. THE CEILING, CHECKED BEFORE THE HASH -- see the header comment on this
  -- function for why the order is the entire control.
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
  -- The RAW phone, not a normalised one: members.phone_normalized is a
  -- generated column and apply_member_lookup normalises what it is handed
  -- through normalize_phone (0031) itself; 0152's comment on this exact call
  -- makes the same argument for the API door, and it applies unchanged here.
  v_member := public.apply_member_lookup(v_install.organization_id, p_phone, null, null, null);

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
  -- 10. p_actor is null -- see the header comment on this function.
  if v_member is null then
    if nullif(trim(coalesce(p_name, '')), '') is null then
      return jsonb_build_object('ok', false, 'reason', 'name_required',
                                'member_id', null, 'company_id', null,
                                'organization_id', null);
    end if;

    v_member := public.apply_member_creation(
      v_install.company_id, p_name, p_phone, null, null, null, null, null,
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
  -- the header comment on this function.
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

revoke execute on function public.widget_verify_code(text, text, text, text) from public;
grant execute on function public.widget_verify_code(text, text, text, text) to service_role;

comment on function public.widget_verify_code(text, text, text, text) is
  'The eleventh and last step of a visitor becoming a listener: proves the six-digit code, then resolves who they are through the same 0061 cores the WhatsApp bot and the Block 15 API door use. Refuses by name -- unknown_installation, no_pending_code, expired, too_many_attempts, wrong_code, listener_anonymized, name_required -- so the widget can tell a visitor which of those happened. THE CEILING (attempts >= 5) IS CHECKED BEFORE THE HASH: a six-digit code is 10^6 possibilities, and the ceiling plus the ten-minute expiry are the entire defence, so comparing the hash first would let a burned row be unlocked by finally guessing right. A wrong guess increments attempts and leaves the row pending; the right one stamps consumed_at immediately, before the listener is even looked up, so the code cannot be replayed regardless of what happens next -- including an anonymised listener, refused with nothing written past that point. p_actor and recorded_by are null throughout: audit_logs.actor_id has been nullable since 0004 for exactly this class of caller, and 0129 states in writing that a null there does not mean "the system did it" -- a website visitor is not an auth.users row and must never become one just to give an insert someone to name. Granted to service_role only.';
