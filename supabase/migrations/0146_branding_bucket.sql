-- supabase/migrations/0146_branding_bucket.sql

-- Where the picture on the sign-in screen lives.
--
-- THE FOURTH BUCKET, AND THE SECOND PUBLIC ONE, and it differs from every other
-- one in this database in the way that decides its whole shape: ITS READER HAS
-- NO SESSION. The sign-in screen is what somebody sees *before* they
-- authenticate, so there is no auth.uid() to write a policy about and no signed
-- URL to hand out -- whoever would sign it is exactly the person who has not
-- signed in yet. A private bucket cannot serve this image at all.
--
-- 0086 drew the line this sits on the safe side of: what is stored here is one
-- piece of marketing artwork, chosen by the operator to be shown to the whole
-- internet on the front door. It is the opposite of a delivery receipt, and
-- 32_branding_bucket.test.sql asserts that the receipt bucket is STILL private,
-- because "make the images public" is the kind of change that takes a
-- neighbouring bucket with it.
--
-- ONE OBJECT, ONE FIXED KEY: 'login-hero.png'. Not a uuid like the artwork
-- bucket's keys, and for the opposite reason -- artwork keys are uuids so the
-- bucket cannot be walked, whereas this object's whole purpose is to be found
-- at an address the sign-in page can build without asking anything first.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
-- `do update` rather than `do nothing`, for 0143's reason: on a database where
-- this bucket somehow already exists, `do nothing` would leave it without the
-- limits above, and a bucket with no opinion is the hole 0134 was written to
-- close.
on conflict (id) do update
   set public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- NOBODY WRITES HERE THROUGH THE APPLICATION. There is no INSERT policy, no
-- UPDATE policy and no DELETE policy, for `anon` or for `authenticated`, and
-- their absence is the design rather than an omission to be tidied up later.
--
-- The operator replaces this image through the Supabase dashboard, which acts
-- as service_role and is not subject to RLS at all. No screen in this product
-- uploads it, so a policy admitting `authenticated` would grant a capability
-- nothing exercises -- and it would grant it to EVERY member of EVERY Station,
-- since this object belongs to the product rather than to a tenant and there
-- is no company id in its path to scope a permission against. The one picture
-- every visitor sees before signing in is not something any tenant's operator
-- should be able to replace.
--
-- This is also why the bucket needs none of what 0143 needed. No
-- may_write_branding(), no INSERT+UPDATE pair for the upsert, and no SELECT
-- policy to make `on conflict` work: nothing that is subject to RLS ever writes
-- here.

-- ---------------------------------------------------------------------------
-- Reading, and the one thing it is actually for.
--
-- The bytes do NOT need this policy. A public bucket is served straight off
-- /storage/v1/object/public/<bucket>/<key>, which consults no policy at all --
-- that is what `public = true` above means, and it is what makes the image
-- reachable by a browser with no session.
--
-- What needs it is the CACHE STAMP. Storage serves a public object with the
-- cache-control the UPLOADER chose, and an upload that names none -- which is
-- what a dashboard drag-and-drop is -- gets `max-age=3600`, measured against
-- the local stack. So an operator who swaps this picture would keep seeing the
-- old one for up to an hour, with nothing on screen to say why -- and would
-- reasonably conclude the upload had failed and do it again. src/lib/branding/
-- login-hero.ts avoids that by reading this object's updated_at and hanging it
-- on the URL as ?v=<epoch>, which makes a replacement a different URL and
-- therefore a different cache entry. Reading updated_at means listing the
-- object, and listing goes through storage.objects, which IS subject to RLS.
--
-- `anon` FIRST AND NOT ONLY `authenticated`: the reader here has no session by
-- definition. `authenticated` is named too so that somebody who still holds a
-- session and lands on /login sees the same picture as everybody else.
--
-- It discloses nothing. Every object in this bucket is already served to
-- anybody at all who knows its address, and its address is a constant compiled
-- into the sign-in page. The policy admits a caller to a row naming a file they
-- can already fetch.
create policy branding_read
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'branding');

-- No `comment on policy`: COMMENT requires ownership of the relation, and the
-- migration role may only ADD policies to storage.objects. 0086, 0123 and 0143
-- all carry the same absence for the same reason, so the reasoning stays here.
