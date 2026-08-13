-- supabase/migrations/0187_album_covers.sql

-- Block 20c. The album record gets a picture, and update_album learns two
-- fields it never had.
--
-- THE WIDENING IS A DROP AND A CREATE, NOT A REPLACE. `create or replace` does
-- not change a function's argument list: it creates a SECOND overload, and
-- every caller compiled against the old one goes on resolving to it in
-- silence. `::regprocedure` cannot detect that -- it resolves the signature you
-- name and ignores the twins -- which is why 49_album_covers.test.sql counts
-- rows in pg_proc instead. Block 4b found this the expensive way.
--
-- WHICH SIGNATURE IS ACTUALLY DROPPED, because the obvious answer is wrong.
-- 0137 created update_album(uuid, text, text) and 0141 ALREADY DROPPED IT,
-- leaving update_album(uuid, text). So the drop below names two arguments, not
-- three, and `drop function public.update_album(uuid, text, text)` would fail
-- here with 42883. Read from the live catalogue (pg_get_functiondef), not from
-- 0137's text: this is the second thing in this area that a migration file no
-- longer describes truthfully, the first being may_write_artwork below.
--
-- THE UPC COMES BACK, AND 0141'S OBJECTION IS ANSWERED RATHER THAN FORGOTTEN.
-- 0141 removed p_upc because the screen editing albums was a ONE-FIELD inline
-- row: every rename called the function with p_upc omitted, the omission took
-- the SQL default of null, and the UPDATE wrote that null over a UPC that came
-- from Deezer. The defect was never the parameter; it was a parameter the form
-- had no field for. Block 20c replaces that inline row with a record dialog
-- carrying titulo, UPC and data de lancamento together, so every call now sends
-- every field it writes -- which is the house convention (update_prize,
-- update_song, update_company_profile) rather than an exception to it.
--
-- SO THE TWO NEW PARAMETERS CARRY NO DEFAULT, AND THAT IS THE WHOLE FIX.
-- 0141's real complaint was never the parameter; it was that an omitted
-- argument and a cleared field were THE SAME REQUEST as far as this function
-- could tell. `default null` is what makes them the same. Without it they are
-- different: omitting p_upc is 42883, "no function matches", at the call --
-- while sending it as null still clears the UPC, deliberately, because an
-- operator who empties the field means it.
--
-- Restoring the parameter WITH a default would have reproduced 0141's defect
-- exactly, one block later and with its own migration explaining why it could
-- not happen. It nearly did: the first draft of this file carried
-- `p_upc text default null` and left updateAlbum sending two arguments, which
-- typechecked and would have emptied the UPC of every album anybody renamed.
--
-- The next person to add a convenience default here should read 0141 first. A
-- default on a wholesale-replace writer is not a convenience; it is a way for a
-- form that forgot a field to delete data, and it cannot be caught by types,
-- because "argument omitted" is what an optional argument is FOR.
--
-- create_album keeps its defaults, and the difference is real: registering a
-- record with fields left blank is an intention somebody had. Emptying one by
-- accident is not.
--
-- THE PICTURE HAS TWO SOURCES AND ONE COLUMN. `cover_md5` (0136) is Deezer's
-- and stays exactly as it is; `thumb_url` is the operator's own upload. The
-- screen prefers the upload and falls back to the cover -- so an album
-- registered from Deezer arrives with a picture at no cost, and one typed by
-- hand can be given one. Nothing merges them in the database, because they are
-- facts from two different places and only the screen has an opinion about
-- which to show.

alter table public.albums add column thumb_url text;

comment on column public.albums.thumb_url is
  'The cover an operator uploaded for this album. NOT cover_md5, which is Deezer''s hash of Deezer''s artwork (0136) and is written by the Deezer path alone -- these are two facts from two sources, and the screen prefers this one and falls back to that one. Server-generated (Block 20c); no form posts it. Written only by set_album_cover: update_album replaces every field it takes, and a picture on that list would be cleared by every ordinary save.';

-- The shape check every sibling picture column carries -- promotions_thumb_shape
-- (0144), prizes_photo_shape (0145), companies_thumb_shape (0153). The column
-- never holds something that would land verbatim in an <img src> without at
-- least being an address.
alter table public.albums
  add constraint albums_thumb_shape
  check (thumb_url is null or thumb_url ~ '^https?://');

-- ---------------------------------------------------------------------------
-- update_album, widened.
--
-- The drop is explicit and comes first. See the header: a replace would leave
-- update_album(uuid, text) beside the new one, every two-argument caller would
-- go on resolving to it, and nothing in the schema would say so. Dropping also
-- resets the ACL, so the revoke/grant pair is restated below -- 0141's note,
-- which applies again for the same reason.
-- ---------------------------------------------------------------------------

drop function public.update_album(uuid, text);

-- NO `default null` ON THE LAST TWO. See the header: the default is the thing
-- that makes "not provided" and "set to nothing" indistinguishable, which is
-- what 0141 removed p_upc over. A caller that omits one now fails at the call
-- with 42883 instead of quietly emptying a column, and 49_album_covers.test.sql
-- asserts both refusals.
create function public.update_album(
  p_album_id     uuid,
  p_title        text,
  p_upc          text,
  p_release_date date
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_title text := nullif(btrim(p_title), '');
begin
  if v_title is null then
    raise exception 'an album needs a title' using errcode = '23514';
  end if;

  -- 0093's one-gated-query idiom: the permission is evaluated inside the same
  -- statement that finds the row, so an unknown id and an unreachable Station
  -- are the same refusal from outside.
  --
  -- STILL NOTHING HERE REACHES deezer_album_id OR cover_md5. That half of
  -- 0137's rule is untouched and must stay untouched: those two travel together
  -- out of one source (0139), and no payload, forged or otherwise, can move
  -- them. thumb_url is absent for the other reason -- it has its own writer,
  -- because a picture on a list of wholesale-replaced fields is a picture that
  -- every ordinary save deletes.
  update public.albums
  set title        = v_title,
      upc          = nullif(btrim(coalesce(p_upc, '')), ''),
      release_date = p_release_date,
      updated_at   = now()
  where id = p_album_id
    and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'update_album denied or missing: actor=% album=%', v_actor, p_album_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;
end;
$$;

comment on function public.update_album(uuid, text, text, date) is
  'Block 20c. Title, UPC and release date -- every one written on every call, the convention update_prize and update_song follow. NONE OF THE THREE HAS A DEFAULT, on purpose: 0141 removed p_upc because `default null` made an omitted argument indistinguishable from a cleared field, so a rename form with no UPC box erased the UPC. Without the default they are different requests -- omitting is 42883 at the call, sending null still clears, which is what an operator emptying the box means. Do not add a convenience default here; on a writer that replaces every field it is a way for a form that forgot one to delete data. No parameter reaches deezer_album_id or cover_md5 (0137, 0139), and none reaches thumb_url, which has set_album_cover as its only writer.';

revoke execute on function public.update_album(uuid, text, text, date) from public;
grant  execute on function public.update_album(uuid, text, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- set_album_cover: the album's picture gets its own writer.
--
-- The fourth of these, and the reasoning has not changed since 0144 wrote it
-- down: update_album replaces every column it takes, so a cover uploaded before
-- a Save would be deleted BY that Save. 0145 and 0153 each hit it again and
-- each answered it the same way.
--
-- `default null` for 0145's reason: an OMITTED argument clears the picture, and
-- without the default the generated types would not let the service express
-- that at all -- PostgREST sends named arguments, and "send p_url as null" and
-- "do not send p_url" are two different requests.
-- ---------------------------------------------------------------------------

create function public.set_album_cover(p_album_id uuid, p_url text default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_current text;
  v_url     text := nullif(btrim(coalesce(p_url, '')), '');
begin
  -- `deleted_at is null` rather than a bare lookup, so an archived album is
  -- unreachable here exactly as it is everywhere else (0137's archive_album is
  -- the only way in, and nothing in this app reverses it).
  select company_id, thumb_url into v_company, v_current
  from public.albums
  where id = p_album_id and deleted_at is null
  for update;

  if not found then
    raise exception 'album not found: %', p_album_id using errcode = 'P0002';
  end if;

  -- music.manage, the same permission every other album door takes (0137). The
  -- gate is BEFORE the work, in the order attach_delivery_receipt established:
  -- a caller who may not be here writes nothing and queues nothing.
  if not public.has_permission('music.manage', v_company) then
    raise log 'set_album_cover denied: actor=% album=%', auth.uid(), p_album_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- Clearing QUEUES the object rather than deleting it: the artwork bucket
  -- gives `authenticated` no delete policy, deliberately (0143), and the worker
  -- tick drains the queue as service_role. Without this the column empties and
  -- the object stays in the bucket for ever.
  if v_url is null then
    perform public.enqueue_artwork_erasure(
      v_current, 'album-covers/' || v_company || '/' || p_album_id);
  end if;

  update public.albums
     set thumb_url  = v_url,
         updated_at = now()
   where id = p_album_id;
end;
$$;

comment on function public.set_album_cover(uuid, text) is
  'Block 20c. Sets or clears the cover an operator uploaded for an album. Gated on music.manage, the same permission every other album door takes (0137) -- somebody who runs promotions is not thereby somebody who edits the music catalogue. Its own writer rather than a field of update_album, which replaces every column it is given (0144, 0145 and 0153 each document that defect). Archived albums are unreachable here. Omitting p_url clears the picture and queues its object for the worker, because the bucket has no delete policy for authenticated.';

revoke execute on function public.set_album_cover(uuid, text) from public;
grant  execute on function public.set_album_cover(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- may_write_artwork gains a slot.
--
-- The whole body is restated because `create or replace` needs it, and 0143's
-- own closing comment asked for exactly this: "An unknown prefix is refused, so
-- adding a slot means adding it here."
--
-- THE BODY BELOW WAS READ OUT OF THE RUNNING DATABASE, not copied from 0143.
-- 0143 is no longer the truth about this function: 0153 added the station-thumbs
-- branch, and a body reconstructed from 0143's text would delete it -- silently,
-- because the result still compiles and every OTHER slot goes on working. That
-- is a whole feature reverted by a migration that appears to add one.
-- ---------------------------------------------------------------------------

create or replace function public.may_write_artwork(p_name text)
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

  -- Block 15. The Station's own picture, and the ONE branch here that does not
  -- ask has_permission: there is no Company permission that could mean "may
  -- change what this Station is called and looks like", and inventing one would
  -- put a customer role in charge of a record the platform owns (design D9).
  -- The console that edits it is /admin/customers, behind the same gate.
  if v_slot = 'station-thumbs' then
    return public.is_platform_admin();
  end if;

  -- Block 20c. An album's cover takes the music catalogue's permission, the
  -- same one every other album door takes (0137). An operator who runs
  -- promotions is not thereby somebody who edits the music catalogue.
  if v_slot = 'album-covers' then
    return public.has_permission('music.manage', v_company::uuid);
  end if;

  -- An unknown prefix is refused rather than allowed. Adding a slot means
  -- adding it here, which is the point.
  return false;
end;
$$;

comment on function public.may_write_artwork(text) is
  'Whether the caller may write the named object in the artwork bucket, decided from the path alone. SECURITY INVOKER deliberately: has_permission and is_platform_admin both answer about auth.uid(). Guards the uuid cast rather than attempting it. Since Block 15 it carries a station-thumbs branch gated on is_platform_admin() rather than a permission code, because that picture belongs to the platform''s record of the Station (D9); since Block 20c an album-covers branch gated on music.manage, the permission every other album door takes. An unknown prefix is refused, so adding a slot means adding it here.';

-- Restated rather than assumed. `create or replace` preserves the ACL, so these
-- two are strictly speaking unchanged -- which is exactly why they are written
-- out: the day this function is dropped and recreated instead, the pair has to
-- already be here or `authenticated` silently loses every upload.
revoke execute on function public.may_write_artwork(text) from public;
grant  execute on function public.may_write_artwork(text) to authenticated;
