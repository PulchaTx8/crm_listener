begin;
select plan(10);

-- The bucket behind the sign-in screen's picture. Asserted rather than trusted,
-- for 29's reason: configuration nobody asserts returns to its default on the
-- next `db reset`, invisibly, because the image simply starts working again.
--
-- WHAT THIS FILE NO LONGER ASSERTS, AND WHY THAT IS THE POINT. It used to prove
-- that `anon` could read these rows, because the sign-in page read the object's
-- updated_at through storage.objects to build a cache stamp -- and rendered no
-- picture at all when that read came back empty. On the hosted project, where
-- the bucket had been made by hand and these migrations had never run, that is
-- exactly what happened. 0147 withdrew the policy and login-hero.ts now asks
-- the object's own public address instead, which consults no policy. So the
-- assertions below are about the bucket and about WRITES; reading is settled
-- over HTTP, by tests/e2e/login.spec.ts, which checks the picture actually
-- loaded rather than that a row was visible.

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

-- ---------------------------------------------------------------------------
-- NO POLICY AT ALL MENTIONS THIS BUCKET, and the absence is the design.
--
-- Writes: the operator replaces the picture through the dashboard, as
-- service_role. A policy admitting `authenticated` would hand every member of
-- every Station the front door of the product, since this object belongs to no
-- tenant and its path carries no company id to scope against.
--
-- Reads: withdrawn by 0147. The assertion is here so that "surely reading needs
-- a policy" cannot quietly put it back -- it would be dead grant, and the
-- feature that once depended on it is what broke because of that dependency.
select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'branding_read'),
  0::bigint,
  '0146''s read policy is gone, because nothing reads these rows any more');

select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and coalesce(qual, '') || coalesce(with_check, '') like '%branding%'),
  0::bigint,
  'and no policy of any kind names this bucket');

-- ---------------------------------------------------------------------------
-- The proofs themselves, run as the roles that actually arrive.
--
-- A PROBE NAME, NOT 'login-hero.png'. This file first inserted the real key,
-- which passed against an empty bucket and failed the moment
-- `npm run seed:branding` had been run on the same database -- a unique
-- violation, and a plan that ran seven of eleven. Whether a developer has
-- seeded their own machine is not something these assertions are entitled to
-- have an opinion about.
set local role anon;

select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('branding', 'pgtap-write-probe')$$,
  '42501', null,
  'a caller with no session cannot write here');

-- The bytes are still served to that same caller over HTTP, which is the whole
-- design: `public = true` on the bucket is what the sign-in screen relies on,
-- and it is decided by storage-api rather than by any policy this can see.
select is(
  (select count(*) from storage.objects where bucket_id = 'branding'),
  0::bigint,
  'and reads no rows through SQL, which the picture no longer depends on');

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
