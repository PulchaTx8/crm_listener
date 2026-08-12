begin;
select plan(19);

-- Block 11a. The retention sweep, and the two lists it must never grow.

select has_function('public', 'sweep_retention', array[]::text[],
  'sweep_retention exists');

select is(
  (select prokind from pg_proc where proname = 'sweep_retention'),
  'p'::"char",
  'sweep_retention is a procedure, because only a procedure may commit');

-- It may carry NEITHER security definer NOR a set clause: Postgres refuses
-- transaction control inside either. A future editor "hardening" this with
-- `set search_path` would break every sweep with `invalid transaction
-- termination`, at 04:11, where nobody is watching. 0094 proved it; 0128 and
-- this file both assert it.
select ok(
  not (select prosecdef from pg_proc where proname = 'sweep_retention')
  and (select proconfig from pg_proc where proname = 'sweep_retention') is null,
  'sweep_retention carries neither security definer nor a set clause');

select ok(
  exists (select 1 from cron.job where command like '%sweep_retention%'),
  'the retention sweep is scheduled');

-- ---------------------------------------------------------------------------
-- THE TWO LISTS, ASSERTED ON THE SOURCE.
--
-- A sweep that quietly gained a table would otherwise be found by its damage,
-- which for these tables means "the thing you needed to prove is gone". No
-- behavioural test can cover a table nobody thought to seed, so the source
-- itself is what is checked.
-- ---------------------------------------------------------------------------

select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    not like '%audit_logs%',
  'the sweep never names audit_logs -- it is the proof erasures happened');

select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    not like '%participations%',
  'the sweep never names participations');
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    not like '%winners%',
  'the sweep never names winners');
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    not like '%inventory_movements%',
  'the sweep never names inventory_movements');
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    not like '%public.members%',
  'the sweep never names members');
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    not like '%public.draws%',
  'the sweep never names draws');

-- An UNPROCESSED erasure is an obligation this installation still owes
-- somebody. 0087 gives that queue no give-up threshold for exactly that reason,
-- and sweeping one by age would silently discharge it.
-- THE ASSERTION THAT WOULD HAVE CAUGHT THE BUG THIS FILE COULD NOT.
--
-- The first version wrapped each delete in `begin … exception when others …
-- end`, which opens a SUBTRANSACTION -- and a COMMIT inside one raises
-- `cannot commit while a subtransaction is active`. Every table failed, every
-- night, and this suite was green throughout, because it asserts the SOURCE and
-- cannot execute a procedure that commits. tests/isolation/retention.test.ts
-- now calls it; this keeps the handler from coming back.
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    not like '%exception when%',
  'the sweep carries no exception handler, which would make its COMMITs fail');

select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    like '%processed_at is not null%',
  'the sweep only removes storage erasures that were actually carried out');

-- ---------------------------------------------------------------------------
-- Behaviour. The sweep COMMITS, so it cannot run inside this transaction --
-- pgTAP wraps the file in one and rolls it back. What is asserted instead is
-- that each period boundary is the one the design names, read off the source:
-- the deletes themselves are exercised by a fixture-driven run in
-- tests/isolation, where a real connection can commit.
-- ---------------------------------------------------------------------------

select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    like '%webhook_events%interval ''90 days''%',
  'webhook_events is kept for 90 days');
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    like '%outbox_messages%interval ''180 days''%',
  'outbox_messages is kept for 180 days');
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    like '%contact_requests%interval ''365 days''%',
  'contact_requests is kept for 365 days');

-- A PENDING outbox row is work not yet done, however old: deleting one would
-- silently drop a message somebody is waiting for.
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    like '%status in (''SENT'', ''FAILED'')%',
  'only terminal outbox rows are swept');

-- And a webhook that could not be processed in ninety days will not be: keeping
-- a listener's message text for ever because the code that should have read it
-- had a bug is an accident, not a policy.
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    like '%status in (''DONE'', ''FAILED'')%',
  'both terminal webhook states are swept, including FAILED');

-- ---------------------------------------------------------------------------
-- Block 19a, final review fix wave, Important #2. widget_link_tokens (0178)
-- carried a comment claiming this sweep already covered it, eighteen
-- migrations before 0183 made that true. Asserted the same way the sweep's
-- other tables are: on the source, because a table added or a table quietly
-- dropped from this list is found by its damage otherwise.
--
-- SECOND DISPATCH, TIGHTENED. The first version of both assertions below
-- matched `LIKE '%widget_link_tokens%'` alone -- and 0183's own body names
-- the table in its item-9 COMMENT before the actual `delete` statement, so
-- the first assertion passed on the comment by itself, with the delete
-- removed entirely. The second named `interval '30 days'` with nothing
-- tying it to `expires_at`, so it would have passed unchanged had the
-- column been swapped to `created_at` -- exactly the mistake this table's
-- own header (0178, 0183) exists to rule out. Both now match the actual
-- `delete ... where expires_at < now() - interval '30 days'` statement as
-- one string, so a comment alone cannot satisfy either and neither can a
-- wrong column.
-- ---------------------------------------------------------------------------
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    like '%delete from public.widget_link_tokens%',
  'the sweep deletes from widget_link_tokens (0183) -- one row per matched hashtag, and it used to accumulate for ever');

select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'sweep_retention')
    like '%delete from public.widget_link_tokens%where expires_at < now() - interval ''30 days''%',
  'widget_link_tokens is kept for 30 days past expires_at specifically, not past created_at or any other column');

select * from finish();
rollback;
