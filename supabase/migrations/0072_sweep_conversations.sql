-- Block 5b, Task 9. What clears up after a conversation nobody finished.
--
-- The Redis driver needs none of this -- an expired key is simply gone -- and
-- that asymmetry is the price of the default driver being a table. The sweep
-- runs on the tick the worker already performs, beside the reclaim, so it costs
-- no new schedule and nothing to remember.
--
-- IT IS NOT WHAT MAKES A CONVERSATION EXPIRE. The store filters on expires_at
-- when it loads (postgres-store.ts), so a conversation is over the moment its
-- window passes whether or not this has run. What this bounds is how long the
-- dead row -- which holds a phone number -- survives afterwards.
create function public.sweep_expired_conversations()
returns table (conversations integer, leases integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_conversations integer;
  v_leases        integer;
begin
  with gone as (
    delete from public.whatsapp_conversations
     where expires_at <= now()
    returning 1
  )
  select count(*)::integer into v_conversations from gone;

  -- Leases too, and for a reason worth stating: a lease is deleted by the
  -- worker that holds it, and a stale one is taken over by the next claim for
  -- the same phone -- so a lease left behind by a worker that died is freed
  -- only if that person messages again. One that carries a phone number
  -- indefinitely for somebody who never does is exactly what this sweep is for.
  --
  -- The cut is deliberately far beyond the staleness interval the claim uses:
  -- this must never delete a lease a live worker is holding, and an hour is
  -- twelve times the five minutes a claim may legitimately be open for.
  with freed as (
    delete from public.whatsapp_conversation_leases
     where claimed_at <= now() - interval '1 hour'
    returning 1
  )
  select count(*)::integer into v_leases from freed;

  return query select v_conversations, v_leases;
end;
$$;

revoke execute on function public.sweep_expired_conversations() from public;
grant execute on function public.sweep_expired_conversations() to service_role;

comment on function public.sweep_expired_conversations() is
  'Deletes conversations whose window has passed, and leases old enough that no live worker can be holding one. Run on the worker''s tick beside reclaim_stale_whatsapp_claims. It does not decide expiry -- the store does that when it loads, so a conversation is over on time whether or not this ran -- it bounds how long the dead row survives, and the row holds a phone number. The lease cut is an hour against a claim staleness of five minutes: twelve times the longest a legitimate claim can be open, because deleting a lease somebody is holding would hand a phone mid-turn to a second worker.';
