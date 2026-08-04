-- supabase/migrations/0111_outbox_template.sql

-- The Templates block, Task 3. The outbox learns to carry a template send,
-- and enqueue_whatsapp_outbound learns to resolve one. Task 4 is the first
-- caller that ever sets p_template_purpose; every call this system has made
-- until now is unaffected, and that is the regression this file must not
-- break.

-- ---------------------------------------------------------------------------
-- 1. Three columns, nullable together. Exactly 0067's shape for `interactive`,
-- for the same reason: a row either names the template it sends, in full, or
-- it names none of it.
-- ---------------------------------------------------------------------------
alter table public.outbox_messages
  add column template_name text,
  add column template_language text,
  add column template_variables jsonb
    check (template_variables is null or jsonb_typeof(template_variables) = 'array'),
  add constraint outbox_messages_template_shape check (
    (template_name is null and template_language is null and template_variables is null)
    or (template_name is not null and template_language is not null and template_variables is not null)
  );

comment on column public.outbox_messages.template_name is
  'Meta''s registered name for the template this row sends (message_templates.name, Task 2), copied at the moment enqueue_whatsapp_outbound resolved it -- NOT re-read at send time, so a registry row edited or archived afterwards does not change what an already-enqueued row claims to have sent. Null on every row this system wrote before Task 3, and null on every plain text or interactive reply since: the three template columns are nullable only together (outbox_messages_template_shape), because a template send names all three or none.';

comment on column public.outbox_messages.template_language is
  'Meta''s registered language for the same template (message_templates.language), stamped alongside template_name under the same shape constraint. Task 4''s worker needs both together to call the Cloud API''s template send, which takes name and language as a pair and accepts neither alone.';

comment on column public.outbox_messages.template_variables is
  'The values actually substituted into the approved body when this row was enqueued -- a positional JSON array matching {{1}}..{{n}} in message_templates.body, exactly what the caller passed to enqueue_whatsapp_outbound. Stored so an operator asking "what was this listener actually sent" can answer without re-deriving it from a registry row that may since have changed. `body` (0059) is NOT NULL either way and already carries the rendered words for that same question once the phone number is pruned; these three columns are the structured half of the same answer, naming which approved template produced it and with what.';

-- ---------------------------------------------------------------------------
-- 2. The claim has to hand the three columns over, same as 0067 did for
-- `interactive`. DROP and CREATE rather than CREATE OR REPLACE: the returned
-- table gains columns, and Postgres refuses to replace a function whose OUT
-- parameters change. The grant goes with the drop -- a dropped function takes
-- its ACL with it, and losing this one would answer 42501 to every send.
-- ---------------------------------------------------------------------------
drop function if exists public.claim_outbox_batch(integer);

create function public.claim_outbox_batch(p_limit integer)
returns table (
  id                  uuid,
  to_phone            text,
  body                text,
  interactive         jsonb,
  template_name       text,
  template_language   text,
  template_variables  jsonb,
  attempts            integer,
  phone_number_id     text
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
              o.attempts, o.integration_id, o.next_attempt_at
  )
  select cl.id, cl.to_phone, cl.body, cl.interactive,
         cl.template_name, cl.template_language, cl.template_variables,
         cl.attempts, i.phone_number_id
  from claimed cl
  left join public.integrations i on i.id = cl.integration_id
  order by cl.next_attempt_at;
$$;

revoke execute on function public.claim_outbox_batch(integer) from public;
grant execute on function public.claim_outbox_batch(integer) to service_role;

comment on function public.claim_outbox_batch(integer) is
  'The next messages to send, marked SENDING in the same statement that chooses them. One statement is the entire point: pg_cron fires on schedule whether or not the previous tick returned, and a batch of fifty sequential calls to Meta outlasts the interval, so two ticks overlap under ordinary load -- with a plain select both would see the same PENDING rows and the listener would be answered twice. dedupe_key does not cover this: it stops a second row being enqueued, not one row being sent twice. FOR UPDATE SKIP LOCKED so an overlapping tick takes the next batch instead of blocking on this one. Returns attempts UNCHANGED, because claiming is not attempting and the ladder counts sends. LEFT JOIN on integrations so a row whose number cannot be resolved comes back and is parked with a reason, rather than being silently never claimed. outbox_messages_claim_shape (0059) requires claimed_at with SENDING, and outbox_messages_sent_shape is untouched, because a SENDING row leaves sent_at and external_id null exactly as a non-SENT row must. Returns `interactive` since 0067 (Block 5b): null on every text reply, and the conversation''s own messages otherwise -- a claim that returned only the body would send a listener the words of a question with none of its buttons. Returns `template_name`, `template_language` and `template_variables` since 0111 (Block Templates, Task 3), null together on every row that is not a registered-template send: Task 4''s worker needs all three to call the Cloud API''s template endpoint, which is a different call from a plain text or interactive send.';

-- ---------------------------------------------------------------------------
-- 3. enqueue_whatsapp_outbound learns to resolve a registered template. Gains
-- two trailing arguments, both defaulted to null so every existing call --
-- positional, five arguments, in 0071 and in src/services/conversation.ts --
-- keeps working unchanged. A new argument count means CREATE OR REPLACE
-- cannot touch this function either (the same trap 0047 hit for
-- apply_inventory_movement and 0092 for apply_winner_transition): DROP and
-- CREATE, and the grant re-issued for the same reason as above.
-- ---------------------------------------------------------------------------
drop function public.enqueue_whatsapp_outbound(uuid, text, text, jsonb, text);

create function public.enqueue_whatsapp_outbound(
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
     interactive, dedupe_key, template_name, template_language, template_variables)
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
     case when p_template_purpose is not null then coalesce(p_template_variables, '[]'::jsonb) end)
  -- Keyed on the message that provoked it, so a turn re-run after a crash
  -- enqueues nothing new. Returning null then, rather than raising: the caller
  -- is retrying something that already happened, which is success.
  on conflict (provider, dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.enqueue_whatsapp_outbound(uuid, text, text, jsonb, text, public.template_purpose, jsonb) from public;
grant execute on function public.enqueue_whatsapp_outbound(uuid, text, text, jsonb, text, public.template_purpose, jsonb) to service_role;

comment on function public.enqueue_whatsapp_outbound(uuid, text, text, jsonb, text, public.template_purpose, jsonb) is
  'Puts one message on the outbound queue on behalf of the conversation engine, which lives in TypeScript and therefore cannot be inside a SECURITY DEFINER body of its own. The organization and the Station are taken from the integration rather than from the caller, so nobody can enqueue a message against a Station they do not hold. Returns null when the dedupe key already exists, which is a turn being re-run after a crash and is success, not a conflict. Since 0111 (Block Templates, Task 3): when p_template_purpose is given, the approved row is resolved from message_templates by (company_id, purpose) -- company_id from the integration, never from the caller -- its body''s {{1}}..{{n}} placeholders are substituted with p_template_variables, and the RENDERED text becomes `body`, with template_name/template_language/template_variables stamped beside it in the same statement. Rendering happens HERE and only here (design decision D6): a caller that rendered its own copy and passed body and variables separately could produce an audit trail that disagrees with itself, which is worse than one that is merely empty, because somebody would believe it. Refuses P0002 when no live template is registered for that purpose at that Station, and 22023 when the variable count disagrees with the highest {{n}} the approved body actually uses -- turning a rejection Meta would answer at send time into a validation error the caller sees immediately. p_template_purpose null, the default, is every call this system made before this task and is unchanged by it: p_body is stored exactly as given and the three template columns stay null together. A fixed-text template with no {{n}} at all is a real, Meta-approved shape (Task 2), and p_template_variables may be omitted for it -- the insert coalesces to an empty array rather than leaving template_variables null beside a non-null template_name, which outbox_messages_template_shape would otherwise refuse. Rendering is a NONCE-KEYED TWO-PASS substitution rather than one replace() per placeholder run against a body that keeps mutating: the first shape lets a value containing literal "{{2}}" text be re-substituted the moment the loop reaches index 2, which is exactly the drift D6 exists to prevent, and reversing the iteration order does not fix it. A JSON null element in p_template_variables (as opposed to a missing one, refused above by the count check) is deliberately left to fail the insert''s `body` NOT NULL constraint with 23502 -- refusing is the correct outcome for a value that was never a string, and no less safe than storing the literal text "null" would have been.';
