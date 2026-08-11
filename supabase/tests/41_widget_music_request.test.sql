begin;
select plan(17);

-- Block 17b. The two doors behind the widget's first button.
--
-- Fixtures follow 40_widget_verification.test.sql: one Organization, two
-- Stations with an installation each, and a listener linked to the FIRST one
-- only -- which is what makes the cross-Station assertion mean anything.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000301', 'Org widget music');

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000301',
   'Station widget music A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000301',
   'Station widget music B', 'America/Sao_Paulo');

insert into public.widget_installations
  (organization_id, company_id, public_key, enabled, allowed_origins)
values
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000302',
   'pw_musicstationa012345678', true, array['https://a.radio.com.br']),
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000303',
   'pw_musicstationb012345678', true, array['https://b.radio.com.br']);

insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000301',
   'Widget Listener', '+5511999997777');

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000302',
   '00000000-0000-0000-0000-000000000301');

-- ---------------------------------------------------------------------------
-- 1. A recording lands, and lands with the shape Block 17b promised.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.widget_record_music_request(
    'pw_musicstationa012345678', '00000000-0000-0000-0000-000000000304',
    3135556, 'Sozinho (Ao Vivo)', 'Caetano Veloso', 'Prenda Minha', 231,
    -- A REAL md5: albums_cover_md5_shape is ^[0-9a-f]{32}$, which is the shape
    -- Deezer's `md5_image` actually has. A short stand-in passes every test
    -- that never reaches the album insert.
    'BRXXX0000001', '0123456789abcdef0123456789abcdef', 302127, '0123456789012', 'Universal', 'MPB',
    '1998-01-01'::date, 'toca pra minha mae')
$$, 'a verified listener records a request');

select is(
  (select channel::text from public.music_requests
    where company_id = '00000000-0000-0000-0000-000000000302'
    order by created_at desc limit 1),
  'WEB', 'the request carries channel WEB');

select is(
  (select show_id from public.music_requests
    where company_id = '00000000-0000-0000-0000-000000000302'
    order by created_at desc limit 1),
  null, 'a web request carries no programme (D5)');

select is(
  (select listener_note from public.music_requests
    where company_id = '00000000-0000-0000-0000-000000000302'
    order by created_at desc limit 1),
  'toca pra minha mae', 'the note is stored');

-- 0129: a null actor does not mean "the system did it". A website visitor is
-- not an auth.users row and must not become one to give an insert a name.
select is(
  (select actor_id from public.audit_logs
    where action = 'widget_record_music_request'
    order by created_at desc limit 1),
  null, 'the audit row names no actor');

-- ---------------------------------------------------------------------------
-- 2. Zero is no ceiling at all (D2).
-- ---------------------------------------------------------------------------
select is(
  (select public.widget_record_music_request(
     'pw_musicstationa012345678', '00000000-0000-0000-0000-000000000304',
     3135557, 'Outra Cancao', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'ok'),
  'true', 'zero cooldown lets a listener ask again at once');

-- ---------------------------------------------------------------------------
-- 3. With an interval set, the next one is refused BY NAME and says how long.
-- ---------------------------------------------------------------------------
update public.widget_installations
   set music_request_cooldown = interval '30 minutes'
 where public_key = 'pw_musicstationa012345678';

select is(
  (select public.widget_record_music_request(
     'pw_musicstationa012345678', '00000000-0000-0000-0000-000000000304',
     3135558, 'Terceira', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'reason'),
  'cooldown', 'inside the interval it refuses by name');

select ok(
  ((select public.widget_music_request_wait(
      'pw_musicstationa012345678',
      '00000000-0000-0000-0000-000000000304') ->> 'wait_seconds')::integer)
    between 1 and 1800,
  'the read-only door says how many seconds are left');

-- ---------------------------------------------------------------------------
-- 4. THE BOUNDARY. This is the assertion that catches a `>` where a `>=`
--    belongs, and it is invisible to any test written with a comfortable gap.
-- ---------------------------------------------------------------------------
update public.music_requests
   set requested_at = now() - interval '30 minutes' - interval '1 second'
 where company_id = '00000000-0000-0000-0000-000000000302';

select is(
  (select public.widget_record_music_request(
     'pw_musicstationa012345678', '00000000-0000-0000-0000-000000000304',
     3135559, 'Quarta', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'ok'),
  'true', 'one second past the interval is allowed');

-- ---------------------------------------------------------------------------
-- 5. The cross-Station hole, which is the one this block could not survive.
-- ---------------------------------------------------------------------------
select is(
  (select public.widget_record_music_request(
     'pw_musicstationb012345678', '00000000-0000-0000-0000-000000000304',
     3135560, 'Quinta', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'reason'),
  'unknown_listener', 'a listener of another Station is refused');

select is(
  (select public.widget_record_music_request(
     'pw_nosuchmusickey0123456', '00000000-0000-0000-0000-000000000304',
     3135561, 'Sexta', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'reason'),
  'unknown_installation', 'an unknown key is refused');

-- ---------------------------------------------------------------------------
-- 6. 0034's erasure, and the note's ceiling.
-- ---------------------------------------------------------------------------
update public.members set anonymized_at = now()
 where id = '00000000-0000-0000-0000-000000000304';

select is(
  (select public.widget_record_music_request(
     'pw_musicstationa012345678', '00000000-0000-0000-0000-000000000304',
     3135562, 'Setima', 'Caetano Veloso', 'Prenda Minha', 200,
     null, null, 302127, null, null, null, null, null) ->> 'reason'),
  'listener_anonymized', 'an anonymised listener is refused');

update public.members set anonymized_at = null
 where id = '00000000-0000-0000-0000-000000000304';

select throws_ok($$
  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, channel, listener_note)
  values ('00000000-0000-0000-0000-000000000301',
          '00000000-0000-0000-0000-000000000302',
          '00000000-0000-0000-0000-000000000304',
          (select id from public.songs
            where company_id = '00000000-0000-0000-0000-000000000302' limit 1),
          'WEB', repeat('x', 501))
$$, '23514', null, 'a note over 500 characters is refused by the check');

-- ---------------------------------------------------------------------------
-- 7. The read-only door refuses a stranger rather than answering "go ahead".
-- ---------------------------------------------------------------------------
select is(
  (select public.widget_music_request_wait(
     'pw_musicstationb012345678',
     '00000000-0000-0000-0000-000000000304') ->> 'reason'),
  'unknown_listener', 'the wait door does not answer about another Station''s listener');

-- ---------------------------------------------------------------------------
-- Block 18. THE PROGRAMME A LISTENER NAMES, and the one they must not.
--
-- 17b wrote show_id as a literal null (D5) because a visitor had no way to know
-- a programme's name. Block 18 gives them a list, which makes the id the ONE
-- other thing a browser can send that names a row — so it is resolved against
-- the Station the key names rather than trusted.
-- ---------------------------------------------------------------------------
insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-000000000320', '00000000-0000-0000-0000-000000000301',
   '00000000-0000-0000-0000-000000000302', 'Programa da Station A'),
  -- The same Organization, the OTHER Station. This is the id a crafted payload
  -- would send, and it is reachable to the same listener's browser precisely
  -- because they belong to the group.
  ('00000000-0000-0000-0000-000000000321', '00000000-0000-0000-0000-000000000301',
   '00000000-0000-0000-0000-000000000303', 'Programa da Station B');

update public.widget_installations set music_request_cooldown = interval '0'
 where public_key = 'pw_musicstationa012345678';

-- CALL, THEN ASSERT, in separate statements. Every subquery in one SELECT sees
-- the same snapshot, so a read of the row the call just inserted returns
-- nothing -- the defect 42_widget_promotions already recorded once.
select public.widget_record_music_request(
  'pw_musicstationa012345678', '00000000-0000-0000-0000-000000000304',
  3135570, 'Com programa', 'Caetano Veloso', 'Prenda Minha', 200,
  null, null, 302127, null, null, null, null, null,
  '00000000-0000-0000-0000-000000000320');

select is(
  -- Found by the song it names, not by created_at: inside ONE transaction
  -- now() is constant, so every request here shares a timestamp and
  --  picks an arbitrary one. The earlier
  -- assertions in this file were passing on luck.
  (select mr.show_id from public.music_requests mr
     join public.songs sg on sg.id = mr.song_id
    where sg.title = 'Com programa'),
  '00000000-0000-0000-0000-000000000320'::uuid,
  'a programme of this Station is recorded on the request');

select public.widget_record_music_request(
  'pw_musicstationa012345678', '00000000-0000-0000-0000-000000000304',
  3135571, 'Programa alheio', 'Caetano Veloso', 'Prenda Minha', 200,
  null, null, 302127, null, null, null, null, null,
  '00000000-0000-0000-0000-000000000321');

select is(
  (select mr.show_id from public.music_requests mr
     join public.songs sg on sg.id = mr.song_id
    where sg.title = 'Programa alheio'),
  null,
  'another Station''s programme is dropped rather than written into this one');

select public.widget_record_music_request(
  'pw_musicstationa012345678', '00000000-0000-0000-0000-000000000304',
  3135572, 'Sem programa', 'Caetano Veloso', 'Prenda Minha', 200,
  null, null, 302127, null, null, null, null, null, null);

select is(
  (select mr.show_id from public.music_requests mr
     join public.songs sg on sg.id = mr.song_id
    where sg.title = 'Sem programa'),
  null, 'and naming none is still the ordinary case (D6)');

select * from finish();
rollback;
