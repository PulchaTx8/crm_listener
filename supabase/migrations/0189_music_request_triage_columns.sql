-- supabase/migrations/0189_music_request_triage_columns.sql

-- Block 22, Task 1: a request stops being only a fact.
--
-- THIS REVERSES 0098 ON PURPOSE. That migration's table comment says, in as
-- many words, "No status column, deliberately (D5) ... PENDING -> PLAYED would
-- force Block 8 to choose between counting requests and counting plays". The
-- reasoning was sound; its conclusion is now wrong, because the owner has asked
-- for the studio queue it declined to build. The fear it names is answered
-- rather than ignored: no aggregate in this database learns the word PLAYED in
-- this block, so every figure Block 8 reports keeps its present value. The
-- comment on the table is amended below rather than left contradicting the
-- columns beside it.
--
-- THE STAMPS ARE THE TRUTH; THE STATUSES ARE DERIVED (design D1). A hand-written
-- enum column beside a timestamp is two places for one fact, and the day a new
-- door writes one and forgets the other, the database accepts a row that says
-- PLAYED over an empty played_at and nothing complains. GENERATED ALWAYS makes
-- that state unrepresentable, and costs nothing at read time: STORED columns
-- filter and index exactly like ordinary ones.

create type public.music_request_read_status as enum ('UNREAD', 'READ', 'CANCELLED');
create type public.music_request_play_status as enum ('NOT_PLAYED', 'PLAYED', 'CANCELLED');

comment on type public.music_request_read_status is
  'Whether a request has been read out. Derived from read_at and cancelled_at by music_requests.read_status -- never written directly.';
comment on type public.music_request_play_status is
  'Whether the song asked for has gone to air. Derived from played_at and cancelled_at by music_requests.play_status -- never written directly.';

-- ADDING A STORED GENERATED COLUMN REWRITES THE TABLE under ACCESS EXCLUSIVE.
-- Said out loud because it is a lock, not a footnote: at today's volume this is
-- a fraction of a second, and it would not be after Block 9 imports a legacy
-- acervo. That is an argument for this migration landing before that block, not
-- for a weaker design.
alter table public.music_requests
  add column read_at      timestamptz,
  add column read_by      uuid references auth.users (id),
  add column played_at    timestamptz,
  add column played_by    uuid references auth.users (id),
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references auth.users (id),
  add column read_status public.music_request_read_status
    generated always as (
      case
        when cancelled_at is not null then 'CANCELLED'::public.music_request_read_status
        when read_at      is not null then 'READ'::public.music_request_read_status
        else 'UNREAD'::public.music_request_read_status
      end
    ) stored,
  add column play_status public.music_request_play_status
    generated always as (
      case
        when cancelled_at is not null then 'CANCELLED'::public.music_request_play_status
        when played_at    is not null then 'PLAYED'::public.music_request_play_status
        else 'NOT_PLAYED'::public.music_request_play_status
      end
    ) stored;

comment on column public.music_requests.read_at is
  'When somebody read this request out. Null means nobody has. The first stamp survives a second mark (0190''s doors are idempotent).';
comment on column public.music_requests.played_at is
  'When the song asked for went to air. Independent of read_at: marking a request played does not require it to have been read first, because two people do those two jobs and sometimes in either order.';
comment on column public.music_requests.cancelled_at is
  'When the request was called off. Outranks the other two stamps in both derivations, which is why cancel_music_request (0190) refuses a request that has already played -- cancelling it would erase a play that really happened.';

-- Every row that already exists reads UNREAD / NOT_PLAYED, which is true of
-- them: nobody has attended anything yet.

-- The filter the studio always has on. The text orderings 0191 adds (song,
-- artist, programme) sort over a join and this index does not serve them --
-- accepted rather than papered over, because those orderings are bounded by a
-- limit (design D7) and the sort is over a small set.
create index music_requests_company_status_idx
  on public.music_requests (company_id, read_status, play_status, requested_at desc)
  where deleted_at is null;

comment on table public.music_requests is
  'What a listener asked for, when, and what has since been done about it. 0098 shipped this table with no status column and argued the case in writing; Block 22 reverses that decision at the owner''s request and answers its fear rather than ignoring it -- the dashboards still count requests, so no figure anybody reads changes value. The state is three timestamps (read_at, played_at, cancelled_at); read_status and play_status are GENERATED from them, so a status can never disagree with its own stamp. deleted_at still exists for one purpose only: a mistyped manual entry, withdrawn through archive_music_request.';
