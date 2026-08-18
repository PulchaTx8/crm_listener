-- supabase/migrations/0233_unsubscribe_tokens_retention.sql

-- Block 29c, Task 5, fix round 2, F19. Spec Section 7 says this token
-- mirrors widget_link_tokens "with its own expiry and its own retention
-- sweep". The expiry landed in 0232; the sweep did not, and no later task
-- touches it. This is that step, the same distance behind unsubscribe_tokens
-- that 0183 was behind widget_link_tokens (0178) -- 0178's own comment once
-- claimed a sweep that did not exist until 0183 gave it one; 0232's comment
-- makes no such claim, so nothing here is a correction, only an addition.
--
-- REPRODUCES 0183, NOT 0161 AND NOT 0133, for 0183's own stated reason,
-- restated because it still applies: 0183 (Block 19a) is the LIVE body of
-- sweep_retention, having already replaced 0161's own extension of 0133's.
-- This migration extracts THAT body by script -- sed -n over the line range
-- grep -n reported for `create or replace procedure public.sweep_retention`
-- in 0183_widget_link_tokens_retention.sql -- and appends one new block,
-- rather than retyping or reassembling the procedure from any migration
-- behind 0183. Retyping it is the exact mistake 0183's own header warns its
-- own successor against making a second time.
create or replace procedure public.sweep_retention()
language plpgsql
as $$
declare
  v_deleted  integer;
  v_total    integer := 0;
  v_counters jsonb   := '{}'::jsonb;
begin
  perform public.job_started('retention-sweep');
  commit;

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
  v_counters := v_counters || jsonb_build_object('webhook_events', v_deleted);

  -- 2. outbox_messages, 180 days. What was said to a listener, and when.
  -- Terminal states only -- a PENDING row is work not yet done, however old,
  -- and deleting it would silently drop a message somebody is waiting for.
  delete from public.outbox_messages
   where created_at < now() - interval '180 days'
     and status in ('SENT', 'FAILED');
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('outbox_messages', v_deleted);

  -- 3. whatsapp_conversations, 180 days after they expired. `expires_at` is
  -- when the conversation window closed, so this is 180 days past the end of
  -- the conversation and not past its start.
  delete from public.whatsapp_conversations
   where expires_at < now() - interval '180 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('whatsapp_conversations', v_deleted);

  -- 4. contact_requests, 365 days. A visitor's name, e-mail, phone and message
  -- from the PUBLIC form -- personal data belonging to somebody who is not a
  -- customer and never became one. A year is long enough to follow up and far
  -- longer than anybody does.
  delete from public.contact_requests
   where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('contact_requests', v_deleted);

  -- 5-7. Operational leftovers, 30 days. No personal data in any of them;
  -- swept for size rather than for law, and listed here so nobody has to
  -- wonder later whether their absence was deliberate. widget_verifications
  -- (8) and widget_link_tokens (9, below) are the exceptions -- both are 30
  -- days for LAW (or its equivalent, a listener's own linked session), not
  -- size.
  delete from public.rate_limit_counters
   where reset_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('rate_limit_counters', v_deleted);

  delete from public.whatsapp_conversation_leases
   where claimed_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('whatsapp_conversation_leases', v_deleted);

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
  v_counters := v_counters || jsonb_build_object('storage_erasure_queue', v_deleted);

  -- 8. widget_verifications, 30 days. Block 17a. A telephone number typed
  -- into a Station's website, hashed code and all -- design D5 rejected a
  -- session table for a visitor precisely because it would carry a retention
  -- obligation, and this table is that obligation, met the same way the seven
  -- above already are. Age only: a verified number's CONSENT record lives in
  -- member_consents (0032, append-only) and is untouched by this sweep, which
  -- deletes only the code and its digest.
  delete from public.widget_verifications
   where created_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('widget_verifications', v_deleted);

  -- 9. widget_link_tokens, 30 days past EXPIRY (Block 19a), not past
  -- creation -- the row's meaningful clock is when the code stopped being
  -- usable, not when it was minted, and the two are fifteen minutes apart in
  -- the ordinary case and never more. One row per matched hashtag, carrying
  -- organization, company, member, public key and promotion; 0178's own
  -- comment claimed this sweep already covered it, which was true of no
  -- migration until this one.
  delete from public.widget_link_tokens
   where expires_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('widget_link_tokens', v_deleted);

  -- 10. unsubscribe_tokens (Block 29c, Task 5, F19). CONSUMED, at any age, OR
  -- 30 days past its OWN expiry -- unlike widget_link_tokens above, which is
  -- swept on expiry alone: a widget link is disposable state with nothing to
  -- keep once it is used, but a spent unsubscribe token is the record that a
  -- listener asked to stop, until consume_unsubscribe_token's own write to
  -- member_consents takes over as that record (append-only, 0032) -- so it is
  -- safe to drop the moment it is spent, not thirty days later. An unused one
  -- gets the same 30-days-past-expiry clock widget_link_tokens is swept on,
  -- because an unopened link is still a live capability until then.
  delete from public.unsubscribe_tokens
   where consumed_at is not null
      or expires_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('unsubscribe_tokens', v_deleted);

  -- Where the counters go. Still NO audit row per deleted record,
  -- deliberately: one per deleted webhook_events row would write more rows
  -- than the sweep removed, into the one table this procedure promises never
  -- to sweep.
  perform public.job_succeeded(
    'retention-sweep',
    v_counters || jsonb_build_object('total', v_total));
  commit;
end;
$$;

comment on procedure public.sweep_retention() is
  'Requirement N7. Deletes data whose retention period has expired: webhook_events at 90 days (Meta''s raw payload, the most sensitive thing this installation stores), outbox_messages and whatsapp_conversations at 180, contact_requests at 365, widget_verifications (Block 17a, a telephone number typed on a Station''s website), widget_link_tokens (Block 19a, past expires_at, not past created_at), unsubscribe_tokens (Block 29c, Task 5, past consumption at any age, or past expires_at by 30 days if never used) and three operational tables at 30. Commits per table so one failure does not roll back the rest, every night, for ever. DOES NOT TOUCH audit_logs -- kept for ever, because it is the proof that erasures happened -- nor any business record: those are what a radio must prove afterwards, and personal data inside them is removed by anonymize_member (0034), which is subject-driven rather than age-driven. Block 11b: reports what it deleted into job_health instead of into a Postgres log nobody reads.';
