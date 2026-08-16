begin;
select plan(11);

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

select * from finish();
rollback;
