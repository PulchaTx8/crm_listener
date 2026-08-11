-- supabase/migrations/0165_template_otp_button.sql

-- Meta's AUTHENTICATION templates carry an OTP button, and a send that does not
-- name that button is refused whole.
--
-- THIS IS A PRODUCTION POST-MORTEM, not a feature. From 2026-08-10, every
-- verification code the Block 17a widget tried to send came back from the Cloud
-- API as `(#131008) Required parameter is missing`, the rows parked FAILED
-- after one attempt (a 400 is permanent, correctly), and no visitor to a
-- Station's website ever received a code. The registered template was
-- `pulchtx_widgetcode`, category Authentication, body `*{{1}}* is your
-- verification code.` -- Meta's own preset text, with a "Copy code" button the
-- operator did not choose and cannot remove: every authentication template
-- created since May 2023 has one.
--
-- 0111 stores three things about a template send -- name, language, variables --
-- and all three were right. What no column could say was that this particular
-- registration needs a fourth component on the wire, so
-- `buildTemplatePayload` sent the body alone, which for an authentication
-- template is not a partial message but an invalid one.
--
-- IT IS TRANSCRIBED, NOT DERIVED, and that is the design decision this file
-- makes. Deriving it from `template_purpose` -- "WEB_VERIFICATION means
-- authentication" -- would be this system guessing at a fact that lives in
-- Meta's records, exactly what D4 refuses for the name and the language, which
-- are transcribed for the same reason. A Station that registers its
-- verification template under Utility is doing something unusual and entirely
-- legal, and a guess would send it a button it does not have -- which Meta
-- refuses just as firmly as the missing one, with the identical symptom.

-- ---------------------------------------------------------------------------
-- 1. The registry learns it.
--
-- NOT NULL DEFAULT false, rather than nullable: every template registered
-- before this migration is a PICKUP_REMINDER whose send has been working, and
-- false is what it has been doing. There is no third state here worth
-- distinguishing -- a template either carries the button or it does not -- so a
-- null would only mean "nobody has said yet", which is a question the screen
-- now always asks.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  add column otp_button boolean not null default false;

comment on column public.message_templates.otp_button is
  'Whether Meta''s approval for this template carries an OTP button -- the mark of the AUTHENTICATION category, mandatory on every authentication template created since May 2023 (copy code, one-tap, or zero-tap). TRANSCRIBED by the operator from the same Meta screen the name and language come from, never derived from `purpose`: what Meta approved is a fact about Meta''s records (D4), and a template registered for WEB_VERIFICATION under the Utility category is unusual but legal -- guessed from the purpose it would be sent a button it does not have, which the Cloud API refuses with the same (#131008) as the missing one. Read at enqueue time and stamped onto outbox_messages.template_otp_button, so a registration edited afterwards does not change what an already-queued row sends -- the rule 0111 states for the other three template columns. false for every row registered before 0165, which is what their sends were already doing.';

-- ---------------------------------------------------------------------------
-- 2. The outbox carries it to the worker.
--
-- Deliberately NOT added to outbox_messages_template_shape (0111), which makes
-- name/language/variables null or non-null together. That constraint exists to
-- stop a row being HALF a template -- naming which template it sends without
-- saying enough to send it. A NOT NULL column cannot be half anything: false is
-- true of every row that is not a template send (a plain text reply does not
-- send an OTP button either), so there is no partial state for the constraint
-- to catch and widening it would only add a way for this migration to fail on
-- historical rows.
-- ---------------------------------------------------------------------------
alter table public.outbox_messages
  add column template_otp_button boolean not null default false;

comment on column public.outbox_messages.template_otp_button is
  'Whether this row''s send must name Meta''s OTP button component, copied from message_templates.otp_button at the moment enqueue_whatsapp_outbound resolved the template -- NOT re-read at send time, for the reason template_name gives: a registry row edited afterwards must not change what an already-enqueued row claims to have sent. false on every row that is not a template send and on every template send registered before 0165, which is exactly what those sends were already doing. The column exists because an authentication template send carrying only its body is refused by the Cloud API with (#131008) Required parameter is missing -- the defect that stopped the Block 17a widget delivering a single verification code between 2026-08-10 and 2026-08-11.';

-- ---------------------------------------------------------------------------
-- 3. The claim hands it over. DROP and CREATE, not CREATE OR REPLACE: the
-- returned table gains a column, and Postgres refuses to replace a function
-- whose OUT parameters change -- 0111's own note, for the same edit. The grant
-- goes with the drop, since a dropped function takes its ACL with it and losing
-- this one would answer 42501 to every send.
-- ---------------------------------------------------------------------------
drop function if exists public.claim_outbox_batch(integer);

create function public.claim_outbox_batch(p_limit integer)
returns table (
  id                   uuid,
  to_phone             text,
  body                 text,
  interactive          jsonb,
  template_name        text,
  template_language    text,
  template_variables   jsonb,
  template_otp_button  boolean,
  attempts             integer,
  phone_number_id      text
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  with due as (
    select c.id
    from public.outbox_messages c
    where c.status = 'PENDING'
      and c.next_attempt_at <= now()
    order by c.next_attempt_at
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.outbox_messages o
       set status = 'SENDING', claimed_at = now()
      from due
     where o.id = due.id
    returning o.id, o.to_phone, o.body, o.interactive,
              o.template_name, o.template_language, o.template_variables,
              o.template_otp_button,
              o.attempts, o.integration_id, o.next_attempt_at
  )
  select cl.id, cl.to_phone, cl.body, cl.interactive,
         cl.template_name, cl.template_language, cl.template_variables,
         cl.template_otp_button,
         cl.attempts, i.phone_number_id
  from claimed cl
  left join public.integrations i on i.id = cl.integration_id
  order by cl.next_attempt_at;
$$;

revoke execute on function public.claim_outbox_batch(integer) from public;
grant execute on function public.claim_outbox_batch(integer) to service_role;

comment on function public.claim_outbox_batch(integer) is
  'The next messages to send, marked SENDING in the same statement that chooses them. One statement is the entire point: pg_cron fires on schedule whether or not the previous tick returned, and a batch of fifty sequential calls to Meta outlasts the interval, so two ticks overlap under ordinary load -- with a plain select both would see the same PENDING rows and the listener would be answered twice. dedupe_key does not cover this: it stops a second row being enqueued, not one row being sent twice. FOR UPDATE SKIP LOCKED so an overlapping tick takes the next batch instead of blocking on this one. Returns attempts UNCHANGED, because claiming is not attempting and the ladder counts sends. LEFT JOIN on integrations so a row whose number cannot be resolved comes back and is parked with a reason, rather than being silently never claimed. outbox_messages_claim_shape (0059) requires claimed_at with SENDING, and outbox_messages_sent_shape is untouched, because a SENDING row leaves sent_at and external_id null exactly as a non-SENT row must. Returns `interactive` since 0067 (Block 5b): null on every text reply, and the conversation''s own messages otherwise -- a claim that returned only the body would send a listener the words of a question with none of its buttons. Returns `template_name`, `template_language` and `template_variables` since 0111 (Block Templates, Task 3), null together on every row that is not a registered-template send. Returns `template_otp_button` since 0165: an authentication template''s send must additionally name Meta''s OTP button component, and a claim that omitted this would leave the worker building the body-only payload the Cloud API refuses with (#131008) -- the defect that stopped the widget delivering verification codes in production.';

-- ---------------------------------------------------------------------------
-- 4. The enqueue stamps it onto the row.
--
-- CREATE OR REPLACE is available here where it was not above: the argument list
-- and the return type are unchanged, so the ACL and the dependencies survive.
-- The body is 0111's, reproduced whole rather than patched, because that is the
-- definition actually live in the database -- 0071's earlier one has been dead
-- since 0111 replaced it, and reproducing THAT would silently revert template
-- rendering to a version that cannot resolve a template at all.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_whatsapp_outbound(
  p_integration_id     uuid,
  p_to_phone           text,
  p_body               text,
  p_interactive        jsonb,
  p_dedupe_key         text,
  p_template_purpose   public.template_purpose default null,
  p_template_variables jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_integ    public.integrations%rowtype;
  v_tpl      public.message_templates%rowtype;
  v_id       uuid;
  v_body     text;
  v_expected integer;
  v_i        integer;
  v_nonce    text;
begin
  select * into v_integ
  from public.integrations
  where id = p_integration_id and enabled and deleted_at is null;

  if not found then
    raise exception 'integration not found or switched off: %', p_integration_id
      using errcode = 'P0002';
  end if;

  if p_template_purpose is not null then
    -- The tenancy for the LOOKUP, exactly as for the insert below: resolved
    -- by the integration's own company, never by anything the caller named.
    select * into v_tpl
      from public.message_templates
     where company_id = v_integ.company_id
       and purpose = p_template_purpose
       and deleted_at is null;

    if not found then
      raise exception 'no approved template registered for % in this station', p_template_purpose
        using errcode = 'P0002';
    end if;

    -- The highest {{n}} the approved body actually uses. Meta rejects a send
    -- whose variable count disagrees; refusing here turns a delivery failure
    -- nobody watches into a validation error somebody reads. Verified against
    -- PostgreSQL 17.6: regexp_matches(..., 'g') is set-returning and each row
    -- is a text[]; aggregating max() over its single implicit column
    -- (named after the function itself) in this scalar-subquery position
    -- works exactly as written -- no restructuring needed.
    v_expected := coalesce((
      select max((regexp_matches[1])::integer)
      from regexp_matches(v_tpl.body, '\{\{(\d+)\}\}', 'g')
    ), 0);

    if coalesce(jsonb_array_length(p_template_variables), 0) <> v_expected then
      raise exception 'template % expects % variable(s), got %',
        v_tpl.name, v_expected, coalesce(jsonb_array_length(p_template_variables), 0)
        using errcode = '22023';
    end if;

    -- 0165. The OTP button's parameter is the code the body already carries, so
    -- a registration marked otp_button whose body has no placeholder at all
    -- describes a send that cannot be built. 0113's door refuses that
    -- registration at the moment it is typed; this is the same rule at the
    -- moment it would be sent, for a row registered before 0165 added the
    -- column and edited into this state by nothing but the default.
    if v_tpl.otp_button and v_expected = 0 then
      raise exception 'template % carries an OTP button but its body has no {{1}} to put in it',
        v_tpl.name using errcode = '22023';
    end if;

    -- RENDERED HERE, not by the caller (D6). One function reads the approved
    -- text and writes both the audit body and the variables, so the two
    -- cannot be produced from different sources and cannot drift.
    --
    -- TWO PASSES, not one `replace()` per placeholder run against a body that
    -- keeps mutating. That first shape has a real bug: if the value dropped
    -- in at {{1}} itself contains the literal text "{{2}}", the very next
    -- iteration's replace() matches THAT text too, silently rewriting a
    -- listener's own words as if they were a second placeholder -- and
    -- iterating in reverse only moves which index is exposed, since a value
    -- landing early can equally well contain a placeholder naming an index
    -- already substituted. Reversing is not a fix.
    --
    -- Here, pass one is a SINGLE regexp_replace over v_tpl.body -- the
    -- ORIGINAL text, never a body a substitution has already touched --
    -- turning every {{n}} into an inert marker carrying its own index and a
    -- per-call random nonce. Pass two is a plain (non-regex) replace() per
    -- index, swapping each marker for its looked-up value. Because pass one
    -- already consumed every {{n}}-shaped occurrence in the original text
    -- before any listener-supplied value exists, and a marker's nonce is
    -- fresh per call, no value substituted in pass two can coincide with a
    -- marker still waiting to be replaced -- so a value containing literal
    -- "{{2}}" text passes through untouched instead of being re-substituted.
    v_nonce := replace(gen_random_uuid()::text, '-', '');
    v_body := regexp_replace(v_tpl.body, '\{\{(\d+)\}\}', v_nonce || '_\1_', 'g');
    for v_i in 1 .. v_expected loop
      -- A JSON null element (as opposed to a missing one, already refused
      -- above by the count check) makes ->> return SQL NULL, and replace()
      -- on a NULL argument returns NULL: v_body collapses to NULL for the
      -- rest of this render and the insert below fails NOT NULL (23502) on
      -- `body`, naming a column rather than the variable index. Deliberate,
      -- not an oversight: refusing is the right outcome for a value that was
      -- never a string, and it is no less safe than storing the literal text
      -- "null" or a silently truncated body would have been.
      v_body := replace(v_body, v_nonce || '_' || v_i || '_',
                        p_template_variables ->> (v_i - 1));
    end loop;
  else
    v_body := p_body;
  end if;

  -- The tenancy columns come from the INTEGRATION and are never passed in: a
  -- caller that could name its own organization_id could enqueue a message
  -- billed to, and read by, another Station.
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body,
     interactive, dedupe_key, template_name, template_language, template_variables,
     template_otp_button)
  values
    ('WHATSAPP', v_integ.id, v_integ.organization_id, v_integ.company_id,
     p_to_phone, v_body, p_interactive, p_dedupe_key,
     v_tpl.name, v_tpl.language,
     -- coalesce, not the bare argument: a template with NO placeholders is a
     -- real, Meta-approved thing (Task 2), and a caller sending one need not
     -- pass an empty array explicitly. Passed through raw, p_template_variables
     -- stays NULL for that call -- validation above already accepts it, since
     -- coalesce(jsonb_array_length(null), 0) = 0 matches an expected count of
     -- zero -- but the insert would then write template_name/template_language
     -- NOT NULL beside a NULL template_variables, which
     -- outbox_messages_template_shape refuses with a bare 23514: the enqueue
     -- said yes and the insert said no, and the caller learns only a
     -- constraint name. Coalescing here keeps the two answers in agreement.
     case when p_template_purpose is not null then coalesce(p_template_variables, '[]'::jsonb) end,
     -- coalesce for a different reason than the line above: v_tpl is simply
     -- unpopulated on a non-template send, so every field of it is NULL, and
     -- the column is NOT NULL. false is the honest value -- a plain text reply
     -- sends no OTP button either.
     coalesce(v_tpl.otp_button, false))
  -- Keyed on the message that provoked it, so a turn re-run after a crash
  -- enqueues nothing new. Returning null then, rather than raising: the caller
  -- is retrying something that already happened, which is success.
  on conflict (provider, dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.enqueue_whatsapp_outbound(uuid, text, text, jsonb, text, public.template_purpose, jsonb) is
  'Puts one message on the outbound queue on behalf of the conversation engine, which lives in TypeScript and therefore cannot be inside a SECURITY DEFINER body of its own. The organization and the Station are taken from the integration rather than from the caller, so nobody can enqueue a message against a Station they do not hold. Returns null when the dedupe key already exists, which is a turn being re-run after a crash and is success, not a conflict. Since 0111 (Block Templates, Task 3): when p_template_purpose is given, the approved row is resolved from message_templates by (company_id, purpose) -- company_id from the integration, never from the caller -- its body''s {{1}}..{{n}} placeholders are substituted with p_template_variables, and the RENDERED text becomes `body`, with template_name/template_language/template_variables stamped beside it in the same statement. Rendering happens HERE and only here (design decision D6): a caller that rendered its own copy and passed body and variables separately could produce an audit trail that disagrees with itself, which is worse than one that is merely empty, because somebody would believe it. Refuses P0002 when no live template is registered for that purpose at that Station, and 22023 when the variable count disagrees with the highest {{n}} the approved body actually uses -- turning a rejection Meta would answer at send time into a validation error the caller sees immediately. p_template_purpose null, the default, is every call this system made before this task and is unchanged by it: p_body is stored exactly as given and the three template columns stay null together. A fixed-text template with no {{n}} at all is a real, Meta-approved shape (Task 2), and p_template_variables may be omitted for it -- the insert coalesces to an empty array rather than leaving template_variables null beside a non-null template_name, which outbox_messages_template_shape would otherwise refuse. Rendering is a NONCE-KEYED TWO-PASS substitution rather than one replace() per placeholder run against a body that keeps mutating: the first shape lets a value containing literal "{{2}}" text be re-substituted the moment the loop reaches index 2, which is exactly the drift D6 exists to prevent, and reversing the iteration order does not fix it. A JSON null element in p_template_variables (as opposed to a missing one, refused above by the count check) is deliberately left to fail the insert''s `body` NOT NULL constraint with 23502 -- refusing is the correct outcome for a value that was never a string, and no less safe than storing the literal text "null" would have been. Since 0165: message_templates.otp_button is stamped onto template_otp_button in the same statement, so the worker can name Meta''s OTP button component for an authentication template -- without it the Cloud API refuses the send with (#131008) Required parameter is missing -- and a registration marked otp_button whose approved body carries no placeholder is refused 22023 here, because the button''s parameter is the code the body would have held.';

-- ---------------------------------------------------------------------------
-- 5. The registry door learns to ask. A NEW ARGUMENT means CREATE OR REPLACE
-- cannot touch this one -- the same trap 0111 named for enqueue_whatsapp_outbound
-- and 0047 for apply_inventory_movement -- so DROP and CREATE, with the grant
-- re-issued because a dropped function takes its ACL with it.
--
-- Defaulted to false so the argument is optional at the SQL level, which is
-- what keeps 0113's own pgTAP calls and any six-argument caller working
-- unchanged. The SCREEN does not use the default: it always sends the operator's
-- answer, because a question not asked is how `pulchtx_widgetcode` came to be
-- registered without the one fact that would have sent it.
-- ---------------------------------------------------------------------------
drop function public.register_message_template(uuid, public.template_purpose, text, text, text, jsonb);

create function public.register_message_template(
  p_company_id uuid,
  p_purpose    public.template_purpose,
  p_name       text,
  p_language   text,
  p_body       text,
  p_variables  jsonb default '[]'::jsonb,
  p_otp_button boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_name     text := nullif(btrim(p_name), '');
  v_language text := nullif(btrim(p_language), '');
  v_body     text := nullif(btrim(p_body), '');
  v_vars     jsonb := coalesce(p_variables, '[]'::jsonb);
  v_otp      boolean := coalesce(p_otp_button, false);
  v_expected integer;
  v_id       uuid;
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'register_message_template denied: actor=% company=% purpose=%',
      v_actor, p_company_id, p_purpose;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Three separate refusals rather than one, so the message names the field
  -- the operator has to go back and fix. 0110 carries a check constraint for
  -- each of these; reaching them would be a 23514 naming a constraint.
  if v_name is null then
    raise exception 'the template name Meta approved is required' using errcode = '22023';
  end if;

  if v_language is null then
    raise exception 'the language Meta approved is required' using errcode = '22023';
  end if;

  if v_body is null then
    raise exception 'the approved body is required' using errcode = '22023';
  end if;

  if jsonb_typeof(v_vars) <> 'array' then
    raise exception 'the variable descriptions must be a JSON array' using errcode = '22023';
  end if;

  -- Every element a non-blank string. 0110's constraint checks the array as a
  -- whole and cannot see inside it, so a null or a number here would reach the
  -- WhatsApp screen as a blank label beside a field the operator is being
  -- asked to fill in correctly — and blank labels are how the wrong value ends
  -- up at the wrong position.
  if exists (
    select 1 from jsonb_array_elements(v_vars) as e
     where jsonb_typeof(e) <> 'string' or btrim(e #>> '{}') = ''
  ) then
    raise exception 'every variable description must be a non-empty string' using errcode = '22023';
  end if;

  -- The same comparison 0111 makes at enqueue, moved to the moment it can
  -- still be acted on. 0111 raises 22023 for a mismatch too — but by then the
  -- caller is 0112's unattended sweep, whose only signal is a WARNING in a
  -- server log nobody is reading, repeated hourly for as long as the wrong
  -- registration stands. The regexp form is 0111's, verified there against
  -- PostgreSQL 17.6: regexp_matches(..., 'g') is set-returning, each row a
  -- text[], and max() over its single implicit column works as written.
  v_expected := coalesce((
    select max((regexp_matches[1])::integer)
    from regexp_matches(v_body, '\{\{(\d+)\}\}', 'g')
  ), 0);

  if jsonb_array_length(v_vars) <> v_expected then
    raise exception 'this body uses % placeholder(s) but % description(s) were given',
      v_expected, jsonb_array_length(v_vars)
      using errcode = '22023';
  end if;

  -- 0165. An OTP button's parameter is the code, and the code is what the body
  -- says with its placeholder -- so a template marked as carrying the button
  -- with nothing to put in it is a registration that could never be sent.
  -- Refused at the moment it is typed, which is the whole argument the
  -- placeholder-count check above makes for itself.
  if v_otp and v_expected = 0 then
    raise exception 'an authentication template carries the code in {{1}}; this body has no placeholder'
      using errcode = '22023';
  end if;

  -- Inferring 0110's partial index, for the reasons set out on the override
  -- door above. created_by likewise stays with whoever first registered a
  -- template for this purpose.
  insert into public.message_templates
    (organization_id, company_id, purpose, name, language, body, variables, otp_button, created_by)
  values (v_org, p_company_id, p_purpose, v_name, v_language, v_body, v_vars, v_otp, v_actor)
  on conflict (company_id, purpose) where deleted_at is null
  do update set name       = excluded.name,
                language   = excluded.language,
                body       = excluded.body,
                variables  = excluded.variables,
                otp_button = excluded.otp_button,
                updated_at = now()
  returning id into v_id;

  -- The body is deliberately not in the detail: it is Meta's approved text,
  -- already on the row and identical for every operator who transcribes the
  -- same approval. What an audit reader needs is which purpose was pointed at
  -- which approved name — and, since 0165, whether that approval was the
  -- authentication shape, which is the difference between a code that arrives
  -- and a (#131008) nobody sees.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'register_message_template', 'message_templates', v_id, v_org, p_company_id,
     jsonb_build_object('purpose', p_purpose, 'name', v_name, 'language', v_language,
                        'otp_button', v_otp));

  return v_id;
end;
$$;

revoke execute on function public.register_message_template(uuid, public.template_purpose, text, text, text, jsonb, boolean) from public;
grant execute on function public.register_message_template(uuid, public.template_purpose, text, text, text, jsonb, boolean) to authenticated;

comment on function public.register_message_template(uuid, public.template_purpose, text, text, text, jsonb, boolean) is
  'Records a template Meta has already approved, or replaces the one recorded for that purpose. Registers only — it does not submit anything to Meta (D4), which is why the name and language are transcribed rather than chosen. Refuses a body whose {{n}} count disagrees with the number of variable descriptions: 0111 makes the identical comparison at send time, where the only reader is a server log, so the same mistake is caught here as a form error instead. Since 0165 it also records p_otp_button, transcribed from the same Meta approval screen: an authentication template carries an OTP button whose parameter must be named on the wire, and a send that omits it is refused with (#131008) Required parameter is missing -- the defect that stopped the Block 17a widget delivering any verification code in production. Refuses 22023 when p_otp_button is given for a body with no placeholder, because the button''s parameter is the code that placeholder would have held.';
