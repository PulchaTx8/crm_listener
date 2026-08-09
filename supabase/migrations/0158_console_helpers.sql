-- supabase/migrations/0158_console_helpers.sql

-- Block 16, design D3 and D4. The two reads the Stations screen needs, in the
-- shape that screen reads them.
--
-- WHY EITHER EXISTS: spec §9. The Station record's dialog opens from what
-- page.tsx already read -- use-record-dialog changes the URL without a server
-- round trip, so anything the dialog fetches for itself is a second way for one
-- screen to be wrong, which is the defect Block 15 shipped and had to correct.
-- That means the page reads the integration and the keys of EVERY Station it
-- lists, before knowing which record will be opened.
--
-- That is only affordable because the screen is filtered to one Organization
-- (D3): three or four rows, not the platform. The retiring customers screen
-- listed twenty-five Stations from every group at once, and it is precisely
-- that screen that could not have done this.

-- ---------------------------------------------------------------------------
-- 1. get_integration -- list_integrations' single-Company sibling.
--
-- Same columns, deliberately: two shapes for one record is two things to keep in
-- step, and the form that reads this is the one lifted out of /admin/integrations
-- unchanged.
--
-- A Station with no integration yields ONE ROW OF NULLS rather than no rows,
-- the same way list_integrations does. The screen's question is "is this Station
-- connected", and no-rows and a-row-of-nulls answer it differently only if the
-- caller remembers to tell them apart.
-- ---------------------------------------------------------------------------

create function public.get_integration(p_company_id uuid)
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
    raise log 'get_integration denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
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
  where c.id = p_company_id
    and c.deleted_at is null;
end;
$$;

comment on function public.get_integration(uuid) is
  'Block 16. One Station''s WhatsApp integration, in list_integrations'' exact columns. Exists because the Stations screen reads the integration of every Station it lists before knowing which record will be opened -- the dialog opens from the page''s read, never from a fetch of its own (spec §9). A Station with no integration yields one row of nulls, as the list does. Platform admin only: the Meta credentials are installation-wide.';

-- ---------------------------------------------------------------------------
-- 2. list_api_credentials_for -- list_api_credentials' bulk sibling.
--
-- ONE CALL FOR EVERY LISTED STATION, and that is the whole reason it exists.
-- Calling the single-Station version once per row is a query per row: the N+1
-- Block 3b measured at 102 queries and cut to 5, met again in a place where the
-- screen would look fine on the developer's two-Station group and be slow on the
-- customer with nine.
--
-- Carries company_id, which the single version has no need for -- the caller
-- groups by it.
--
-- THE HASH IS NOT AMONG THE COLUMNS AND MUST NEVER BE ADDED. That rule is
-- 0149's and it does not weaken because the read got wider.
-- ---------------------------------------------------------------------------

create function public.list_api_credentials_for(p_company_ids uuid[])
returns table (
  company_id   uuid,
  id           uuid,
  name         text,
  token_prefix text,
  scopes       text[],
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_platform_admin() then
    raise log 'list_api_credentials_for denied: actor=%', auth.uid();
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  return query
    select c.company_id, c.id, c.name, c.token_prefix,
           -- The filter matters, exactly as it does in 0149: a left join with no
           -- scopes yields one row with a null code, and array_agg would return
           -- {NULL} rather than an empty array -- which renders as a blank chip.
           coalesce(array_agg(s.permission_code order by s.permission_code)
                    filter (where s.permission_code is not null), '{}'::text[]),
           c.expires_at, c.last_used_at, c.revoked_at, c.created_at
      from public.api_credentials c
      left join public.api_credential_scopes s on s.credential_id = c.id
     -- `= any(...)` rather than `in (select unnest(...))`: one array parameter,
     -- and a null or empty array yields no rows rather than an error, which is
     -- what a screen with no Stations selected needs.
     where c.company_id = any(coalesce(p_company_ids, '{}'::uuid[]))
     group by c.id
     order by c.company_id, c.created_at desc;
end;
$$;

comment on function public.list_api_credentials_for(uuid[]) is
  'Block 16. Every key of every named Station, newest first within each, revoked ones included. list_api_credentials'' bulk sibling: the Stations screen would otherwise call that one per row, which is the N+1 Block 3b measured at 102 queries. The hash is not among the columns and must never be added. Platform admin only.';

revoke execute on function public.get_integration(uuid) from public;
revoke execute on function public.list_api_credentials_for(uuid[]) from public;

grant execute on function public.get_integration(uuid) to authenticated;
grant execute on function public.list_api_credentials_for(uuid[]) to authenticated;
