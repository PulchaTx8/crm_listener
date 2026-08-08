begin;
select plan(11);

-- The bucket behind the sign-in screen's picture. Asserted rather than trusted,
-- for 29's reason: configuration nobody asserts returns to its default on the
-- next `db reset`, invisibly, because the image simply starts working again.
--
-- What is different here, and what most of this file is about: THE READER HAS
-- NO SESSION. Every other bucket in this database is read by somebody who has
-- signed in. This one is read by somebody looking at the screen where they
-- sign in, so `anon` is the role that matters and `anon` is what is proved.

select is(
  (select public from storage.buckets where id = 'branding'),
  true,
  'the branding bucket is public, because its reader has not signed in yet');

select is(
  (select file_size_limit from storage.buckets where id = 'branding'),
  5242880::bigint,
  'five megabytes at most');

select is(
  (select allowed_mime_types from storage.buckets where id = 'branding'),
  array['image/png', 'image/jpeg', 'image/webp'],
  'PNG, JPEG and WebP');

select ok(
  not ((select allowed_mime_types from storage.buckets where id = 'branding')
    && array['text/html', 'image/svg+xml', 'application/octet-stream']),
  'and never anything a browser would run');

-- The delivery receipt does not move. 29 asserts this too, and it is repeated
-- rather than deduplicated on purpose: this file is the one that adds a SECOND
-- public bucket, so this file is where "make the images public" would take the
-- receipt with it.
select is(
  (select public from storage.buckets where id = 'delivery-receipts'),
  false,
  'the delivery receipt stays private, for 0086''s reason');

select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'branding_read'),
  1::bigint,
  'the read policy exists, without which the cache stamp cannot be read');

-- THE ABSENCE IS THE DESIGN, so the absence is asserted. Nothing subject to RLS
-- writes here -- the operator replaces the picture through the dashboard, as
-- service_role -- and a policy admitting `authenticated` would hand every
-- member of every Station the front door of the product, since this object
-- belongs to no tenant and its path carries no company id to scope against.
select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and cmd <> 'SELECT'
      and qual || coalesce(with_check, '') like '%branding%'),
  0::bigint,
  'and NO write policy mentions this bucket, which is the design, not an omission');

-- ---------------------------------------------------------------------------
-- The proofs themselves, run as the roles that actually arrive.
--
-- Two rows, in two buckets, so that what is proved is that the policy is SCOPED
-- rather than merely present: a policy written `using (true)` would pass an
-- "anon can read branding" assertion and hand anon every delivery receipt in
-- the database.
--
-- A PROBE NAME, NOT 'login-hero.png', AND NOT A ROW COUNT. This file first
-- inserted the real key and asserted `count(*) = 1`, which passed against an
-- empty bucket and failed the moment `npm run seed:branding` had been run on
-- the same database -- a unique-violation on the insert, and a plan that ran
-- seven of eleven. Whether a developer has seeded their own machine is not
-- something these assertions are entitled to have an opinion about, so nothing
-- below depends on what else the bucket holds.
insert into storage.objects (bucket_id, name)
values ('branding', 'pgtap-probe'),
       ('artwork', 'promotion-thumbs/11111111-1111-1111-1111-111111111111/pgtap-probe');

set local role anon;

select is(
  (select count(*) from storage.objects
    where bucket_id = 'branding' and name = 'pgtap-probe'),
  1::bigint,
  'a caller with no session can read a branding object, which is the point');

select is(
  (select count(*) from storage.objects where bucket_id = 'artwork'),
  0::bigint,
  'and sees nothing in the neighbouring bucket, so the policy is scoped');

select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('branding', 'pgtap-write-probe')$$,
  '42501', null,
  'a caller with no session cannot write here');

reset role;
set local role authenticated;

-- The one somebody would be tempted to add a policy for. An operator IS
-- authenticated, and replacing the picture IS something an operator does -- but
-- they do it through the dashboard, not through this database's RLS.
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('branding', 'pgtap-write-probe')$$,
  '42501', null,
  'and neither can a signed-in member, because no screen uploads this');

reset role;

select * from finish();
rollback;
