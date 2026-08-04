-- supabase/migrations/0106_music_merge_doors.sql

-- Block 7b, Task 2: THE FIRST MERGE IN THIS CODEBASE.
--
-- One private core, five public doors — the shape §4 prescribes and the shape
-- 0100 already used for the reference doors. The listener merge ruled for on
-- 2026-08-01 and still unbuilt should inherit this, and it moves participations,
-- winners and documents, which is more delicate than music but is the same act.
--
-- THE CORE IS PRIVATE, in the shape of apply_winner_transition (0092):
-- SECURITY INVOKER, EXECUTE granted to nobody. It is reachable only from
-- inside the five SECURITY DEFINER doors below, which have already established
-- who the caller is and which Station they hold music.merge in.

create function public.apply_music_merge(
  p_kind       public.music_merge_kind,
  p_company_id uuid,
  p_winner_id  uuid,
  p_loser_ids  uuid[],
  p_reason     text
)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_table   text := public.music_merge_table(p_kind);
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_losers  uuid[];
  v_all     uuid[];
  v_org     uuid;
  v_locked  integer := 0;
  v_row     record;
  v_loser   uuid;
  v_moved   integer;
  v_total   integer := 0;
begin
  -- Mandatory (§3.4), and blank is not a reason. Refused before anything is
  -- read, so a caller cannot use a reasonless call to probe for existence.
  if v_reason is null then
    raise exception 'a merge needs a reason' using errcode = '22023';
  end if;

  -- Distinct and non-null. The screen sends what the operator ticked, and a
  -- duplicate id in that array would otherwise archive one record and write
  -- two history rows claiming two different child counts for it.
  select coalesce(array_agg(distinct l), '{}'::uuid[]) into v_losers
    from unnest(coalesce(p_loser_ids, '{}'::uuid[])) as l
   where l is not null;

  if coalesce(array_length(v_losers, 1), 0) = 0 then
    raise exception 'a merge needs at least one record to absorb' using errcode = '22023';
  end if;

  if p_winner_id = any(v_losers) then
    raise exception 'the surviving record cannot also be one of the ones being absorbed'
      using errcode = '22023';
  end if;

  v_all := v_losers || p_winner_id;

  -- ONE ordered pass over winner AND losers together (D-b). Not the winner
  -- first: two operators merging an overlapping pair in opposite directions —
  -- A says "W wins, L loses", B says the reverse — would deadlock under
  -- winner-first ordering, and queue safely under this one. The LockRows node
  -- sits above the Sort, so the rows really are locked in id order.
  --
  -- SCOPED TO THE STATION (D-a), which is what makes §4's "refuses records
  -- belonging to different Stations" true by construction rather than by a
  -- comparison. A comparison would be an oracle: a caller holding music.merge
  -- in Station A could learn whether a uuid names a live song in Station B by
  -- reading which of two messages came back. Scoped this way, a loser in
  -- another Station is simply not found, and answers the identical P0002 as a
  -- uuid that names nothing anywhere.
  --
  -- `deleted_at is null` is here for the same reason 0100's doors carry it:
  -- the composite foreign keys reference a non-partial constraint and cannot
  -- see deleted_at, so this is the only thing standing between an archived row
  -- and a second merge that would resurrect it into the winner's history.
  for v_row in execute format(
    'select id, organization_id from public.%I
      where id = any($1) and company_id = $2 and deleted_at is null
      order by id
      for update', v_table)
    using v_all, p_company_id
  loop
    v_locked := v_locked + 1;
    v_org := v_row.organization_id;
  end loop;

  -- Every id named must be present, live and in this Station. One message for
  -- all three, deliberately: they are the same answer from outside.
  if v_locked <> array_length(v_all, 1) then
    raise exception 'one of these records is missing, already archived, or in another station'
      using errcode = 'P0002';
  end if;

  foreach v_loser in array v_losers
  loop
    -- The only part that varies by kind: five one-line updates.
    --
    -- Withdrawn children move with the live ones (D-c). No `deleted_at is
    -- null` filter here, on purpose: a withdrawn request still points
    -- somewhere, and leaving it aimed at the row this merge is about to
    -- archive would make one uuid mean two different things depending on
    -- which side of deleted_at the reader is on.
    if p_kind = 'SONG' then
      update public.music_requests
         set song_id = p_winner_id, updated_at = now()
       where song_id = v_loser;
    elsif p_kind = 'ARTIST' then
      update public.songs
         set artist_id = p_winner_id, updated_at = now()
       where artist_id = v_loser;
    elsif p_kind = 'LABEL' then
      update public.songs
         set label_id = p_winner_id, updated_at = now()
       where label_id = v_loser;
    elsif p_kind = 'GENRE' then
      update public.songs
         set genre_id = p_winner_id, updated_at = now()
       where genre_id = v_loser;
    elsif p_kind = 'SHOW' then
      update public.music_requests
         set show_id = p_winner_id, updated_at = now()
       where show_id = v_loser;
    else
      -- Unreachable while music_merge_table is total, and loud rather than
      -- silent if a sixth kind is ever added to the enum without a branch here.
      raise exception 'no repoint rule for merge kind %', p_kind using errcode = 'XX000';
    end if;

    get diagnostics v_moved = row_count;
    v_total := v_total + v_moved;

    insert into public.music_merges
      (organization_id, company_id, kind, winner_id, loser_id, reason, children_moved, merged_by)
    values
      (v_org, p_company_id, p_kind, p_winner_id, v_loser, v_reason, v_moved, v_actor);

    -- NEVER a delete. This project deletes nothing, and the history row above
    -- needs something to keep pointing at.
    execute format(
      'update public.%I set deleted_at = now(), updated_at = now() where id = $1', v_table)
      using v_loser;
  end loop;

  -- One audit row for the operation, not one per loser: the operator pressed
  -- one button, and music_merges already carries the per-loser detail.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'merge_music', v_table, p_winner_id, v_org, p_company_id,
     jsonb_build_object('kind', p_kind, 'losers', v_losers,
                        'children_moved', v_total, 'reason', v_reason));

  return v_total;
end;
$$;

revoke execute on function
  public.apply_music_merge(public.music_merge_kind, uuid, uuid, uuid[], text) from public;

comment on function
  public.apply_music_merge(public.music_merge_kind, uuid, uuid, uuid[], text) is
  'Collapses one or more records into a survivor, in one transaction: locks winner and losers together in id order and scoped to the Station, refuses a winner named among the losers, refuses any id that is missing/archived/elsewhere, repoints the children, writes one music_merges row per loser and soft-deletes it. Returns the total number of children repointed. Atomic on purpose, and deliberately the opposite of 6d''s sweep, which commits per winner: there an unattended sweep must not let one bad row stop every Station; here one operator pressed one button, and half a merge is worse than none. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody — the five doors below are the only callers.';

-- ---------------------------------------------------------------------------
-- The five doors. Each checks music.merge at the winner's Station BEFORE
-- revealing whether the record exists — 0093's rule, and the same
-- one-gated-query idiom update_music_reference (0100) uses: `not found` covers
-- no such id, an id in a Station this caller holds nothing in, and an
-- already-archived row, all answering 42501 alike.
--
-- Five near-identical bodies rather than one door taking a kind, on 0027's
-- reasoning: the caller is a screen with a kind already in hand, and a single
-- door taking p_kind would let a UI bug aimed at genres archive songs. Five
-- names are five distinct capabilities in an audit log and five distinct
-- things to grep for. What they share — everything that could drift — is in
-- the core.
-- ---------------------------------------------------------------------------

create function public.merge_songs(p_winner_id uuid, p_loser_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.songs
   where id = p_winner_id and deleted_at is null
     and public.has_permission('music.merge', company_id);

  if v_company is null then
    raise log 'merge_songs denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  return public.apply_music_merge('SONG', v_company, p_winner_id, p_loser_ids, p_reason);
end;
$$;

create function public.merge_artists(p_winner_id uuid, p_loser_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.artists
   where id = p_winner_id and deleted_at is null
     and public.has_permission('music.merge', company_id);

  if v_company is null then
    raise log 'merge_artists denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  return public.apply_music_merge('ARTIST', v_company, p_winner_id, p_loser_ids, p_reason);
end;
$$;

create function public.merge_record_labels(p_winner_id uuid, p_loser_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.record_labels
   where id = p_winner_id and deleted_at is null
     and public.has_permission('music.merge', company_id);

  if v_company is null then
    raise log 'merge_record_labels denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  return public.apply_music_merge('LABEL', v_company, p_winner_id, p_loser_ids, p_reason);
end;
$$;

create function public.merge_music_genres(p_winner_id uuid, p_loser_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.music_genres
   where id = p_winner_id and deleted_at is null
     and public.has_permission('music.merge', company_id);

  if v_company is null then
    raise log 'merge_music_genres denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  return public.apply_music_merge('GENRE', v_company, p_winner_id, p_loser_ids, p_reason);
end;
$$;

-- The fifth door, and the one D3 did not originally have. The owner ruled for
-- it on 2026-08-04: a duplicated programme splits Block 8's per-show numbers
-- exactly as a duplicated song splits "most requested", and shows had no other
-- cure. 0105 re-issues 0098's table comment, which recorded the gap.
create function public.merge_shows(p_winner_id uuid, p_loser_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.shows
   where id = p_winner_id and deleted_at is null
     and public.has_permission('music.merge', company_id);

  if v_company is null then
    raise log 'merge_shows denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: music.merge required' using errcode = '42501';
  end if;

  return public.apply_music_merge('SHOW', v_company, p_winner_id, p_loser_ids, p_reason);
end;
$$;

comment on function public.merge_songs(uuid, uuid[], text) is
  'Absorbs one or more duplicate songs into a survivor, moving their music_requests. Gated on music.merge at the winner''s Station, checked before existence — an unknown id and an unauthorised Station both answer 42501. Returns the number of requests repointed.';
comment on function public.merge_artists(uuid, uuid[], text) is
  'Absorbs one or more duplicate artists into a survivor, moving their songs. Gated on music.merge. Returns the number of songs repointed.';
comment on function public.merge_record_labels(uuid, uuid[], text) is
  'Absorbs one or more duplicate record labels into a survivor, moving their songs. Gated on music.merge. Returns the number of songs repointed.';
comment on function public.merge_music_genres(uuid, uuid[], text) is
  'Absorbs one or more duplicate genres into a survivor, moving their songs. Gated on music.merge. A duplicated genre splits Block 8''s "most requested category" exactly as a duplicated song splits "most requested". Returns the number of songs repointed.';
comment on function public.merge_shows(uuid, uuid[], text) is
  'Absorbs one or more duplicate programmes into a survivor, moving their music_requests. Gated on music.merge. The fifth door, added on the owner''s 2026-08-04 ruling against D3''s original four. Returns the number of requests repointed.';

revoke execute on function public.merge_songs(uuid, uuid[], text)         from public;
revoke execute on function public.merge_artists(uuid, uuid[], text)       from public;
revoke execute on function public.merge_record_labels(uuid, uuid[], text) from public;
revoke execute on function public.merge_music_genres(uuid, uuid[], text)  from public;
revoke execute on function public.merge_shows(uuid, uuid[], text)         from public;

grant execute on function public.merge_songs(uuid, uuid[], text)         to authenticated;
grant execute on function public.merge_artists(uuid, uuid[], text)       to authenticated;
grant execute on function public.merge_record_labels(uuid, uuid[], text) to authenticated;
grant execute on function public.merge_music_genres(uuid, uuid[], text)  to authenticated;
grant execute on function public.merge_shows(uuid, uuid[], text)         to authenticated;
