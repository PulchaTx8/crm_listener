-- supabase/migrations/0141_update_album_renames_only.sql

-- Block 13a, fix round: update_album loses p_upc.
--
-- FOUND BY BUILDING THE CATALOGUE TAB, and it is 0102's defect exactly, one
-- block later and one table over.
--
-- 0137 gave update_album a p_upc parameter defaulting to null, following the
-- house convention that an update sets every field on every call. The
-- catalogue panel that edits albums is a ONE-FIELD row — a name, edited in
-- place, the same shape labels, genres and shows use (reference-panel.tsx). So
-- every rename would have called update_album with p_upc omitted, which takes
-- the SQL default of null, which the UPDATE then writes unconditionally: the
-- first rename of any album registered from Deezer would silently erase its
-- UPC.
--
-- That is the same sentence 0102 had to write about legacy_id, and the same
-- fix applies. A hidden field re-forwarding the current value would stop the
-- erasure and leave the column writable by anyone who can craft a POST, which
-- is not read-only in any sense that matters. The honest fix removes the write
-- path: this function renames, and nothing else.
--
-- WHERE THE UPC COMES FROM INSTEAD. create_album still takes it — that is the
-- Deezer register path — and resolve_or_create_album (0137) fills it in with
-- `coalesce(upc, ...)` the first time an album typed by hand is matched
-- against Deezer. So an album can gain a UPC it lacked; it can never lose one
-- it has. That is the same asymmetry the cover and the Deezer id already have,
-- and for the same reason: all three travel together, out of one source.
--
-- DROP + CREATE, not CREATE OR REPLACE: dropping a parameter changes the
-- signature, and a replace would leave both overloads with every three-argument
-- caller still resolving to the old, erasing body. Dropping resets the ACL, so
-- the revoke/grant pair is restated.

drop function public.update_album(uuid, text, text);

create function public.update_album(
  p_album_id uuid,
  p_title    text
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
  update public.albums
  set title      = v_title,
      updated_at = now()
  where id = p_album_id
    and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'update_album denied or missing: actor=% album=%', v_actor, p_album_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;
end;
$$;

comment on function public.update_album(uuid, text) is
  'Block 13a. Renames an album and touches nothing else. No parameter reaches upc, cover_md5 or deezer_album_id: all three come from the Deezer path alone, and an omitted parameter on a one-field form is indistinguishable from a cleared one (0102''s lesson, which 0137 reproduced and this migration corrects).';

revoke execute on function public.update_album(uuid, text) from public;
grant  execute on function public.update_album(uuid, text) to authenticated;
