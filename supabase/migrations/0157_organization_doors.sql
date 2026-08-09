-- supabase/migrations/0157_organization_doors.sql

-- Block 16, design D1 and D2. The three doors the Organizations screen needs,
-- and the retirement of the one that made the screen wrong.
--
-- THE DEFECT THIS CLOSES. provision_customer (0007, amended by 0016) created an
-- Organization and a Company in one call, so every customer the platform has
-- ever taken on arrived with exactly one radio -- whether or not that was true.
-- A group with four stations was provisioned as one, then had three added by
-- hand; a group with none could not be recorded at all. The console then listed
-- the Companies and called them customers, and four rows could equally mean four
-- customers or one customer with four radios, with no way to tell from the
-- screen.
--
-- So provisioning stops guessing. It creates the group and its owner, and
-- add_company (0017) adds each radio afterwards, once somebody knows how many
-- there are.

-- ---------------------------------------------------------------------------
-- provision_organization.
--
-- provision_customer's body minus the `companies` insert, and nothing else
-- changed: the profile flags, the seven-day provisional window and the audit
-- row are all carried across as they were.
--
-- The audit row's company_id becomes null, which audit_logs allows and which is
-- the honest value -- no Station was created, and naming one would be a lie in
-- the only record that outlives the console.
--
-- Creating the auth user is the Supabase Admin API and creating the tenant is
-- SQL; there is no transaction spanning the two, so the caller creates the user
-- first and deletes it if this fails (services/organizations.ts). Everything
-- below IS atomic. On the denied path it RAISE LOGs rather than writing an audit
-- row: an INSERT followed by RAISE EXCEPTION in one transaction is discarded
-- when that transaction aborts, so the row could never commit. The server log
-- survives; the application records the denial from outside the failed
-- transaction.
-- ---------------------------------------------------------------------------

create function public.provision_organization(
  p_user_id           uuid,
  p_organization_name text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  if not public.is_platform_admin() then
    raise log 'provision_organization denied: actor=% target_user=%', v_actor, p_user_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  if coalesce(btrim(p_organization_name), '') = '' then
    raise exception 'organization name is required' using errcode = '22023';
  end if;

  insert into public.organizations (name)
  values (btrim(p_organization_name))
  returning id into v_org;

  insert into public.organization_memberships (user_id, organization_id, role)
  values (p_user_id, v_org, 'owner');

  update public.profiles
     set must_change_password   = true,
         provisional_expires_at = now() + interval '7 days',
         updated_at             = now()
   where id = p_user_id;

  if not found then
    raise exception 'profile not found for user %', p_user_id using errcode = 'P0002';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'provision_organization', 'organizations', v_org, v_org, null,
     jsonb_build_object('owner_user_id', p_user_id,
                        'organization_name', btrim(p_organization_name)));

  return v_org;
end;
$$;

comment on function public.provision_organization(uuid, text) is
  'Block 16, D1. Creates a customer group and its owner, and NO Station -- how many radios a customer has is not known at provisioning time, and inventing one is what made every group in this platform look like a single station. add_company (0017) adds each radio afterwards. Gated on is_platform_admin(). The owner arrives with must_change_password and a seven-day window, exactly as provision_customer left them.';

-- ---------------------------------------------------------------------------
-- update_organization.
--
-- EVERY FIELD IS WRITTEN ON EVERY CALL, NEVER MERGED -- update_prize,
-- update_song and update_company_profile all do this, so a partial submission
-- blanks what it omits and there is one rule rather than a per-field guess about
-- whether null means "unchanged" or "cleared".
--
-- p_billing_entity defaults to 'STATIONS' rather than null for the same reason
-- the column does (0154): it is not null, so an omitted value has to be
-- SOMETHING, and the something that is true of a customer nobody has decided
-- about is "each radio invoices for itself".
--
-- IT REACHES NO STATION COLUMN, and that is design D7 rather than an omission.
-- The selector above says who EMITS an invoice; a Station's own razao social and
-- CNPJ are facts about the Station, and a door that could blank them from the
-- group's screen is exactly how a true fact gets thrown away to store a
-- preference. 35_company_profile asserts this door has no such parameter.
-- ---------------------------------------------------------------------------

create function public.update_organization(
  p_organization_id        uuid,
  p_name                   text,
  p_legal_name             text default null,
  p_tax_id                 text default null,
  p_municipal_registration text default null,
  p_fiscal_email           text default null,
  p_billing_entity         public.billing_entity default 'STATIONS',
  p_address_line           text default null,
  p_address_number         text default null,
  p_address_complement     text default null,
  p_neighbourhood          text default null,
  p_city                   text default null,
  p_state                  text default null,
  p_postal_code            text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_name   text := nullif(btrim(coalesce(p_name, '')), '');
  v_tax_id text := nullif(btrim(coalesce(p_tax_id, '')), '');
  v_before jsonb;
begin
  if not public.is_platform_admin() then
    raise log 'update_organization denied: actor=% org=%', v_actor, p_organization_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'organization name is required' using errcode = '22023';
  end if;

  -- Caught here rather than left to organizations_tax_id_shape, so the console
  -- can print a sentence where the constraint would give it a constraint name.
  if v_tax_id is not null and v_tax_id !~ '^[0-9]{14}$' then
    raise exception 'a CNPJ has fourteen digits' using errcode = '22023';
  end if;

  select jsonb_build_object(
           'name', name, 'legal_name', legal_name, 'tax_id', tax_id,
           'municipal_registration', municipal_registration,
           'fiscal_email', fiscal_email, 'billing_entity', billing_entity,
           'address_line', address_line, 'address_number', address_number,
           'address_complement', address_complement, 'neighbourhood', neighbourhood,
           'city', city, 'state', state, 'postal_code', postal_code)
    into v_before
  from public.organizations
  where id = p_organization_id and deleted_at is null;

  if v_before is null then
    raise exception 'organization not found: %', p_organization_id using errcode = 'P0002';
  end if;

  update public.organizations
     set name                   = v_name,
         legal_name             = nullif(btrim(coalesce(p_legal_name, '')), ''),
         tax_id                 = v_tax_id,
         municipal_registration = nullif(btrim(coalesce(p_municipal_registration, '')), ''),
         fiscal_email           = nullif(btrim(coalesce(p_fiscal_email, '')), ''),
         billing_entity         = p_billing_entity,
         address_line           = nullif(btrim(coalesce(p_address_line, '')), ''),
         address_number         = nullif(btrim(coalesce(p_address_number, '')), ''),
         address_complement     = nullif(btrim(coalesce(p_address_complement, '')), ''),
         neighbourhood          = nullif(btrim(coalesce(p_neighbourhood, '')), ''),
         city                   = nullif(btrim(coalesce(p_city, '')), ''),
         state                  = nullif(btrim(coalesce(p_state, '')), ''),
         postal_code            = nullif(btrim(coalesce(p_postal_code, '')), ''),
         updated_at             = now()
   where id = p_organization_id and deleted_at is null;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'update_organization', 'organizations', p_organization_id, p_organization_id,
     jsonb_build_object('before', v_before, 'after', jsonb_build_object(
       'name', v_name, 'legal_name', p_legal_name, 'tax_id', v_tax_id,
       'municipal_registration', p_municipal_registration,
       'fiscal_email', p_fiscal_email, 'billing_entity', p_billing_entity,
       'address_line', p_address_line, 'address_number', p_address_number,
       'address_complement', p_address_complement, 'neighbourhood', p_neighbourhood,
       'city', p_city, 'state', p_state, 'postal_code', p_postal_code)));
end;
$$;

comment on function public.update_organization is
  'Block 16, D2. Replaces a group''s name, invoicing identity and address wholesale -- every field on every call, the convention update_prize and update_company_profile follow. It reaches NO Station column on purpose (D7): billing_entity says who emits an invoice and never who has a legal identity, and a door that could blank a Station''s CNPJ from the group''s screen is how a true fact gets thrown away to store a preference. Gated on is_platform_admin().';

-- ---------------------------------------------------------------------------
-- list_organizations.
--
-- ONE CALL FOR THE WHOLE SCREEN, and it returns the record's fields as well as
-- the row's, because the dialog opens from what the page already read. Block
-- 15's form failed exactly by fetching on open -- use-record-dialog changes the
-- URL without a server round trip, so anything the dialog fetches for itself is
-- a second way for one screen to be wrong.
--
-- No paging: the platform has tens of Organizations, not thousands. The screen
-- that needed a cursor was listing STATIONS, and it is now filtered to one group
-- at a time.
--
-- The Stations are NOT joined into a text column here. The record's third tab
-- links each one to /admin/stations?organization=<id>, so it needs their ids,
-- and the page reads them in a single query of its own -- a concatenated string
-- would have to be taken apart again by the only caller that reads it.
--
-- More than one owner is allowed since Block 1c. The earliest is the one shown,
-- ordered rather than left to whatever order Postgres returns, so which account
-- the reissue-password button targets does not change between renders.
-- ---------------------------------------------------------------------------

create function public.list_organizations()
returns table (
  id                     uuid,
  name                   text,
  legal_name             text,
  tax_id                 text,
  municipal_registration text,
  fiscal_email           text,
  billing_entity         public.billing_entity,
  address_line           text,
  address_number         text,
  address_complement     text,
  neighbourhood          text,
  city                   text,
  state                  text,
  postal_code            text,
  suspended_at           timestamptz,
  suspension_reason      text,
  created_at             timestamptz,
  station_count          bigint,
  owner_user_id          uuid,
  owner_email            text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_platform_admin() then
    raise log 'list_organizations denied: actor=%', auth.uid();
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  return query
  select
    o.id,
    o.name,
    o.legal_name,
    o.tax_id,
    o.municipal_registration,
    o.fiscal_email,
    o.billing_entity,
    o.address_line,
    o.address_number,
    o.address_complement,
    o.neighbourhood,
    o.city,
    o.state,
    o.postal_code,
    o.suspended_at,
    o.suspension_reason,
    o.created_at,
    (select count(*)
       from public.companies c
      where c.organization_id = o.id and c.deleted_at is null) as station_count,
    owner.user_id,
    owner.email
  from public.organizations o
  left join lateral (
    select om.user_id, p.email
    from public.organization_memberships om
    join public.profiles p on p.id = om.user_id
    where om.organization_id = o.id
      and om.role = 'owner'
      and om.deleted_at is null
    order by om.created_at asc, om.user_id asc
    limit 1
  ) owner on true
  where o.deleted_at is null
  -- Newest first, the habit the retiring customers screen had and for its
  -- reason: an operator opens this screen about a customer they have just taken
  -- on, to add the Stations provisioning no longer invents for them.
  order by o.created_at desc, o.id desc;
end;
$$;

comment on function public.list_organizations() is
  'Block 16, D2. Every customer group with its record, its Station count and its owner, in one call. Returns the record''s own fields as well as the row''s because the dialog opens from the page''s read rather than fetching on open -- the defect Block 15 met. No paging: the platform has tens of groups, and the screen that needed a cursor was listing Stations. Gated on is_platform_admin().';

revoke execute on function public.provision_organization(uuid, text) from public;
revoke execute on function public.update_organization(
  uuid, text, text, text, text, text, public.billing_entity,
  text, text, text, text, text, text, text) from public;
revoke execute on function public.list_organizations() from public;

grant execute on function public.provision_organization(uuid, text) to authenticated;
grant execute on function public.update_organization(
  uuid, text, text, text, text, text, public.billing_entity,
  text, text, text, text, text, text, text) to authenticated;
grant execute on function public.list_organizations() to authenticated;

-- ---------------------------------------------------------------------------
-- And the door that guessed is closed.
--
-- Dropped rather than deprecated. Two provisioning doors, one of which creates a
-- Station and one of which does not, is a coin-flip an operator has no way to
-- see: both succeed, and the difference only shows up months later as a group
-- with a phantom radio nobody broadcasts from. The one caller is
-- services/provisioning.ts, replaced in this same block.
-- ---------------------------------------------------------------------------

drop function public.provision_customer(uuid, text, text, text);
