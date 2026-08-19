-- supabase/migrations/0242_campaigns.sql

-- Block 29d-2, Task 2. The two tables a campaign lives in.
--
-- QUEUE AND HISTORY IN ONE TABLE, copied from report_runs (0122), whose own
-- header gives the reason in terms that transfer exactly: a finished run is a
-- queued run with an outcome, and "is it ready?" and "what did I send last
-- month?" are one query against one table.
--
-- THE RECIPIENT TABLE IS THE SNAPSHOT *AND* THE QUEUE. They are not two things
-- that happen to share a shape -- they are the same row. Splitting them would
-- mean copying every recipient twice and keeping the copies in agreement.
--
-- THE ADDRESS IS STORED AS RESOLVED AT SNAPSHOT TIME, not looked up at send.
-- A listener who changes their number between creation and send is sent to the
-- number the campaign was built against, which is what an audit of "who did we
-- write to" has to be able to answer months later.

-- ---------------------------------------------------------------------------
-- 1. message_campaigns -- the queue and the history.
-- ---------------------------------------------------------------------------
create table public.message_campaigns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id),
  company_id       uuid not null,

  list_id          uuid not null references public.send_lists (id),
  channel          public.message_channel not null,
  template_id      uuid not null references public.message_templates (id),

  status           public.campaign_status not null default 'queued',

  -- The four counters an operator reads on the history grid (Task 7). Each is
  -- written by the drain's own settle write (Task 6), never recomputed by a
  -- query against message_campaign_recipients -- a campaign's history must
  -- still answer instantly once that table's rows have aged out under
  -- retention (Task 8).
  total_recipients integer not null default 0,
  sent_count       integer not null default 0,
  failed_count     integer not null default 0,
  suppressed_count integer not null default 0,

  created_by       uuid references auth.users (id),
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,

  -- Section 10 (Part 17 of the request). Recorded by cancel_campaign (Task 3),
  -- a SECURITY DEFINER door, alongside an audit_logs row -- never written by
  -- anything a client session can reach directly.
  cancelled_by     uuid references auth.users (id),
  cancelled_at     timestamptz,
  cancel_reason    text,

  constraint message_campaigns_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  -- CANCELLED is a claim about who and when, stated structurally rather than
  -- trusted from whoever wrote the row, the same shape report_runs_ready_has_a_file
  -- (0122) and outbox_messages_sent_shape (0059) use for their own terminal
  -- states. cancel_reason is deliberately NOT required here: an operator
  -- cancelling a campaign they know is wrong may have nothing more to say than
  -- that it should stop.
  constraint message_campaigns_cancelled_shape check (
    status <> 'cancelled' or (cancelled_by is not null and cancelled_at is not null)
  )
);

comment on table public.message_campaigns is
  'One row per bulk send: the queue and the history in one table, copied from report_runs (0122) for the reason its own header gives -- a finished run is a queued run with an outcome, and "is it ready?" and "what did I send last month?" are one query against one table. Carries the Station, the send list (0238) it was snapshotted from, the channel and template it sends through, its status (campaign_status, 0241), the four running counters an operator reads on the history grid, who created it, and section 10''s cancellation trio. No deleted_at: unlike a send list, a campaign''s history is not archived away -- it outlives everything it describes, the same guarantee report_runs states for itself.';

comment on column public.message_campaigns.list_id is
  'The send list (0238) this campaign was snapshotted from at creation (Task 3). A LIVING list keeps changing after and a FIXED one may be archived; this campaign''s recipients follow neither -- they are message_campaign_recipients rows, already resolved.';

comment on column public.message_campaigns.channel is
  'WHATSAPP or EMAIL (message_channel, 0222). Must agree with template_id''s own channel -- 29b-1''s design D1 records why a campaign points at one template rather than one per channel. Enforcing the agreement is create_campaign''s (0243) job: a single CHECK here cannot read another table''s column.';

comment on column public.message_campaigns.template_id is
  'The registered template (message_templates, 0110/0222) this campaign sends. Per spec section 6, a WhatsApp campaign is refused at creation if the template is not Meta-registered; an e-mail campaign''s body is free within the frame. No ON DELETE: nothing in this project deletes a message_templates row (it is soft-deleted, deleted_at), so a campaign''s reference stays resolvable for as long as the campaign''s own history does.';

comment on column public.message_campaigns.total_recipients is
  'The snapshot size, written once by create_campaign (0243) and never revised after -- the denominator sent_count, failed_count and suppressed_count are read against on the history grid.';

comment on column public.message_campaigns.sent_count is
  'Recipients the drain (Task 6) has moved to sent. Incremented by the drain''s own settle write; this table never recomputes it from message_campaign_recipients.';

comment on column public.message_campaigns.failed_count is
  'Recipients the drain gave up on after the retry ladder ran out -- OUR problem. Kept apart from suppressed_count below by design: a counter that combined them would hide the one fact spec section 5 says an operator needs.';

comment on column public.message_campaigns.suppressed_count is
  'Recipients the drain refused to send to because consent was withdrawn between snapshot and send (spec D1) -- the listener''s choice, never retried, and never folded into failed_count.';

comment on column public.message_campaigns.cancelled_by is
  'Set together with cancelled_at by cancel_campaign (0243); message_campaigns_cancelled_shape requires both whenever status is cancelled. Null on every campaign nobody cancelled.';

comment on column public.message_campaigns.cancelled_at is
  'Set together with cancelled_by. See message_campaigns_cancelled_shape.';

comment on column public.message_campaigns.cancel_reason is
  'Free text from the operator who cancelled, optional -- cancel_campaign (0243) may be called with none, and message_campaigns_cancelled_shape does not require it.';

-- ---------------------------------------------------------------------------
-- 2. message_campaign_recipients -- the snapshot AND the queue.
--
-- message_campaign_recipients HOLDS A REAL PERSON'S PHONE NUMBER OR E-MAIL
-- ADDRESS AND THE VARIABLE VALUES RESOLVED FOR THEM, IN THE CLEAR. That is not
-- an oversight this migration leaves for later to notice: Task 8 (0245)
-- extends anonymize_member to clear address and variables on a listener's rows
-- here the moment they are erased, and wires the retention sweep to remove
-- rows of finished campaigns beyond its window, the same way it already
-- removes outbox_messages and unsubscribe_tokens. A reader who finds contact
-- details sitting in a queue table with no erasure path anywhere in this file
-- should conclude it was missed -- so this sentence says plainly that it is
-- not: 0245 is where it is paid.
-- ---------------------------------------------------------------------------
create table public.message_campaign_recipients (
  id                  uuid primary key default gen_random_uuid(),
  campaign_id         uuid not null references public.message_campaigns (id),
  member_id           uuid not null references public.members (id),

  channel             public.message_channel not null,

  -- NULLABLE, and only because Task 8's anonymize_member (0245) empties it on
  -- erasure. Unlike outbox_messages.to_phone (0059), which has no member_id to
  -- join erasure through and is only ever cleared by retention age, this table
  -- carries member_id (below) and erasure reaches a row here directly, at
  -- whatever status it holds, the moment the listener it names asks for it.
  address             text,
  -- The template variable values resolved for this recipient at snapshot
  -- time, positional in the same order as message_templates.variables (0222).
  -- Cleared alongside address by the same erasure, for the same reason: a
  -- listener's name and city are personal data too.
  --
  -- BUILT ONCE, AT SNAPSHOT, AND NEVER RE-ORDERED AFTER. A provider (Task 5)
  -- must send this array exactly as it stands and must never re-consult
  -- message_templates.variables' CURRENT order to interpret it: a template
  -- edited while a campaign is draining would then read this same array
  -- against a different position list and scramble values into the wrong
  -- slots, silently, because nothing about a jsonb array says which index
  -- used to mean what.
  variables           jsonb not null default '[]'::jsonb,

  status              public.campaign_recipient_status not null default 'pending',
  attempts            integer not null default 0 check (attempts >= 0),
  next_attempt_at     timestamptz not null default now(),
  claimed_at          timestamptz,

  provider_message_id text,
  error_code          text,
  error_description   text,

  -- CLAIMED is a claim about claimed_at, the same structural rule
  -- outbox_messages_claim_shape (0059) states for SENDING.
  constraint message_campaign_recipients_claim_shape check (
    status <> 'claimed' or claimed_at is not null
  ),

  -- SENT is a claim about provider_message_id, in both directions: every
  -- provider (Task 5) returns one on success and none on failure, so a sent
  -- row without it, or a non-sent row with one, is a settle write that lied.
  constraint message_campaign_recipients_sent_shape check (
    (status = 'sent' and provider_message_id is not null)
    or (status <> 'sent' and provider_message_id is null)
  ),

  -- FAILED says why, the same rule report_runs_failed_says_why (0122) states:
  -- every provider failure (Task 5's SendOutcome) carries a code, so a failed
  -- row with none is a settle write that dropped it. Deliberately not asked of
  -- SUPPRESSED: that path never reaches a provider at all (spec D1), so it has
  -- no taxonomy code to require.
  constraint message_campaign_recipients_failed_says_why check (
    status <> 'failed' or error_code is not null
  ),

  -- POSITIONAL, not keyed: 0222 states in capitals that a WhatsApp template's
  -- own variables is positional, index 0 is {{1}}, and this column's comment
  -- above says a recipient's resolved values are a parallel array in that
  -- same order. Prose said so and the column's own default, '{}'::jsonb, was
  -- an empty OBJECT -- the gap between a contract asserted in a comment and
  -- one the database actually holds. This CHECK is the difference.
  constraint message_campaign_recipients_variables_is_positional
    check (jsonb_typeof(variables) = 'array'),

  -- Two rows for the same listener in the same campaign means one listener
  -- receives the campaign twice. That is the complaint that costs a WhatsApp
  -- Business number its quality rating, which is exactly why this block's
  -- stated reason for existing is to check consent on every single row before
  -- sending: a listener sent twice is the same inbox complaint as one sent
  -- after they withdrew.
  constraint message_campaign_recipients_one_row_per_listener
    unique (campaign_id, member_id)
);

comment on table public.message_campaign_recipients is
  'One row per recipient of a campaign -- the snapshot AND the queue, the same row rather than two kept in agreement (see this file''s header). HOLDS A REAL PERSON''S PHONE NUMBER OR E-MAIL ADDRESS AND THEIR RESOLVED VARIABLE VALUES IN THE CLEAR: Task 8 (0245) extends anonymize_member to clear address and variables on a listener''s rows here, and wires the retention sweep to remove rows of finished campaigns beyond its window -- do not read the absence of either mechanism in THIS file as the obligation being skipped; it is paid in 0245. RLS is on with NO POLICY, the same shape send_list_members (0238) uses for its own table: nothing reads this as a user, and the doors (0243) and claim_campaign_batch (0244) reach it from inside a SECURITY DEFINER body, where RLS never applies. UNLIKE send_list_members, service_role DOES hold SELECT and UPDATE here (below) -- the drain (Task 6) settles a send''s outcome with a direct write after calling a provider, no RPC mediates that step, the same reason outbox_messages (0059) grants service_role that exact pair. Its default-ACL TRUNCATE is revoked below regardless: a queue that can be emptied by one statement is worse than a list that can.';

comment on column public.message_campaign_recipients.campaign_id is
  'The campaign this row belongs to. No ON DELETE behaviour: nothing in this project hard-deletes a message_campaigns row -- it outlives everything it describes, like report_runs -- so there is no cascade to reason about.';

comment on column public.message_campaign_recipients.member_id is
  'The listener this row was resolved for. This is the join outbox_messages (0059) never had, which is exactly why THAT table could only be pruned by retention age and never by erasure -- anonymize_member (0245) reaches these rows by this column directly, whatever their status.';

comment on column public.message_campaign_recipients.status is
  'pending, claimed, sent, failed, suppressed or cancelled (campaign_recipient_status, 0241). suppressed is never retried and never counted with failed -- see message_campaigns.suppressed_count.';

comment on column public.message_campaign_recipients.attempts is
  'Send attempts so far. The retry ladder itself (BACKOFF_SECONDS, MAX_ATTEMPTS) is reused from src/services/whatsapp.ts by the drain (Task 6), not restated here.';

comment on column public.message_campaign_recipients.next_attempt_at is
  'When this row becomes sendable again. What message_campaign_recipients_sendable_idx below is built on, the same shape outbox_messages_sendable (0059) uses for claim_outbox_batch.';

comment on column public.message_campaign_recipients.claimed_at is
  'Set by claim_campaign_batch (0244) in the same statement that marks a row claimed; message_campaign_recipients_claim_shape requires it whenever status is claimed. Also what a stale-claim reclaim compares against, the role outbox_messages.claimed_at (0059) plays for STALE_CLAIM.';

comment on column public.message_campaign_recipients.provider_message_id is
  'The id a provider (Task 5) returned on a successful send. message_campaign_recipients_sent_shape requires it exactly when status is sent and requires it absent at every other status.';

comment on column public.message_campaign_recipients.error_code is
  'The taxonomy code from a provider failure (SendOutcome, Task 5) -- graph.ts''s own retryable/permanent distinction, in this table''s terms. message_campaign_recipients_failed_says_why requires it whenever status is failed.';

comment on column public.message_campaign_recipients.error_description is
  'Human-readable detail beside error_code, for the history screen (Task 7) and for an operator asking why one recipient did not go out.';

-- ---------------------------------------------------------------------------
-- 3. The claim's partial index.
--
-- What claim_campaign_batch (0244) will scan -- ONE status, because that
-- function asks for one. claim_outbox_batch's own migration (0059) states the
-- warning this index repeats in campaign terms: a predicate naming a status
-- the claim can ALSO see -- here, `claimed`, the state an abandoned-but-not-
-- yet-reclaimed row sits in -- turns the index condition into a FILTER the
-- instant the claim's `status = 'pending'` stops matching the index exactly,
-- and the planner's choice of whether to use the index at all then depends on
-- how large the table has grown. That is how a claim silently stops using its
-- index rather than visibly failing to. `pending` is the only status a fresh,
-- sendable row holds, so it is the only one named here.
-- ---------------------------------------------------------------------------
create index message_campaign_recipients_sendable_idx
  on public.message_campaign_recipients (next_attempt_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 4. RLS.
-- ---------------------------------------------------------------------------

alter table public.message_campaigns enable row level security;
revoke all on public.message_campaigns from anon, authenticated;
grant select on public.message_campaigns to authenticated;

create policy message_campaigns_select_messaging_view on public.message_campaigns
  for select to authenticated
  using (public.has_permission('messaging.view', company_id));

comment on policy message_campaigns_select_messaging_view on public.message_campaigns is
  'has_permission already carries the platform-admin bypass (0121), so no separate is_platform_admin() check is needed here, the same shape send_lists_select_messaging_view (0238) uses. No deleted_at filter: a campaign''s history is not archived away the way a list is.';

-- SELECT accompanies UPDATE for the reason outbox_messages (0059) states:
-- PostgreSQL requires it for the WHERE clause of an UPDATE. No INSERT: the
-- only writer of a new row is create_campaign (0243), SECURITY DEFINER, run as
-- the owner. No DELETE: like report_runs, a campaign's row outlives everything
-- it describes.
grant select, update on public.message_campaigns to service_role;
revoke truncate on public.message_campaigns from service_role;

alter table public.message_campaign_recipients enable row level security;

-- NO POLICY, deliberately, the same shape send_list_members (0238) states for
-- its own table: nothing reads this as a user. The doors (0243) and
-- claim_campaign_batch (0244) reach it from inside a SECURITY DEFINER body,
-- where RLS never applies to begin with.
revoke all on public.message_campaign_recipients from anon, authenticated;

-- UNLIKE send_list_members, service_role DOES hold a grant here: the drain
-- (Task 6) settles a send's outcome -- status, attempts, next_attempt_at,
-- claimed_at, provider_message_id, the error pair -- with a direct write after
-- calling a provider, because no RPC mediates that step (Task 6's own
-- Interfaces list names none). outbox_messages (0059) grants service_role the
-- identical pair, select+update, for the identical reason. No INSERT:
-- create_campaign (0243) writes the snapshot as the owner. No DELETE: the
-- retention sweep (0245) removes rows itself as a SECURITY DEFINER
-- procedure and does not need the grant either.
grant select, update on public.message_campaign_recipients to service_role;

-- And TRUNCATE, which the default ACL hands out and which neither grant above
-- mentions -- 0238's own late fix (whole-branch review, F9) is exactly the
-- omission this line exists not to repeat: a queue that can be emptied by one
-- statement is worse than a list that can.
revoke truncate on public.message_campaign_recipients from service_role;
