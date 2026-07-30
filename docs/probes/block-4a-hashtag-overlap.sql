begin;

create extension if not exists btree_gist with schema extensions;

create table probe (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  hashtag      text,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  cancelled_at timestamptz,
  deleted_at   timestamptz,
  constraint probe_no_overlap exclude using gist (
    company_id with =,
    lower(hashtag) with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (deleted_at is null and cancelled_at is null and hashtag is not null)
);

\echo ''
\echo '=== 1. baseline (expect SUCCEED) ==='
insert into probe (company_id, hashtag, starts_at, ends_at)
values ('11111111-1111-1111-1111-111111111111', '#EUQUERO',
        '2026-08-01 00:00Z', '2026-08-31 00:00Z');

\echo ''
\echo '=== 2. overlapping, same hashtag, same Station (expect FAIL) ==='
savepoint s2;
insert into probe (company_id, hashtag, starts_at, ends_at)
values ('11111111-1111-1111-1111-111111111111', '#EUQUERO',
        '2026-08-15 00:00Z', '2026-09-15 00:00Z');
rollback to s2;

\echo ''
\echo '=== 3. same hashtag in different case, overlapping (expect FAIL) ==='
savepoint s3;
insert into probe (company_id, hashtag, starts_at, ends_at)
values ('11111111-1111-1111-1111-111111111111', '#euquero',
        '2026-08-15 00:00Z', '2026-09-15 00:00Z');
rollback to s3;

\echo ''
\echo '=== 4. TOUCHING window, same hashtag (expect SUCCEED) ==='
savepoint s4;
insert into probe (company_id, hashtag, starts_at, ends_at)
values ('11111111-1111-1111-1111-111111111111', '#EUQUERO',
        '2026-08-31 00:00Z', '2026-09-30 00:00Z');
release s4;

\echo ''
\echo '=== 5. overlapping, same hashtag, DIFFERENT Station (expect SUCCEED) ==='
savepoint s5;
insert into probe (company_id, hashtag, starts_at, ends_at)
values ('22222222-2222-2222-2222-222222222222', '#EUQUERO',
        '2026-08-15 00:00Z', '2026-09-15 00:00Z');
release s5;

\echo ''
\echo '=== 6. overlapping but the NEW one is cancelled (expect SUCCEED) ==='
savepoint s6;
insert into probe (company_id, hashtag, starts_at, ends_at, cancelled_at)
values ('11111111-1111-1111-1111-111111111111', '#EUQUERO',
        '2026-08-15 00:00Z', '2026-09-15 00:00Z', now());
release s6;

\echo ''
\echo '=== 7. cancel the live one, then reuse its exact window (expect SUCCEED) ==='
savepoint s7;
update probe set cancelled_at = now()
 where company_id = '11111111-1111-1111-1111-111111111111'
   and hashtag = '#EUQUERO' and cancelled_at is null
   and starts_at = '2026-08-01 00:00Z';
insert into probe (company_id, hashtag, starts_at, ends_at)
values ('11111111-1111-1111-1111-111111111111', '#EUQUERO',
        '2026-08-01 00:00Z', '2026-08-31 00:00Z');
\echo '--- now UN-cancel the old one: it would collide with the new (expect FAIL) ---'
savepoint s7b;
update probe set cancelled_at = null
 where company_id = '11111111-1111-1111-1111-111111111111'
   and hashtag = '#EUQUERO' and starts_at = '2026-08-01 00:00Z'
   and cancelled_at is not null;
rollback to s7b;
rollback to s7;

\echo ''
\echo '=== 8. archived (deleted_at set) does not block a new one (expect SUCCEED) ==='
savepoint s8;
update probe set deleted_at = now()
 where company_id = '11111111-1111-1111-1111-111111111111'
   and starts_at = '2026-08-01 00:00Z';
insert into probe (company_id, hashtag, starts_at, ends_at)
values ('11111111-1111-1111-1111-111111111111', '#EUQUERO',
        '2026-08-01 00:00Z', '2026-08-31 00:00Z');
rollback to s8;

\echo ''
\echo '=== 9. null hashtag never collides, whatever the window (expect SUCCEED twice) ==='
savepoint s9;
insert into probe (company_id, hashtag, starts_at, ends_at)
values ('11111111-1111-1111-1111-111111111111', null,
        '2026-08-05 00:00Z', '2026-08-20 00:00Z');
insert into probe (company_id, hashtag, starts_at, ends_at)
values ('11111111-1111-1111-1111-111111111111', null,
        '2026-08-06 00:00Z', '2026-08-21 00:00Z');
release s9;

\echo ''
\echo '=== surviving rows ==='
select left(company_id::text, 8) as station, coalesce(hashtag, '(null)') as hashtag,
       starts_at::date as starts, ends_at::date as ends,
       (cancelled_at is not null) as cancelled
from probe order by company_id, starts_at;

rollback;
