-- supabase/migrations/0205_music_categories.sql

-- Block 27. A category is music_genres with a different name, and that is the
-- whole argument for making it a fifth music_reference_kind (0204) rather than
-- a record with doors of its own: 0100 exists precisely so that tables with
-- identical columns share ONE trio of doors, and a fifth costs an enum value
-- and the branches at the foot of this file. prize_categories (0025/0202) is
-- the other shape and stays that shape — it is the same word in the inventory
-- domain, governed by inventory.catalogue, and one table for both would tie a
-- stock label to a music permission.
--
-- Per Station, like every other catalogue table (0098's D1): organization_id
-- AND company_id, the composite foreign key against companies, and a unique
-- (id, company_id) pair so a child proves its Station in a constraint rather
-- than a trigger.

create table public.music_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  name            text not null,
  legacy_id       text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint music_categories_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint music_categories_name_not_blank check (btrim(name) <> '')
);

comment on table public.music_categories is
  'A Station''s own filing words for a recording — the vocabulary its scheduling software uses — beside the genre rather than instead of it: a genre says what the music IS, a category says where this Station files it. Names are deliberately not unique, the same D2/D3 ruling music_genres carries: a duplicate is allowed and the cure is a merge, not a wall. NOT public.prize_categories, which is the same word in the inventory domain and is governed by inventory.catalogue.';

-- Non-partial, because a foreign key cannot reference a partial index — which
-- is exactly why an archived parent needs the explicit check in
-- assert_song_references_live at the foot of this file, the same gap 0098
-- documents for its own four tables.
alter table public.music_categories
  add constraint music_categories_id_company_unique unique (id, company_id);

-- D7's shape, from 0098: unique WHEN PRESENT, per Station, so the many rows
-- with no handle do not collide — the trap prizes.internal_code (0025) hit
-- first. Without it an ETL that runs twice duplicates the whole list.
create unique index music_categories_legacy_unique
  on public.music_categories (company_id, legacy_id) where legacy_id is not null;

-- The list every screen and every <select> opens on.
create index music_categories_company_idx
  on public.music_categories (company_id, name) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- The column on songs.
-- ---------------------------------------------------------------------------

alter table public.songs add column category_id uuid;

-- The constraint that makes "no Station points at another's category" true in
-- Postgres rather than in a screen, the same shape 0098 gives artist, label and
-- genre.
alter table public.songs
  add constraint songs_category_company_fk
  foreign key (category_id, company_id)
  references public.music_categories (id, company_id);

comment on column public.songs.category_id is
  'Block 27. The Station''s own filing word for this recording. Nullable, and not an oversight: the whole catalogue predates this column, so requiring one would make every existing song unsavable — the same reason label_id and genre_id are nullable (0098).';

create index songs_category_idx on public.songs (category_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- RLS, exactly 0099's shape.
--
-- Read gate only: `select` for authenticated, gated on music.view resolved from
-- the row's own company_id, filtering deleted_at AT THE POLICY so an ordinary
-- select through PostgREST cannot list archived rows just because whoever
-- writes the next screen forgot to filter them. Its consequence, which 0099
-- states and which this table inherits: an archived category is not merely
-- hidden from the list, it is UNREADABLE through RLS for every caller.
-- ---------------------------------------------------------------------------

alter table public.music_categories enable row level security;
revoke all on public.music_categories from anon, authenticated;
grant select on public.music_categories to authenticated;

create policy music_categories_select_music_view on public.music_categories
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));

-- ---------------------------------------------------------------------------
-- The two functions that learn about the kind.
--
-- CREATE OR REPLACE on both, not DROP + CREATE: neither signature changes, so
-- there is no second overload for a caller to resolve to, and REPLACE KEEPS THE
-- ACL — 0100's `revoke execute ... from public` still stands on
-- music_reference_table (granted to nobody) and its grant to authenticated
-- still stands on archive_music_reference. 0102 restated its revoke/grant pair
-- because DROP resets an ACL; that reason does not reach these two.
-- ---------------------------------------------------------------------------

create or replace function public.music_reference_table(p_kind public.music_reference_kind)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'GENRE'    then 'music_genres'
    when 'LABEL'    then 'record_labels'
    when 'ARTIST'   then 'artists'
    when 'SHOW'     then 'shows'
    when 'CATEGORY' then 'music_categories'
  end;
$$;

comment on function public.music_reference_table(public.music_reference_kind) is
  'Maps a reference kind to its table name, for the format(%I) in 0100''s three doors. IMMUTABLE and total: a value with no branch here returns null, and every caller formats that null into `public.""` and fails loudly rather than writing somewhere unintended. EXECUTE granted to nobody: it is only ever called from inside a SECURITY DEFINER body.';

-- 0100's body with a fifth branch, copied forward from 0100 rather than from
-- 0103 or 0104: 0103 replaced assert_song_references_live and RESTATED THIS
-- FUNCTION'S COMMENT, and 0104 corrected one sentence of that comment. Neither
-- touched this body. Checked before copying, because copying from the wrong
-- migration is a mistake this project has made and written down.
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

  if p_kind = 'ARTIST' then
    select count(*) into v_in_use from public.songs
     where artist_id = p_id and deleted_at is null;
  elsif p_kind = 'LABEL' then
    select count(*) into v_in_use from public.songs
     where label_id = p_id and deleted_at is null;
  elsif p_kind = 'GENRE' then
    select count(*) into v_in_use from public.songs
     where genre_id = p_id and deleted_at is null;
  -- Block 27. REFUSED while a live song wears it, not detached — and the
  -- difference from archive_prize_category (0202/0203) is the point rather than
  -- an inconsistency. Its three siblings above all refuse, and a fourth kind
  -- behaving differently INSIDE THIS SAME FUNCTION, chosen by an argument, would
  -- make one function mean two things depending on what you passed it. 0202
  -- detaches because prizes.category_id has no assert_ helper standing over it
  -- and a prize left pointing at an unreadable row renders as uncategorised
  -- anyway; here the song would render a category that had silently become
  -- blank, which is the exact failure 0100's own comment gives for artists.
  elsif p_kind = 'CATEGORY' then
    select count(*) into v_in_use from public.songs
     where category_id = p_id and deleted_at is null;
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
  'Soft-deletes a genre, label, artist, category or show. Gated on music.manage. Never a DELETE — this project deletes nothing, and 0106''s merge history needs rows to keep pointing at. Refused while a live song (or, for a show, a live request) still names it, so no screen is left rendering a reference that RLS has made unreadable. Takes FOR UPDATE on the row before counting; that excludes a concurrent create_song only because 0103 makes assert_song_references_live take FOR KEY SHARE on the same row, and FOR KEY SHARE conflicts with FOR UPDATE and with nothing weaker. The two locks are a pair and neither works alone: until 0103 the reader took no lock, so an archive and a create could interleave and leave a live song naming an archived reference. Do not weaken this FOR UPDATE — FOR SHARE does not conflict with FOR KEY SHARE, so that change would reopen the race while both comments still claimed it was closed. 0205 added the CATEGORY branch, which is held by the same pair.';

-- ---------------------------------------------------------------------------
-- The live-reference check gains the fifth reference.
--
-- WITHOUT THIS, the category would be the one reference of five that a song
-- could name AFTER IT WAS ARCHIVED. songs_category_company_fk references
-- music_categories_id_company_unique, a NON-PARTIAL constraint — a foreign key
-- cannot reference a partial index — so it proves the Station and cannot see
-- deleted_at. And the FOR KEY SHARE below is the other half of
-- archive_music_reference's FOR UPDATE: without it, an archive and a create
-- could interleave past the count above, which is exactly the race 0103 was
-- written to close for the other three. Neither half works alone; whoever
-- changes one changes both.
--
-- DROP + CREATE, not REPLACE: the signature changes. The parameter is added
-- LAST and DEFAULTED, so 0152's four-argument call site keeps resolving here —
-- plpgsql resolves a call at execution time, so there is no stale reference in
-- any existing body to fix, and no CASCADE is needed on the drop.
--
-- The revoke is restated because DROP RESETS THE ACL (0102 records the same
-- thing about its own recreate). Without it the default ACL would leave every
-- role holding EXECUTE on a helper that takes row locks — and a locking clause
-- needs UPDATE privilege on the table, not merely SELECT, so a caller who
-- somehow reached it would fail confusingly rather than harmlessly.
-- ---------------------------------------------------------------------------

drop function public.assert_song_references_live(uuid, uuid, uuid, uuid);

create function public.assert_song_references_live(
  p_company_id  uuid,
  p_artist_id   uuid,
  p_label_id    uuid,
  p_genre_id    uuid,
  p_category_id uuid default null
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if p_artist_id is null then
    raise exception 'a song must name an artist' using errcode = '22023';
  end if;

  -- FOR KEY SHARE, not a bare read: this is the half that holds the row against
  -- archive_music_reference's FOR UPDATE. See 0103's header for the measured
  -- conflict table, and for why `perform ... for key share` is the shape rather
  -- than `exists (... for key share)`.
  perform 1 from public.artists
   where id = p_artist_id and company_id = p_company_id and deleted_at is null
   for key share;

  if not found then
    raise exception 'artist not found in this station: %', p_artist_id using errcode = 'P0002';
  end if;

  if p_label_id is not null then
    perform 1 from public.record_labels
     where id = p_label_id and company_id = p_company_id and deleted_at is null
     for key share;

    if not found then
      raise exception 'record label not found in this station: %', p_label_id using errcode = 'P0002';
    end if;
  end if;

  if p_genre_id is not null then
    perform 1 from public.music_genres
     where id = p_genre_id and company_id = p_company_id and deleted_at is null
     for key share;

    if not found then
      raise exception 'genre not found in this station: %', p_genre_id using errcode = 'P0002';
    end if;
  end if;

  -- Block 27. Inside the `is not null` guard for the reason 0103's header gives
  -- about the two above it: with PERFORM, FOUND is set by every execution, so
  -- `if p_category_id is not null and not found` would work only by accident of
  -- evaluation order.
  if p_category_id is not null then
    perform 1 from public.music_categories
     where id = p_category_id and company_id = p_company_id and deleted_at is null
     for key share;

    if not found then
      raise exception 'category not found in this station: %', p_category_id using errcode = 'P0002';
    end if;
  end if;
end;
$$;

revoke execute on function public.assert_song_references_live(uuid, uuid, uuid, uuid, uuid) from public;

comment on function public.assert_song_references_live(uuid, uuid, uuid, uuid, uuid) is
  'Refuses an artist, label, genre or category that is missing, archived, or from another Station. SECURITY INVOKER, EXECUTE granted to nobody. The composite foreign keys prove the Station by themselves; what they cannot see is deleted_at, which is the half this covers. Each check takes FOR KEY SHARE on the row it reads (0103), the weakest row-lock mode that conflicts with archive_music_reference''s FOR UPDATE: without it the two could interleave and leave a live song naming an archived reference. It deliberately does not conflict with another FOR KEY SHARE, so concurrent song creation is not serialised. p_category_id is last and defaulted (0205) so 0152''s four-argument call resolves here unchanged and means "no category".';
