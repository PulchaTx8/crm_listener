-- supabase/migrations/0145_prize_photo.sql

-- Block 14, D3. A prize gets a photograph.
--
-- Of the same kind as the promotion's thumb and for the same purpose: it
-- identifies the prize on the inventory list and on its own record. Nothing in
-- this block sends it anywhere. The column is here if that is ever wanted, and
-- until somebody asks it stays internal -- which is why it is held to the
-- thumb's tighter pixel ceiling rather than the banner's, and why no rule of
-- Meta's decides anything about it.
--
-- ITS OWN WRITER, for the reason 0144 gives at length: update_prize (0027) sets
-- every column it takes on every call, so a photograph uploaded before a Save
-- would be deleted by that Save.

alter table public.prizes add column photo_url text;

comment on column public.prizes.photo_url is
  'A picture identifying this prize on the inventory list and its record. Server-generated (Block 14); no form posts it. Written only by set_prize_photo -- update_prize replaces every field it takes, and a photograph on that list would be cleared by every ordinary save.';

alter table public.prizes
  add constraint prizes_photo_shape
  check (photo_url is null or photo_url ~ '^https?://');

-- `default null` for the reason 0144's two setters give: an omitted argument
-- clears the photograph and queues its object, and without the default the
-- generated types would not let the service express that at all.
create function public.set_prize_photo(p_prize_id uuid, p_url text default null)
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
  -- `deleted_at is null` rather than a bare lookup, so an archived prize is
  -- unreachable here exactly as it is everywhere else. 0029 makes archiving
  -- irreversible from this app; a setter that could still write to one would be
  -- the single door out of that.
  select company_id, photo_url into v_company, v_current
  from public.prizes
  where id = p_prize_id and deleted_at is null
  for update;

  if not found then
    raise exception 'prize not found: %', p_prize_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.catalogue', v_company) then
    raise log 'set_prize_photo denied: actor=% prize=%', auth.uid(), p_prize_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  if v_url is null then
    perform public.enqueue_artwork_erasure(
      v_current, 'prize-photos/' || v_company || '/' || p_prize_id);
  end if;

  update public.prizes
     set photo_url  = v_url,
         updated_at = now()
   where id = p_prize_id;
end;
$$;

comment on function public.set_prize_photo(uuid, text) is
  'Sets or clears the picture identifying a prize. Gated on inventory.catalogue, the same permission every other catalogue field takes (0027) -- somebody who runs promotions is not thereby somebody who edits the stock catalogue. Its own writer rather than a field of update_prize, which replaces every column it is given. Archived prizes are unreachable here, as they are everywhere else (0029). Null clears and queues the object.';

revoke execute on function public.set_prize_photo(uuid, text) from public;
grant execute on function public.set_prize_photo(uuid, text) to authenticated;
