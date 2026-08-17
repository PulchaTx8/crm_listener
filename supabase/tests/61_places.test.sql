begin;
select plan(19);

-- Block 28. The place cache, its key, and its queue.
--
-- The key assertions below are THE OTHER HALF of
-- tests/unit/place-normalise.test.ts. Two languages compute this string —
-- normalisePlaceKey in TypeScript and member_place_key here — and nothing sees
-- both, so both are pinned to the same literals. A drift between them throws
-- nothing: every listener stops matching a place row, the map renders empty and
-- the coverage line says 0 of N. A bug with no error message is one that has to
-- be pinned rather than described.

-- The key ------------------------------------------------------------------

select is(public.member_place_key('BR', 'MA', 'São Luís', 'Cohab'),
          'c:br|s:ma|t:sao luis|n:cohab',
          'the key is exactly what normalisePlaceKey builds');
select is(public.member_place_key('BR', 'MA', 'São Luís', null),
          'c:br|s:ma|t:sao luis',
          'and a missing neighbourhood leaves no empty slot');

select is(public.member_place_key('br', 'ma', 'SAO LUIS', '  COHAB '),
          public.member_place_key('BR', 'MA', 'São Luís', 'Cohab'),
          'case, accents and surrounding space fold together');
select is(public.member_place_key('BR', 'MA', 'São  Luís', null),
          public.member_place_key('BR', 'MA', 'São Luís', null),
          'and so does a doubled inner space');

select is(public.member_place_key('BR', 'MA', 'São Luís', 'Bairro da Cohab'),
          public.member_place_key('BR', 'MA', 'São Luís', 'Cohab'),
          'the noise a person types in front of a name is dropped');
select isnt(public.member_place_key('BR', 'SP', 'Santos', 'Vila Nova'),
            public.member_place_key('BR', 'SP', 'Santos', 'Nova'),
            'but "Vila" is part of the name and is NOT dropped');

select isnt(public.member_place_key('BR', 'MA', null, null),
            public.member_place_key('BR', null, 'MA', null),
            'a state and a city of the same name do not collide — this is what the labels are for');
select is(public.member_place_key(null, null, null, null), '',
          'no place at all is the empty key, which is the signal callers filter on');

select is(public.member_place_key('BR', 'MA', 'São Luís', ''),
          public.member_place_key('BR', 'MA', 'São Luís', null),
          'a blank part and a missing one are the same place');

-- The table ------------------------------------------------------------------

select has_table('public', 'geocoded_places', 'the cache exists');
-- A unique INDEX rather than a unique constraint, so col_is_unique (which looks
-- for a constraint) is the wrong instrument. Proved by doing it: a second row
-- with the same key is refused, which is the property, not the mechanism.
select lives_ok(
  $$ insert into public.geocoded_places (place_key, city) values ('c:br|t:test', 'Test') $$,
  'a place can be registered');
select throws_ok(
  $$ insert into public.geocoded_places (place_key, city) values ('c:br|t:test', 'Test') $$,
  '23505',
  null,
  'and only once — the uniqueness IS the cache');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.geocoded_places'::regclass),
  'row level security is on');
select ok(
  has_table_privilege('authenticated', 'public.geocoded_places', 'select'),
  'a member may read places — the table carries no tenant and no personal data');
select ok(
  not has_table_privilege('authenticated', 'public.geocoded_places', 'insert'),
  'and may not write one: the worker''s doors are the only way in');
select ok(
  not has_table_privilege('anon', 'public.geocoded_places', 'select'),
  'and anon may read nothing');

-- A coordinate is both halves or neither, the pairing 0155 already makes for
-- companies. Half a coordinate puts a dot on the prime meridian.
select throws_ok(
  $$ insert into public.geocoded_places (place_key, latitude) values ('c:br', 1.0) $$,
  '23514',
  null,
  'half a coordinate is refused');

-- The doors --------------------------------------------------------------------
--
-- service_role and nobody else. These claim work and write verdicts; a signed-in
-- caller reaching them could empty the queue or plant coordinates.

select ok(
  not has_function_privilege('authenticated', 'public.claim_places_to_geocode(integer)', 'execute'),
  'a member may not claim geocoding work');
select ok(
  has_function_privilege('service_role', 'public.enqueue_missing_places(integer)', 'execute'),
  'and the worker may fill the queue');

select * from finish();
rollback;
