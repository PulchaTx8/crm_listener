-- supabase/migrations/0239_send_list_doors.sql

-- Block 29d-1, Task 3: the three ways a send list is written. 0238 grants
-- `authenticated` nothing on send_lists but SELECT and nothing at all on
-- send_list_members, so these are the only path in — the same shape 0199's
-- vendor doors give a Station-scoped table whose writes are all RPCs.
--
-- SECURITY DEFINER, re-checking messaging.manage in its own body even though
-- RLS never applies here: the boundary is the database's, and hiding a button
-- is a courtesy (has_permission already ORs in the platform-admin bypass,
-- 0121, so none is added here).
--
-- ONE STATION, ALWAYS (spec D3, 0238's own comment). create_send_list takes a
-- single p_company_id and every person it stores must already be linked
-- there (member_linked_to_company, 0034) — without that check a caller who
-- could pass any uuid would assemble a list of listeners at a Station they
-- cannot see, from the id alone.
--
-- A FIXED list and a LIVING list cannot both agree and disagree with their own
-- kind: fixed with no people is not a list yet, and living with people
-- supplied directly is a fixed list wearing the wrong label. Both are refused
-- as 22023, a sentence, rather than left to whatever constraint would
-- otherwise fire.

create function public.create_send_list(
  p_company_id uuid,
  p_name       text,
  p_source     public.send_list_source,
  p_kind       public.send_list_kind,
  p_filters    jsonb,
  p_member_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor      uuid := auth.uid();
  v_org        uuid;
  v_name       text := nullif(btrim(coalesce(p_name, '')), '');
  v_member_ids uuid[] := coalesce(p_member_ids, '{}');
  v_bad_member uuid;
  v_id         uuid;
begin
  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Permission before existence, the house order (0199's own comment on
  -- save_vendor): a caller who may not write here learns that, and learns
  -- nothing about which listeners this Station has.
  if not public.has_permission('messaging.manage', p_company_id) then
    raise log 'create_send_list denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: messaging.manage required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'the list needs a name' using errcode = '22023';
  end if;

  if p_source is null then
    raise exception 'the list needs a source' using errcode = '22023';
  end if;

  if p_kind is null then
    raise exception 'the list needs a kind' using errcode = '22023';
  end if;

  if p_kind = 'living' and array_length(v_member_ids, 1) is not null then
    raise exception 'a living list is resolved from its filters on every send, not given people directly'
      using errcode = '22023';
  end if;

  if p_kind = 'fixed' and array_length(v_member_ids, 1) is null then
    raise exception 'a fixed list needs at least one person' using errcode = '22023';
  end if;

  if p_kind = 'fixed' then
    select m into v_bad_member
      from unnest(v_member_ids) as m
     where not public.member_linked_to_company(m, p_company_id)
     limit 1;

    if v_bad_member is not null then
      raise exception 'listener not linked to this station: %', v_bad_member using errcode = 'P0002';
    end if;
  end if;

  insert into public.send_lists
    (organization_id, company_id, name, source, kind, filters, created_by)
  values
    (v_org, p_company_id, v_name, p_source, p_kind, coalesce(p_filters, '{}'::jsonb), v_actor)
  returning id into v_id;

  if p_kind = 'fixed' then
    insert into public.send_list_members (list_id, member_id)
    select v_id, m from unnest(v_member_ids) as m;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_send_list', 'send_lists', v_id, v_org, p_company_id,
     jsonb_build_object('name', v_name, 'source', p_source, 'kind', p_kind,
                         'member_count', coalesce(array_length(v_member_ids, 1), 0)));

  return v_id;
end;
$$;

comment on function public.create_send_list(
  uuid, text, public.send_list_source, public.send_list_kind, jsonb, uuid[]
) is
  'Names a send list and, for a FIXED one, freezes its people. Gated on messaging.manage at p_company_id. Every id in p_member_ids must already be linked to that Station (member_linked_to_company, 0034) or the whole call is refused as P0002 — a caller who could pass any uuid would otherwise assemble a list of listeners at a Station they cannot see. A LIVING list must be given no people (its filters are resolved again on every send, 0238) and a FIXED one must be given at least one; either mismatch is 22023.';

-- Nothing else in this Station's send list carries the Station or the person
-- who wrote it, so both remaining doors take only the list's own id and
-- resolve the Station FROM THE ROW — the shape archive_vendor (0199) and
-- delete_role (0017) both use, and the reason they take one argument rather
-- than a company_id the caller could disagree with the row about.

create function public.rename_send_list(
  p_list_id uuid,
  p_name    text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_name    text := nullif(btrim(coalesce(p_name, '')), '');
begin
  select organization_id, company_id into v_org, v_company
    from public.send_lists
   where id = p_list_id and deleted_at is null;

  if not found then
    raise exception 'send list not found: %', p_list_id using errcode = 'P0002';
  end if;

  if not public.has_permission('messaging.manage', v_company) then
    raise log 'rename_send_list denied: actor=% list=%', v_actor, p_list_id;
    raise exception 'permission denied: messaging.manage required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'the list needs a name' using errcode = '22023';
  end if;

  update public.send_lists
     set name       = v_name,
         updated_at = now()
   where id = p_list_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'rename_send_list', 'send_lists', p_list_id, v_org, v_company,
     jsonb_build_object('name', v_name));
end;
$$;

comment on function public.rename_send_list(uuid, text) is
  'Renames a send list. Station is resolved from the row, not a caller-supplied argument, and gated on messaging.manage there. An unknown or already-deleted list answers P0002 — 0238''s select policy hides an archived one from every ordinary read too, so this door does the same.';

create function public.delete_send_list(p_list_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
begin
  select organization_id, company_id into v_org, v_company
    from public.send_lists
   where id = p_list_id and deleted_at is null
     for update;

  if not found then
    raise exception 'send list not found: %', p_list_id using errcode = 'P0002';
  end if;

  if not public.has_permission('messaging.manage', v_company) then
    raise log 'delete_send_list denied: actor=% list=%', v_actor, p_list_id;
    raise exception 'permission denied: messaging.manage required' using errcode = '42501';
  end if;

  -- A FIXED list's people are freeze-dried into send_list_members, and once
  -- the list itself is gone there is no other fact they were recording (0238's
  -- own comment). Deleted HERE, explicitly, rather than left to
  -- send_list_members' ON DELETE CASCADE: that cascade fires on an actual
  -- DELETE of the send_lists row, and this is a soft delete — only an UPDATE
  -- of deleted_at — so no DELETE on send_lists ever happens for it to catch.
  delete from public.send_list_members where list_id = p_list_id;

  update public.send_lists
     set deleted_at = now(),
         updated_at = now()
   where id = p_list_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'delete_send_list', 'send_lists', p_list_id, v_org, v_company, '{}'::jsonb);
end;
$$;

comment on function public.delete_send_list(uuid) is
  'Soft-deletes a send list. Station is resolved from the row and gated on messaging.manage there. Explicitly empties send_list_members first: that table''s ON DELETE CASCADE (0238) only fires on an actual DELETE of the send_lists row, and a soft delete never issues one. An unknown or already-deleted list answers P0002.';

-- `create function` grants EXECUTE to PUBLIC by default; every write door in
-- this project revokes that and grants back only to `authenticated`, so
-- `anon` and PUBLIC itself hold nothing on any of the three (0199's own
-- convention). None of the three is called by the WhatsApp worker or the
-- widget, so `service_role` gets no grant either — the same choice 0199 makes
-- for save_vendor and archive_vendor.

revoke execute on function public.create_send_list(
  uuid, text, public.send_list_source, public.send_list_kind, jsonb, uuid[]
) from public;
revoke execute on function public.rename_send_list(uuid, text) from public;
revoke execute on function public.delete_send_list(uuid) from public;

grant execute on function public.create_send_list(
  uuid, text, public.send_list_source, public.send_list_kind, jsonb, uuid[]
) to authenticated;
grant execute on function public.rename_send_list(uuid, text) to authenticated;
grant execute on function public.delete_send_list(uuid) to authenticated;
