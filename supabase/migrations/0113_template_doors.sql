-- supabase/migrations/0113_template_doors.sql

-- The Templates block, Task 5's prerequisite: the four operator doors.
--
-- 0109 and 0110 each opened their table to `authenticated` for READING and to
-- nobody at all for writing, and each said in a comment that the write door
-- would be SECURITY DEFINER. Neither wrote one, and the plan's file list stops
-- at 0112 — so an operator holding templates.manage could not change a single
-- word, and the isolation suite had no write to be refused. This is that door.
--
-- Four of them, not two, and not one discriminated on a kind the way 0100's
-- reference doors are: the two tables share a permission code and nothing else.
-- One is a per-key override of copy this system already has a default for; the
-- other is a transcription of something Meta approved out of band. A shared
-- body would have a branch in every line.
--
-- All four follow the rules the block already runs on:
--   * permission BEFORE existence (0093) — an unknown Station and an
--     unauthorised one answer 42501 alike, so neither door is an oracle for
--     whether a Company id names anything;
--   * SECURITY DEFINER inherits no RLS, so every predicate 0109's and 0110's
--     select policies would have applied is restated by hand here;
--   * `revoke execute … from public`, then granted to `authenticated` alone.
--     NOT to service_role: 0109 and 0110 grant it SELECT so the conversation
--     engine and the enqueue can resolve a Station's wording, and an EXECUTE
--     here would let the worker rewrite the texts it reads.

-- ---------------------------------------------------------------------------
-- The overrides. Upsert per (company_id, key), because the Messages screen
-- edits one of ten texts at a time and D2 makes an absent row a valid state:
-- there is no create-then-update pair to separate, only "this Station says
-- this" and "this Station says nothing, use the code's default".
-- ---------------------------------------------------------------------------

create function public.set_station_message_template(
  p_company_id uuid,
  p_key        public.system_message_key,
  p_body       text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  -- Trimmed, and stored trimmed. 0109's check constraint refuses a body that
  -- is blank after btrim, so a body of '   ' would otherwise reach the table
  -- as a bare 23514 with no column named; and leading or trailing whitespace
  -- on a WhatsApp message is invisible to the operator who typed it and
  -- visible to nobody at all.
  v_body  text := nullif(btrim(p_body), '');
  v_id    uuid;
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'set_station_message_template denied: actor=% company=% key=%',
      v_actor, p_company_id, p_key;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  -- Nearly unreachable — has_permission already required an active Company —
  -- and kept for the Station archived between the two statements, where the
  -- alternative is a null organization_id reaching a not-null column.
  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if v_body is null then
    raise exception 'a message body is required' using errcode = '22023';
  end if;

  -- ON CONFLICT inferring the PARTIAL index (0109's
  -- station_message_templates_key_unique, `where deleted_at is null`), which
  -- is why the predicate is repeated here: without it Postgres cannot match
  -- the index and the statement fails outright. Inferring it correctly is also
  -- what lets a cleared key be set again — the archived row does not
  -- participate in the index, so the new insert is not a conflict at all.
  --
  -- created_by is NOT touched on update: it is who first gave this Station its
  -- own words. Who changed them since is the audit row below, which is the
  -- only history this module keeps by design (0109: "there is no history to
  -- lose", because clearing falls back to a default the code still holds).
  insert into public.station_message_templates
    (organization_id, company_id, key, body, created_by)
  values (v_org, p_company_id, p_key, v_body, v_actor)
  on conflict (company_id, key) where deleted_at is null
  do update set body = excluded.body, updated_at = now()
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'set_station_message_template', 'station_message_templates', v_id,
     v_org, p_company_id, jsonb_build_object('key', p_key, 'body', v_body));

  return v_id;
end;
$$;

comment on function public.set_station_message_template(uuid, public.system_message_key, text) is
  'Gives one of the ten system texts a Station''s own wording, or replaces the wording it already had. Gated on templates.manage, checked before the Station is resolved so an unauthorised caller cannot learn whether a Company id names anything. Upsert rather than create/update, because D2 makes "no row" a valid state rather than a missing one — the screen edits a text, not a record. The previous wording is not kept: the audit row records who changed it to what, and clearing returns to the constant in engine.ts.';

create function public.clear_station_message_template(
  p_company_id uuid,
  p_key        public.system_message_key
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_id    uuid;
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'clear_station_message_template denied: actor=% company=% key=%',
      v_actor, p_company_id, p_key;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  -- Never a DELETE: this project deletes nothing, and the archived row is what
  -- an operator asking "what did it used to say?" has left after the default
  -- has come back.
  update public.station_message_templates
     set deleted_at = now(), updated_at = now()
   where company_id = p_company_id
     and key = p_key
     and deleted_at is null
  returning id, organization_id into v_id, v_org;

  -- Refused rather than silently accepted. The caller already holds
  -- templates.manage in this Station and can read its overrides, so naming the
  -- absence reveals nothing — and a clear that reported success while changing
  -- nothing would leave the screen showing a default the operator believes
  -- they just chose.
  if v_id is null then
    raise exception 'no live override to clear for % in this station', p_key
      using errcode = 'P0002';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'clear_station_message_template', 'station_message_templates', v_id,
     v_org, p_company_id, jsonb_build_object('key', p_key));
end;
$$;

comment on function public.clear_station_message_template(uuid, public.system_message_key) is
  'Removes a Station''s own wording for one text, returning that text to the default engine.ts holds (D2). Soft-delete, so the wording that was there is still readable; the partial unique index means the key is immediately free for a new override. Refuses P0002 when there is no live override, rather than reporting a success that changed nothing.';

-- ---------------------------------------------------------------------------
-- The registry. Upsert per (company_id, purpose) for a different reason than
-- the overrides': Meta approves a new version under a new name, and the
-- operator transcribes it over the old one (D4/D5). One live row per purpose
-- is what lets 0111's enqueue resolve a template by purpose alone.
-- ---------------------------------------------------------------------------

create function public.register_message_template(
  p_company_id uuid,
  p_purpose    public.template_purpose,
  p_name       text,
  p_language   text,
  p_body       text,
  p_variables  jsonb default '[]'::jsonb
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

  -- Inferring 0110's partial index, for the reasons set out on the override
  -- door above. created_by likewise stays with whoever first registered a
  -- template for this purpose.
  insert into public.message_templates
    (organization_id, company_id, purpose, name, language, body, variables, created_by)
  values (v_org, p_company_id, p_purpose, v_name, v_language, v_body, v_vars, v_actor)
  on conflict (company_id, purpose) where deleted_at is null
  do update set name       = excluded.name,
                language   = excluded.language,
                body       = excluded.body,
                variables  = excluded.variables,
                updated_at = now()
  returning id into v_id;

  -- The body is deliberately not in the detail: it is Meta's approved text,
  -- already on the row and identical for every operator who transcribes the
  -- same approval. What an audit reader needs is which purpose was pointed at
  -- which approved name.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'register_message_template', 'message_templates', v_id, v_org, p_company_id,
     jsonb_build_object('purpose', p_purpose, 'name', v_name, 'language', v_language));

  return v_id;
end;
$$;

comment on function public.register_message_template(uuid, public.template_purpose, text, text, text, jsonb) is
  'Records a template Meta has already approved, or replaces the one recorded for that purpose. Registers only — it does not submit anything to Meta (D4), which is why the name and language are transcribed rather than chosen. Refuses a body whose {{n}} count disagrees with the number of variable descriptions: 0111 makes the identical comparison at send time, where the only reader is a server log, so the same mistake is caught here as a form error instead.';

create function public.archive_message_template(p_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_purpose public.template_purpose;
begin
  -- 0093's one-gated-query idiom, the same shape as archive_music_reference:
  -- the Station is resolved FROM THE ROW, never from a parameter, so a caller
  -- cannot redirect the permission check at a Station they do hold
  -- templates.manage in. `not found` covers three facts on purpose — no such
  -- id, an id in a Station this caller holds nothing in, and an already
  -- archived row — and all three answer 42501 alike.
  select organization_id, company_id, purpose
    into v_org, v_company, v_purpose
    from public.message_templates
   where id = p_id
     and deleted_at is null
     and public.has_permission('templates.manage', company_id)
   for update;

  if v_company is null then
    raise log 'archive_message_template denied: actor=% id=%', v_actor, p_id;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  -- Nothing to refuse this on. A registration with no live row is exactly what
  -- a Station that has not registered anything looks like, and 0112's sweep
  -- already treats that as "this Station sends no reminders" rather than an
  -- error — it logs the P0002 per winner and carries on to the next Station.
  -- Archiving stops a future reminder; it loses no past one, because the
  -- outbox row carries its own rendered body and template stamp (D6).
  update public.message_templates
     set deleted_at = now(), updated_at = now()
   where id = p_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_message_template', 'message_templates', p_id, v_org, v_company,
     jsonb_build_object('purpose', v_purpose));
end;
$$;

comment on function public.archive_message_template(uuid) is
  'Soft-deletes a registered template. Never a DELETE — this project deletes nothing, and outbox rows keep their own rendered body and template stamp regardless (D6), so a past reminder stays readable. The partial unique index frees the purpose immediately for a new registration. An unknown id, a template in a Station the caller cannot reach and an already-archived one all answer 42501 alike (0093). Takes FOR UPDATE, so a concurrent re-registration cannot interleave between the check and the archive.';

revoke execute on function public.set_station_message_template(uuid, public.system_message_key, text)   from public;
revoke execute on function public.clear_station_message_template(uuid, public.system_message_key)       from public;
revoke execute on function public.register_message_template(uuid, public.template_purpose, text, text, text, jsonb) from public;
revoke execute on function public.archive_message_template(uuid)                                        from public;

grant execute on function public.set_station_message_template(uuid, public.system_message_key, text)    to authenticated;
grant execute on function public.clear_station_message_template(uuid, public.system_message_key)        to authenticated;
grant execute on function public.register_message_template(uuid, public.template_purpose, text, text, text, jsonb) to authenticated;
grant execute on function public.archive_message_template(uuid)                                         to authenticated;
