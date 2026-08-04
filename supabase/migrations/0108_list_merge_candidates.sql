-- supabase/migrations/0108_list_merge_candidates.sql

-- Block 7b, Task 4: what the Maintenance screen reads.
--
-- The screen asks the operator to name which duplicate STAYS, and the merge is
-- not reversible. child_count is the number that makes that a decision rather
-- than a coin flip: two songs with the same title, one with three hundred
-- requests behind it and one with none, are not interchangeable. One read
-- gives it for the whole page, where the alternative is one count per row from
-- the screen.
--
-- SECURITY DEFINER and gated on music.view, not music.merge — Task 9's fix
-- round 1 corrected this from the original music.merge gate, which read as
-- consistent with the five doors but collided with the Maintenance screen's
-- own requirement (task-9-brief.md) that a caller without music.merge still
-- see the list read-only: since page.tsx resolves this read and
-- getMusicPermissions in the same request, gating the read itself on
-- music.merge meant `permissions.merge = false` and "the read already
-- threw" were the same event, and the read-only branch could never run.
--
-- D8 (0098) defines music.view as "see the catalogue and the requests" and
-- music.merge as the one destructive code, kept separate on purpose. A
-- candidate list is seeing the catalogue: every column it returns (label,
-- sub_label, legacy_id) is already readable by a music.view caller through
-- 0099's ordinary select policies, and child_count is an aggregate over rows
-- that same caller can already read and count for themselves, one row at a
-- time. Nothing here is destructive and nothing here is a secret a
-- music.view caller could not already assemble by hand — gating the READ on
-- music.merge leaked nothing, it only cost the screen its read-only mode.
-- The destruction stays exactly where D8 put it: music.merge, checked by
-- each of the five doors before any of them writes anything.
--
-- sub_label is the second line a candidate needs to be told apart from its
-- duplicate: for a song, the artist. The four short lists have nothing to put
-- there and return null.

create function public.list_merge_candidates(
  p_company_id uuid,
  p_kind       public.music_merge_kind,
  p_search     text    default null,
  p_limit      integer default 100
)
returns table (
  id          uuid,
  label       text,
  sub_label   text,
  child_count integer,
  legacy_id   text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_like   text;
begin
  if not public.has_permission('music.view', p_company_id) then
    raise log 'list_merge_candidates denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: music.view required' using errcode = '42501';
  end if;

  v_like := '%' || coalesce(v_search, '') || '%';

  if p_kind = 'SONG' then
    return query
      select s.id, s.title, a.name,
             (select count(*)::integer from public.music_requests r where r.song_id = s.id),
             s.legacy_id
        from public.songs s
        join public.artists a on a.id = s.artist_id
       where s.company_id = p_company_id and s.deleted_at is null
         and (v_search is null or s.title ilike v_like)
       order by s.title, s.id
       limit p_limit;

  elsif p_kind = 'ARTIST' then
    return query
      select x.id, x.name, null::text,
             (select count(*)::integer from public.songs g where g.artist_id = x.id),
             x.legacy_id
        from public.artists x
       where x.company_id = p_company_id and x.deleted_at is null
         and (v_search is null or x.name ilike v_like)
       order by x.name, x.id
       limit p_limit;

  elsif p_kind = 'LABEL' then
    return query
      select x.id, x.name, null::text,
             (select count(*)::integer from public.songs g where g.label_id = x.id),
             x.legacy_id
        from public.record_labels x
       where x.company_id = p_company_id and x.deleted_at is null
         and (v_search is null or x.name ilike v_like)
       order by x.name, x.id
       limit p_limit;

  elsif p_kind = 'GENRE' then
    return query
      select x.id, x.name, null::text,
             (select count(*)::integer from public.songs g where g.genre_id = x.id),
             x.legacy_id
        from public.music_genres x
       where x.company_id = p_company_id and x.deleted_at is null
         and (v_search is null or x.name ilike v_like)
       order by x.name, x.id
       limit p_limit;

  elsif p_kind = 'SHOW' then
    return query
      select x.id, x.name, null::text,
             (select count(*)::integer from public.music_requests r where r.show_id = x.id),
             x.legacy_id
        from public.shows x
       where x.company_id = p_company_id and x.deleted_at is null
         and (v_search is null or x.name ilike v_like)
       order by x.name, x.id
       limit p_limit;

  else
    -- Unreachable while the enum has five values, and loud rather than an
    -- empty list if a sixth is added without a branch here. An empty list
    -- would read as "no duplicates", which is the wrong answer to give
    -- somebody about to decide there is nothing to clean up.
    raise exception 'no candidate rule for merge kind %', p_kind using errcode = 'XX000';
  end if;
end;
$$;

comment on function public.list_merge_candidates(uuid, public.music_merge_kind, text, integer) is
  'The Maintenance screen''s one read: every live record of one kind in one Station, with the number of children a merge would move. Gated on music.view (D8), not music.merge — every column and the child_count aggregate are already readable by a music.view caller through 0099''s ordinary policies, so this leaks nothing new, and it is what lets a caller without music.merge still see the screen read-only. child_count is what makes naming the survivor a decision rather than a coin flip, and the counts include withdrawn/archived children because apply_music_merge moves those too.';

revoke execute on function public.list_merge_candidates(uuid, public.music_merge_kind, text, integer) from public;
grant execute on function public.list_merge_candidates(uuid, public.music_merge_kind, text, integer) to authenticated;
