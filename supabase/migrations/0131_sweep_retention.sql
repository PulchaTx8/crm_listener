-- supabase/migrations/0131_sweep_retention.sql

-- Block 11a, Task 1: requirement N7, eighteen blocks late.
--
-- Nothing in this installation has ever been deleted for AGE. The raw Meta
-- payload of every WhatsApp message ever received is still in webhook_events --
-- in full, with the listener's phone number and their message text -- because
-- no code ever said otherwise.
--
-- ============================================================================
-- WHAT THIS SWEEP DOES NOT TOUCH, AND WHY IT IS WRITTEN DOWN
-- ============================================================================
--
-- An absence in a retention sweep reads as an oversight unless it is stated as
-- a decision, so both lists are here rather than inferable from what is
-- missing:
--
-- audit_logs: KEPT FOR EVER. It is pseudonymised by construction since Block 3
-- -- it holds ids, not names -- and it is the PROOF THAT ERASURES HAPPENED.
-- Deleting the record of a deletion is the worst available outcome in an audit,
-- and it is exactly the kind of event somebody asks about years later. Block
-- 10a's runbook flagged this as open; design D5 closes it this way.
--
-- participations, winners, draws, promotions, members, prizes,
-- inventory_movements: NO RETENTION PERIOD. They are what the radio must be
-- able to prove afterwards -- a prize delivered in 2024 and disputed in 2028
-- needs its winners row and its inventory_movements chain intact. Personal data
-- inside them is removed by ERASURE (anonymize_member, 0034), which is
-- subject-driven and already built. Age and erasure are different mechanisms
-- and this file adds nothing to the second.
--
-- 23_... asserts both lists against this procedure's own source, because a
-- sweep that quietly gained a table would otherwise be found by its damage.
--
-- ============================================================================
-- THE PERIODS ARE FIXED FOR THE INSTALLATION (design D3)
-- ============================================================================
--
-- §9's N7 says "according to the per-Company policy", which costs a policy
-- table, a screen, permissions for that screen and twice the tests -- all
-- starting with every radio on the same default. The owner ruled for constants.
-- When a radio needs a different period, the table this block did not build is
-- a migration and the sweep reads it instead of the numbers below.
--
-- ============================================================================
-- A PROCEDURE, CARRYING NEITHER `security definer` NOR `set search_path`
-- ============================================================================
--
-- 0094's header proved it and 0128 restated it: Postgres refuses transaction
-- control inside either -- a bare `commit;` in a procedure declared with one of
-- them raises `invalid transaction termination`, because both wrap the call in
-- a save/restore guard incompatible with the COMMIT being the sole top-level
-- statement. There is no workaround, so every reference below is qualified by
-- hand.
--
-- It commits PER TABLE, so a table already swept stays swept even if a later
-- one fails.
--
-- AND IT CARRIES NO EXCEPTION HANDLER, which is not an omission -- it is the
-- correction of a version that had one per table and DELETED NOTHING AT ALL. A
-- PL/pgSQL block with an `exception` clause opens a SUBTRANSACTION, and a COMMIT
-- inside one raises `cannot commit while a subtransaction is active`. Every
-- table failed that way, every night, logging a warning nobody reads -- and the
-- pgTAP suite passed the whole time, because it asserts this procedure's SOURCE
-- and cannot execute it (the file runs inside a transaction that pgTAP rolls
-- back).
--
-- It was found by CALLING it. tests/isolation/retention.test.ts now does that
-- on every run, which is the only place in this repository that can.
--
-- The cost of dropping the handlers, stated: a table that cannot be swept
-- aborts the procedure, and the tables after it wait until tomorrow. That is
-- strictly better than the alternative it replaced, which was all seven waiting
-- for ever.

create procedure public.sweep_retention()
language plpgsql
as $$
declare
  v_deleted integer;
  v_total   integer := 0;
begin
  -- 1. webhook_events, 90 days. The most sensitive and the highest volume:
  -- Meta's raw payload, whole. Its only use is reprocessing a failed
  -- ingestion, which happens within hours -- so ninety days is already
  -- generous rather than tight.
  --
  -- Every terminal state, INCLUDING FAILED: a webhook that could not be
  -- processed in ninety days will not be processed, and keeping a listener's
  -- message text for ever because the code that should have read it had a bug
  -- is not a retention policy, it is an accident.
  delete from public.webhook_events
   where received_at < now() - interval '90 days'
     and status in ('DONE', 'FAILED');
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  raise notice 'retention: webhook_events %', v_deleted;

  -- 2. outbox_messages, 180 days. What was said to a listener, and when.
  -- Terminal states only -- a PENDING row is work not yet done, however old,
  -- and deleting it would silently drop a message somebody is waiting for.
  delete from public.outbox_messages
   where created_at < now() - interval '180 days'
     and status in ('SENT', 'FAILED');
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  raise notice 'retention: outbox_messages %', v_deleted;

  -- 3. whatsapp_conversations, 180 days after they expired. `expires_at` is
  -- when the conversation window closed, so this is 180 days past the end of
  -- the conversation and not past its start.
  delete from public.whatsapp_conversations
   where expires_at < now() - interval '180 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  raise notice 'retention: whatsapp_conversations %', v_deleted;

  -- 4. contact_requests, 365 days. A visitor's name, e-mail, phone and message
  -- from the PUBLIC form -- personal data belonging to somebody who is not a
  -- customer and never became one. A year is long enough to follow up and far
  -- longer than anybody does.
  delete from public.contact_requests
   where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  raise notice 'retention: contact_requests %', v_deleted;

  -- 5-7. Operational leftovers, 30 days. No personal data in any of them; they
  -- are swept for size rather than for law, and they are listed here so nobody
  -- has to wonder later whether their absence was deliberate.

  delete from public.rate_limit_counters
   where reset_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  raise notice 'retention: rate_limit_counters %', v_deleted;

  delete from public.whatsapp_conversation_leases
   where claimed_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  raise notice 'retention: whatsapp_conversation_leases %', v_deleted;

  -- processed_at NOT NULL only: an unprocessed row is an erasure this
  -- installation still owes somebody, and 0087 is explicit that it has NO
  -- give-up threshold for exactly that reason. Sweeping one by age would
  -- silently discharge a legal obligation, which is the one thing that table
  -- exists to prevent.
  delete from public.storage_erasure_queue
   where processed_at is not null
     and processed_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  raise notice 'retention: storage_erasure_queue %', v_deleted;

  -- Counted and said out loud. Block 11b hangs an alert off this; until then it
  -- is in the Postgres log, where the other three sweeps in this schema already
  -- report. NO audit row per deleted record, deliberately: one audit row per
  -- deleted webhook_events row would write more rows than the sweep removed,
  -- into the one table this file promises never to sweep.
  raise notice 'retention sweep: % row(s) deleted across 7 tables', v_total;
end;
$$;

comment on procedure public.sweep_retention() is
  'Requirement N7. Deletes data whose retention period has expired: webhook_events at 90 days (Meta''s raw payload, the most sensitive thing this installation stores), outbox_messages and whatsapp_conversations at 180, contact_requests at 365, and three operational tables at 30. Commits per table so one failure does not roll back the rest, every night, for ever. DOES NOT TOUCH audit_logs -- kept for ever, because it is the proof that erasures happened and deleting the record of a deletion is the worst outcome in an audit -- nor any business record: those are what a radio must prove afterwards, and personal data inside them is removed by anonymize_member (0034), which is subject-driven rather than age-driven.';

-- 04:11, off the hour and off every other sweep in this schema (0094 at :00
-- hourly, 0128 at 03:17): a delete over the largest table here should not
-- contend with the report expiry queueing storage erasures.
select cron.schedule(
  'retention-sweep',
  '11 4 * * *',
  $$ call public.sweep_retention(); $$
);
