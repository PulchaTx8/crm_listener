-- supabase/migrations/0240_send_list_member_ids.sql

-- Block 29d-1, Task 5 fix round 1 (F3, Critical). send_list_members (0238)
-- shipped RLS ON with NO POLICY, on the stated ground that "nothing reads
-- this as a user". That stopped being true the moment reach (Task 5,
-- src/services/send-lists.ts listReach) needed a FIXED list's frozen people:
-- listReach had no door onto this table, so it fell back to re-resolving the
-- list's stored filters -- the same path a LIVING list uses. A FIXED list
-- exists precisely so its membership does NOT move, and that fallback
-- answered reach for whoever matches the filters TODAY, which is a different
-- population from the one the list actually holds the moment either drifts.
--
-- THE STATION IS RESOLVED FROM THE ROW, not taken as a parameter -- the same
-- reason rename_send_list and delete_send_list (0239) both give: a caller who
-- could pass any company_id could ask about a Station's list while holding
-- permission only at a different one.
--
-- GATED ON messaging.view, not messaging.manage and not members.view. This is
-- a read, and it is the SAME permission the list itself is gated on (0238's
-- select policy on send_lists) -- so anyone who can already see a list on the
-- grid can see who is in it. The permission split Task 5's own review round
-- records stays intact on purpose: this door hands back ids, and
-- members_marketing_eligible_bulk (0235) still requires members.view
-- separately to say which of those ids may be written to on a channel. A
-- caller can hold one and not the other, and each continues to answer for
-- itself.
--
-- P0002 for an unknown or already-soft-deleted list, matching rename_send_list
-- and delete_send_list exactly -- 0238's own select policy already hides an
-- archived list from every ordinary read, so this door answers the same way
-- rather than a different one.
--
-- NO AUDIT ROW. This is a read; nothing else that only reads in this project
-- writes one, and the three send-list doors that DO write (0239) already log
-- themselves under their own names.
create function public.send_list_member_ids(p_list_id uuid)
returns setof uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_company uuid;
begin
  select company_id into v_company
    from public.send_lists
   where id = p_list_id and deleted_at is null;

  if not found then
    raise exception 'send list not found: %', p_list_id using errcode = 'P0002';
  end if;

  if not public.has_permission('messaging.view', v_company) then
    raise log 'send_list_member_ids denied: actor=% list=%', v_actor, p_list_id;
    raise exception 'permission denied: messaging.view required' using errcode = '42501';
  end if;

  return query
    select slm.member_id
      from public.send_list_members slm
     where slm.list_id = p_list_id;
end;
$$;

comment on function public.send_list_member_ids(uuid) is
  'The frozen membership of a FIXED send list -- the one read door onto send_list_members (0238), which carries RLS with no policy of its own ("nothing reads this as a user"). Station is resolved from the row, not a caller-supplied argument (rename_send_list/delete_send_list''s own reason, 0239), and gated on messaging.view there -- the same permission the list itself requires (0238''s select policy), so a caller who can see the list on the grid can see who is in it. An unknown or already-deleted list answers P0002. Called by listReach (services/send-lists.ts) for a FIXED list only; a LIVING list has nothing frozen here and is resolved through its stored filters instead.';

-- `create function` grants EXECUTE to PUBLIC by default; every door beside it
-- in this feature (0239) revokes that and grants back only to authenticated,
-- and this one is reached the same way -- from a user''s own request via
-- listReach, never the WhatsApp worker or the widget -- so service_role gets
-- no grant either, matching 0239''s own choice for its three doors.
revoke execute on function public.send_list_member_ids(uuid) from public;
grant execute on function public.send_list_member_ids(uuid) to authenticated;
