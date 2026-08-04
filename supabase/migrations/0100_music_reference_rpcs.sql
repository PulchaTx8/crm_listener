-- supabase/migrations/0100_music_reference_rpcs.sql

-- Block 7a, Task 3: one trio of doors for the four short lists.
--
-- 0027 writes a separate RPC per operation, and its comment gives the reason:
-- the permission check belongs beside the operation, so a reader looking for
-- "who may do this" finds it there rather than inside a shared helper. That
-- reason does not reach here. All four of these entities are gated on the
-- SAME single code, music.manage (D8), so there is nothing to keep beside
-- anything — and what is left is four tables with identical columns, where
-- twelve near-identical bodies would be twelve places for one fix to be
-- applied to eleven.
--
-- It is also the shape §4 prescribes for 7b's merge: one private core, four
-- public doors, discriminated on a kind. The block ends up with one idea.
--
-- NOTE FOR 7b: these four kinds are NOT the merge's four. The merge covers
-- songs, artists, record labels and genres; shows is not among them and songs
-- is. 7b declares music_merge_kind of its own and does not reuse this type.
create type public.music_reference_kind as enum ('GENRE', 'LABEL', 'ARTIST', 'SHOW');

comment on type public.music_reference_kind is
  'The four catalogue lists that are a name and nothing else. Not the merge''s kinds (7b) — that set drops SHOW and adds SONG.';

-- The one place a kind becomes a table name. IMMUTABLE and total: adding a
-- value to the enum without adding a branch here returns null, and every
-- caller below formats that null into `public.""` and fails loudly rather
-- than writing somewhere unintended.
create or replace function public.music_reference_table(p_kind public.music_reference_kind)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'GENRE'  then 'music_genres'
    when 'LABEL'  then 'record_labels'
    when 'ARTIST' then 'artists'
    when 'SHOW'   then 'shows'
  end;
$$;

revoke execute on function public.music_reference_table(public.music_reference_kind) from public;

comment on function public.music_reference_table(public.music_reference_kind) is
  'Maps a reference kind to its table name, for the format(%I) in the three doors below. EXECUTE granted to nobody: it is only ever called from inside a SECURITY DEFINER body.';

-- ---------------------------------------------------------------------------
-- The three doors. Each is SECURITY DEFINER and each checks music.manage
-- BEFORE revealing whether anything exists — the rule 0093 settled and wrote
-- out at length. create_ resolves the Organization only AFTER the check;
-- update_ and archive_ use 0093's one-gated-query idiom, where an unknown id
-- and an unauthorised Station are the same 42501 from outside.
--
-- The table name reaches SQL through format(%I) over a value this schema
-- produced from an enum — never through a caller's string. The identifier is
-- the only part that cannot be a bind parameter; every value below is bound.
-- ---------------------------------------------------------------------------

create or replace function public.create_music_reference(
  p_company_id uuid,
  p_kind       public.music_reference_kind,
  p_name       text,
  p_legacy_id  text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_table  text := public.music_reference_table(p_kind);
  v_name   text := nullif(btrim(p_name), '');
  v_legacy text := nullif(btrim(coalesce(p_legacy_id, '')), '');
  v_id     uuid;
begin
  -- Permission first, existence second — the opposite order to 0027's
  -- catalogue RPCs, deliberately. has_permission is false for a Station that
  -- does not exist and for one that is suspended, so this answers 42501
  -- without ever confirming whether the id names anything.
  if not public.has_permission('music.manage', p_company_id) then
    raise log 'create_music_reference denied: actor=% company=% kind=%', v_actor, p_company_id, p_kind;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  -- Nearly unreachable — has_permission already required an active Company —
  -- and kept for the Station archived between the two statements, where the
  -- alternative is a null organization_id reaching a not-null column.
  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if v_name is null then
    raise exception 'a name is required' using errcode = '22023';
  end if;

  begin
    execute format(
      'insert into public.%I (organization_id, company_id, name, legacy_id, created_by)
       values ($1, $2, $3, $4, $5) returning id', v_table)
    into v_id
    using v_org, p_company_id, v_name, v_legacy, v_actor;
  exception
    when unique_violation then
      -- The only unique index on these tables is the legacy handle (D7);
      -- names deliberately have none (D2/D3 — the cure is the merge, not a
      -- wall). So this branch can mean one thing, and says it.
      raise exception 'a record with legacy id "%" already exists in this station', v_legacy
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_music_reference', v_table, v_id, v_org, p_company_id,
     jsonb_build_object('kind', p_kind, 'name', v_name, 'legacy_id', v_legacy));

  return v_id;
end;
$$;

comment on function public.create_music_reference(uuid, public.music_reference_kind, text, text) is
  'Registers a genre, record label, artist or show in one Station. Gated on music.manage, checked BEFORE the Station is resolved so an unauthorised caller cannot learn whether a Company id names anything. Names are deliberately not unique (D2/D3): a duplicate is allowed and 7b''s maintenance screen merges it. legacy_id is unique per Station when present (D7) and a collision is refused with 23505 naming the handle.';

create or replace function public.update_music_reference(
  p_kind      public.music_reference_kind,
  p_id        uuid,
  p_name      text,
  p_legacy_id text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_table   text := public.music_reference_table(p_kind);
  v_name    text := nullif(btrim(p_name), '');
  v_legacy  text := nullif(btrim(coalesce(p_legacy_id, '')), '');
  v_org     uuid;
  v_company uuid;
begin
  -- 0093's idiom: ONE gated query resolves the Station, and `not found`
  -- covers three facts on purpose — no such id, an id in a Station this
  -- caller holds nothing in, and an already-archived row. The composite
  -- foreign keys cannot see deleted_at (they reference a non-partial
  -- constraint), so `deleted_at is null` here is the only thing standing
  -- between an archived genre and an edit that puts it back in every screen's
  -- reference list.
  execute format(
    'select organization_id, company_id from public.%I
      where id = $1 and deleted_at is null
        and public.has_permission(''music.manage'', company_id)', v_table)
  into v_org, v_company
  using p_id;

  if v_company is null then
    raise log 'update_music_reference denied: actor=% kind=% id=%', v_actor, p_kind, p_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'a name is required' using errcode = '22023';
  end if;

  begin
    execute format(
      'update public.%I set name = $1, legacy_id = $2, updated_at = now() where id = $3', v_table)
    using v_name, v_legacy, p_id;
  exception
    when unique_violation then
      raise exception 'a record with legacy id "%" already exists in this station', v_legacy
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_music_reference', v_table, p_id, v_org, v_company,
     jsonb_build_object('kind', p_kind, 'name', v_name, 'legacy_id', v_legacy));
end;
$$;

comment on function public.update_music_reference(public.music_reference_kind, uuid, text, text) is
  'Replaces a reference record''s name and legacy handle wholesale (the convention update_role and update_prize follow: every field set on every call, never merged). The Station is resolved from the row itself, never from a parameter, so a caller cannot redirect the permission check at a Station they do hold music.manage in. An unknown id, a Station the caller cannot reach and an already-archived row all answer 42501 alike.';

create or replace function public.archive_music_reference(
  p_kind public.music_reference_kind,
  p_id   uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_table   text := public.music_reference_table(p_kind);
  v_org     uuid;
  v_company uuid;
  v_in_use  integer;
begin
  execute format(
    'select organization_id, company_id from public.%I
      where id = $1 and deleted_at is null
        and public.has_permission(''music.manage'', company_id)
        for update', v_table)
  into v_org, v_company
  using p_id;

  if v_company is null then
    raise log 'archive_music_reference denied: actor=% kind=% id=%', v_actor, p_kind, p_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- Refused while a live song still names it. Archiving it anyway would leave
  -- the song pointing at a row no screen can read (0099's policy filters
  -- deleted_at), so the song's own record would render an artist that had
  -- silently become blank — the same shape as archive_prize refusing a prize
  -- with stock, and delete_role refusing a role in use.
  --
  -- SHOW is checked against music_requests instead: nothing else references
  -- it, and a show with requests behind it is exactly as load-bearing as an
  -- artist with songs.
  if p_kind = 'ARTIST' then
    select count(*) into v_in_use from public.songs
     where artist_id = p_id and deleted_at is null;
  elsif p_kind = 'LABEL' then
    select count(*) into v_in_use from public.songs
     where label_id = p_id and deleted_at is null;
  elsif p_kind = 'GENRE' then
    select count(*) into v_in_use from public.songs
     where genre_id = p_id and deleted_at is null;
  else
    select count(*) into v_in_use from public.music_requests
     where show_id = p_id and deleted_at is null;
  end if;

  if v_in_use > 0 then
    raise exception 'this record is still used by % live row(s); change them first', v_in_use
      using errcode = '23503';
  end if;

  execute format(
    'update public.%I set deleted_at = now(), updated_at = now() where id = $1', v_table)
  using p_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_music_reference', v_table, p_id, v_org, v_company,
     jsonb_build_object('kind', p_kind));
end;
$$;

comment on function public.archive_music_reference(public.music_reference_kind, uuid) is
  'Soft-deletes a genre, label, artist or show. Gated on music.manage. Never a DELETE — this project deletes nothing, and 7b''s merge history needs rows to keep pointing at. Refused while a live song (or, for a show, a live request) still names it, so no screen is left rendering a reference that RLS has made unreadable. Takes FOR UPDATE on the row, so a create_song naming this artist cannot interleave past the count.';

revoke execute on function public.create_music_reference(uuid, public.music_reference_kind, text, text)   from public;
revoke execute on function public.update_music_reference(public.music_reference_kind, uuid, text, text)   from public;
revoke execute on function public.archive_music_reference(public.music_reference_kind, uuid)              from public;

grant execute on function public.create_music_reference(uuid, public.music_reference_kind, text, text)    to authenticated;
grant execute on function public.update_music_reference(public.music_reference_kind, uuid, text, text)    to authenticated;
grant execute on function public.archive_music_reference(public.music_reference_kind, uuid)               to authenticated;
