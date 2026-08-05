-- supabase/migrations/0122_report_runs.sql

-- Block 8b, Task 3: one table, which is both the queue and the history.
--
-- THE NAME. The master spec §11 calls this `saved_reports`. It is deliberately
-- not called that: the owner ruled that what gets saved is the record of a
-- GENERATION -- who asked for what, when, and where the file went -- and not a
-- named, re-runnable filter definition. A table called "saved reports" holding
-- a work queue misleads every future reader about what it is for. §11's term
-- maps to this table and to nothing else.
--
-- QUEUE AND HISTORY TOGETHER, rather than a jobs table draining into an
-- archive. A finished run is exactly a queued run with an outcome, and the two
-- questions an operator asks -- "is it ready?" and "what did I export last
-- month?" -- are one query against one table. Splitting them would mean a
-- migration between two shapes at the moment of completion, which is one more
-- place for a run to be lost.

create type public.report_type as enum (
  'LISTENERS',
  'PARTICIPATIONS',
  'WINNERS',
  'MUSIC_REQUESTS',
  'MOVEMENTS',
  'AUDIENCE_PANEL',
  'MUSIC_PANEL',
  'PROMOTIONS_PANEL'
);

create type public.report_format as enum ('CSV', 'XLSX', 'PDF');

create type public.report_status as enum ('QUEUED', 'RUNNING', 'READY', 'FAILED');

create table public.report_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id),
  company_ids      uuid[] not null,
  requested_by     uuid not null references auth.users (id),
  report_type      public.report_type not null,
  format           public.report_format not null,
  filters          jsonb not null default '{}'::jsonb,
  payload          jsonb,
  status           public.report_status not null default 'QUEUED',
  storage_path     text,
  row_count        integer,
  byte_size        integer,
  withheld         text[] not null default '{}',
  attempts         integer not null default 0,
  last_error       text,
  requested_at     timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  expires_at       timestamptz,

  constraint report_runs_companies_not_empty
    check (cardinality(company_ids) > 0),

  -- The per-type filter shape is Zod's job at the boundary, and the page
  -- functions read only the keys they know. A CHECK cannot express eight
  -- different filter shapes, and pretending otherwise would put half a
  -- validator in SQL where nobody would think to look for it.
  constraint report_runs_filters_is_object
    check (jsonb_typeof(filters) = 'object'),

  -- A panel's numbers are captured at request time, as the caller (design D2),
  -- because the three aggregates are SECURITY INVOKER and granted to
  -- authenticated only -- the worker cannot call them at all. A panel run with
  -- no payload is therefore unrenderable, and this refuses it at the insert
  -- rather than ten seconds later inside the tick.
  constraint report_runs_panel_carries_payload
    check (
      (report_type in ('AUDIENCE_PANEL', 'MUSIC_PANEL', 'PROMOTIONS_PANEL'))
        = (payload is not null)
    ),

  -- Panels render to PDF; listings render to a spreadsheet. Neither direction
  -- is meaningful reversed: a PDF of forty thousand participations is not a
  -- report, and a panel in CSV is three numbers in a grid.
  constraint report_runs_format_matches_type
    check (
      case
        when report_type in ('AUDIENCE_PANEL', 'MUSIC_PANEL', 'PROMOTIONS_PANEL')
          then format = 'PDF'
        else format in ('CSV', 'XLSX')
      end
    ),

  -- READY means there is a file. The three fields arrive together or the run is
  -- not READY, so no screen has to handle a ready run with nothing to show.
  constraint report_runs_ready_has_a_file
    check (
      status <> 'READY'
      or (storage_path is not null and row_count is not null and expires_at is not null)
    ),

  constraint report_runs_failed_says_why
    check (status <> 'FAILED' or last_error is not null)
);

-- The claim path (0127). Partial, because QUEUED rows are a vanishing fraction
-- of this table after a month of use and the tick reads it every ten seconds.
create index report_runs_claimable_idx
  on public.report_runs (requested_at)
  where status = 'QUEUED';

-- The stall sweep reads RUNNING rows by age.
create index report_runs_running_idx
  on public.report_runs (started_at)
  where status = 'RUNNING';

-- The /reports screen: one requester's runs, newest first.
create index report_runs_requester_idx
  on public.report_runs (requested_by, requested_at desc);

-- The expiry sweep (0128). Partial on the file still existing, because a run
-- whose bytes are already gone is never a candidate again.
create index report_runs_expiring_idx
  on public.report_runs (expires_at)
  where storage_path is not null;

comment on table public.report_runs is
  'Every report ever asked for: the queue and the history in one table. §11 calls this saved_reports; it is not named that because what is saved is the record of a generation, not a re-runnable filter definition. A row OUTLIVES ITS FILE -- the file expires after seven days (0128) and the row does not -- because "who exported which personal data, when" is the audit record this block contributes, and it must not expire with the bytes.';

comment on column public.report_runs.payload is
  'The captured aggregate for a panel run; null for a listing. Design D2: the worker cannot call get_*_dashboard (SECURITY INVOKER, granted to authenticated only, and auth.uid() is null in a service_role client), so a panel''s numbers are computed at request time by the same call the screen makes, under the requester''s own rights, and the worker only renders them.';

comment on column public.report_runs.withheld is
  'Columns omitted from the file because the requester''s permissions did not carry them, named so the file itself can say so (design D7). Absent, never blank: an empty phone column is a false statement about people, where a missing one is only a missing one.';

comment on column public.report_runs.attempts is
  'Deliberately UNLIKE storage_erasure_queue (0087), which has no give-up threshold because a silently abandoned erasure is a legal obligation dropped. A report is the opposite: after three attempts the run is FAILED with the error on the operator''s own screen and they ask again, because a queue that retries for ever hides the defect behind a row that is always about to succeed.';

comment on column public.report_runs.expires_at is
  'Seven days from finished_at, set on success. The clock starts when the file EXISTS, not when it was asked for, so a run that sat in the queue does not arrive already half-expired.';

-- ---------------------------------------------------------------------------
-- RLS. A run is readable by the person who asked for it and by the
-- Organization's owner -- who is accountable for what leaves the installation,
-- and is the one person who should be able to see that a report of forty
-- thousand listeners was exported on Tuesday.
--
-- NO WRITE POLICY OF ANY KIND. Every transition is an RPC (0127) running as
-- service_role. A client that could update this table could set status = READY
-- and point storage_path at another Station's object, which the bucket policy
-- (0123) would then happily sign.
-- ---------------------------------------------------------------------------

alter table public.report_runs enable row level security;

revoke all on public.report_runs from anon, authenticated;
grant select on public.report_runs to authenticated;
grant select, insert, update, delete on public.report_runs to service_role;

create policy report_runs_read_own on public.report_runs
  for select to authenticated
  using (
    requested_by = auth.uid()
    or public.is_owner(organization_id)
    or public.is_platform_admin()
  );

comment on policy report_runs_read_own on public.report_runs is
  'The requester, the Organization''s owner, and the platform admin. Not "anybody in the Station": a report is a thing a named person asked for, and its history is about them.';
