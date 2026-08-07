-- supabase/migrations/0143_artwork_bucket.sql

-- Block 14, D4. Where a promotion's and a prize's pictures live.
--
-- THE THIRD BUCKET, AND THE FIRST PUBLIC ONE. 0086 chose private and said why:
-- a delivery receipt is a photograph of a real person, and a public bucket is a
-- URL anybody can guess their way around. That reasoning is untouched and that
-- bucket does not move. This one is different in the one way that decides it:
-- META FETCHES THE BANNER ITSELF, at send time, which may be days after the
-- operator uploaded it. A signed URL expires; a private bucket would mean a
-- banner that works on the day it is set and silently stops working later.
--
-- What is stored here is promotional material -- a banner drawn to be shown to
-- listeners, a product photograph, a picture that identifies a promotion on a
-- list. None of it is personal data. The line 0086 drew stays where it was, and
-- 29_artwork_bucket.test.sql asserts that the receipt bucket is still private,
-- because "make the images public" is the kind of change that takes a
-- neighbouring bucket with it.
--
-- Keys are UUIDs in both segments (src/lib/storage/artwork-keys.ts), so the
-- bucket cannot be walked even though it can be read.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('artwork', 'artwork', true, 5242880, array['image/jpeg', 'image/png'])
-- Not `do nothing`, which is what 0086 and 0123 use: on a database where this
-- bucket somehow already exists, `do nothing` would leave it without the limits
-- above, and a bucket with no opinion is exactly the hole 0134 was written to
-- close.
on conflict (id) do update
   set public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Who may write, decided from the path alone.
--
-- A FUNCTION RATHER THAN THE PREDICATE INLINE, for two reasons. An upsert needs
-- an INSERT policy AND an UPDATE policy -- a bucket that accepts the first
-- upload and refuses the replacement is worse than one that refuses both -- and
-- the UPDATE policy needs the rule twice, in USING and in WITH CHECK. Written
-- inline that is the same twenty lines three times, which is three places for
-- them to drift.
--
-- WHERE THIS DEPARTS FROM 0086, AND WHY. That migration casts
-- (storage.foldername(name))[1] straight to uuid inside the policy. On a
-- malformed path that raises 22P02 -- an ERROR, not a refusal. It has never
-- fired because our own code builds every path, but a policy that errors where
-- it means to deny is not a shape to carry forward without noticing. The cast
-- here is guarded.
--
-- SECURITY INVOKER, and stated rather than left to the default: has_permission
-- answers about auth.uid(), so this must run as the caller. A definer here
-- would answer about the function's owner and let anybody write anywhere.
create function public.may_write_artwork(p_name text)
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_parts   text[] := storage.foldername(p_name);
  v_slot    text   := v_parts[1];
  v_company text   := v_parts[2];
begin
  if v_company is null
     or v_company !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    return false;
  end if;

  -- A promotion's two pictures take the same permission because they are two
  -- fields of one record: somebody who may edit a promotion may set both.
  if v_slot in ('promotion-thumbs', 'promotion-banners') then
    return public.has_permission('promotions.edit', v_company::uuid);
  end if;

  -- The prize's takes the catalogue permission rather than the promotions one.
  -- Somebody who runs promotions is not thereby somebody who edits the stock
  -- catalogue, and 0027 already draws that line for every other prize field.
  if v_slot = 'prize-photos' then
    return public.has_permission('inventory.catalogue', v_company::uuid);
  end if;

  -- An unknown prefix is refused rather than allowed. Adding a slot means
  -- adding it here, which is the point.
  return false;
end;
$$;

comment on function public.may_write_artwork(text) is
  'Whether the caller may write the named object in the artwork bucket, decided from the path alone. SECURITY INVOKER deliberately: has_permission answers about auth.uid(). Guards the uuid cast rather than attempting it, unlike 0086, whose policy raises 22P02 on a malformed path instead of refusing it. An unknown prefix is refused, so adding a slot means adding it here.';

revoke execute on function public.may_write_artwork(text) from public;
grant execute on function public.may_write_artwork(text) to authenticated;

create policy artwork_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'artwork' and public.may_write_artwork(name));

create policy artwork_update
  on storage.objects for update to authenticated
  using (bucket_id = 'artwork' and public.may_write_artwork(name))
  with check (bucket_id = 'artwork' and public.may_write_artwork(name));

-- No SELECT policy, and its absence is the feature: the bucket is public, so
-- reads go through the public endpoint and never reach RLS at all.
--
-- No DELETE policy for authenticated, deliberately -- the shape 0123 chose.
-- Clearing an image queues its object in storage_erasure_queue (0087) and the
-- worker deletes it through service_role. A client that could delete here could
-- take a Station's banner off the air without leaving a row saying so.
--
-- No `comment on policy` on either: COMMENT requires ownership of the relation,
-- and the migration role may only add policies to storage.objects. 0086 and
-- 0123 carry the same absence for the same reason, so the reasoning stays here.
