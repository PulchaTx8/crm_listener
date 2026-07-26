-- Clearing the password gate goes through this function, never through a
-- direct UPDATE. 0006 grants `authenticated` only column-level UPDATE on
-- profiles.full_name, so must_change_password and provisional_expires_at are
-- unreachable from a client; this is the one sanctioned way to clear them, and
-- it is called only after auth.updateUser() has confirmed the new password.
--
-- (The plan closed the hole here with `revoke update (...) on profiles`. That
-- would have been a no-op: PostgreSQL ignores a column-level REVOKE when the
-- role already holds the table-level privilege, so the fix has to be a
-- column-level GRANT at the source, which is what 0006 now does.)
create or replace function public.complete_password_change()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  update public.profiles
     set must_change_password   = false,
         provisional_expires_at = null,
         updated_at             = now()
   where id = v_user;

  if not found then
    raise exception 'profile not found for user %', v_user using errcode = 'P0002';
  end if;

  insert into public.audit_logs (actor_id, action, target_table, target_id)
  values (v_user, 'complete_password_change', 'profiles', v_user);
end;
$$;

revoke execute on function public.complete_password_change() from public;
grant execute on function public.complete_password_change() to authenticated;
