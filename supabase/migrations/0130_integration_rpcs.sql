-- supabase/migrations/0130_integration_rpcs.sql

-- Block 10a, Task 2: the integration nobody could configure.
--
-- 0057 created public.integrations, enabled RLS, and wrote NO POLICIES -- so
-- the table is reachable only through SECURITY DEFINER functions, which is the
-- shape claim_outbox_batch (0061) already uses to read it. Nothing has ever
-- WRITTEN it from the application: connecting a new radio to WhatsApp means
-- issuing SQL by hand against production, and there is no way for the person
-- operating the platform to see why a Station receives no messages.
--
-- THE GATE IS is_platform_admin(), NOT has_permission. There is no Company
-- permission that could grant this and there should not be: the three WhatsApp
-- secrets (WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN)
-- are installation-wide environment variables, so ONE Meta app serves every
-- Station and the account being configured belongs to the platform rather than
-- to the customer. Design D5 and D7.
--
-- NO SECRET IS WRITTEN HERE. These functions carry identifiers -- the
-- phone_number_id, the WABA id, the display number -- and nothing else. A
-- secret in this table would need encryption at rest, rotation, and an answer
-- to "who may read it"; the block deliberately does not open that.
--
-- THE TWO UNIQUE INDEXES ARE THE ERROR TAXONOMY, AND THEY ARE NOT CAUGHT HERE.
-- 0057 ships both:
--
--   integrations_number_live       unique (provider, phone_number_id) where live
--   integrations_one_per_company   unique (company_id, provider)      where live
--
-- The first is a CORRECTNESS constraint rather than hygiene: the webhook routes
-- an inbound message by phone_number_id, so two Stations sharing one would be
-- ambiguous in a way that silently delivers a listener's message to the wrong
-- radio. Both raise 23505 with their constraint name, and services/
-- integrations.ts tells them apart by it. Catching them here would replace a
-- precise refusal -- "that number already belongs to another Station" -- with a
-- generic one.

-- ---------------------------------------------------------------------------
-- 1. list_integrations. Every Company, with its integration or nulls.
--
-- EVERY COMPANY, not every integration, and the difference is the whole
-- usefulness of the screen: connecting a new radio starts from seeing it listed
-- without one, rather than from already knowing its id.
-- ---------------------------------------------------------------------------

create function public.list_integrations()
returns table (
  company_id           uuid,
  company_name         text,
  organization_id      uuid,
  organization_name    text,
  company_status       public.company_status,
  integration_id       uuid,
  phone_number_id      text,
  display_phone_number text,
  waba_id              text,
  enabled              boolean,
  updated_at           timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_platform_admin() then
    raise log 'list_integrations denied: actor=%', auth.uid();
    raise exception 'permission denied: platform administrator required'
      using errcode = '42501';
  end if;

  return query
  select
    c.id, c.name, o.id, o.name, c.status,
    i.id, i.phone_number_id, i.display_phone_number, i.waba_id, i.enabled, i.updated_at
  from public.companies c
  join public.organizations o on o.id = c.organization_id
  left join public.integrations i
    on i.company_id = c.id
   and i.provider = 'WHATSAPP'
   and i.deleted_at is null
  where c.deleted_at is null
  order by o.name, c.name;
end;
$$;

comment on function public.list_integrations() is
  'Block 10a. Every live Company with its WhatsApp integration or nulls -- every Company, not every integration, because connecting a new radio starts from seeing it listed without one rather than from knowing its id. Platform admin only: the Meta credentials are installation-wide, so the account being configured belongs to the platform rather than to the customer.';

-- ---------------------------------------------------------------------------
-- 2. upsert_integration.
--
-- One row per Company per provider, so this is an upsert rather than a create
-- and an edit: the screen has one form, and a Station that already has an
-- integration is edited through the same submission that would have created it.
-- ---------------------------------------------------------------------------

create function public.upsert_integration(
  p_company_id           uuid,
  p_phone_number_id      text,
  p_waba_id              text    default null,
  p_display_phone_number text    default null,
  p_enabled              boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_number text := nullif(btrim(coalesce(p_phone_number_id, '')), '');
  v_id     uuid;
begin
  if not public.is_platform_admin() then
    raise log 'upsert_integration denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: platform administrator required'
      using errcode = '42501';
  end if;

  if v_number is null then
    raise exception 'a phone number id is required' using errcode = '22023';
  end if;

  select c.organization_id into v_org
  from public.companies c
  where c.id = p_company_id and c.deleted_at is null;

  if v_org is null then
    raise exception 'that station does not exist' using errcode = '22023';
  end if;

  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id,
     display_phone_number, waba_id, enabled, created_by)
  values
    (v_org, p_company_id, 'WHATSAPP', v_number,
     nullif(btrim(coalesce(p_display_phone_number, '')), ''),
     nullif(btrim(coalesce(p_waba_id, '')), ''),
     coalesce(p_enabled, true), v_actor)
  -- The inference names the partial index's predicate, because that is what
  -- makes it the index Postgres matches: a Station whose integration was
  -- soft-deleted gets a NEW row rather than reviving the old one, which keeps
  -- the history of what was configured when.
  on conflict (company_id, provider) where deleted_at is null
  do update set
    phone_number_id      = excluded.phone_number_id,
    display_phone_number = excluded.display_phone_number,
    waba_id              = excluded.waba_id,
    enabled              = excluded.enabled,
    updated_at           = now()
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'configure_integration', 'integrations', v_id, v_org, p_company_id,
     -- The identifiers, which are not secrets, and are exactly what somebody
     -- reading this trail later needs to answer "when did this number change".
     jsonb_build_object(
       'phone_number_id', v_number,
       'waba_id',         nullif(btrim(coalesce(p_waba_id, '')), ''),
       'enabled',         coalesce(p_enabled, true)));

  return v_id;
end;
$$;

comment on function public.upsert_integration(uuid, text, text, text, boolean) is
  'Block 10a. Points a Station at a WhatsApp number, or edits the one it has -- one row per Company per provider, so the screen has one form for both. Writes identifiers only; the three Meta secrets stay environment variables. Does NOT catch the two 23505s 0057''s unique indexes raise: integrations_number_live is a correctness constraint (the webhook routes inbound messages by phone_number_id, so a shared number delivers a listener''s message to the wrong radio) and the caller tells the two apart by constraint name.';

-- ---------------------------------------------------------------------------
-- 3. disable_integration.
--
-- Sets enabled = false; does NOT soft-delete. The number stays CLAIMED by this
-- Station -- integrations_number_live still covers the row -- which is the
-- point: a disabled integration means "this radio is not sending right now",
-- and freeing its number for another Station to claim is a different and much
-- larger decision.
-- ---------------------------------------------------------------------------

create function public.disable_integration(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_id    uuid;
  v_org   uuid;
begin
  if not public.is_platform_admin() then
    raise log 'disable_integration denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: platform administrator required'
      using errcode = '42501';
  end if;

  update public.integrations
     set enabled = false, updated_at = now()
   where company_id = p_company_id
     and provider = 'WHATSAPP'
     and deleted_at is null
  returning id, organization_id into v_id, v_org;

  if v_id is null then
    raise exception 'that station has no live integration' using errcode = '22023';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'disable_integration', 'integrations', v_id, v_org, p_company_id, '{}'::jsonb);
end;
$$;

comment on function public.disable_integration(uuid) is
  'Block 10a. Stops a Station sending, without releasing its number: the row stays live, so integrations_number_live still claims the phone_number_id. "This radio is not sending right now" and "this number is free for another radio" are different statements, and only the first is what an operator means by disabling.';

revoke execute on function public.list_integrations() from public;
revoke execute on function public.upsert_integration(uuid, text, text, text, boolean) from public;
revoke execute on function public.disable_integration(uuid) from public;
grant execute on function public.list_integrations() to authenticated;
grant execute on function public.upsert_integration(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.disable_integration(uuid) to authenticated;
