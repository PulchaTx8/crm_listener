begin;
select plan(9);

-- Block 14. The bucket is the barrier no client goes around, and the policies
-- are what decide who writes. Asserted because configuration nobody asserts
-- returns to its default on the next `db reset` -- invisibly, because an upload
-- simply starts succeeding again.

select is(
  (select public from storage.buckets where id = 'artwork'),
  true,
  'the artwork bucket is public, because Meta fetches the banner itself');

select is(
  (select file_size_limit from storage.buckets where id = 'artwork'),
  5242880::bigint,
  'an image may be five megabytes at most, which is Meta''s number');

select is(
  (select allowed_mime_types from storage.buckets where id = 'artwork'),
  array['image/jpeg', 'image/png'],
  'JPEG and PNG, which is the whole of what an image message accepts');

select ok(
  not ((select allowed_mime_types from storage.buckets where id = 'artwork')
    && array['text/html', 'image/svg+xml', 'application/octet-stream']),
  'and never anything a browser would run');

-- The delivery receipt does not move. Asserted here rather than trusted,
-- because "make the images public" is the kind of change that takes a
-- neighbouring bucket with it.
select is(
  (select public from storage.buckets where id = 'delivery-receipts'),
  false,
  'the delivery receipt stays private, for 0086''s reason');

-- may_write_artwork, with no session: has_permission answers false for every
-- Station when there is no caller, so every branch below refuses. What is being
-- proved is the SHAPE -- that a malformed path is REFUSED rather than raising
-- 22P02, which is what 0086's unguarded cast does, and that an unknown prefix
-- is refused rather than allowed by omission.
select is(
  public.may_write_artwork('promotion-banners/not-a-uuid/abc'),
  false,
  'a path whose Station segment is not a uuid is refused, not an error');

select is(
  public.may_write_artwork('somewhere-else/11111111-1111-1111-1111-111111111111/abc'),
  false,
  'an unknown prefix is refused rather than allowed by omission');

select is(
  public.may_write_artwork('abc'),
  false,
  'a path with no folders at all is refused');

select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('artwork_insert', 'artwork_update')),
  2::bigint,
  'both write policies exist, because an upsert needs INSERT and UPDATE');

select * from finish();
rollback;
