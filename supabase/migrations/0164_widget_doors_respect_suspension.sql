-- supabase/migrations/0164_widget_doors_respect_suspension.sql

-- Block 17a, whole-branch fix wave. The widget's three public doors resolved
-- an installation from widget_installations ALONE -- `enabled and deleted_at
-- is null` -- and joined neither companies nor organizations. That made the
-- widget the only external door in this product that a suspended Station and a
-- blocked Organization could both keep walking through.
--
-- WHAT IT COST, CONCRETELY. suspend_company sets companies.status = 'suspended'
-- and Block 16's blocking sets organizations.suspended_at; NEITHER touches
-- widget_installations.enabled, and nothing else does either. So a Station
-- suspended for non-payment kept being framed on its own website, kept calling
-- widget_request_code -- whose own comment says "THIS IS THE ENDPOINT THAT
-- SPENDS MONEY", because every call past the limits makes Meta bill that same
-- Station -- and kept writing members, links and consents into an Organization
-- somebody had deliberately blocked. Revoking the widget meant remembering to
-- go and disable the installation by hand, on a screen (the console's Widget
-- tab) that says nothing about billing.
--
-- 0161's OWN HEADER NAMES BLOCK 15's API DOOR AS ITS PRECEDENT, and this is the
-- half of that precedent it did not copy. 0149_api_credential_rpcs.sql:56-62
-- joins companies with `deleted_at is null and status = 'active'` under a
-- comment worth repeating here: "A lapsed subscription stops the machine door
-- too. Without this a Station suspended for non-payment would go on accepting
-- writes for as long as nobody remembered to revoke its keys." 0152 repeats it
-- at both intake doors. The widget is the same class of door with the same
-- consequence, plus a bill.
--
-- ORGANIZATIONS TOO, WHICH BLOCK 15 DOES NOT CHECK -- deliberately, not by
-- oversight. organizations.suspended_at did not exist when 0149 was written
-- (0156 added it), and Block 16 put the condition inside is_owner_for and
-- has_company_access_for instead, which is how twenty-odd policies needed no
-- edit. These three doors call neither: their subject is a public key, not an
-- auth.uid(), so nothing about the human access path applies and the condition
-- has to be stated here in full -- the same reasoning 0156's own header gives
-- for restating it in has_company_access_for.
--
-- THE REFUSAL IS THE EXISTING ONE, NOT A NEW REASON, and that is a decision
-- rather than laziness. A suspended Station answers exactly as an unknown key
-- does: `{"found": false}` from widget_frame_context, `unknown_installation`
-- from the other two. 0152's comment states the same rule for the API door --
-- "an unknown credential, a revoked one, an expired one, a suspended Station
-- and a missing scope are all the same refusal from outside". Here it is
-- stronger than a convention: the caller is an ANONYMOUS VISITOR on a third
-- party's website, and a distinct reason would publish one radio station's
-- billing status to anybody who loads its home page. The operator learns it
-- from the console, where the fact belongs.
--
-- CHECKED AT THE DOOR RATHER THAN BY A TRIGGER THAT DISABLES THE INSTALLATION.
-- The rejected alternative was to have suspend_company and block_organization
-- flip widget_installations.enabled to false. It fails on release: unblocking
-- would then have to remember which installations it had switched off and which
-- the operator had, and it cannot -- the column holds no such distinction. A
-- join reads the live answer every time and needs nothing to be undone.
--
-- Everything else about all three functions is reproduced from 0161 unchanged.
-- 0161 is the newest definition of each: `grep -rn 'widget_frame_context\|
-- widget_request_code\|widget_verify_code' supabase/migrations/` names 0161
-- alone for the bodies (0162 and 0163 define only the two console doors), and
-- 0163 is the highest-numbered migration before this file.

-- ---------------------------------------------------------------------------
-- One column comment, unrelated to the joins below and appended here because
-- migrations are append-only and this fact belongs in the database rather than
-- only in a source file. 0161's inline comment on widget_verifications.phone
-- claimed the doors normalise through normalize_phone. They do not, and never
-- did -- the insert and the lookup both use p_phone raw. Nothing about the
-- schema changes; what changes is that `\d+ widget_verifications` now says
-- something true, which is where a 17b or 17c author reading this table for the
-- first time will look.
-- ---------------------------------------------------------------------------
comment on column public.widget_verifications.phone is
  'The telephone number EXACTLY AS THE VISITOR TYPED IT, and matched exactly: widget_request_code inserts it raw and widget_verify_code looks the row up with `phone = p_phone`. Not normalised -- normalize_phone (0031) runs further down widget_verify_code, inside apply_member_lookup, but that is member RESOLUTION asked after the code is already proved and it never touches this column. CONSEQUENCE, and it is the one a later block has to know: two formattings of one number are TWO verification rows, with separate codes and separate attempt ceilings, and a code minted under one cannot be verified under the other. Invisible from the widget, whose two steps carry one string through; a live trap for anything that reaches this table with a number obtained anywhere else. members.phone_normalized is the identity; this column is one leg of a lookup key.';

-- ---------------------------------------------------------------------------
-- Door 1: what the Edge middleware asks before it renders the page.
--
-- Granted to anon (0161). The grants are not repeated -- create or replace
-- keeps the existing ACL -- but the comment is, because a replaced function
-- keeps its old comment otherwise and that comment now describes three refusal
-- causes where there are five.
-- ---------------------------------------------------------------------------
create or replace function public.widget_frame_context(p_public_key text)
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
       join public.companies c
         on c.id = w.company_id
        and c.deleted_at is null
        and c.status = 'active'
       join public.organizations o
         on o.id = w.organization_id
        and o.suspended_at is null
      where w.public_key = p_public_key
        and w.enabled
        and w.deleted_at is null),
    jsonb_build_object('found', false, 'origins', '[]'::jsonb));
$$;

comment on function public.widget_frame_context(text) is
  'The origins one installation may be framed by, for the Edge middleware to build frame-ancestors from. Answers {"found": false, "origins": []} for an unknown key, a disabled installation, an archived one, a SUSPENDED Station and a BLOCKED Organization alike -- one answer for five causes, so probing learns nothing (a distinct reason here would publish a customer''s billing status to anybody loading their home page), and so the caller has exactly one refusal branch to get right. The last two joins are 0164: without them a Station suspended for non-payment went on being framed until somebody remembered to disable the installation by hand. GRANTED TO anon deliberately (spec Sec.4.3): the middleware holds the anon key and runs before any session exists.';

-- ---------------------------------------------------------------------------
-- Door 2: mint a verification. THE ENDPOINT THAT SPENDS MONEY, which is why
-- the suspension join matters more here than anywhere else in this file: every
-- call that gets past it bills the very Station whose subscription lapsed.
--
-- 0161's header comment on this function stands unchanged and is not repeated:
-- the code itself never arrives, only its SHA-256; p_code_plain is the one
-- deliberate bounded exception, and must not be "fixed" into a hash.
-- ---------------------------------------------------------------------------
create or replace function public.widget_request_code(
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
  -- 0164: the two joins. `w.*` rather than `*` now that the from-list has
  -- three relations in it -- `select *` would try to build a
  -- widget_installations record out of every column of all three and fail.
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
    -- value that actually reaches the phone. See 0161's header comment on this
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
    -- the six digits live in the database, exactly as 0161's header comment
    -- requires.
    update public.outbox_messages
       set body = replace(v_template.body, '{{1}}', '******')
     where id = v_outbox_id;
  end if;

  return jsonb_build_object('ok', true, 'reason', null, 'verification_id', v_id);
end;
$$;

comment on function public.widget_request_code(text, text, text, text, integer) is
  'Mints a verification row and enqueues the WhatsApp code that proves the phone typed into a Station''s widget is reachable. Refuses by NAME -- unknown_installation, no_integration, no_template -- rather than one generic failure, because the console tab (spec Sec.5) reads the reason to tell an operator why an enabled widget is silent. 0164: a SUSPENDED Station (companies.status) and a BLOCKED Organization (organizations.suspended_at) both answer unknown_installation, the same refusal an unknown key gets -- this is THE ENDPOINT THAT SPENDS MONEY, so a lapsed subscription that could still reach it would go on billing the customer who stopped paying, and a distinct reason would publish that fact to an anonymous visitor. no_integration covers an absent integration AND a switched-off one, on purpose -- see the comment on the lookup above for why a fifth reason is not worth adding. Does not rate-limit: spec Sec.6.3''s limits are keyed by IP as well as by phone, and the database has no idea what an IP is, so that lives in the server action''s PostgresRateLimiter instead. p_code_plain is the one deliberate, bounded exception to this codebase''s rule that a raw secret never travels as an RPC argument -- see 0161''s header comment above this function for the full reasoning, and do not "fix" it into a hash. `body` on the outbox row this leaves is overwritten to the MASKED text immediately after enqueue_whatsapp_outbound writes it live: 0111''s D6 renders body from the same template_variables that carry the real code, which is correct for an ordinary template send and wrong for a code that must not outlive its own ten-minute expiry in a column 0059 never prunes.';

-- ---------------------------------------------------------------------------
-- Door 3: prove the code, and become a listener.
--
-- 0161's header comment on this function stands unchanged and is not repeated:
-- the ceiling is checked BEFORE the hash, the row is taken FOR UPDATE, and
-- p_actor/recorded_by are null throughout. Only the installation lookup in
-- step 1 changes.
--
-- THE JOIN MATTERS MOST AT THIS DOOR for a reason that has nothing to do with
-- money: steps 8, 9 and 10 write a member, a company link and a consent. Those
-- are rows in a tenant somebody blocked, created after they blocked it, and
-- nothing on any screen would explain where they came from.
-- ---------------------------------------------------------------------------
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
     and phone = p_phone
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
  -- 10. p_actor is null -- see 0161's header comment on this function.
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

comment on function public.widget_verify_code(text, text, text, text) is
  'The eleventh and last step of a visitor becoming a listener: proves the six-digit code, then resolves who they are through the same 0061 cores the WhatsApp bot and the Block 15 API door use. Refuses by name -- unknown_installation, no_pending_code, expired, too_many_attempts, wrong_code, listener_anonymized, name_required -- so the widget can tell a visitor which of those happened. 0164: a SUSPENDED Station and a BLOCKED Organization both answer unknown_installation, indistinguishable from an unknown key. It matters more at this door than the billing argument that carries widget_request_code -- steps 8, 9 and 10 WRITE a member, a company link and a consent, so without the joins a blocked Organization went on gaining listeners after somebody blocked it, with nothing on any screen to explain where they came from. THE CEILING (attempts >= 5) IS CHECKED BEFORE THE HASH: a six-digit code is 10^6 possibilities, and the ceiling plus the ten-minute expiry are the entire defence (design doc Sec.6.1), so comparing the hash first would let a burned row be unlocked by finally guessing right. The row is read FOR UPDATE, which is what makes that ceiling apply to five attempts total rather than five PER CONCURRENT CONNECTION. A wrong guess increments attempts and leaves the row pending; the right one stamps consumed_at immediately, before the listener is even looked up, so the code cannot be replayed regardless of what happens next -- including an anonymised listener, refused with nothing written past that point. p_actor and recorded_by are null throughout: audit_logs.actor_id has been nullable since 0004 for exactly this class of caller, and 0129 states in writing that a null there does not mean "the system did it" -- a website visitor is not an auth.users row and must never become one just to give an insert someone to name. Granted to service_role only.';
