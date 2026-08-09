-- supabase/migrations/0162_widget_console.sql

-- Block 17a, Task 6. The two doors the platform console uses to configure an
-- installation -- the last database task in this block. Everything upstream
-- (0159-0161) is either a public door a visitor's browser reaches or a table
-- with no policy at all; these two are the ONLY way a console operator ever
-- touches widget_installations, gated on is_platform_admin() for 0130's
-- reason applied unchanged: configuring what a Station's website may embed is
-- an act of the platform, not of a Company role.

-- ---------------------------------------------------------------------------
-- 1. upsert_widget_installation.
--
-- ONE INSERT, INFERRING 0159's PARTIAL UNIQUE INDEX on (company_id) where
-- deleted_at is null -- the same shape register_message_template (0113) uses
-- for its own (company_id, purpose) index. A select-then-branch would leave a
-- window between the read and the write in which two concurrent saves could
-- each see no row and both try to insert, and the second would fail with an
-- unhandled unique violation instead of updating; ON CONFLICT is what makes
-- "a second call updates the same row" a guarantee the index enforces rather
-- than a race that happens to resolve correctly under the sequential calls a
-- pgTAP transaction makes.
--
-- EVERY FIELD ON EVERY CALL, NEVER MERGED -- update_prize, update_role,
-- update_song and update_company_profile all follow this convention, so
-- there is one rule for what a partial submission does rather than a
-- per-field guess. The DO UPDATE clause writes public_key, enabled and
-- allowed_origins from `excluded` unconditionally; nothing here reads the
-- row's current value first.
--
-- created_by IS NOT IN THE DO UPDATE CLAUSE, the same omission
-- register_message_template makes for the same reason: it names whoever
-- first configured this Station's widget, and a later edit does not change
-- who that was.
--
-- p_public_key ARRIVES FROM NODE, ALREADY MADE. Task 7's generatePublicKey()
-- is issue_api_credential's precedent (0149) applied to a value that is not
-- even a secret: the database does not mint it, mints nothing here, and has
-- no reason to.
--
-- THE ORIGIN AND KEY-SHAPE CHECKS ARE 0159's, NOT RESTATED HERE. This
-- function does not re-validate what widget_installations_origins_shape and
-- widget_installations_key_shape already refuse, and it does not catch or
-- swallow the exception either -- a malformed origin or key still reaches
-- the caller as the CHECK's own 23514, the same contract every other door in
-- this schema gives a constraint violation.
-- ---------------------------------------------------------------------------

create function public.upsert_widget_installation(
  p_company_id      uuid,
  p_public_key      text,
  p_enabled         boolean,
  p_allowed_origins text[]
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
    (organization_id, company_id, public_key, enabled, allowed_origins, created_by)
  values
    (v_org, p_company_id, p_public_key, p_enabled, p_allowed_origins, v_actor)
  on conflict (company_id) where deleted_at is null
  do update set public_key      = excluded.public_key,
                enabled         = excluded.enabled,
                allowed_origins = excluded.allowed_origins,
                updated_at      = now()
  returning id into v_id;

  -- public_key is logged in full, deliberately: 0159's own column comment is
  -- explicit that it is NOT A SECRET, unlike issue_api_credential's hash,
  -- which 0149 keeps out of the audit detail for exactly the opposite reason.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'upsert_widget_installation', 'widget_installations', v_id, v_org, p_company_id,
     jsonb_build_object('public_key', p_public_key, 'enabled', p_enabled,
                        'allowed_origins', to_jsonb(p_allowed_origins)));

  return v_id;
end;
$$;

comment on function public.upsert_widget_installation(uuid, text, boolean, text[]) is
  'Block 17a. The console''s only writer of widget_installations. Writes every field on every call, never merged -- update_prize, update_role, update_song and update_company_profile''s convention. ON CONFLICT (company_id) infers 0159''s partial unique index, the same shape register_message_template (0113) uses, so a second call for a Station that already has an installation is a design guarantee to update it rather than a race that usually does. Does not re-validate the origin or key-shape CHECKs; a malformed value reaches the caller as their own 23514 unchanged. p_public_key is generated in Node (Task 7) and merely recorded here, matching issue_api_credential (0149).';

revoke execute on function public.upsert_widget_installation(uuid, text, boolean, text[]) from public;
grant  execute on function public.upsert_widget_installation(uuid, text, boolean, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. widget_installation_for.
--
-- has_template IS COMPUTED IN THIS QUERY, NOT A SECOND ONE. The console tab
-- reads it to warn an operator that an enabled widget can never send a code
-- (spec §5); a second, separate query for the same fact could disagree
-- with the first between the two round trips -- an installation enabled a
-- moment ago and a template registered a moment ago are each a write this
-- function would otherwise have to read twice to relate, and the whole point
-- of folding both into one SELECT is that they cannot drift apart here the
-- way two independent reads could.
--
-- RETURNS NULL FOR A STATION WITH NO INSTALLATION, deliberately unlike
-- widget_frame_context's {"found": false, ...} in 0161. That shape exists to
-- give a probing caller ONE answer for THREE causes (unknown key, disabled,
-- archived) on a door anon can reach; this door is platform-admin-gated and
-- answers a console screen that already knows which Station it is asking
-- about, so there is no probing to defend against and nothing gained by
-- inventing a second vocabulary for "nothing here yet".
-- ---------------------------------------------------------------------------

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
           -- A correlated subquery inside the SAME select as the row itself
           -- -- one query, one snapshot, the reason this function exists
           -- rather than the console reading widget_installations and
           -- message_templates separately.
           'has_template', exists (
             select 1 from public.message_templates mt
              where mt.company_id = w.company_id
                and mt.purpose = 'WEB_VERIFICATION'
                and mt.deleted_at is null))
    into v_result
    from public.widget_installations w
   where w.company_id = p_company_id
     and w.deleted_at is null;

  return v_result;
end;
$$;

comment on function public.widget_installation_for(uuid) is
  'Block 17a. The console''s only reader of a Station''s installation. Returns the row plus has_template, computed as a correlated subquery in the SAME select so the two facts the tab''s warning line depends on (spec §5) cannot be read a moment apart and disagree. Returns SQL NULL for a Station with no installation yet -- unlike widget_frame_context (0161), this door is platform-admin-gated and already knows which Station it is asking about, so there is no probing to defend with a found/not-found envelope.';

revoke execute on function public.widget_installation_for(uuid) from public;
grant  execute on function public.widget_installation_for(uuid) to authenticated;
