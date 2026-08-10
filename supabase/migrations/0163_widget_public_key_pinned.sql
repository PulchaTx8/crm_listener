-- supabase/migrations/0163_widget_public_key_pinned.sql

-- Block 17a. Fixes upsert_widget_installation (0162), reproduced below from
-- that file exactly, with one line changed in the DO UPDATE clause.
--
-- 0162's own header wrote "EVERY FIELD ON EVERY CALL, NEVER MERGED" and meant
-- it for enabled and allowed_origins -- a Station's own configuration, which
-- SHOULD move to whatever the console last sent. public_key rode along under
-- that same sentence by accident of being one more column in the same DO
-- UPDATE, and it should not have: this column is not configuration, it is an
-- identifier a third party already pasted into an <iframe> on their own
-- website (0159's column comment: "It travels in the src of an iframe on a
-- public page"), and that page breaks the instant this function saves the
-- SAME Station a second time with any public_key that is not byte-identical
-- to what it already had -- a retry, a script, or a future edit to the Node
-- caller that forgets to read the existing row first.
--
-- THAT LAST CASE WAS, UNTIL THIS MIGRATION, THE ONLY THING STANDING BETWEEN A
-- LIVE KEY AND SILENT ROTATION: one `??` in
-- src/services/widget-installations.ts's upsertWidgetInstallation, which
-- reads the row before deciding whether to mint a key -- Node's discipline,
-- not the schema's guarantee. Every other invariant this block cares about
-- lives in a door: 0159's CHECK constraints refuse a malformed origin or key
-- shape, 0161's `for update` on widget_verifications serialises the attempt
-- ceiling under real concurrency. Leaving this one to a caller's discipline
-- was out of step with both, and the failure mode is silent: nothing raises,
-- nothing logs, a radio station just reports a blank box days or months
-- later with no error anywhere pointing at why.
--
-- created_by IS THE PRECEDENT FOR EXCLUDING A COLUMN FROM DO UPDATE, NOT THE
-- PATTERN FOR THIS FIX. 0162 already excludes created_by from this same
-- clause, following register_message_template (0113): provenance stays with
-- whoever wrote first. A public key is a stronger claim than provenance --
-- rotating created_by tells nobody anything false; rotating public_key
-- breaks a third party who never asked to be involved in this Station's
-- console session at all. So this is deliberately NOT "exclude public_key
-- from DO UPDATE" the way created_by is excluded -- that would leave a
-- Station with no key stuck, since the column would then never be set by an
-- update either, only by the initial INSERT's `values` list on a row that
-- does not yet exist. `coalesce(widget_installations.public_key,
-- excluded.public_key)` states the actual rule: keep the stored value if
-- there is one, take the caller's only if there is not. public_key is NOT
-- NULL (0159), so once a Station has a key the coalesce always resolves to
-- it -- there is no third case where the stored column is null and the
-- caller's value wins by default.
--
-- THE READ-BEFORE-WRITE IN NODE IS NOW BELT-AND-BRACES, NOT THE RULE. See
-- widget-installations.ts's updated comment: it still avoids minting a key
-- the database would have discarded anyway, but the guarantee that a second
-- save cannot rotate a live key now rests here, in the door every caller
-- must go through, not in the one function that happens to call it today.
--
-- NOTHING ELSE ABOUT THE FUNCTION CHANGES. The platform-admin gate, the
-- station lookup, the ON CONFLICT target, the audit write, and the grants are
-- reproduced unchanged from 0162 -- confirmed the highest-numbered
-- definition of this function before this file was written (`grep -rln
-- upsert_widget_installation supabase/migrations/` names only 0162).

create or replace function public.upsert_widget_installation(
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
  do update set public_key      = coalesce(widget_installations.public_key, excluded.public_key),
                enabled         = excluded.enabled,
                allowed_origins = excluded.allowed_origins,
                updated_at      = now()
  returning id into v_id;

  -- public_key is logged in full, deliberately: 0159's own column comment is
  -- explicit that it is NOT A SECRET, unlike issue_api_credential's hash,
  -- which 0149 keeps out of the audit detail for exactly the opposite reason.
  --
  -- LOGGED AS p_public_key, THE ARGUMENT THE CALLER SENT -- not the row's
  -- resolved value, which on a Station that already had a key may now differ
  -- from what was actually stored. That gap is itself the fact worth keeping:
  -- an audit reader asking "did somebody try to change this Station's key"
  -- needs to see the attempt, not a record that quietly agrees with what the
  -- database just refused to do.
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
  'Block 17a, fixed by 0163. The console''s only writer of widget_installations. Writes enabled and allowed_origins from `excluded` on every call, never merged -- update_prize, update_role, update_song and update_company_profile''s convention. public_key is the one exception: DO UPDATE sets it to coalesce(widget_installations.public_key, excluded.public_key), so a Station''s key is set once, on the row''s first insert, and pinned against every call after regardless of what a caller sends -- a rotated key would break every <iframe> a third party already embedded on their own site, a stronger claim than the provenance created_by protects by the same exclusion-from-DO-UPDATE pattern (register_message_template, 0113). public_key is NOT NULL (0159), so the coalesce always resolves to the stored value once one exists. ON CONFLICT (company_id) infers 0159''s partial unique index, the same shape register_message_template (0113) uses. Does not re-validate the origin or key-shape CHECKs; a malformed value reaches the caller as their own 23514 unchanged. p_public_key is generated in Node (Task 7) and only OFFERED here now -- the database, not the caller, decides whether it is used.';

revoke execute on function public.upsert_widget_installation(uuid, text, boolean, text[]) from public;
grant  execute on function public.upsert_widget_installation(uuid, text, boolean, text[]) to authenticated;
