begin;
select plan(15);

-- Block 27. The structure of the card and its one door.
--
-- Every cross-Station claim and the upsert itself are in
-- tests/isolation/song-integrations.test.ts, for the reason every file in this
-- directory gives: this session is superuser with a null auth.uid(), where RLS
-- never applies and has_permission has no actor to resolve.

select has_table('public', 'song_integrations', 'the card table exists');
select has_column('public', 'song_integrations', 'code',
                  'keyed by the customer''s own code');
select has_column('public', 'song_integrations', 'category_name',
                  'their word for the category, not ours');

-- LIVE rows only, so a retired card's code can be registered again — and so the
-- door's `on conflict ... where deleted_at is null` has a partial index to
-- infer. Widening this to a plain unique would compile and would quietly change
-- what re-registration does.
select has_index('public', 'song_integrations', 'song_integrations_code_live',
                 'one live card per code per Station');

-- The two columns that must not be confused, asserted side by side because the
-- confusion is the whole reason 0207 named its key `code`.
select has_column('public', 'songs', 'internal_code',
                  'the integration code keeps its own column name');
select has_column('public', 'songs', 'external_id',
                  'and 0150''s API-intake key is untouched beside it');

-- The door -----------------------------------------------------------------

select has_function('public', 'save_song_integration',
                    array['uuid', 'text', 'text', 'text', 'text'],
                    'the one door exists');
select ok(
  has_function_privilege('authenticated', 'public.save_song_integration(uuid,text,text,text,text)', 'execute'),
  'a member may write a card');
-- `revoke ... from public` is what makes this false; without it the default ACL
-- would leave every role holding execute, anon included.
select ok(
  not has_function_privilege('anon', 'public.save_song_integration(uuid,text,text,text,text)', 'execute'),
  'anon may not');

-- RLS ------------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.song_integrations'::regclass),
  'row level security is on');
select ok(
  not has_table_privilege('authenticated', 'public.song_integrations', 'insert'),
  'and the door is the only way in');

-- 0208 — the column the card is matched against ------------------------------
--
-- The field moved to the Integration tab, so the Song data form stopped
-- carrying it — and an update RPC that still TOOK it would read "not carried"
-- and "cleared" as the same payload, erasing a song's integration code on every
-- ordinary save. That is 0102's defect one column over, and it gets 0102's fix:
-- the parameter is gone, and a door that writes one column takes its place.
--
-- These four assertions are the whole of that fix, and the first two are the
-- ones that would catch somebody "restoring" the parameter for convenience.

select has_function('public', 'set_song_integration_code', array['uuid', 'text'],
                    'the one door onto songs.internal_code exists');
select hasnt_function('public', 'update_song',
                      array['uuid', 'text', 'uuid', 'uuid', 'uuid',
                            'music_nationality', 'music_vocal', 'integer',
                            'text', 'uuid', 'text', 'uuid'],
                      'and update_song no longer takes an internal code');

select ok(
  has_function_privilege('authenticated', 'public.set_song_integration_code(uuid,text)', 'execute'),
  'a member may point a song at a code');
select ok(
  not has_function_privilege('anon', 'public.set_song_integration_code(uuid,text)', 'execute'),
  'anon may not');

select * from finish();
rollback;
