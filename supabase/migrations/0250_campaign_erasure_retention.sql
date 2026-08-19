-- supabase/migrations/0250_campaign_erasure_retention.sql

-- Block 29d-2, Task 8. `send_list_members` holds listener ids only, so an
-- erased listener lingering there was recorded as tolerable (0238's own
-- header). `message_campaign_recipients` (0242) holds a real person's PHONE
-- NUMBER OR E-MAIL ADDRESS, resolved at snapshot time, and -- for an EMAIL
-- campaign -- variable values that can themselves carry the listener's own
-- first name, full name and city (0242's own EMAIL shape: an array of
-- {"name", "value"} objects drawn from the template_variable vocabulary).
-- The same gap here would leave that in the clear after a listener asked to
-- be erased. 0242's own table comment already names this file as where the
-- obligation is paid; this is that file.
--
-- Two doors close it: `anonymize_member` (0034, last amended 0087 and 0220)
-- must reach these rows the moment a listener is erased, and `sweep_retention`
-- (0131, last amended 0233) must remove them once their campaign is old
-- enough that nobody will ask "who did we send this to" again.
--
-- BOTH ROUTINES ARE RECREATED FROM THEIR LIVE DEFINITIONS, read with
-- `pg_get_functiondef` through a throwaway Node script against the local
-- stack, never retyped from the migration that first created either --
-- `anonymize_member` has been amended twice since 0034 (0087: delivery
-- receipts; 0220: gender and country) and `sweep_retention` nine times since
-- 0131, and rebuilding either from an old file would silently revert every
-- fix after it. The live body of each, verified against the database rather
-- than assumed, is byte-for-byte what 0220 and 0233 already carry in this
-- repository -- so what follows is that text, carried forward, not retyped
-- from memory of what it should say.

-- ---------------------------------------------------------------------------
-- 1. anonymize_member -- one more table reached, in the same transaction.
-- ---------------------------------------------------------------------------
create or replace function public.anonymize_member(
  p_member_id uuid,
  p_reason public.member_erasure_reason)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  -- Not filtered on deleted_at: an already-archived listener can still be erased —
  -- archival and erasure are different mechanisms (spec §6) and neither implies the
  -- other.
  select organization_id into v_org
  from public.members
  where id = p_member_id;

  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  if not public.member_reachable(p_member_id, v_org, 'members.erase') then
    raise log 'anonymize_member denied: actor=% member=%', v_actor, p_member_id;
    raise exception 'permission denied: members.erase required' using errcode = '42501';
  end if;

  if p_reason is null then
    raise exception 'a reason is required to erase a listener' using errcode = '22023';
  end if;

  update public.members
     set full_name = null, phone = null, email = null,
         cpf_hash = null, cpf_last_digits = null, passport = null,
         birth_date = null,
         gender = null,
         address_line = null, address_number = null, address_complement = null,
         neighbourhood = null, city = null, state = null, postal_code = null,
         country = null,
         discovery_source = null,
         first_contact_origin = null,
         anonymized_at = now(),
         updated_at = now()
   where id = p_member_id and anonymized_at is null;

  if not found then
    raise exception 'that listener is already anonymised, or does not exist'
      using errcode = 'P0002';
  end if;

  update public.member_notes
     set body = null
   where member_id = p_member_id and body is not null;

  update public.member_consents
     set origin = null
   where member_id = p_member_id and origin is not null;

  update public.member_blocks
     set reason = null, lift_reason = null
   where member_id = p_member_id and (reason is not null or lift_reason is not null);

  -- Block 29d-2, Task 8. message_campaign_recipients (0242) holds this
  -- listener's phone number or e-mail address, resolved at snapshot time, and
  -- -- for an EMAIL campaign -- variable values that can themselves carry
  -- their first name, full name and city. Reached directly by member_id, at
  -- WHATEVER STATUS the row holds -- the same promise 0242's own column
  -- comment on message_campaign_recipients.member_id makes for this
  -- function, and unlike outbox_messages.to_phone (0059), which carries no
  -- such join and can only be pruned by retention age.
  --
  -- variables IS `jsonb not null` (0242), never nullable -- cleared to
  -- '[]'::jsonb, an empty array, which still satisfies
  -- message_campaign_recipients_variables_is_positional
  -- (jsonb_typeof(variables) = 'array') for both channels' own shapes.
  --
  -- PENDING moves to SUPPRESSED, in this same statement: 0242's own index
  -- comment calls `pending` "the only status a fresh, sendable row holds",
  -- and a row whose address was just nulled is not sendable -- left
  -- `pending`, claim_campaign_batch (0244) would still claim it before
  -- anything discovers there is nowhere left to send it.
  --
  -- CLAIMED IS LEFT EXACTLY AS IT STANDS, deliberately, not forgotten: that
  -- row is already inside a batch an active drain tick is holding in memory
  -- (src/services/campaigns.ts), which asks eligibility again -- and re-reads
  -- anonymized_at through it (members_marketing_eligible_bulk_for_worker,
  -- 0246) -- BEFORE it ever reads an address. An erased listener's claimed
  -- row therefore still resolves to `suppressed` there, through the drain's
  -- own settle write and its own atomic counter bump (bump_campaign_counters,
  -- 0247) -- which this statement has no way to reach correctly for a row it
  -- does not know is mid-flight. SENT, FAILED, CANCELLED and an
  -- already-SUPPRESSED row are also left exactly as they stand: each is a row
  -- the drain, or cancel_campaign (0243), has already finished with, and
  -- rewriting its status now would misstate what actually happened at send
  -- time.
  --
  -- CLEARED, NEVER DELETED -- the same choice this function already makes
  -- for every table above. message_campaigns' own counters (sent_count,
  -- failed_count, suppressed_count, 0242) are written once by the drain as
  -- it goes and never recomputed from this table (0242's own comment), so a
  -- finished campaign's history stays answerable from message_campaigns
  -- alone even after this row is cleared, or, later, removed outright by the
  -- retention sweep below.
  update public.message_campaign_recipients
     set address   = null,
         variables = '[]'::jsonb,
         status    = case when status = 'pending'
                          then 'suppressed'::public.campaign_recipient_status
                          else status
                     end
   where member_id = p_member_id
     and (address is not null or variables <> '[]'::jsonb or status = 'pending');

  -- Block 6b. The queue row is written BEFORE the update that nulls the column
  -- it reads -- reverse the two and this erases the reference and forgets the
  -- object, which is the failure mode the queue exists to close.
  --
  -- Both statements are in this transaction, so an erasure cannot be recorded
  -- without the instruction to finish it, and the instruction cannot be issued
  -- for an erasure that rolled back.
  insert into public.storage_erasure_queue (bucket, path)
  select 'delivery-receipts', w.receipt_path
  from public.winners w
  where w.member_id = p_member_id and w.receipt_path is not null;

  update public.winners
     set receipt_path = null,
         receipt_erased_at = now(),
         updated_at = now()
   where member_id = p_member_id and receipt_path is not null;

  -- The audit entry names the event, the actor and the reason. p_reason is a bounded
  -- enum (owner's ruling A), never free text, so there is no operator prose here
  -- that could re-plant what this function just scrubbed.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'anonymize_member', 'members', p_member_id, v_org,
     jsonb_build_object('member_id', p_member_id, 'reason', p_reason));
end;
$$;

comment on function public.anonymize_member(uuid, public.member_erasure_reason) is
  'LGPD erasure. Nulls every identifying column on members and sets anonymized_at; the row and its id survive so participations and deliveries still reference something. Also nulls member_notes.body, member_consents.origin and member_blocks.reason/lift_reason (owner''s ruling B), keeping those rows and their dates/types/authors. EXTENDED IN 0087 to reach delivery receipts: a receipt is a photograph or a signature, so winners.receipt_path is cleared, receipt_erased_at is stamped, and the object is queued in storage_erasure_queue IN THE SAME TRANSACTION -- because deleting a storage.objects row in SQL takes only the metadata and leaves the file, so the worker (0064) is what actually deletes it. EXTENDED IN 0250 (Block 29d-2, Task 8) to reach message_campaign_recipients (0242): a real person''s phone number or e-mail address, and an EMAIL campaign''s own resolved variable values (which can carry a first name, full name and city), cleared at whatever status the row holds; a `pending` row also moves to `suppressed` in the same statement, since a row with no address left `pending` is not the sendable row that status claims it is -- a `claimed` row is left alone on purpose, because the drain (src/services/campaigns.ts) re-checks eligibility, and therefore anonymized_at, before it ever reads an address, and settles that row itself. What SURVIVES an erasure, deliberately: the DELIVERY movement, its actor and its date, and a campaign''s own counters, all facts about what happened rather than about a person. Gated on members.erase via member_reachable. The UPDATE''s own WHERE clause (anonymized_at is null) makes a double-erase a clean, atomic refusal (P0002).';

-- ---------------------------------------------------------------------------
-- 2. sweep_retention -- one more table, wired the way 0233 wired
-- unsubscribe_tokens: commit; count; commit; add to the running total; add to
-- the reported counters.
-- ---------------------------------------------------------------------------
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

  -- 11. message_campaign_recipients (Block 29d-2, Task 8). A campaign's own
  -- counters (message_campaigns.sent_count / failed_count / suppressed_count,
  -- 0242) are already final by the time a row here can qualify for this
  -- delete -- the drain (src/services/campaigns.ts) writes them in as it
  -- goes and never recomputes them from this table (0242's own comment) --
  -- so removing these rows loses no number a finished campaign's history
  -- still needs to answer.
  --
  -- WINDOWED ON THE CAMPAIGN, not on a column of this table: unlike every
  -- other table above, message_campaign_recipients carries no timestamp of
  -- its own recording when a row was last settled -- only the campaign it
  -- belongs to, and that campaign's own finished_at / cancelled_at. 180 days,
  -- the same window item 2's outbox_messages is kept for: both are "what was
  -- said to a listener, and when", one row per message rather than per
  -- conversation.
  --
  -- BOTH CLOCKS, joined with coalesce: cancel_campaign (0243) sets
  -- cancelled_at and status = 'cancelled' but never finished_at -- only a
  -- campaign the drain runs to completion gets that column set
  -- (finalizeCampaign, src/services/campaigns.ts) -- so a cancelled
  -- campaign's own clock has to be cancelled_at, or its recipients' contact
  -- details would never age out at all.
  delete from public.message_campaign_recipients r
   using public.message_campaigns c
   where r.campaign_id = c.id
     and c.status in ('sent', 'failed', 'cancelled')
     and coalesce(c.finished_at, c.cancelled_at) < now() - interval '180 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('message_campaign_recipients', v_deleted);

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
  'Requirement N7. Deletes data whose retention period has expired: webhook_events at 90 days (Meta''s raw payload, the most sensitive thing this installation stores), outbox_messages and whatsapp_conversations at 180, contact_requests at 365, widget_verifications (Block 17a, a telephone number typed on a Station''s website), widget_link_tokens (Block 19a, past expires_at, not past created_at), unsubscribe_tokens (Block 29c, Task 5, past consumption at any age, or past expires_at by 30 days if never used), message_campaign_recipients (Block 29d-2, Task 8, 180 days past a finished or cancelled campaign''s own clock -- finished_at, or cancelled_at for a campaign cancel_campaign stopped, since that door never sets finished_at) and three operational tables at 30. Commits per table so one failure does not roll back the rest, every night, for ever. DOES NOT TOUCH audit_logs -- kept for ever, because it is the proof that erasures happened -- nor any business record: those are what a radio must prove afterwards, and personal data inside them is removed by anonymize_member (0034, last replaced in 0250), which is subject-driven rather than age-driven. Block 11b: reports what it deleted into job_health instead of into a Postgres log nobody reads.';
