-- supabase/migrations/0168_widget_cooldown_console.sql

-- Block 17b. The console can write the Station's cooldown, and read it back.
--
-- A THIRD FILE WHERE THE DESIGN SAID TWO, and the reason is worth the extra
-- file: 0167 is already committed, and a migration that has been applied
-- anywhere is append-only. Editing it to add a parameter would work on a
-- laptop and diverge from any database that had already run it.
--
-- The two functions below belong to 0162 (Block 17a) and are REPLACED rather
-- than overloaded. `create or replace` cannot add a parameter -- it would
-- create a second function beside the first, and the four-argument version
-- would go on quietly writing installations with no cooldown. Dropping first
-- is what makes the old signature stop existing.

drop function if exists public.upsert_widget_installation(uuid, text, boolean, text[]);

create function public.upsert_widget_installation(
  p_company_id      uuid,
  p_public_key      text,
  p_enabled         boolean,
  p_allowed_origins text[],
  -- Defaulted so the shape of a call that does not care is unchanged, and
  -- because zero is this column's own default and its meaning: no ceiling.
  p_music_request_cooldown interval default '0'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_id    uuid;
begin
  if not public.is_platform_admin() then
    raise log 'upsert_widget_installation denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  insert into public.widget_installations
    (organization_id, company_id, public_key, enabled, allowed_origins, created_by,
     music_request_cooldown)
  values
    (v_org, p_company_id, p_public_key, p_enabled, p_allowed_origins, v_actor,
     p_music_request_cooldown)
  on conflict (company_id) where deleted_at is null
  -- PINNED, and this line is 0163's whole reason for existing: the key is set
  -- on the first call and kept against every call after, because it is pasted
  -- into a Station's website and a rotation would silently blank the widget on
  -- a page nobody in this console can see. `coalesce` states the rule exactly
  -- -- keep the stored value if there is one, take the caller's only if there
  -- is not.
  --
  -- IT NEARLY DIED HERE. This function's body was copied forward from 0162 to
  -- add the cooldown, and 0162 predates the pin: the copy reverted it, and
  -- 39_widget_installations test 19 is what said so. Copying a function body
  -- forward carries none of the fixes made to it since.
  do update set public_key             = coalesce(widget_installations.public_key,
                                                  excluded.public_key),
                enabled                = excluded.enabled,
                allowed_origins        = excluded.allowed_origins,
                music_request_cooldown = excluded.music_request_cooldown,
                updated_at             = now()
  returning id into v_id;

  -- public_key is logged in full, deliberately: 0159's own column comment is
  -- explicit that it is NOT A SECRET, unlike issue_api_credential's hash,
  -- which 0149 keeps out of the audit detail for exactly the opposite reason.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'upsert_widget_installation', 'widget_installations', v_id, v_org, p_company_id,
     jsonb_build_object('public_key', p_public_key, 'enabled', p_enabled,
                        'allowed_origins', to_jsonb(p_allowed_origins),
                        'music_request_cooldown', p_music_request_cooldown::text));

  return v_id;
end;
$$;

comment on function public.upsert_widget_installation(uuid, text, boolean, text[], interval) is
  'Block 17a, extended by 17b. The console''s only writer of widget_installations. Writes every field on every call, never merged -- update_prize, update_role, update_song and update_company_profile''s convention. ON CONFLICT (company_id) infers 0159''s partial unique index, the same shape register_message_template (0113) uses, so a second call for a Station that already has an installation is a design guarantee to update it rather than a race that usually does. Does not re-validate the origin or key-shape CHECKs; a malformed value reaches the caller as their own 23514 unchanged. p_public_key is generated in Node and merely recorded here, matching issue_api_credential (0149). p_music_request_cooldown is Block 17b''s wait between web music requests: zero is no ceiling.';

revoke execute on function public.upsert_widget_installation(uuid, text, boolean, text[], interval) from public;
grant execute on function public.upsert_widget_installation(uuid, text, boolean, text[], interval) to authenticated;

-- ---------------------------------------------------------------------------
-- The reader. Three integers rather than one interval, because that is what the
-- form has: an interval crossing the wire as '01:30:00' would make the console
-- parse Postgres's own output format, and `extract` is the authority on what a
-- component of an interval is.
-- ---------------------------------------------------------------------------
drop function if exists public.widget_installation_for(uuid);

create function public.widget_installation_for(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  if not public.is_platform_admin() then
    raise log 'widget_installation_for denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'id',              w.id,
           'organization_id', w.organization_id,
           'company_id',      w.company_id,
           'public_key',      w.public_key,
           'enabled',         w.enabled,
           'allowed_origins', to_jsonb(w.allowed_origins),
           'created_at',      w.created_at,
           'updated_at',      w.updated_at,
           -- Block 17b. Postgres does not normalise across these units, so 36
           -- hours read back as 36 hours rather than as a day and a half --
           -- the operator sees the numbers they typed.
           'cooldown_days',    floor(extract(day    from w.music_request_cooldown))::integer,
           'cooldown_hours',   floor(extract(hour   from w.music_request_cooldown))::integer,
           'cooldown_minutes', floor(extract(minute from w.music_request_cooldown))::integer,
           -- A correlated subquery inside the SAME select as the row itself
           -- -- one query, one snapshot, the reason this function exists
           -- rather than the console reading widget_installations and
           -- message_templates separately.
           'has_template', exists (
             select 1 from public.message_templates mt
              where mt.company_id = w.company_id
                and mt.purpose = 'WEB_VERIFICATION'
                and mt.deleted_at is null
           )
         )
    into v_result
    from public.widget_installations w
   where w.company_id = p_company_id
     and w.deleted_at is null;

  return v_result;
end;
$$;

comment on function public.widget_installation_for is
  'Block 17a, extended by 17b. One snapshot of a Station''s widget for the console: the installation, whether a WEB_VERIFICATION template exists, and the music-request cooldown decomposed into the three integers the form actually has. Platform admin only.';

revoke execute on function public.widget_installation_for(uuid) from public;
grant execute on function public.widget_installation_for(uuid) to authenticated;
