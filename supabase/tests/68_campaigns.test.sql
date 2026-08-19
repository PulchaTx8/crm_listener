begin;
select plan(3);

-- Block 29d-2. Two vocabularies: what a campaign is doing, and what happened to
-- one recipient.
select is(
  (select count(*)::int from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'campaign_status'),
  5, 'a campaign is queued, running, sent, failed or cancelled');

select is(
  (select count(*)::int from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'campaign_recipient_status'),
  6, 'and a recipient has six outcomes, not five');

-- SUPPRESSED IS ITS OWN OUTCOME, and this assertion is the reason the enum has
-- six values rather than five. `failed` is our problem and earns a retry;
-- `suppressed` is the listener's choice and must never be retried. A counter
-- that added them together would hide the one fact the operator needs.
select ok(
  'suppressed' = any(enum_range(null::public.campaign_recipient_status)::text[]),
  'a listener who withdrew is suppressed, never failed');

select finish();
rollback;
