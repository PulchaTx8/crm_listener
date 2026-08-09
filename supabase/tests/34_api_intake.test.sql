begin;
select plan(4);

-- Block 15. What the two API endpoints write, and the two facts that make a
-- retry harmless.

select has_column('public', 'songs', 'external_id',
  'a song can carry the calling system''s own key');
select has_column('public', 'music_requests', 'external_id',
  'and so can a request, so a retry is not a second request');

-- Design D5: this is NOT legacy_id. Block 9's ETL owns that column, and two
-- sources sharing one unique index would collide on values that mean different
-- things -- surfacing to an integrator as "this song already exists" about a
-- record that has nothing to do with theirs.
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'songs'
      and column_name in ('legacy_id', 'external_id')),
  2::bigint, 'external_id lives beside legacy_id, not instead of it');

-- 0098 predicted this value and reserved WHATSAPP for a different caller.
select is(
  (select count(*) from pg_enum e
     join pg_type t on t.oid = e.enumtypid
    where t.typname = 'music_request_channel' and e.enumlabel = 'API'),
  1::bigint, 'a request can say it arrived over the API');

select * from finish();
rollback;
