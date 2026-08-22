-- supabase/migrations/0283_manageable_stations_are_the_reachable_ones.sql

create or replace function public.list_manageable_companies(
  p_organization_id uuid,
  p_permission      text
)
returns table (id uuid, name text, status public.company_status)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_permission not in ('users.manage', 'users.invite') then
    raise exception 'list_manageable_companies: unsupported permission %', p_permission
      using errcode = '22023';
  end if;

  -- 0283. THE ANSWER IS THE STATIONS THE CALLER MAY ACT AT, and until now it was
  -- every Station in the Organization, gated once at the top.
  --
  -- That was true while users.manage and users.invite were Organization-wide.
  -- 0281 and 0282 descended them, so the screen went on OFFERING Stations the
  -- door would then refuse -- the invite checklist listed a sister Station, the
  -- send failed, and nothing on the page explained why. A list of what you may
  -- do that includes what you may not is worse than a short list.
  --
  -- THE OUTER RAISE GOES, and that is the other half. has_org_permission matches
  -- a company_membership joined to a ROLE carrying the code; a Station's owner
  -- (0278) holds a membership with role_id NULL, so it never matched them and
  -- this function refused outright -- the "could not load manageable stations"
  -- error that appeared in P5a's own e2e log and was wrongly dismissed there as
  -- unrelated. The function was not touched; P5a created a caller it could not
  -- recognise.
  --
  -- An empty list is the honest answer for somebody who may act nowhere, and it
  -- leaks nothing: every row returned is a Station this caller can already
  -- reach, so there is no wider audience to protect this from.
  return query
    select c.id, c.name, c.status
    from public.companies c
    where c.organization_id = p_organization_id
      and c.deleted_at is null
      and public.has_permission(p_permission, c.id)
    order by c.name;
end;
$$;

comment on function public.list_manageable_companies(uuid, text) is
  'The Stations of this Organization where the caller may exercise users.manage or users.invite -- since 0283 filtered per Station rather than gated once and returned all of them. It fed the Team screen''s Station-assignment rows and invite checklist a list that stopped matching what the doors accept the moment 0281 and 0282 descended those permissions, and it refused a Station''s owner outright, because has_org_permission matches a membership joined to a ROLE and an owner holds one with role_id null. Returns an empty set rather than raising for a caller who may act nowhere: that is the true answer, and every row it does return names a Station the caller can already reach.';
