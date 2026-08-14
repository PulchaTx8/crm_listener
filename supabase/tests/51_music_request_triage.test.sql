begin;
select plan(15);

-- Block 22, Task 1. The stamps are the truth and the two statuses are derived
-- from them by Postgres (D1), so this file proves the derivation rather than
-- trusting a door to keep two columns in step.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000022f1', 'Org 22 triage');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-0000000022f1',
   'Station 22 triage', 'America/Sao_Paulo');
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', 'Elis Regina');
insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-0000000022d1', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', 'Aguas de Marco',
   '00000000-0000-0000-0000-0000000022b1');
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000022e1', '00000000-0000-0000-0000-0000000022f1',
   'Carla Ouvinte', '+5511988887777');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000022e1', '00000000-0000-0000-0000-0000000022c1',
   '00000000-0000-0000-0000-0000000022f1');
insert into public.music_requests
  (id, organization_id, company_id, member_id, song_id, channel)
values
  ('00000000-0000-0000-0000-00000000221a', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-0000000022e1',
   '00000000-0000-0000-0000-0000000022d1', 'MANUAL');

-- 1-2: a request that nobody has touched.
select is(
  (select read_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221a'),
  'UNREAD', 'a fresh request is UNREAD');
select is(
  (select play_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221a'),
  'NOT_PLAYED', 'a fresh request is NOT_PLAYED');

-- 3: the stamps decide, and nothing else can be written -- the columns are
-- GENERATED, so there is no second value for a door to forget.
update public.music_requests
   set read_at = now(), played_at = now()
 where id = '00000000-0000-0000-0000-00000000221a';
select is(
  (select read_status::text || '/' || play_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221a'),
  'READ/PLAYED', 'the two statuses follow their own stamps');

-- 4: refused, not merely unnecessary. A BEFORE UPDATE trigger keeping a
-- hand-written status column in step could never offer this -- it is the one
-- behaviour that tells GENERATED ALWAYS apart from that alternative, the one
-- D1 rejected, and every assertion above would still pass against it.
-- 428C9 is Postgres' own SQLSTATE for generated_always, confirmed by running
-- the statement rather than assumed from memory.
select throws_ok($$
  update public.music_requests set read_status = 'READ'
    where id = '00000000-0000-0000-0000-00000000221a'
$$, '428C9', null, 'a direct write to a generated column is refused outright');

-- 5: cancellation outranks both (D2), which is why cancel_music_request
-- refuses a played request -- see Task 2.
update public.music_requests
   set cancelled_at = now()
 where id = '00000000-0000-0000-0000-00000000221a';
select is(
  (select read_status::text || '/' || play_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221a'),
  'CANCELLED/CANCELLED', 'a cancelled request reads CANCELLED on both sides');

-- ---------------------------------------------------------------------------
-- Block 22, Task 2. The doors.
-- ---------------------------------------------------------------------------

-- Undo Task 1's direct stamps so the doors act on a fresh request.
update public.music_requests
   set read_at = null, played_at = null, cancelled_at = null
 where id = '00000000-0000-0000-0000-00000000221a';

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000022c2', '00000000-0000-0000-0000-0000000022f1',
   'Station 22 elsewhere', 'America/Sao_Paulo');

-- The attendant: participations.view (the code D5 gates the three writers on)
-- and music.view, plus members.view so the reveal door can be proved here.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000022a1', '00000000-0000-0000-0000-0000000022f1',
   'Attendant 22');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000022a1', 'music.view'),
  ('00000000-0000-0000-0000-0000000022a1', 'participations.view'),
  ('00000000-0000-0000-0000-0000000022a1', 'members.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000022a2', 'attendant-22@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000022a2', '00000000-0000-0000-0000-0000000022c1',
   '00000000-0000-0000-0000-0000000022f1', '00000000-0000-0000-0000-0000000022a1');

-- The onlooker: music.view alone. Sees the list, attends nothing, and must not
-- learn a telephone number.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000022a3', '00000000-0000-0000-0000-0000000022f1',
   'Onlooker 22');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000022a3', 'music.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000022a4', 'onlooker-22@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000022a4', '00000000-0000-0000-0000-0000000022c1',
   '00000000-0000-0000-0000-0000000022f1', '00000000-0000-0000-0000-0000000022a3');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 6: the read mark lands.
select lives_ok($$
  select public.mark_music_request_read('00000000-0000-0000-0000-00000000221a')
$$, 'mark_music_request_read stamps a request');
-- 7: and the derived status followed it.
select is(
  (select read_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221a'),
  'READ', 'the read mark shows in read_status');

-- 8: marking twice keeps the FIRST stamp (D4) and writes no second audit row.
-- Read as the superuser pgTAP connects as, deliberately (precedent:
-- 15_music_rpcs.test.sql:109-115) -- audit_logs' own select policies
-- (0006_rls_policies.sql, 0014_rls_1b.sql) admit only a platform admin or a
-- caller holding audit.view, and this attendant holds neither, so under
-- `authenticated` this count would read 0 regardless of whether the door
-- wrote the row -- the write happens either way, through the door's own
-- SECURITY DEFINER body.
select public.mark_music_request_read('00000000-0000-0000-0000-00000000221a');
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-00000000221a'
      and action = 'mark_music_request_read'),
  1, 'a second read mark is a no-op that writes no second audit row');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 9: played is independent of read -- no ordering is imposed (D3).
select lives_ok($$
  select public.mark_music_request_played('00000000-0000-0000-0000-00000000221a')
$$, 'mark_music_request_played stamps a request that was already read');

-- 10: cancelling a played request is refused (D2), because the derivation would
-- erase a play that really happened.
select throws_ok($$
  select public.cancel_music_request('00000000-0000-0000-0000-00000000221a')
$$, '22023', null, 'a request that has played cannot be cancelled');

-- 11: the reveal door returns the whole number to members.view.
select is(
  public.reveal_request_phone('00000000-0000-0000-0000-00000000221a'),
  '+5511988887777', 'reveal_request_phone returns the number to a caller holding members.view');

-- 12: and writes the audit row that is its entire reason to exist. Read as
-- the superuser for the same reason as assertion 8.
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-00000000221a'
      and action = 'reveal_request_phone'),
  1, 'a revealed telephone number leaves a trace');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a4", "role": "authenticated"}';

-- 13-14: music.view alone attends nothing and reveals nothing.
select throws_ok($$
  select public.mark_music_request_read('00000000-0000-0000-0000-00000000221a')
$$, '42501', null, 'music.view alone cannot mark a request read');
select throws_ok($$
  select public.reveal_request_phone('00000000-0000-0000-0000-00000000221a')
$$, '42501', null, 'music.view alone cannot reveal a telephone number');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 15: an id that names nothing answers exactly what an unreachable Station
-- answers -- permission before existence (0093's idiom).
select throws_ok($$
  select public.mark_music_request_read('00000000-0000-0000-0000-0000000000ff')
$$, '42501', null, 'an unknown request id is refused the way an unreachable one is');

reset role;

select * from finish();
rollback;
