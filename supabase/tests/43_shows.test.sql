begin;
select plan(15);

-- Block 18. A programme with a schedule, a run of dates, and a way to end.
--
-- Two Stations in DIFFERENT TIMEZONES, and that is not decoration: assertion 12
-- is the one that catches a shows_on_air written against a bare now(), which
-- passes every test run in the afternoon and is wrong at 21:00.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000501', 'Org shows');

insert into public.companies (id, organization_id, name, timezone) values
  -- UTC+14 and UTC-11: 25 hours apart, so no instant exists at which the two
  -- agree about either the weekday or the hour.
  ('00000000-0000-0000-0000-000000000502', '00000000-0000-0000-0000-000000000501',
   'Station far east', 'Pacific/Kiritimati'),
  ('00000000-0000-0000-0000-000000000503', '00000000-0000-0000-0000-000000000501',
   'Station far west', 'Pacific/Niue');

-- A CALLER WITH music.manage ON BOTH STATIONS. save_show re-checks the
-- permission against auth.uid() inside its own body, so without this the four
-- refusals below would be answered by the permission gate (42501) rather than
-- by the validation they exist to test -- and the file would pass for the wrong
-- reason if it ever expected the wrong code.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000000504', '00000000-0000-0000-0000-000000000501', 'Shows Manager');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000000504', 'music.manage'),
  ('00000000-0000-0000-0000-000000000504', 'music.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000505', 'shows-probe@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000000505', '00000000-0000-0000-0000-000000000502',
   '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000504'),
  ('00000000-0000-0000-0000-000000000505', '00000000-0000-0000-0000-000000000503',
   '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000504');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000505", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- 1-4. What save_show refuses. D3 and D7's required set lives in the door, not
--      only on the screen -- the columns are nullable because four programmes
--      already exist in production carrying nothing but a name.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.save_show(
    '00000000-0000-0000-0000-000000000502', 'Sem tipo', null, 'L'::public.show_age_rating,
    '2026-01-01'::date, '[{"days":[1],"starts":"10:00","ends":"12:00"}]'::jsonb)
$$, '22023', null, 'a programme without a kind is refused');

select throws_ok($$
  select public.save_show(
    '00000000-0000-0000-0000-000000000502', 'Sem faixa', 'MUSICAL'::public.show_kind, null,
    '2026-01-01'::date, '[{"days":[1],"starts":"10:00","ends":"12:00"}]'::jsonb)
$$, '22023', null, 'a programme without an age rating is refused');

select throws_ok($$
  select public.save_show(
    '00000000-0000-0000-0000-000000000502', 'Sem inicio', 'MUSICAL'::public.show_kind,
    'L'::public.show_age_rating, null,
    '[{"days":[1],"starts":"10:00","ends":"12:00"}]'::jsonb)
$$, '22023', null, 'a programme without a start date is refused');

select throws_ok($$
  select public.save_show(
    '00000000-0000-0000-0000-000000000502', 'Sem grade', 'MUSICAL'::public.show_kind,
    'L'::public.show_age_rating, '2026-01-01'::date, '[]'::jsonb)
$$, '22023', null, 'a programme with no band at all is refused');

-- ---------------------------------------------------------------------------
-- 5. THE BAND MARKER. Five days typed as one band are five rows that still know
--    they were one -- without the marker, regrouping them for the screen is a
--    guess about whether the operator wrote one band or five.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.save_show(
    '00000000-0000-0000-0000-000000000502', 'Manha Total', 'MUSICAL'::public.show_kind,
    'L'::public.show_age_rating, current_date - 30,
    '[{"days":[1,2,3,4,5],"starts":"10:00","ends":"12:30"}]'::jsonb)
$$, 'a weekday band is saved');

select is(
  (select count(distinct band)::text || ':' || count(*)::text
     from public.show_schedules sc
     join public.shows s on s.id = sc.show_id
    where s.name = 'Manha Total'),
  '1:5', 'five days typed as one band are five rows sharing one marker');

-- ---------------------------------------------------------------------------
-- 6. THE ASSERTION THIS BLOCK IS BUILT AROUND. One of the four programmes in
--    production is called Madrugada Pulchá. A band from 23:00 to 02:00 ends
--    before it starts, and `time between start and end` returns nothing for it
--    -- the programme vanishes from "on air now" during exactly the hours it
--    airs. Split on write, so no future filter has to remember.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.save_show(
    '00000000-0000-0000-0000-000000000502', 'Madrugada', 'MUSICAL'::public.show_kind,
    '16'::public.show_age_rating, current_date - 30,
    '[{"days":[6],"starts":"23:00","ends":"02:00"}]'::jsonb)
$$, 'an overnight band is saved');

select is(
  (select string_agg(sc.weekday::text || '=' || sc.starts_at::text || '-' || sc.ends_at::text,
                     ' ' order by sc.weekday)
     from public.show_schedules sc
     join public.shows s on s.id = sc.show_id
    where s.name = 'Madrugada'),
  '6=23:00:00-24:00:00 7=00:00:00-02:00:00',
  'an overnight band becomes two rows, on the two days it actually covers');

select is(
  (select count(distinct band) from public.show_schedules sc
     join public.shows s on s.id = sc.show_id where s.name = 'Madrugada'),
  1::bigint, 'and both halves still remember they were typed as one band');

-- ---------------------------------------------------------------------------
-- 10. Saving again REPLACES the schedule rather than adding to it. A programme
--     edited from five days down to two must not end up airing on seven.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.save_show(
    '00000000-0000-0000-0000-000000000502', 'Manha Total', 'MUSICAL'::public.show_kind,
    'L'::public.show_age_rating, current_date - 30,
    '[{"days":[1,2],"starts":"09:00","ends":"11:00"}]'::jsonb,
    null, null, null, (select id from public.shows where name = 'Manha Total'))
$$, 'the same programme is saved again with a shorter week');

select is(
  (select count(*) from public.show_schedules sc
     join public.shows s on s.id = sc.show_id
    where s.name = 'Manha Total'),
  2::bigint, 'and its schedule was replaced, not added to');

-- ---------------------------------------------------------------------------
-- 11. THE TIMEZONE, AND THIS IS THE ASSERTION THAT DECIDES THE FUNCTION.
--
--     The two Stations are 25 hours apart, so no instant exists at which they
--     agree about the weekday and the hour. Each gets a programme whose band
--     covers ITS OWN local clock right now. A shows_on_air written against a
--     bare now() answers with the server's clock and gets exactly one of the
--     two wrong -- and which one depends on the hour the suite happens to run,
--     which is how this passes all afternoon and fails at 21:00.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.save_show(
    '00000000-0000-0000-0000-000000000502', 'Agora no leste', 'MUSICAL'::public.show_kind,
    'L'::public.show_age_rating, current_date - 30,
    jsonb_build_array(jsonb_build_object(
      'days',   jsonb_build_array(extract(isodow from (now() at time zone 'Pacific/Kiritimati'))::int),
      'starts', to_char((now() at time zone 'Pacific/Kiritimati') - interval '1 minute', 'HH24:MI'),
      'ends',   to_char((now() at time zone 'Pacific/Kiritimati') + interval '1 minute', 'HH24:MI'))));
  select public.save_show(
    '00000000-0000-0000-0000-000000000503', 'Agora no oeste', 'MUSICAL'::public.show_kind,
    'L'::public.show_age_rating, current_date - 30,
    jsonb_build_array(jsonb_build_object(
      'days',   jsonb_build_array(extract(isodow from (now() at time zone 'Pacific/Niue'))::int),
      'starts', to_char((now() at time zone 'Pacific/Niue') - interval '1 minute', 'HH24:MI'),
      'ends',   to_char((now() at time zone 'Pacific/Niue') + interval '1 minute', 'HH24:MI'))))
$$, 'each Station gets a programme covering its own local minute');

select is(
  (select array[
     (select count(*) from public.shows s where s.name = 'Agora no leste' and s.id = any(public.shows_on_air('00000000-0000-0000-0000-000000000502'))),
     (select count(*) from public.shows s where s.name = 'Agora no oeste' and s.id = any(public.shows_on_air('00000000-0000-0000-0000-000000000503')))]),
  array[1::bigint, 1::bigint],
  'both are on air, each answered in its own Station''s timezone');

-- ---------------------------------------------------------------------------
-- 12. Ending. The schedule is untouched and the past keeps reading; the
--     programme simply stops being on air.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.end_show(
    (select id from public.shows where name = 'Agora no leste'), current_date - 1)
$$, 'a programme is ended by date rather than deleted');

select is(
  (select count(*) from public.shows s where s.name = 'Agora no leste' and s.id = any(public.shows_on_air('00000000-0000-0000-0000-000000000502'))) || ':' ||
  (select count(*)::text from public.show_schedules sc
     join public.shows s on s.id = sc.show_id where s.name = 'Agora no leste'),
  '0:1', 'an ended programme leaves the air with its schedule intact');

select * from finish();
rollback;
