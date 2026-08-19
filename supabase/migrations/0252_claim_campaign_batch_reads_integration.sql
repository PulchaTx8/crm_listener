-- supabase/migrations/0252_claim_campaign_batch_reads_integration.sql

-- Block 29d-2, Task 9. A defect no review before this task could see, because
-- nothing before it ever ran the drain against a real Postgres grant.
--
-- claim_campaign_batch (0244) hands the drain a claimed batch's channel,
-- address and template columns, and src/services/campaigns.ts's own
-- loadPhoneNumberIds then went back to Postgres A SECOND TIME, through the
-- ordinary service-role PostgREST client, to read `public.integrations` for
-- each Station's WhatsApp `phone_number_id` -- `.from('integrations').select(...)`.
-- That call cannot ever succeed: `integrations` (0057) is a system table
-- whose own comment states "nothing reaches this table through a
-- user-scoped client, by design", and the design reaches further than the
-- prose about it -- CONFIRMED LIVE against this stack, service_role itself
-- holds no SELECT, INSERT, UPDATE or DELETE on this table, only the
-- REFERENCES/TRIGGER privileges left over from the schema's own default
-- ACL. Every WhatsApp campaign recipient therefore threw
-- "permission denied for table integrations" the instant the drain reached
-- it, in every environment including production -- discovered here because
-- Task 9's own isolation cases are the first thing in this repository to
-- call `drainCampaigns` against a real database with a real WhatsApp
-- integration row seeded, the way `tests/isolation/geocode-drain.test.ts`
-- already does for the fourth drain.
--
-- outbox_messages' own claim (claim_outbox_batch, 0063) already answers the
-- identical shape of problem, and answers it correctly: it LEFT JOINs
-- `integrations` INSIDE ITS OWN SECURITY DEFINER BODY and returns
-- `phone_number_id` as a column of the claim itself, because a SECURITY
-- DEFINER function executes as its OWNER -- who does hold the grant this
-- migration's own schema deliberately withholds from every session-facing
-- role -- rather than as whatever role called it. This migration gives
-- claim_campaign_batch the same shape, rather than inventing a second one:
-- one more LEFT JOIN, for the identical structural reason 0244's own
-- comment already gives for its other two (a data-modifying WITH query's
-- UPDATE runs unconditionally, so an INNER JOIN that failed to match would
-- silently drop an already-claimed row from what this function returns
-- while leaving it claimed in the table) -- `integrations_one_per_company`
-- (0057) is a partial unique index on `(company_id, provider) where
-- deleted_at is null`, so this join can return at most one row per
-- recipient regardless of how many Stations or providers the schema holds.
--
-- DROP + CREATE, not `create or replace`: the return TABLE gains a column,
-- and Postgres refuses `create or replace function` across a changed return
-- type. The grants are restated below for the identical reason 0244's own
-- header gives -- dropping a function drops its ACL with it.
drop function public.claim_campaign_batch(integer);

create function public.claim_campaign_batch(p_limit integer)
returns table (
  id                 uuid,
  campaign_id        uuid,
  channel            public.message_channel,
  address            text,
  variables          jsonb,
  attempts           integer,
  company_id         uuid,
  template_name      text,
  template_language  text,
  body               text,
  subject            text,
  phone_number_id    text
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  with due as (
    select r.id
    from public.message_campaign_recipients r
    where r.status = 'pending'
      and r.next_attempt_at <= now()
    order by r.next_attempt_at
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.message_campaign_recipients r
       set status = 'claimed', claimed_at = now()
      from due
     where r.id = due.id
    returning r.id, r.campaign_id, r.channel, r.address, r.variables, r.attempts,
              r.next_attempt_at
  )
  -- LEFT JOIN on every one of the three tables, for the reason 0244's own
  -- comment already gives about message_campaigns and message_templates,
  -- extended here to integrations: a claimed row this join cannot match
  -- (an EMAIL campaign, or a WHATSAPP Station with no live integration)
  -- comes back with phone_number_id null rather than silently dropped from
  -- what this function returns while remaining claimed in the table.
  select cl.id, cl.campaign_id, cl.channel, cl.address, cl.variables, cl.attempts,
         c.company_id, t.name, t.language, t.body, t.subject, i.phone_number_id
  from claimed cl
  left join public.message_campaigns c on c.id = cl.campaign_id
  left join public.message_templates t on t.id = c.template_id
  left join public.integrations i
    on i.company_id = c.company_id
   and i.provider = 'WHATSAPP'
   and i.deleted_at is null
  order by cl.next_attempt_at;
$$;

revoke execute on function public.claim_campaign_batch(integer) from public;
grant execute on function public.claim_campaign_batch(integer) to service_role;

comment on function public.claim_campaign_batch(integer) is
  'The next campaign recipients to send, marked claimed in the same statement that chooses them -- claim_outbox_batch''s shape, read live via pg_get_functiondef rather than trusted from any one migration''s text, since it has been dropped and recreated more than once since it was first written. ONE STATEMENT: pg_cron-driven overlap is the ordinary case for this worker (0063''s own reasoning), and a plain select would let two ticks claim the same rows and send a listener the campaign twice -- the exact complaint that costs a WhatsApp number its quality rating, spec''s own reason this whole block exists. FOR UPDATE SKIP LOCKED so an overlapping call takes the next rows instead of blocking on these. Scans message_campaign_recipients_sendable_idx (0242), partial on `status = ''pending''` alone -- naming `claimed` here too would turn that predicate into a filter applied after the fetch and make the planner''s use of the index depend on table size, the same warning outbox_messages'' own migration (0059) states for the index claim_outbox_batch (0063) scans. Returns attempts UNCHANGED, because claiming is not attempting. LEFT JOINs message_campaigns, message_templates AND (0252) integrations for a reason that is structural rather than "these might be missing": the claim CTE''s UPDATE runs unconditionally as a data-modifying WITH query, so an INNER JOIN that failed to match would silently drop an already-claimed row from what this function returns while leaving it claimed in the table. variables comes back exactly as message_campaign_recipients stores it, snapshot-time, never re-read against message_templates'' current shape (0242''s own warning) -- an array on both channels, positional strings for WHATSAPP (index 0 is {{1}}, 0222) and {name, value} objects for EMAIL, whose placeholders are named in the body and subject instead (0223/0225, R26; 0242''s column comment describes both). Does not return from_name, from_email or reply_to (0223): the drain resolves sender identity once per campaign, not once per row, so widening this claim would be the wrong fix for that. phone_number_id (0252) is the Station''s live WhatsApp integration (0057), joined here because service_role itself holds no SELECT on that table through PostgREST -- confirmed live -- the same reason claim_outbox_batch (0063) already resolves it inside its own SECURITY DEFINER body rather than leaving its caller to look it up separately; null for an EMAIL row or a WHATSAPP Station with no live integration. GRANTED TO service_role ALONE: the drain (Task 6) is the only caller, and a claim reachable by a user session is a way to take real recipient rows out of circulation. What gives them back is the drain''s OWN reclaim (Task 6b, src/services/campaigns.ts), a direct write rather than an RPC -- the same shape 0242''s own grant comment already justifies for settling a send''s outcome -- scanning message_campaign_recipients_claimed_idx (0245), and returning any row `claimed` longer than STALE_CLAIM to `pending` UNCONDITIONALLY. That last word is load-bearing: this function therefore claims rows of a campaign an operator has already cancelled, and the drain settles those `cancelled` without sending rather than this claim excluding them, because a row never claimed is a row nothing ever settles (whole-branch review C1, ruling R34).';
