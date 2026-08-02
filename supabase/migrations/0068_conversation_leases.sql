-- Block 5b. What stops two messages from one phone advancing the same
-- conversation at once.
--
-- WHY THIS IS A TABLE AND NOT pg_advisory_xact_lock, which is what the design
-- spec asked for until 2026-08-02: the engine is TypeScript. A turn is
--
--     load the state -> advance() in Node -> write
--
-- and an advisory lock is released when the transaction that took it commits --
-- before the state is read and before the write goes back. It would have
-- covered neither end of the read-modify-write it was chosen to protect, while
-- looking in every review exactly like the mechanism that did.
--
-- And the ticks overlap by design. pg_cron fires every ten seconds whether or
-- not the previous tick returned (0063 says so about the outbound half, and the
-- inbound half runs in the same tick), and the webhook fires one of its own on
-- top. Two turns for one phone are the ordinary case under load.
--
-- So: the claim/reclaim shape 0063 already uses, for the same reason it exists
-- there -- a claim that has to outlive its transaction cannot be a lock. It is
-- also what keeps the state's home free: the lease is in Postgres whichever
-- driver holds the conversation (design spec D6), which is the property the
-- advisory lock was chosen for and could not deliver.
create table public.whatsapp_conversation_leases (
  integration_id uuid not null references public.integrations (id),
  phone          text not null check (length(btrim(phone)) > 0),

  -- Who holds it. Handed back by the claim and required by the release, so a
  -- worker whose lease was taken over cannot free the lease of the worker that
  -- took it -- which would hand a phone somebody is mid-turn on to a third
  -- worker, the exact race this table exists to stop, reached the long way
  -- round.
  token          uuid not null default gen_random_uuid(),

  claimed_at     timestamptz not null default now(),

  primary key (integration_id, phone)
);

alter table public.whatsapp_conversation_leases enable row level security;

-- No policy and NO GRANT, and the absence is deliberate rather than the
-- omission 5a shipped three times: nothing outside the two functions below ever
-- touches this table, so the only way to reach it is to be one of them --
-- the shape `integrations` (0057) already has. Adding a PostgREST read of it is
-- then a decision somebody makes in a migration rather than a 42501 they meet
-- in production.
revoke all on public.whatsapp_conversation_leases from anon, authenticated;

comment on table public.whatsapp_conversation_leases is
  'One row per (integration, phone) while a worker is running a turn for it (design spec §4.3). Claimed before the conversation state is read and released after it is written, so it spans the part of the turn that runs in Node -- which is what an advisory lock could not do, being released at commit. WHAT IT GUARANTEES: two live workers cannot run a turn for one phone at the same time. WHAT IT DOES NOT: it is not a fencing token. A worker declared stale and taken over can still, on waking, write the conversation state it was holding, because the store''s save does not carry the token. That window is the staleness interval -- five minutes against a turn that takes under a second -- and closing it would mean a compare-and-set in the store, which §4.4 refuses on the grounds that the lease is the one mechanism. Stated here so the guarantee is not read as larger than it is.';

-- One statement, which is the entire point: two callers cannot both win it.
-- The second blocks on the conflicting row until the first commits, then
-- re-evaluates the WHERE against a claimed_at that is now fresh, updates
-- nothing and returns null.
create function public.claim_conversation_turn(
  p_integration_id uuid,
  p_phone          text,
  p_stale_after    interval
)
returns uuid
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.whatsapp_conversation_leases (integration_id, phone)
  values (p_integration_id, p_phone)
  on conflict (integration_id, phone) do update
     set claimed_at = now(),
         -- A takeover is a NEW holder, so it is a new token. Without this the
         -- worker that lost the lease could still release the one that took it.
         token = gen_random_uuid()
   where whatsapp_conversation_leases.claimed_at < now() - p_stale_after
  returning token;
$$;

revoke execute on function public.claim_conversation_turn(uuid, text, interval) from public;
grant execute on function public.claim_conversation_turn(uuid, text, interval) to service_role;

comment on function public.claim_conversation_turn(uuid, text, interval) is
  'Takes the turn lease for one (integration, phone), or returns null if another worker holds a live one. Null is not an error and the caller must not wait on it: the message is left for the next tick, the way 5a''s deferEvent already leaves an event it could not decide. Waiting would hold a worker open for the length of somebody else''s HTTPS call to Meta. p_stale_after is the caller''s, and is the same five minutes 0063 measures a claim''s age against -- a lease older than that belonged to a worker that died mid-turn, and is taken over by this statement rather than by a separate reclaim somebody has to remember to run.';

create function public.release_conversation_turn(
  p_integration_id uuid,
  p_phone          text,
  p_token          uuid
)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  delete from public.whatsapp_conversation_leases
   where integration_id = p_integration_id
     and phone = p_phone
     and token = p_token;
$$;

revoke execute on function public.release_conversation_turn(uuid, text, uuid) from public;
grant execute on function public.release_conversation_turn(uuid, text, uuid) to service_role;

comment on function public.release_conversation_turn(uuid, text, uuid) is
  'Frees the lease, and only for the worker that holds it -- the token is checked in the WHERE. A release that matches nothing is silent and correct: it means this worker was declared stale and taken over while it was working, and the lease it is trying to free belongs to somebody else now.';
