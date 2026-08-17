-- supabase/migrations/0225_marketing_template_door.sql

-- Block 29b-1, Task 4. The second write door, and the split is FORCED rather
-- than chosen (design D5).
--
-- register_message_template upserts on (company_id, purpose) -- which is how the
-- screen's "Replace what is recorded" works, and an ON CONFLICT clause needs a
-- real index whose predicate matches exactly. A marketing template has no
-- purpose, so there is no conflict target to name for it at all. That is NOT
-- because two marketing rows would collide on "purpose is null": a plain
-- unique index never treats NULL as equal to NULL, so they never would have.
-- It is because 0223 narrows message_templates_purpose_unique to `where
-- purpose is not null`, so the index still names a valid ON CONFLICT target
-- for the system half and keeps meaning one registration per system purpose --
-- with marketing rows excluded from it entirely rather than sitting inside it
-- unable to conflict with anything. Writing by id is the only shape available.
--
-- Folding both into one function would mean a function branching on "is purpose
-- null" and using two different write strategies -- two functions wearing one
-- name.

create function public.save_marketing_template(
  p_company_id     uuid,
  p_channel        public.message_channel,
  p_internal_name  text,
  p_body           text,
  p_id             uuid default null,
  p_description    text default null,
  p_subject        text default null,
  p_name           text default null,
  p_language       text default null,
  p_variables      jsonb default '[]'::jsonb,
  p_from_name      text default null,
  p_from_email     text default null,
  p_reply_to       text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_label   text := nullif(btrim(p_internal_name), '');
  v_body    text := nullif(btrim(p_body), '');
  v_subject text := nullif(btrim(p_subject), '');
  v_name    text := nullif(btrim(p_name), '');
  v_lang    text := nullif(btrim(p_language), '');
  v_fields  public.template_variable[];
  v_known   text[];
  v_used    text;
  v_id      uuid;
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'save_marketing_template denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if v_label is null then
    raise exception 'an internal name is required' using errcode = '22023';
  end if;

  if v_body is null then
    raise exception 'the body is required' using errcode = '22023';
  end if;

  -- ---------------------------------------------------------------------
  -- The two channels part company here, and only here.
  -- ---------------------------------------------------------------------
  if p_channel = 'EMAIL' then
    if v_subject is null then
      raise exception 'an email needs a subject' using errcode = '22023';
    end if;

    -- AN EMAIL BODY NAMES ITS OWN PLACEHOLDERS, so they are validated rather
    -- than declared: every {{...}} must be a value this system substitutes.
    -- The capture is WIDE -- anything between the braces, including nothing at
    -- all -- and the judgement happens after, case-insensitively against the
    -- lower-cased enum. A narrower capture (letters and underscore only) would
    -- silently let {{Listener_First_Name}}, {{123}} or {{}} through uncaught,
    -- rendered to a listener as literal, un-substituted text.
    select array_agg(lower(v::text)) into v_known
      from unnest(enum_range(null::public.template_variable)) as v;

    for v_used in
      select (regexp_matches[1])
      from regexp_matches(v_body, '\{\{([^{}]*)\}\}', 'g')
    loop
      if not (lower(v_used) = any(v_known)) then
        raise exception 'this body names %, which is not a value this system substitutes', v_used
          using errcode = '22023';
      end if;
    end loop;

    -- The positional array is meaningless for email and the CHECK in 0223
    -- refuses a non-empty one; refused here by name instead of as a 23514.
    if coalesce(jsonb_array_length(p_variables), 0) > 0 then
      raise exception 'an email template declares no positional variables; its body names them'
        using errcode = '22023';
    end if;
    v_fields := '{}'::public.template_variable[];
    v_name := null;
    v_lang := null;
  else
    -- WHATSAPP. In 29b-1 this is still a TRANSCRIPTION of something Meta
    -- approved in its own console -- the same act the system half performs,
    -- and the reason the screen keeps that notice on this channel only. 29b-2
    -- is what makes it possible to author one here.
    if v_name is null or v_lang is null then
      raise exception 'a WhatsApp template needs the name and language Meta approved'
        using errcode = '22023';
    end if;

    begin
      select array_agg(e #>> '{}' order by ord)::public.template_variable[]
        into v_fields
        from jsonb_array_elements(coalesce(p_variables, '[]'::jsonb)) with ordinality as t(e, ord);
    exception
      when invalid_text_representation then
        raise exception 'one of the variables is not a value this system substitutes'
          using errcode = '22023';
    end;

    v_fields := coalesce(v_fields, '{}'::public.template_variable[]);

    if cardinality(v_fields) <> coalesce((
      select max((regexp_matches[1])::integer)
      from regexp_matches(v_body, '\{\{(\d+)\}\}', 'g')), 0)
    then
      raise exception 'the body''s placeholders and the variables given do not agree'
        using errcode = '22023';
    end if;

    v_subject := null;
  end if;

  if p_id is null then
    insert into public.message_templates
      (organization_id, company_id, purpose, channel, internal_name, description,
       name, language, body, subject, variables,
       from_name, from_email, reply_to, created_by, updated_by)
    values
      (v_org, p_company_id, null, p_channel, v_label, nullif(btrim(p_description), ''),
       v_name, v_lang, v_body, v_subject, v_fields,
       nullif(btrim(p_from_name), ''), nullif(btrim(p_from_email), ''),
       nullif(btrim(p_reply_to), ''), v_actor, v_actor)
    returning id into v_id;
  else
    -- The tenancy is re-stated in the WHERE clause rather than trusted from the
    -- id: an id is a value a caller supplies, and a template of another Station
    -- must not be reachable by naming it. `purpose is null` is the second half
    -- -- this door may not edit a SYSTEM registration, which belongs to
    -- register_message_template and its own validations.
    update public.message_templates
       set internal_name = v_label,
           description   = nullif(btrim(p_description), ''),
           channel       = p_channel,
           name          = v_name,
           language      = v_lang,
           body          = v_body,
           subject       = v_subject,
           variables     = v_fields,
           from_name     = nullif(btrim(p_from_name), ''),
           from_email    = nullif(btrim(p_from_email), ''),
           reply_to      = nullif(btrim(p_reply_to), ''),
           updated_by    = v_actor,
           updated_at    = now()
     where id = p_id
       and company_id = p_company_id
       and purpose is null
       and deleted_at is null
    returning id into v_id;

    if v_id is null then
      raise exception 'that template could not be found in this station'
        using errcode = 'P0002';
    end if;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_marketing_template', 'message_templates', v_id, v_org, p_company_id,
     jsonb_build_object('channel', p_channel, 'internal_name', v_label,
                        'created', p_id is null));

  return v_id;
end;
$$;

revoke execute on function public.save_marketing_template(
  uuid, public.message_channel, text, text, uuid, text, text, text, text, jsonb,
  text, text, text) from public;
grant execute on function public.save_marketing_template(
  uuid, public.message_channel, text, text, uuid, text, text, text, text, jsonb,
  text, text, text) to authenticated;

comment on function public.save_marketing_template(uuid, public.message_channel, text, text, uuid, text, text, text, text, jsonb, text, text, text) is
  'Creates or updates a MARKETING template -- one with no purpose. Separate from register_message_template because that door upserts on (company_id, purpose), and a marketing template has no purpose to give that ON CONFLICT clause as a target -- not because two marketing rows would collide (a plain unique index never treats NULL as equal to NULL), but because there is no conflict target to name for a null one at all. Writes by id, re-stating company_id and `purpose is null` in the UPDATE''s own WHERE clause so an id from another Station, or a SYSTEM registration, is unreachable by naming it. An EMAIL body''s {{placeholders}} are validated against template_variable rather than declared in an array, because the body names its own and a second declaration would drift.';
