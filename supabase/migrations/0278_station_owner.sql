-- supabase/migrations/0278_station_owner.sql

-- A STATION HAS OWNERS OF ITS OWN (design D17), and 0277 is why it needs them
-- now rather than in a later block.
--
-- 0277 took every write away from the group's owner. A Station has no staff of
-- its own -- add_company (0017) creates the company and an audit row and nothing
-- else -- so on its own that migration leaves every Station in the platform
-- operable by nobody, until somebody grants a role by hand. Possible, since the
-- group's owner still holds roles.manage through has_org_permission, which 0277
-- did not touch; but a manual step per customer that no screen asks for, and one
-- nobody would discover until they tried to work.
--
-- A COLUMN RATHER THAN A ROLE GRANTING ALL THIRTY-FOUR WRITES. The role would
-- have needed no schema change and would have rotted the first time a block
-- added a permission and nobody remembered to add it there -- the same drift
-- 0276 exists to prevent one layer down. This creates the concept the model
-- already describes instead of imitating it.
--
-- ON company_memberships RATHER THAN A TABLE OF ITS OWN, because that table is
-- already exactly "this user works at this Station": Block 1c replaced its old
-- role enum with role_id, and an owner is a person who works there and needs no
-- role to say what they may do.
alter table public.company_memberships
  add column is_owner boolean not null default false;

-- AND role_id STOPS BEING MANDATORY, which is the half of this that the column
-- alone does not say. An owner needs no role -- that is the whole point of the
-- concept -- and role_id was NOT NULL, so an owner row could not be written
-- without inventing a role to satisfy a constraint that had never had to
-- consider one.
--
-- The CHECK keeps the rule the NOT NULL was really carrying: a membership means
-- something. Either this person owns the Station, or a role says what they may
-- do there. A row that is neither is somebody working there for no stated
-- reason, and it was unrepresentable before this migration and stays so.
alter table public.company_memberships
  alter column role_id drop not null;

alter table public.company_memberships
  add constraint company_memberships_says_something
    check (is_owner or role_id is not null);

comment on column public.company_memberships.is_owner is
  'Whether this person owns the Station rather than merely holding a role there (design D17). An owner needs no role: has_permission_for admits them to every permission at that Station and at no other, which is the difference between a Station''s owner and a group''s. Set for every Organization owner at every Station of their group by 0279, so that 0277 changes nobody''s day and changes what can be revoked.';

create index company_memberships_station_owner_idx
  on public.company_memberships (company_id)
  where is_owner and deleted_at is null;

-- The pair, matching the shape 0121 gave every other helper here: a _for sibling
-- that names its user, and a wrapper that asks about auth.uid(). The wrapper is
-- what a screen calls; the sibling is what a worker calls, and 0121's comment
-- explains why granting the wrapper to service_role would invite a background
-- job to get a confident false.
create or replace function public.is_station_owner_for(p_user_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.company_memberships cm
    where cm.user_id = p_user_id
      and cm.company_id = p_company_id
      and cm.is_owner
      and cm.deleted_at is null
  );
$$;

create or replace function public.is_station_owner(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_station_owner_for(auth.uid(), p_company_id);
$$;

revoke execute on function public.is_station_owner_for(uuid, uuid) from public;
revoke execute on function public.is_station_owner(uuid) from public;
grant execute on function public.is_station_owner_for(uuid, uuid) to authenticated, service_role;
grant execute on function public.is_station_owner(uuid) to authenticated;

comment on function public.is_station_owner_for(uuid, uuid) is
  'Whether this user owns THIS Station (design D17). Deliberately not is_owner_of_company, which resolves the Station''s Organization and asks whether the caller owns the GROUP -- a different question, and one that gates reads: every one of the nine policies calling an ownership helper is a SELECT, so narrowing that family would have taken away reads D19 keeps.';
