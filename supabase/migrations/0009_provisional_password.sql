-- The provisional password travels outside the system — WhatsApp, a phone call
-- — so it is treated as compromised by default and expires on its own after
-- seven days (spec §6). Enforcing that expiry is the middleware's job; putting
-- the gate back is this function's.
--
-- Regeneration exists because expiry without it would strand the customer: the
-- password sitting in a chat history stops working, and the owner needs one
-- click to issue another.
create or replace function public.reset_provisional_password(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  -- SECURITY DEFINER bypasses RLS, so the permission check must live here.
  if not public.is_platform_admin() then
    raise log 'reset_provisional_password denied: actor=% target_user=%', v_actor, p_user_id;
    raise exception 'permission denied: platform admin required'
      using errcode = '42501';
  end if;

  update public.profiles
     set must_change_password   = true,
         provisional_expires_at = now() + interval '7 days',
         updated_at             = now()
   where id = p_user_id
     and deleted_at is null;

  if not found then
    raise exception 'profile not found for user %', p_user_id using errcode = 'P0002';
  end if;

  insert into public.audit_logs (actor_id, action, target_table, target_id)
  values (v_actor, 'reset_provisional_password', 'profiles', p_user_id);
end;
$$;

revoke execute on function public.reset_provisional_password(uuid) from public;
grant execute on function public.reset_provisional_password(uuid) to authenticated;
