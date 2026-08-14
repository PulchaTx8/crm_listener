begin;
select plan(5);

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

select * from finish();
rollback;
