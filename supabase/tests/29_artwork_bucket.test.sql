begin;
select plan(11);

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

-- THE POLICY NOBODY WOULD GUESS IS LOAD-BEARING, asserted so that tidying it
-- away as "the bucket is public, why would reads need a policy" breaks a test
-- rather than every upload.
--
-- storage-api sends a replacement as `insert ... on conflict do update`, and
-- PostgreSQL applies SELECT policies to that statement whether or not a row
-- actually conflicts. Without this, the FIRST upload of the FIRST picture fails
-- with 42501 naming the insert.
select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'artwork_read'),
  1::bigint,
  'and a SELECT policy, without which on-conflict refuses every upload');

-- The proof itself, rather than the policy's existence: the statement
-- storage-api actually sends, run as an authenticated caller with no
-- permission anywhere. It must fail on the WITH CHECK -- 42501 -- rather than
-- on the absence of a readable row, and it must fail for a caller who may not
-- write here at all.
set local role authenticated;
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('artwork', 'promotion-thumbs/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222')
    on conflict (bucket_id, name) do update set updated_at = now()$$,
  '42501', null,
  'a caller with no permission cannot upsert into the artwork bucket');
reset role;

select * from finish();
rollback;
