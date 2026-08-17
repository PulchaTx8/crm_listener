-- supabase/migrations/0224_enqueue_channel_term.sql

-- Block 29b-1, Task 3. ONE TERM, and the whole file is here to justify it.
--
-- 0111's lookup resolves a system template by (company_id, purpose). Since 0223
-- a purpose is no longer enough to identify one row's CHANNEL -- and an email
-- template carrying a system purpose would be resolved by this function and
-- handed to the Cloud API, which would refuse a message with no `name` and no
-- `language` at all. The failure would arrive as a send that never happens, in
-- a sweep whose only reader is a server log.
--
-- FROM THE LIVE DEFINITION, not from 0111's body: this function has been
-- recreated since, and rebuilding it from the migration that first created it
-- would silently revert every fix applied in between.
--
-- Signature unchanged, so `create or replace` keeps the grant.

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
       and channel = 'WHATSAPP'
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
