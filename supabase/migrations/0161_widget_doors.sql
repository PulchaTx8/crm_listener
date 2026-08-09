-- supabase/migrations/0161_widget_doors.sql

-- Block 17a, spec §6. The verification code, and the four doors the widget
-- reaches the database through.
--
-- THE WIDGET SESSION IS THE SUBJECT, not a borrowed auth.uid(). This is the
-- same principle Block 15's D1 argued for the API key, and it is here for the
-- same reason: a visitor on a radio station's website is not a member of
-- anything, has no role, and must never appear on the Team screen.

create table public.widget_verifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  installation_id uuid not null references public.widget_installations (id) on delete cascade,
  -- Stored as given and normalised by the doors through normalize_phone (0031),
  -- so this can never disagree with members.phone_normalized, which is
  -- GENERATED from the same function.
  phone           text not null,
  code_hash       text not null,
  attempts        integer not null default 0,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  created_at      timestamptz not null default now(),

  constraint widget_verifications_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  -- The shape check that refuses a RAW code written where a digest belongs.
  -- A backstop, not a licence to relax the Node side: the code is hashed before
  -- it is passed, because an RPC argument lands in query logs and in backups --
  -- the rule the WhatsApp webhook already follows for the wamid.
  constraint widget_verifications_hash_shape
    check (code_hash ~ '^[0-9a-f]{64}$'),

  constraint widget_verifications_attempts_floor
    check (attempts >= 0)
);

create index widget_verifications_lookup_idx
  on public.widget_verifications (installation_id, phone, created_at desc);

comment on table public.widget_verifications is
  'One six-digit code sent to one telephone number for one installation. RLS on, no policy, reachable only from the SECURITY DEFINER doors below. Rows are not deleted on use -- consumed_at is stamped instead, so "was this number verified, and when" survives the session that used it. HOLDS A PHONE NUMBER, so sweep_retention (0131) is extended to delete it at 30 days: design D5 rejected a session table precisely because it would carry a retention obligation, and this table carrying one unswept would be that same hole with a different name.';

alter table public.widget_verifications enable row level security;
revoke all on public.widget_verifications from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Door 1: what the Edge middleware asks before it renders the page.
--
-- GRANTED TO anon, which is the first SECURITY DEFINER body in this schema that
-- is. It is written to the standard that implies: it takes a public key and it
-- returns an origin list and a boolean. No Station name, no id, no count, no
-- error that distinguishes the three ways of not existing. What somebody can
-- learn by guessing keys is which keys exist -- which is exactly what a key in
-- an iframe src already tells them.
-- ---------------------------------------------------------------------------
create function public.widget_frame_context(p_public_key text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select jsonb_build_object(
              'found', true,
              'origins', to_jsonb(w.allowed_origins))
       from public.widget_installations w
      where w.public_key = p_public_key
        and w.enabled
        and w.deleted_at is null),
    jsonb_build_object('found', false, 'origins', '[]'::jsonb));
$$;

revoke execute on function public.widget_frame_context(text) from public;
grant execute on function public.widget_frame_context(text) to anon, service_role;

comment on function public.widget_frame_context(text) is
  'The origins one installation may be framed by, for the Edge middleware to build frame-ancestors from. Answers {"found": false, "origins": []} for an unknown key, a disabled installation and an archived one alike -- one answer for three causes, so probing learns nothing, and so the caller has exactly one refusal branch to get right. GRANTED TO anon deliberately (spec §4.3): the middleware holds the anon key and runs before any session exists.';

-- ---------------------------------------------------------------------------
-- The retention sweep, extended for one more table.
--
-- create or replace, IN A NEW FILE, because both 0131 and 0133 are shipped and
-- migrations are append-only.
--
-- REPRODUCES 0133, NOT 0131. 0131 is the procedure's original shape, but 0133
-- (Block 11b, D5) already replaced it once, wrapping every delete with
-- job_started/job_succeeded stamps into job_health and a v_counters jsonb
-- instead of a Postgres log nobody read. That is the version live before this
-- migration runs, and the one this file must extend -- reproducing 0131's
-- `raise notice` body instead would silently drop the job_health stamp, which
-- is exactly the kind of regression tests/isolation/job-health.test.ts exists
-- to catch (it calls this procedure for real and asserts the exact set of
-- counter keys, which is why that file gains `widget_verifications` in the
-- same commit as this one).
--
-- NEITHER `security definer` NOR `set search_path`: Postgres refuses
-- transaction control (the `commit` below) inside either, so every reference
-- here is schema-qualified by hand instead.
--
-- NO EXCEPTION HANDLER: a PL/pgSQL block with one opens a subtransaction, and a
-- `commit` inside a subtransaction raises "cannot commit while a
-- subtransaction is active". 0131's header records that a version WITH
-- handlers deleted nothing at all, every night, silently. Dropping them means a
-- failing table aborts the ones after it until tomorrow rather than every
-- table waiting for ever.
--
-- The cron.schedule call is NOT repeated: the job already exists and points at
-- this procedure by name, so replacing the body is the whole change.
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
  -- (8, below) is the exception -- it is 30 days for LAW, not size.
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
  'Requirement N7. Deletes data whose retention period has expired: webhook_events at 90 days (Meta''s raw payload, the most sensitive thing this installation stores), outbox_messages and whatsapp_conversations at 180, contact_requests at 365, widget_verifications (Block 17a, a telephone number typed on a Station''s website) and three operational tables at 30. Commits per table so one failure does not roll back the rest, every night, for ever. DOES NOT TOUCH audit_logs -- kept for ever, because it is the proof that erasures happened -- nor any business record: those are what a radio must prove afterwards, and personal data inside them is removed by anonymize_member (0034), which is subject-driven rather than age-driven. Block 11b: reports what it deleted into job_health instead of into a Postgres log nobody reads.';
