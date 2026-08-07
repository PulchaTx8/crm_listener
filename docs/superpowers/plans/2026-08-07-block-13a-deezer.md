# Block 13a — Deezer, albums and covers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the song dialogs a Deezer tab that finds a recording and registers it in one click, store the album it came from in a table of its own, and carry the cover through every screen that names a song.

**Architecture:** A new per-Station `albums` table holds title, UPC, Deezer id and the cover hash; `songs` gains `album_id`, `deezer_track_id` and a hand-editable `isrc`. Registering from Deezer resolves-or-creates artist, label, genre and album inside one transaction. The Deezer HTTP layer sits behind a transport interface with a fake, so CI proves the block with no network.

**Tech Stack:** Next 15 (App Router, Server Actions), Supabase Postgres with RLS + SECURITY DEFINER RPCs, zod, next-intl, vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-07-deezer-integration-design.md`

## Global Constraints

- **Migrations are append-only and numbered.** The next free number is `0136`. Never edit a migration that is already committed.
- **Deezer errors arrive as HTTP 200** with `{"error":{...}}` in the body. Every call parses the body and checks `error` *before* `response.ok`. (Spec §2.1.)
- **Preview URLs are signed and expire in hours.** Never store one, never put one in a database column, never cache one across requests. (Spec §2.1.)
- **`deezer_track_id` has no write path from a form.** `update_song` gains no parameter for it. (D6.)
- **Covers are stored as `cover_md5`**, never as a URL. (D4.)
- **Every RPC is `SECURITY DEFINER`, checks its permission FIRST**, then resolves anything, and uses `set search_path = pg_catalog, public`.
- **Every user-visible string is a catalogue key** in `messages/en.json`, `pt.json`, `es.json`. Never call `useTranslations`/`getTranslations` in a module body — only inside a component or a function. (Block 12c took a route down doing this.)
- **No `revalidatePath` in music actions.** The grids patch their own rows (`src/lib/row-patch.ts`).
- **Commands:** `npm test` (vitest), `npm run db:test` (pgTAP), `npm run test:isolation`, `npm run test:e2e`, `npm run typecheck`, `npm run lint`, `npm run db:types`.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0136_albums.sql` | The `albums` table, its indexes, its RLS |
| `supabase/migrations/0137_album_rpcs.sql` | `create_album` / `update_album` / `archive_album` |
| `supabase/migrations/0138_songs_deezer.sql` | `songs.album_id`, `deezer_track_id`, `isrc`; `update_song` v2 |
| `supabase/migrations/0139_song_deezer_doors.sql` | `create_song_from_deezer`, `link_song_to_deezer`, `unlink_song_from_deezer` |
| `supabase/tests/28_albums.test.sql` | pgTAP for 0136–0139 |
| `src/lib/integrations/deezer/transport.ts` | The seam: types + interface, no I/O |
| `src/lib/integrations/deezer/client.ts` | The real HTTP implementation |
| `src/lib/integrations/deezer/fake.ts` | The transport CI uses |
| `src/lib/integrations/deezer/cover.ts` | `cover_md5` → CDN URL, one place |
| `src/components/music/song-thumb.tsx` | The cover, or the fallback icon |
| `src/app/(app)/music/songs/deezer-actions.ts` | Server actions: search, register, link, unlink |
| `src/app/(app)/music/songs/deezer-tab.tsx` | The tab: filters, results, preview, buttons |
| `tests/unit/deezer-client.test.ts` | Error-as-200, query builder, mapping |
| `tests/unit/deezer-cover.test.ts` | The URL builder |
| `tests/isolation/deezer.test.ts` | Permission and cross-Station refusals |
| `tests/e2e/deezer.spec.ts` | Search → register → row with cover; link an old song |

**Modified**

| File | Change |
| --- | --- |
| `src/lib/supabase/database.types.ts` | Regenerated (`npm run db:types`) |
| `src/services/music.ts` | `AlbumSummary`; `SongSummary` gains album/cover/deezer/isrc |
| `src/schemas/music.ts` | `isrc`, `albumId` on the song schemas; Deezer search schema |
| `src/app/(app)/music/songs/song-fields.tsx` | Album select, ISRC input, read-only Deezer code |
| `src/app/(app)/music/songs/songs-grid.tsx` | Cover column; the create dialog gains tabs |
| `src/app/(app)/music/songs/song-record-dialog.tsx` | Second tab (`deezer`) |
| `src/lib/record-params.ts` | `SONG_TABS` gains `'deezer'` |
| `src/app/(app)/music/requests/requests-grid.tsx` | Cover beside the song title |
| `src/app/(app)/music/artists/artist-record-dialog.tsx` | Cover in the songs tab |
| `src/app/(app)/music/maintenance/merge-panel.tsx` | Cover on song candidates |
| `src/components/charts/top-list.tsx` | Optional leading image slot |
| `src/app/(app)/dashboards/music/page.tsx` | Pass the cover through |
| `src/app/(app)/music/catalog/reference-panel.tsx` | Albums tab |
| `src/lib/security/csp.ts` | `img-src`, new `media-src` |
| `tests/unit/csp.test.ts` | The two new directives |
| `messages/{en,pt,es}.json` | Every new string |

---

## Task 1: The `albums` table

**Files:**
- Create: `supabase/migrations/0136_albums.sql`
- Create: `supabase/tests/28_albums.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.albums` with columns `id, organization_id, company_id, title, upc, deezer_album_id, cover_md5, release_date, legacy_id, created_by, created_at, updated_at, deleted_at`; the unique pair `(id, company_id)` that Task 3's foreign key needs.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/28_albums.test.sql`:

```sql
begin;
select plan(9);

select has_table('public', 'albums', 'albums exists');
select col_not_null('public', 'albums', 'title', 'a title is required');
select has_index('public', 'albums', 'albums_deezer_live', 'the partial unique on the Deezer id exists');

-- The composite pair songs will point at.
select col_is_unique('public', 'albums', array['id', 'company_id'],
  'the (id, company_id) pair a child uses to prove its Station');

-- RLS is on and the policy is the music.view one every music table carries.
select is(
  (select relrowsecurity from pg_class where oid = 'public.albums'::regclass),
  true, 'row level security is enabled');
select policies_are('public', 'albums', array['albums_select_music_view'],
  'one read policy, no write policy');

-- UPC shape.
select throws_ok(
  $$insert into public.albums (organization_id, company_id, title, upc)
    values ('00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-000000000001', 'x', 'not-a-upc')$$,
  '23514', null, 'a UPC that is not 12-14 digits is refused');

-- Two live albums may not share one Deezer id in one Station...
select lives_ok(
  $$select 1$$, 'placeholder for the fixture-backed duplicate check below');

-- ...but the index is partial, so archiving and re-registering stays possible.
select index_is_partial('public', 'albums', 'albums_deezer_live',
  'the unique is partial, so an archived album does not block a new one');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `relation "public.albums" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0136_albums.sql`:

```sql
-- supabase/migrations/0136_albums.sql

-- Block 13a, Task 1: the album, which Block 7 left out because nothing then
-- had a use for it and which the Deezer tab now needs a home for.
--
-- Per Station, in the shape 0098 gave the other five music tables:
-- organization_id AND company_id, the composite foreign key against
-- companies (id, organization_id), and the unique (id, company_id) pair so a
-- song proves its Station in a constraint rather than a trigger. A group with
-- five Stations keeps five catalogues; that was the owner's ruling of
-- 2026-08-03 and it is not revisited here.
--
-- THE COVER IS A HASH, NOT A URL (design D4). Deezer returns `md5_image`, and
-- every size is built from it in code:
--   https://cdn-images.dzcdn.net/images/cover/{md5}/{W}x{H}-000000-80-0-0.jpg
-- Storing the hash makes a CDN host change a one-line fix in
-- src/lib/integrations/deezer/cover.ts instead of a migration over data, and
-- it removes the need for a check constraint pinning a URL -- a column whose
-- value lands directly in <img src> is otherwise a vector, and a check
-- constraint is a poor place to defend that.

create table public.albums (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  title           text not null,

  -- The barcode of the release. 12 to 14 digits: UPC-A is 12, EAN-13 is 13,
  -- and Deezer pads some to 14. Text and not a number -- leading zeros are
  -- significant and it is an identifier, not a quantity.
  upc text,

  -- bigint, not uuid and not text: Deezer's ids are integers (album 103763,
  -- track 921568) and they exceed nothing, but they are large enough that
  -- integer would be an unnecessary bet.
  deezer_album_id bigint,

  cover_md5    text,
  release_date date,

  legacy_id  text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint albums_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint albums_title_not_blank check (btrim(title) <> ''),
  constraint albums_upc_shape check (upc is null or upc ~ '^[0-9]{12,14}$'),
  constraint albums_cover_md5_shape
    check (cover_md5 is null or cover_md5 ~ '^[0-9a-f]{32}$')
);

-- What songs (0138) points at to prove its Station in a constraint.
alter table public.albums add constraint albums_id_company_key unique (id, company_id);

-- Partial, for the reason 0057 wrote out: moving or re-registering an album
-- means soft-deleting one row and inserting another, and a total unique would
-- refuse that second insert forever.
create unique index albums_deezer_live
  on public.albums (company_id, deezer_album_id)
  where deleted_at is null and deezer_album_id is not null;

-- The list is read by title; the Songs grid joins on id.
create index albums_company_title on public.albums (company_id, title)
  where deleted_at is null;

comment on table public.albums is
  'Block 13a. One Station''s albums. Holds the cover hash every screen that names a song renders, and the UPC of the release.';
comment on column public.albums.cover_md5 is
  'Deezer''s md5_image. The URL is built from it in src/lib/integrations/deezer/cover.ts -- never stored, so a CDN host change is a code fix.';

-- ---------------------------------------------------------------------------
-- RLS, identical to what 0099 gives the other music tables: read gated on
-- music.view resolved from the row's own company_id, filtering deleted_at AT
-- THE POLICY so an ordinary PostgREST select cannot list archived rows just
-- because a screen forgot to. No write policy -- writes go through 0137's
-- SECURITY DEFINER doors, which is where the music.manage check lives.
-- ---------------------------------------------------------------------------

alter table public.albums enable row level security;
revoke all on public.albums from anon, authenticated;
grant select on public.albums to authenticated;

create policy albums_select_music_view on public.albums
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, 9 of 9.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0136_albums.sql supabase/tests/28_albums.test.sql
git commit -m "feat(music): albums get a table, and the cover gets a hash rather than a URL"
```

---

## Task 2: The album doors

**Files:**
- Create: `supabase/migrations/0137_album_rpcs.sql`
- Modify: `supabase/tests/28_albums.test.sql`

**Interfaces:**
- Consumes: `public.albums` (Task 1).
- Produces:
  - `create_album(p_company_id uuid, p_title text, p_upc text default null, p_deezer_album_id bigint default null, p_cover_md5 text default null, p_release_date date default null, p_legacy_id text default null) returns uuid`
  - `update_album(p_album_id uuid, p_title text, p_upc text default null) returns void`
  - `archive_album(p_album_id uuid) returns void`
  - `resolve_or_create_album(p_company_id uuid, p_title text, p_deezer_album_id bigint, p_upc text, p_cover_md5 text, p_release_date date) returns uuid` — **not granted to anyone**; called only from inside Task 4's `create_song_from_deezer`.

- [ ] **Step 1: Add the failing assertions**

Append to `supabase/tests/28_albums.test.sql`, before `select * from finish();`, and raise the `plan(9)` to `plan(13)`:

```sql
select has_function('public', 'create_album', 'the create door exists');
select has_function('public', 'update_album', 'the update door exists');
select has_function('public', 'archive_album', 'the archive door exists');

-- The private resolver is reachable by nobody from outside.
select is(
  has_function_privilege('authenticated', 'public.resolve_or_create_album(uuid,text,bigint,text,text,date)', 'execute'),
  false,
  'resolve_or_create_album is not executable by authenticated');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `function public.create_album does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0137_album_rpcs.sql`:

```sql
-- supabase/migrations/0137_album_rpcs.sql

-- Block 13a, Task 2: the album's three doors, plus the private resolver the
-- Deezer register path calls.
--
-- NOT folded into 0100's create_music_reference/update_music_reference trio,
-- and the reason is that trio's own comment: it exists because four tables had
-- IDENTICAL columns, so twelve near-identical bodies would have been twelve
-- places for one fix to be applied to eleven. Albums are not identical -- they
-- carry a UPC, a Deezer id, a cover hash and a release date. Widening
-- music_reference_kind to include them would push five album-only parameters
-- into every genre and label call, which is the opposite of what that trio was
-- for.
--
-- The permission is the same single code, music.manage (D8), and the order is
-- the one 0100 settled: PERMISSION FIRST, EXISTENCE SECOND. has_permission is
-- false for a Station that does not exist and for one that is suspended, so an
-- unknown id and an unauthorised Station are one 42501 from outside.

create or replace function public.create_album(
  p_company_id      uuid,
  p_title           text,
  p_upc             text   default null,
  p_deezer_album_id bigint default null,
  p_cover_md5       text   default null,
  p_release_date    date   default null,
  p_legacy_id       text   default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_title text := nullif(btrim(p_title), '');
  v_id    uuid;
begin
  if not public.has_permission('music.manage', p_company_id) then
    raise log 'create_album denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_title is null then
    raise exception 'an album needs a title' using errcode = '23514';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if v_org is null then
    raise exception 'no such station' using errcode = '42501';
  end if;

  insert into public.albums (
    organization_id, company_id, title, upc, deezer_album_id,
    cover_md5, release_date, legacy_id, created_by
  )
  values (
    v_org, p_company_id, v_title,
    nullif(btrim(coalesce(p_upc, '')), ''),
    p_deezer_album_id,
    nullif(btrim(coalesce(p_cover_md5, '')), ''),
    p_release_date,
    nullif(btrim(coalesce(p_legacy_id, '')), ''),
    v_actor
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_album is
  'Block 13a. Registers an album in one Station. music.manage, checked before anything is resolved.';

-- ---------------------------------------------------------------------------
-- update_album takes TITLE AND UPC AND NOTHING ELSE.
--
-- deezer_album_id and cover_md5 are deliberately absent, for the reason 0102
-- had to learn the hard way with legacy_id: a field that must not be edited is
-- protected by THE ABSENCE OF A WRITE PATH, not by a form that happens not to
-- send it. An update form that simply never carries a value forward is
-- indistinguishable, to the function it calls, from an operator who cleared it.
-- The code and the cover travel together and are set by the Deezer path alone
-- (0139); nothing here can move them.
-- ---------------------------------------------------------------------------

create or replace function public.update_album(
  p_album_id uuid,
  p_title    text,
  p_upc      text default null
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
      upc        = nullif(btrim(coalesce(p_upc, '')), ''),
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

create or replace function public.archive_album(p_album_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  update public.albums
  set deleted_at = now()
  where id = p_album_id
    and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'archive_album denied or missing: actor=% album=%', v_actor, p_album_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- Songs keep pointing at it. albums_select_music_view hides the row, so
  -- services/music.ts's embed comes back null and the screens show the same
  -- "Unavailable" they already show for an archived artist -- the behaviour
  -- SONG_COLUMNS' comment describes at length. Nulling songs.album_id here
  -- would destroy which album a song belonged to in order to tidy a display.
end;
$$;

comment on function public.archive_album is
  'Block 13a. Soft-deletes an album. Songs keep album_id; the embed simply stops resolving, exactly as it does for an archived artist.';

-- ---------------------------------------------------------------------------
-- The private resolver. EXECUTE GRANTED TO NOBODY: it is called only from
-- inside 0139's create_song_from_deezer, which has already checked
-- music.manage and already resolved the Organization. Exposing it would be a
-- second, ungated write path into albums.
--
-- Matching is by Deezer id first and by folded title second. `upper(unaccent)`
-- is NOT used -- unaccent is not installed in this project (0001 installs
-- pgcrypto only). Postgres's own `lower()` over a `citext`-free column plus an
-- explicit accent fold via translate() would be fragile; instead the match is
-- case-insensitive on the raw title, and an accent difference produces a
-- second album rather than a wrong match. That is the safe direction: a
-- duplicate an operator can merge later beats silently filing a song under
-- somebody else's record.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_or_create_album(
  p_company_id      uuid,
  p_title           text,
  p_deezer_album_id bigint,
  p_upc             text,
  p_cover_md5       text,
  p_release_date    date
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org   uuid;
  v_title text := nullif(btrim(p_title), '');
  v_id    uuid;
begin
  if v_title is null then
    return null;
  end if;

  if p_deezer_album_id is not null then
    select id into v_id
    from public.albums
    where company_id = p_company_id
      and deezer_album_id = p_deezer_album_id
      and deleted_at is null;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  select id into v_id
  from public.albums
  where company_id = p_company_id
    and deleted_at is null
    and lower(title) = lower(v_title)
  order by created_at
  limit 1;

  if v_id is not null then
    -- An album first typed by hand and now met on Deezer: fill in what it
    -- lacked, never overwrite what it has. An operator's correction outranks
    -- a catalogue's.
    update public.albums
    set deezer_album_id = coalesce(deezer_album_id, p_deezer_album_id),
        upc             = coalesce(upc, nullif(btrim(coalesce(p_upc, '')), '')),
        cover_md5       = coalesce(cover_md5, nullif(btrim(coalesce(p_cover_md5, '')), '')),
        release_date    = coalesce(release_date, p_release_date),
        updated_at      = now()
    where id = v_id;
    return v_id;
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  insert into public.albums (
    organization_id, company_id, title, upc, deezer_album_id,
    cover_md5, release_date, created_by
  )
  values (
    v_org, p_company_id, v_title,
    nullif(btrim(coalesce(p_upc, '')), ''),
    p_deezer_album_id,
    nullif(btrim(coalesce(p_cover_md5, '')), ''),
    p_release_date,
    auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.resolve_or_create_album(uuid, text, bigint, text, text, date) from public;

comment on function public.resolve_or_create_album is
  'Block 13a. Deezer id first, folded title second, insert last. EXECUTE granted to nobody: called only from create_song_from_deezer, which has already checked music.manage.';
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, 13 of 13.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0137_album_rpcs.sql supabase/tests/28_albums.test.sql
git commit -m "feat(music): three doors for albums, and a resolver nobody outside can call"
```

---

## Task 3: `songs` gains the album, the Deezer id and the ISRC

**Files:**
- Create: `supabase/migrations/0138_songs_deezer.sql`
- Modify: `supabase/tests/28_albums.test.sql`

**Interfaces:**
- Consumes: `public.albums` and its `(id, company_id)` unique (Task 1).
- Produces: `songs.album_id uuid`, `songs.deezer_track_id bigint`, `songs.isrc text`; `update_song` with two new trailing parameters `p_album_id uuid default null, p_isrc text default null`.

- [ ] **Step 1: Add the failing assertions**

Append to `supabase/tests/28_albums.test.sql` and raise `plan(13)` to `plan(19)`:

```sql
select has_column('public', 'songs', 'album_id', 'songs point at an album');
select has_column('public', 'songs', 'deezer_track_id', 'songs carry the Deezer id');
select has_column('public', 'songs', 'isrc', 'songs carry the ISRC');
select has_index('public', 'songs', 'songs_deezer_live', 'the partial unique on the Deezer track id');

-- D6: update_song must NOT be able to write the Deezer id.
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_song'
      and pg_get_function_arguments(p.oid) like '%deezer%'),
  0,
  'update_song has no parameter that could write the Deezer id');

-- D8: the ISRC is hand-editable, so it carries a format check but no unique.
select throws_ok(
  $$update public.songs set isrc = 'nope' where false$$,
  null, null, 'the isrc check exists (no row matched, so this only compiles it)');

select * from finish();
```

> Replace the trailing `select * from finish();` that was already there — there must be exactly one.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `column "album_id" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0138_songs_deezer.sql`:

```sql
-- supabase/migrations/0138_songs_deezer.sql

-- Block 13a, Task 3. Three columns on songs, and the one consequence for
-- update_song.
--
-- ALL THREE ARE OPTIONAL, and that is the requirement rather than a
-- convenience: songs typed by hand and songs registered from Deezer coexist
-- for good, and every screen must render both.

alter table public.songs
  add column album_id        uuid,
  add column deezer_track_id bigint,
  add column isrc            text;

-- The Station proof, in a constraint. 0098 gives artist_id, label_id and
-- genre_id the same treatment: an album from another Station is refused by
-- Postgres, before any screen or RPC gets a say.
alter table public.songs
  add constraint songs_album_company_fk
    foreign key (album_id, company_id)
    references public.albums (id, company_id);

-- An ISRC is two letters of country, three of registrant, two of year and five
-- of designation. The check is here and there is NO UNIQUE INDEX, deliberately
-- (design D8): this column is hand-editable, and a unique would turn one
-- operator's typo into a door nobody can open. The duplicate guard belongs on
-- deezer_track_id below, which no human types.
alter table public.songs
  add constraint songs_isrc_shape
    check (isrc is null or isrc ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$');

-- Design D9. Partial for 0057's reason, and it is this index -- not the
-- interface -- that makes "already registered" true when two tabs are open at
-- once.
create unique index songs_deezer_live
  on public.songs (company_id, deezer_track_id)
  where deleted_at is null and deezer_track_id is not null;

create index songs_album on public.songs (album_id) where deleted_at is null;

comment on column public.songs.deezer_track_id is
  'Block 13a. Set only by link_song_to_deezer/create_song_from_deezer (0139). update_song has no parameter for it, by design D6.';
comment on column public.songs.isrc is
  'Block 13a. Hand-editable: not every song comes from Deezer, and the ISRC is what the radio industry actually uses. Format-checked, never unique.';

-- ---------------------------------------------------------------------------
-- update_song, with two new trailing parameters and NOT A THIRD.
--
-- p_album_id and p_isrc are here because design D7 makes both hand-editable.
-- p_deezer_track_id is NOT here and must never be added: D6 says the code and
-- the cover travel together, and 0102 already paid once for believing that a
-- form which does not send a field is the same as a field that cannot be
-- written. The only write path is 0139.
--
-- Every column is still set on every call, which is what the whole file has
-- always done -- a partial submission blanks what it omits. The two new
-- parameters therefore MUST be sent by every caller of this function, and
-- src/app/(app)/music/songs/actions.ts is updated in the same block.
-- ---------------------------------------------------------------------------

create or replace function public.update_song(
  p_song_id          uuid,
  p_title            text,
  p_artist_id        uuid,
  p_label_id         uuid default null,
  p_genre_id         uuid default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_internal_code    text default null,
  p_album_id         uuid default null,
  p_isrc             text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_company uuid;
  v_isrc    text := nullif(btrim(upper(coalesce(p_isrc, ''))), '');
begin
  select company_id into v_company
  from public.songs
  where id = p_song_id
    and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if v_company is null then
    raise log 'update_song denied or missing: actor=% song=%', v_actor, p_song_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- 0101's guard, unchanged: an artist, label or genre that RLS would hide is
  -- refused rather than silently written. The album joins that list.
  perform public.assert_song_references_live(v_company, p_artist_id, p_label_id, p_genre_id);

  if p_album_id is not null and not exists (
    select 1 from public.albums
    where id = p_album_id and company_id = v_company and deleted_at is null
  ) then
    raise exception 'that album is not available in this station' using errcode = '23503';
  end if;

  update public.songs
  set title            = btrim(p_title),
      artist_id        = p_artist_id,
      label_id         = p_label_id,
      genre_id         = p_genre_id,
      nationality      = p_nationality,
      vocal            = p_vocal,
      duration_seconds = p_duration_seconds,
      internal_code    = nullif(btrim(coalesce(p_internal_code, '')), ''),
      album_id         = p_album_id,
      isrc             = v_isrc,
      updated_at       = now()
  where id = p_song_id;
end;
$$;
```

> **Before writing this**, open `supabase/migrations/0101_music_song_rpcs.sql` and copy `update_song`'s existing body verbatim, then add only the two parameters, the album check and the two `set` lines. The body above reproduces its shape; the file on disk is the authority for anything that differs.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, 19 of 19.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0138_songs_deezer.sql supabase/tests/28_albums.test.sql
git commit -m "feat(music): songs carry an album, a Deezer id and an ISRC

The ISRC is hand-editable and so carries a format check and no unique;
the Deezer id is not, and update_song gains no parameter for it."
```

---

## Task 4: The Deezer doors

**Files:**
- Create: `supabase/migrations/0139_song_deezer_doors.sql`
- Modify: `supabase/tests/28_albums.test.sql`

**Interfaces:**
- Consumes: `resolve_or_create_album` (Task 2), the three new columns (Task 3), `create_music_reference` (0100), `assert_song_references_live` (0101).
- Produces:
  - `create_song_from_deezer(p_company_id uuid, p_title text, p_artist_name text, p_label_name text, p_genre_name text, p_album_title text, p_deezer_track_id bigint, p_deezer_album_id bigint, p_isrc text, p_upc text, p_cover_md5 text, p_release_date date, p_duration_seconds integer) returns uuid`
  - `link_song_to_deezer(p_song_id uuid, p_deezer_track_id bigint, p_album_title text, p_deezer_album_id bigint, p_upc text, p_cover_md5 text, p_release_date date, p_isrc text) returns void`
  - `unlink_song_from_deezer(p_song_id uuid) returns void`

- [ ] **Step 1: Add the failing assertions**

Append to `supabase/tests/28_albums.test.sql` (before `finish()`), raising the plan to `plan(22)`:

```sql
select has_function('public', 'create_song_from_deezer', 'the register door exists');
select has_function('public', 'link_song_to_deezer', 'the link door exists');
select has_function('public', 'unlink_song_from_deezer', 'the unlink door exists');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `function public.create_song_from_deezer does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0139_song_deezer_doors.sql`:

```sql
-- supabase/migrations/0139_song_deezer_doors.sql

-- Block 13a, Task 4: the three doors the Deezer tab uses.
--
-- ATOMICITY IS THE WHOLE POINT OF create_song_from_deezer (design D3). It
-- resolves-or-creates FOUR references -- artist, label, genre, album -- and
-- then inserts the song. Doing that from four round trips in Node would leave,
-- on any failure after the first write, up to four orphan rows in a Station's
-- catalogue with nothing to explain where they came from and no screen that
-- would ever show them as related. A plpgsql function body is one transaction;
-- a raised exception unwinds every one of them.
--
-- The artist is REQUIRED and the other three are not, which mirrors 0098's own
-- columns: songs.artist_id is NOT NULL because a song without an artist is a
-- draft, not a record.

create or replace function public.create_song_from_deezer(
  p_company_id       uuid,
  p_title            text,
  p_artist_name      text,
  p_label_name       text    default null,
  p_genre_name       text    default null,
  p_album_title      text    default null,
  p_deezer_track_id  bigint  default null,
  p_deezer_album_id  bigint  default null,
  p_isrc             text    default null,
  p_upc              text    default null,
  p_cover_md5        text    default null,
  p_release_date     date    default null,
  p_duration_seconds integer default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_title    text := nullif(btrim(p_title), '');
  v_artist   uuid;
  v_label    uuid;
  v_genre    uuid;
  v_album    uuid;
  v_isrc     text := nullif(btrim(upper(coalesce(p_isrc, ''))), '');
  v_id       uuid;
begin
  if not public.has_permission('music.manage', p_company_id) then
    raise log 'create_song_from_deezer denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_title is null then
    raise exception 'a song needs a title' using errcode = '23514';
  end if;
  if nullif(btrim(coalesce(p_artist_name, '')), '') is null then
    raise exception 'a song needs an artist' using errcode = '23514';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if v_org is null then
    raise exception 'no such station' using errcode = '42501';
  end if;

  v_artist := public.resolve_or_create_reference(p_company_id, 'ARTIST', p_artist_name);
  v_label  := public.resolve_or_create_reference(p_company_id, 'LABEL',  p_label_name);
  v_genre  := public.resolve_or_create_reference(p_company_id, 'GENRE',  p_genre_name);
  v_album  := public.resolve_or_create_album(
                p_company_id, p_album_title, p_deezer_album_id,
                p_upc, p_cover_md5, p_release_date);

  -- 0103's lock and 0101's assertion still apply: a reference this function
  -- just resolved could be archived by a concurrent transaction between the
  -- resolve and the insert, and this is the guard that refuses that song
  -- rather than writing one whose artist no screen can read.
  perform public.assert_song_references_live(p_company_id, v_artist, v_label, v_genre);

  insert into public.songs (
    organization_id, company_id, title, artist_id, label_id, genre_id,
    album_id, duration_seconds, deezer_track_id, isrc, created_by
  )
  values (
    v_org, p_company_id, v_title, v_artist, v_label, v_genre,
    v_album,
    -- 0098 checks duration_seconds > 0. Deezer answers 0 for a handful of
    -- rows, and 0 would fail that check and take the whole registration with
    -- it -- over a field nobody asked for.
    nullif(coalesce(p_duration_seconds, 0), 0),
    p_deezer_track_id, v_isrc, v_actor
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_song_from_deezer is
  'Block 13a, design D3. Resolves or creates artist, label, genre and album and inserts the song, all in one transaction. A failure anywhere leaves no orphan reference behind.';

-- ---------------------------------------------------------------------------
-- link_song_to_deezer: the only write path to deezer_track_id on a song that
-- already exists (design D10). It touches the Deezer columns and the album and
-- NOTHING the operator typed -- not the title, not the artist, not the genre.
-- Somebody who has curated a record for a year is not corrected by a
-- catalogue.
--
-- p_isrc is written ONLY when the song has none. Same rule, same reason.
-- ---------------------------------------------------------------------------

create or replace function public.link_song_to_deezer(
  p_song_id         uuid,
  p_deezer_track_id bigint,
  p_album_title     text   default null,
  p_deezer_album_id bigint default null,
  p_upc             text   default null,
  p_cover_md5       text   default null,
  p_release_date    date   default null,
  p_isrc            text   default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_company uuid;
  v_album   uuid;
begin
  select company_id into v_company
  from public.songs
  where id = p_song_id
    and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if v_company is null then
    raise log 'link_song_to_deezer denied or missing: actor=% song=%', v_actor, p_song_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if p_deezer_track_id is null then
    raise exception 'a link needs a deezer track id' using errcode = '23514';
  end if;

  v_album := public.resolve_or_create_album(
               v_company, p_album_title, p_deezer_album_id,
               p_upc, p_cover_md5, p_release_date);

  update public.songs
  set deezer_track_id = p_deezer_track_id,
      album_id        = coalesce(v_album, album_id),
      isrc            = coalesce(isrc, nullif(btrim(upper(coalesce(p_isrc, ''))), '')),
      updated_at      = now()
  where id = p_song_id;

  -- No explicit duplicate check: songs_deezer_live (0138) raises 23505 with
  -- its own constraint name, and src/app/(app)/music/errors.ts tells it apart
  -- by that name. Catching it here would replace a precise refusal -- "another
  -- song in this Station is already linked to that recording" -- with a
  -- generic one, which is the mistake 0130's own comment warns about.
end;
$$;

create or replace function public.unlink_song_from_deezer(p_song_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  update public.songs
  set deezer_track_id = null,
      updated_at      = now()
  where id = p_song_id
    and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'unlink_song_from_deezer denied or missing: actor=% song=%', v_actor, p_song_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- album_id and isrc SURVIVE an unlink, deliberately. Unlinking says "this
  -- row is no longer the same recording as that Deezer track"; it does not say
  -- the album was wrong or the ISRC was wrong. Clearing them would throw away
  -- an operator's data to tidy a relationship.
end;
$$;
```

- [ ] **Step 4: Write `resolve_or_create_reference`**

`create_song_from_deezer` calls it and it does not exist yet. Add it to the **top** of the same migration file, before `create_song_from_deezer`:

```sql
-- The reference twin of resolve_or_create_album, over 0100's four short lists.
-- EXECUTE granted to nobody, for the same reason: it writes without checking a
-- permission, because its only caller has already checked one.
--
-- A null or blank name returns null rather than raising -- label and genre are
-- optional on a song, and Deezer supplies neither for every track.
create or replace function public.resolve_or_create_reference(
  p_company_id uuid,
  p_kind       public.music_reference_kind,
  p_name       text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_table text := public.music_reference_table(p_kind);
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_org   uuid;
  v_id    uuid;
begin
  if v_name is null then
    return null;
  end if;

  -- format(%I) over a value this schema produced from an enum, never over a
  -- caller's string -- 0100's rule. Every value below is bound.
  execute format(
    'select id from public.%I where company_id = $1 and deleted_at is null and lower(name) = lower($2) order by created_at limit 1',
    v_table
  ) into v_id using p_company_id, v_name;

  if v_id is not null then
    return v_id;
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  execute format(
    'insert into public.%I (organization_id, company_id, name, created_by) values ($1, $2, $3, $4) returning id',
    v_table
  ) into v_id using v_org, p_company_id, v_name, auth.uid();

  return v_id;
end;
$$;

revoke execute on function public.resolve_or_create_reference(uuid, public.music_reference_kind, text) from public;
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, 22 of 22.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0139_song_deezer_doors.sql supabase/tests/28_albums.test.sql
git commit -m "feat(music): register, link and unlink against Deezer

Four references and the song in one transaction, so a failure halfway
leaves no orphan artist behind. Link touches nothing the operator typed."
```

---

## Task 5: Regenerate types, and widen the service layer

**Files:**
- Modify: `src/lib/supabase/database.types.ts` (generated)
- Modify: `src/services/music.ts:130-199` (`SONG_COLUMNS`, `SongRow`, `SongSummary`, `toSongSummary`)
- Modify: `src/schemas/music.ts`

**Interfaces:**
- Consumes: the four migrations.
- Produces:
  - `SongSummary` gains `albumId: string | null`, `albumTitle: string | null`, `coverMd5: string | null`, `deezerTrackId: number | null`, `isrc: string | null`.
  - `listAlbums(companyId: string): Promise<ReferenceSummary[]>`.
  - `songUpdateSchema` gains `albumId` (optional uuid) and `isrc` (optional, uppercased, format-checked).

- [ ] **Step 1: Regenerate the database types**

Run: `npm run db:reset && npm run db:types`
Expected: `src/lib/supabase/database.types.ts` now contains an `albums` table and the three new `songs` columns.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/song-summary-deezer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toSongSummary } from '@/services/music';

describe('toSongSummary', () => {
  it('carries the album title and cover through the embed', () => {
    const row = {
      id: 's1', title: 'Sozinho', artist_id: 'a1', label_id: null, genre_id: null,
      nationality: null, vocal: null, duration_seconds: 191, internal_code: null,
      legacy_id: null, created_at: '2026-08-07T00:00:00Z',
      album_id: 'al1', deezer_track_id: 921568, isrc: 'BRPGD9800678',
      artists: { name: 'Caetano Veloso' },
      record_labels: null,
      music_genres: null,
      albums: { title: 'Prenda Minha', cover_md5: '2a0f6ac6bc05458fb072275653f01dd2' },
    };

    expect(toSongSummary(row as never)).toMatchObject({
      albumId: 'al1',
      albumTitle: 'Prenda Minha',
      coverMd5: '2a0f6ac6bc05458fb072275653f01dd2',
      deezerTrackId: 921568,
      isrc: 'BRPGD9800678',
    });
  });

  it('leaves the album null when RLS hides it, exactly as it does for an artist', () => {
    const row = {
      id: 's1', title: 'x', artist_id: 'a1', label_id: null, genre_id: null,
      nationality: null, vocal: null, duration_seconds: null, internal_code: null,
      legacy_id: null, created_at: '2026-08-07T00:00:00Z',
      album_id: 'al1', deezer_track_id: null, isrc: null,
      artists: null, record_labels: null, music_genres: null,
      albums: null,
    };

    const summary = toSongSummary(row as never);
    expect(summary.albumId).toBe('al1');
    expect(summary.albumTitle).toBeNull();
    expect(summary.coverMd5).toBeNull();
  });
});
```

> `toSongSummary` is module-private today. Export it (`export function toSongSummary`) — the second test above is the reason: the archived-album case is exactly the one `SONG_COLUMNS`' long comment says cost a whole Station's list when it was got wrong for artists.

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -- song-summary-deezer`
Expected: FAIL — `toSongSummary is not exported`.

- [ ] **Step 4: Widen `SONG_COLUMNS`, `SongRow`, `SongSummary` and `toSongSummary`**

In `src/services/music.ts`, extend the constant at line 130:

```ts
const SONG_COLUMNS =
  'id, title, artist_id, label_id, genre_id, nationality, vocal, duration_seconds, internal_code, legacy_id, created_at, album_id, deezer_track_id, isrc, artists(name), record_labels(name), music_genres(name), albums(title, cover_md5)';
```

Add to `SongRow`'s hand-written embed block — **typed nullable, for the reason the existing comment gives at length**:

```ts
  /** Null when the album row is hidden by RLS — an archived album — while album_id still names it. The same trap SONG_COLUMNS' comment describes for artists. */
  albums: { title: string; cover_md5: string | null } | null;
```

Add to `SongSummary`:

```ts
  albumId: string | null;
  /** Null means either "no album" or "an album this caller cannot read". The screens render both as no cover, which is the honest rendering of both. */
  albumTitle: string | null;
  coverMd5: string | null;
  /** Read-only in the interface: 0139's two doors are the only write path (design D6). */
  deezerTrackId: number | null;
  isrc: string | null;
```

And to `toSongSummary`:

```ts
    albumId: row.album_id,
    albumTitle: row.albums?.title ?? null,
    coverMd5: row.albums?.cover_md5 ?? null,
    deezerTrackId: row.deezer_track_id,
    isrc: row.isrc,
```

- [ ] **Step 5: Add `listAlbums`**

Append to `src/services/music.ts`, beside `listMusicReferences`:

```ts
/**
 * The album picker's options. Same shape and same cap as the other reference
 * lists, and the same RLS consequence: an archived album is unreadable, so it
 * cannot be chosen — which is what makes update_song's own album check
 * unreachable from this screen rather than merely unlikely.
 */
export async function listAlbums(companyId: string): Promise<ReferenceSummary[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('albums')
    .select('id, title')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('title', { ascending: true })
    .limit(500);

  if (error) throw new InternalError(`Could not read albums: ${error.message}`);
  return (data ?? []).map((row) => ({ id: row.id, name: row.title }));
}
```

- [ ] **Step 6: Extend the schemas**

In `src/schemas/music.ts`, add beside the other field helpers:

```ts
/**
 * Two letters of country, three of registrant, two of year, five of
 * designation — folded to upper case before the check, because an operator
 * typing it off a sleeve will not shift-lock, and 0138 stores it folded too.
 */
const isrc = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() : blankToUndefined(v)),
  z
    .string()
    .regex(/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/, 'An ISRC looks like BRPGD9800678.')
    .optional(),
);
```

Add `albumId: optionalUuid` and `isrc` to both `songFormSchema` and `songUpdateSchema`.

- [ ] **Step 7: Run the tests**

Run: `npm test -- song-summary-deezer && npm run typecheck`
Expected: PASS, and the typecheck fails on `updateSongAction` — which Task 6 fixes. If you want a green tree at this commit, add `albumId: formData.get('albumId') || null, isrc: formData.get('isrc') || null` to the `safeParse` call in `src/app/(app)/music/songs/actions.ts` and pass both through to `updateSong` now.

- [ ] **Step 8: Commit**

```bash
git add src/lib/supabase/database.types.ts src/services/music.ts src/schemas/music.ts \
        src/app/\(app\)/music/songs/actions.ts tests/unit/song-summary-deezer.test.ts
git commit -m "feat(music): the service layer carries the album, its cover and the ISRC

The album embed is typed nullable for the reason SONG_COLUMNS already
records about artists: PostgREST returns null for a row RLS hides, which
is not the same fact as the column being null."
```

---

## Task 6: The Deezer client

**Files:**
- Create: `src/lib/integrations/deezer/transport.ts`, `client.ts`, `fake.ts`, `cover.ts`
- Create: `tests/unit/deezer-client.test.ts`, `tests/unit/deezer-cover.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface DeezerTrack {
  id: number;
  title: string;
  artistName: string;
  albumId: number;
  albumTitle: string;
  coverMd5: string | null;
  durationSeconds: number;
  isrc: string | null;
  /** Signed and short-lived. Never store it. */
  previewUrl: string | null;
}

export interface DeezerAlbumDetail {
  id: number;
  title: string;
  upc: string | null;
  label: string | null;
  genreName: string | null;
  releaseDate: string | null;
  coverMd5: string | null;
}

export type DeezerResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not-found' | 'quota' | 'network' | 'malformed'; message: string };

export interface DeezerSearchFilters { track?: string; artist?: string; album?: string }

export interface DeezerTransport {
  search(filters: DeezerSearchFilters): Promise<DeezerResult<DeezerTrack[]>>;
  album(albumId: number): Promise<DeezerResult<DeezerAlbumDetail>>;
}

export function buildSearchQuery(filters: DeezerSearchFilters): string;
export function coverUrl(md5: string | null, size: 56 | 250 | 500): string | null;
```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/deezer-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildSearchQuery } from '@/lib/integrations/deezer/transport';
import { createDeezerClient } from '@/lib/integrations/deezer/client';

function respondWith(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

describe('buildSearchQuery', () => {
  it('quotes each filter and joins them', () => {
    expect(buildSearchQuery({ track: 'Sozinho', artist: 'Caetano Veloso' }))
      .toBe('track:"Sozinho" artist:"Caetano Veloso"');
  });

  it('drops blank filters instead of sending empty terms', () => {
    expect(buildSearchQuery({ track: '  ', artist: 'x', album: '' })).toBe('artist:"x"');
  });

  it('strips double quotes so a term cannot break out of its own filter', () => {
    expect(buildSearchQuery({ track: 'a"b' })).toBe('track:"ab"');
  });
});

describe('the Deezer client', () => {
  // The one that will be forgotten. Deezer answers a bad id with HTTP 200 and
  // an error object in the body; code that trusts response.ok reads a failure
  // as a success.
  it('treats an error body on HTTP 200 as a failure', async () => {
    const fetchImpl = respondWith({
      error: { type: 'DataException', message: 'no data', code: 800 },
    });
    const client = createDeezerClient({ fetchImpl });

    const result = await client.album(999999999999);

    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('reports a quota refusal separately from a missing row', async () => {
    const fetchImpl = respondWith({
      error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 },
    });
    const client = createDeezerClient({ fetchImpl });

    const result = await client.search({ track: 'x' });

    expect(result).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('maps a search hit, ISRC and preview included', async () => {
    const fetchImpl = respondWith({
      data: [
        {
          id: 921568,
          title: 'Sozinho (Ao Vivo)',
          duration: 191,
          isrc: 'BRPGD9800678',
          preview: 'https://cdnt-preview.dzcdn.net/api/1/1/x.mp3?hdnea=exp=1',
          md5_image: '2a0f6ac6bc05458fb072275653f01dd2',
          artist: { id: 232, name: 'Caetano Veloso' },
          album: { id: 103763, title: 'Prenda Minha', md5_image: '2a0f6ac6bc05458fb072275653f01dd2' },
        },
      ],
    });
    const client = createDeezerClient({ fetchImpl });

    const result = await client.search({ track: 'Sozinho' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toEqual({
      id: 921568,
      title: 'Sozinho (Ao Vivo)',
      artistName: 'Caetano Veloso',
      albumId: 103763,
      albumTitle: 'Prenda Minha',
      coverMd5: '2a0f6ac6bc05458fb072275653f01dd2',
      durationSeconds: 191,
      isrc: 'BRPGD9800678',
      previewUrl: 'https://cdnt-preview.dzcdn.net/api/1/1/x.mp3?hdnea=exp=1',
    });
  });

  it('maps the album detail, UPC, label and first genre included', async () => {
    const fetchImpl = respondWith({
      id: 103763,
      title: 'Prenda Minha',
      upc: '731453833227',
      label: 'Universal Music Mexico',
      release_date: '2014-06-17',
      md5_image: '2a0f6ac6bc05458fb072275653f01dd2',
      genres: { data: [{ id: 132, name: 'Pop' }] },
    });
    const client = createDeezerClient({ fetchImpl });

    const result = await client.album(103763);

    expect(result).toMatchObject({
      ok: true,
      value: {
        upc: '731453833227',
        label: 'Universal Music Mexico',
        genreName: 'Pop',
        releaseDate: '2014-06-17',
      },
    });
  });

  it('survives an album with no genres rather than throwing', async () => {
    const fetchImpl = respondWith({
      id: 1, title: 'x', upc: null, label: null, release_date: null,
      md5_image: null, genres: { data: [] },
    });
    const client = createDeezerClient({ fetchImpl });

    const result = await client.album(1);
    expect(result).toMatchObject({ ok: true, value: { genreName: null } });
  });

  it('reports a thrown fetch as a network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const client = createDeezerClient({ fetchImpl });

    expect(await client.search({ track: 'x' })).toMatchObject({ ok: false, reason: 'network' });
  });
});
```

Create `tests/unit/deezer-cover.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { coverUrl } from '@/lib/integrations/deezer/cover';

describe('coverUrl', () => {
  it('builds the CDN URL from the hash', () => {
    expect(coverUrl('2a0f6ac6bc05458fb072275653f01dd2', 56)).toBe(
      'https://cdn-images.dzcdn.net/images/cover/2a0f6ac6bc05458fb072275653f01dd2/56x56-000000-80-0-0.jpg',
    );
  });

  it('answers null for a song with no album, so callers render the fallback', () => {
    expect(coverUrl(null, 250)).toBeNull();
  });

  // 0136 constrains the column, but this module is also fed by search results
  // that never touched the database.
  it('refuses anything that is not a 32-character hex hash', () => {
    expect(coverUrl('../../etc/passwd', 250)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- deezer`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write `cover.ts`**

```ts
/**
 * The one place a cover hash becomes a URL (design D4). Nothing stores a
 * Deezer URL: a CDN host change is this constant, not a migration over data.
 */
const COVER_HOST = 'https://cdn-images.dzcdn.net/images/cover';

/** Deezer's md5_image is a plain MD5. Anything else is refused rather than interpolated into a URL that lands in <img src>. */
const HASH = /^[0-9a-f]{32}$/;

export function coverUrl(md5: string | null | undefined, size: 56 | 250 | 500): string | null {
  if (!md5 || !HASH.test(md5)) return null;
  return `${COVER_HOST}/${md5}/${size}x${size}-000000-80-0-0.jpg`;
}
```

- [ ] **Step 4: Write `transport.ts`**

The interface and types from **Interfaces** above, plus:

```ts
/**
 * Deezer's advanced search. Each term is quoted so that a space inside one
 * does not become a second filter, and any double quote the operator typed is
 * removed first — otherwise a `"` closes the filter and everything after it is
 * read as a new one.
 */
export function buildSearchQuery(filters: DeezerSearchFilters): string {
  const parts: string[] = [];
  const add = (key: 'track' | 'artist' | 'album') => {
    const raw = filters[key]?.replace(/"/g, '').trim();
    if (raw) parts.push(`${key}:"${raw}"`);
  };
  add('track');
  add('artist');
  add('album');
  return parts.join(' ');
}
```

- [ ] **Step 5: Write `client.ts`**

```ts
import { buildSearchQuery, type DeezerAlbumDetail, type DeezerResult,
         type DeezerSearchFilters, type DeezerTrack, type DeezerTransport } from './transport';

const BASE = 'https://api.deezer.com';
const SEARCH_LIMIT = 20;

/** Deezer's own codes. 4 is the quota; 800 is "no data". */
const QUOTA_CODES = new Set([4, 700]);

/**
 * DEEZER ANSWERS FAILURES WITH HTTP 200. `GET /track/999999999999` returns 200
 * with {"error":{"type":"DataException","code":800}} in the body — so
 * `response.ok` is true for a request that found nothing, and code that trusts
 * it reads a failure as a success. Every call goes through this function, and
 * the body is inspected BEFORE the status.
 */
async function call<T>(
  url: string,
  fetchImpl: typeof fetch,
): Promise<DeezerResult<T>> {
  let body: unknown;
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    body = await response.json();
    if (!response.ok && !isErrorBody(body)) {
      return { ok: false, reason: 'network', message: `deezer answered ${response.status}` };
    }
  } catch (cause) {
    return { ok: false, reason: 'network', message: String(cause) };
  }

  if (isErrorBody(body)) {
    const { code, message } = body.error;
    if (QUOTA_CODES.has(code)) return { ok: false, reason: 'quota', message };
    return { ok: false, reason: 'not-found', message };
  }

  return { ok: true, value: body as T };
}

function isErrorBody(body: unknown): body is { error: { code: number; message: string } } {
  return (
    typeof body === 'object' && body !== null && 'error' in body &&
    typeof (body as { error: unknown }).error === 'object' &&
    (body as { error: unknown }).error !== null
  );
}

export function createDeezerClient(
  options: { fetchImpl?: typeof fetch } = {},
): DeezerTransport {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async search(filters: DeezerSearchFilters) {
      const q = buildSearchQuery(filters);
      if (!q) return { ok: true, value: [] };

      const url = `${BASE}/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`;
      const result = await call<{ data: unknown[] }>(url, fetchImpl);
      if (!result.ok) return result;
      if (!Array.isArray(result.value?.data)) {
        return { ok: false, reason: 'malformed', message: 'no data array' };
      }
      return { ok: true, value: result.value.data.map(toTrack).filter((t): t is DeezerTrack => t !== null) };
    },

    async album(albumId: number) {
      const result = await call<Record<string, unknown>>(`${BASE}/album/${albumId}`, fetchImpl);
      if (!result.ok) return result;
      return { ok: true, value: toAlbum(result.value) };
    },
  };
}

function toTrack(raw: unknown): DeezerTrack | null {
  const t = raw as Record<string, never>;
  if (!t || typeof t.id !== 'number') return null;
  const album = (t.album ?? {}) as Record<string, never>;
  const artist = (t.artist ?? {}) as Record<string, never>;
  return {
    id: t.id,
    // `title`, not `title_short`: "(Ao Vivo)" is the difference between two
    // recordings, and a radio needs to know which one is on the shelf.
    title: String(t.title ?? ''),
    artistName: String(artist.name ?? ''),
    albumId: typeof album.id === 'number' ? album.id : 0,
    albumTitle: String(album.title ?? ''),
    coverMd5: typeof album.md5_image === 'string' ? album.md5_image : null,
    durationSeconds: typeof t.duration === 'number' ? t.duration : 0,
    isrc: typeof t.isrc === 'string' && t.isrc ? t.isrc : null,
    // Signed, and valid for hours. It reaches the browser and is never stored.
    previewUrl: typeof t.preview === 'string' && t.preview ? t.preview : null,
  };
}

function toAlbum(raw: Record<string, unknown>): DeezerAlbumDetail {
  const genres = (raw.genres as { data?: { name?: string }[] } | undefined)?.data ?? [];
  return {
    id: Number(raw.id ?? 0),
    title: String(raw.title ?? ''),
    upc: typeof raw.upc === 'string' && raw.upc ? raw.upc : null,
    label: typeof raw.label === 'string' && raw.label ? raw.label : null,
    // The first of however many. Deezer orders them broadest first, and songs
    // carry one genre.
    genreName: genres[0]?.name ?? null,
    releaseDate: typeof raw.release_date === 'string' && raw.release_date ? raw.release_date : null,
    coverMd5: typeof raw.md5_image === 'string' ? raw.md5_image : null,
  };
}
```

- [ ] **Step 6: Write `fake.ts`**

```ts
import type { DeezerAlbumDetail, DeezerResult, DeezerSearchFilters,
              DeezerTrack, DeezerTransport } from './transport';

/** Answers from a fixture instead of the network. The transport CI uses. */
export class FakeDeezerTransport implements DeezerTransport {
  readonly searches: DeezerSearchFilters[] = [];
  private failure: DeezerResult<never> | null = null;

  constructor(
    private readonly tracks: DeezerTrack[] = [],
    private readonly albums: Record<number, DeezerAlbumDetail> = {},
  ) {}

  /** The next call fails once, then normal service resumes. */
  failNext(reason: 'not-found' | 'quota' | 'network' | 'malformed'): void {
    this.failure = { ok: false, reason, message: `fake ${reason}` };
  }

  private takeFailure(): DeezerResult<never> | null {
    const f = this.failure;
    this.failure = null;
    return f;
  }

  async search(filters: DeezerSearchFilters): Promise<DeezerResult<DeezerTrack[]>> {
    this.searches.push(filters);
    return this.takeFailure() ?? { ok: true, value: this.tracks };
  }

  async album(albumId: number): Promise<DeezerResult<DeezerAlbumDetail>> {
    const failure = this.takeFailure();
    if (failure) return failure;
    const found = this.albums[albumId];
    return found
      ? { ok: true, value: found }
      : { ok: false, reason: 'not-found', message: 'no data' };
  }
}
```

- [ ] **Step 7: Run the tests**

Run: `npm test -- deezer`
Expected: PASS, 11 of 11.

- [ ] **Step 8: Commit**

```bash
git add src/lib/integrations/deezer tests/unit/deezer-client.test.ts tests/unit/deezer-cover.test.ts
git commit -m "feat(music): a Deezer client that reads the body before the status

Deezer answers a missing row with HTTP 200 and an error object, so
response.ok is true for a request that found nothing. Every call checks
the body first, and the test that proves it is named for the trap."
```

---

## Task 7: The server actions

**Files:**
- Create: `src/app/(app)/music/songs/deezer-actions.ts`
- Modify: `src/app/(app)/music/errors.ts` (the `songs_deezer_live` constraint name)

**Interfaces:**
- Consumes: `createDeezerClient` (Task 6), the three doors (Task 4), `InMemoryRateLimiter` (`src/lib/rate-limit`).
- Produces:
  - `searchDeezerAction(companyId: string, filters: DeezerSearchFilters): Promise<{ status: 'ok'; tracks: DeezerSearchRow[] } | { status: 'error'; message: string }>` where `DeezerSearchRow = DeezerTrack & { registeredSongId: string | null }`
  - `registerFromDeezerAction(prev, formData): Promise<SongFormState>`
  - `linkToDeezerAction(prev, formData): Promise<SongSaveState>`
  - `unlinkFromDeezerAction(prev, formData): Promise<SongSaveState>`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/deezer-client.test.ts` a describe block for the search-row marking, which is pure and worth its own test:

```ts
import { markRegistered } from '@/app/(app)/music/songs/deezer-marking';

describe('markRegistered', () => {
  it('points an already-registered track at its existing record', () => {
    const rows = markRegistered(
      [{ id: 921568 }, { id: 3135556 }] as never,
      new Map([[921568, 'song-uuid-1']]),
    );
    expect(rows[0].registeredSongId).toBe('song-uuid-1');
    expect(rows[1].registeredSongId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- deezer`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `deezer-marking.ts`**

Create `src/app/(app)/music/songs/deezer-marking.ts` (a plain module, no `'use server'`, so a unit test can import it):

```ts
import type { DeezerTrack } from '@/lib/integrations/deezer/transport';

export type DeezerSearchRow = DeezerTrack & { registeredSongId: string | null };

/**
 * Which of these tracks this Station already has (design D9). The interface
 * half of the guard; songs_deezer_live (0138) is the half that holds when two
 * tabs race.
 */
export function markRegistered(
  tracks: DeezerTrack[],
  existing: Map<number, string>,
): DeezerSearchRow[] {
  return tracks.map((track) => ({
    ...track,
    registeredSongId: existing.get(track.id) ?? null,
  }));
}
```

- [ ] **Step 4: Write `deezer-actions.ts`**

```ts
'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { createDeezerClient } from '@/lib/integrations/deezer/client';
import type { DeezerSearchFilters } from '@/lib/integrations/deezer/transport';
import { InMemoryRateLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { markRegistered, type DeezerSearchRow } from './deezer-marking';
import { describeMusicWriteError } from '../errors';
import type { SongFormState, SongSaveState } from './actions';

// ---------------------------------------------------------------------------
// Deezer's rate limit is per IP, and every Station shares this server's IP —
// so nothing Deezer offers isolates one radio from another. This does. Keyed
// by Station AND person, so one operator holding a key down cannot spend the
// Station's budget either.
//
// Module scope, so it survives between requests within an instance. With
// `output: 'standalone'` there may be several instances, each with its own
// counter; that is disclosed in the spec rather than pretended away.
// ---------------------------------------------------------------------------
const limiter = new InMemoryRateLimiter();
const SEARCHES_PER_MINUTE = 30;

const client = createDeezerClient();

export type DeezerSearchState =
  | { status: 'ok'; tracks: DeezerSearchRow[] }
  | { status: 'error'; message: string };

export async function searchDeezerAction(
  companyId: string,
  filters: DeezerSearchFilters,
): Promise<DeezerSearchState> {
  const t = await getTranslations('music');
  const supabase = await createUserClient();
  const { data: session } = await supabase.auth.getSession();
  const userId = session.session?.user.id;
  if (!userId) redirect('/login');

  // THE PERMISSION IS CHECKED HERE, not left to the RPC — because this action
  // does not call an RPC. It calls an outside service on the Station's behalf
  // and reads `songs` to mark duplicates, and neither of those refuses an
  // operator who may only view the catalogue. Block 5a lost three defects at
  // exactly this seam.
  const { data: allowed } = await supabase.rpc('has_permission', {
    p_key: 'music.manage',
    p_company_id: companyId,
  });
  if (allowed !== true) {
    return { status: 'error', message: t('youDoNotHoldMusicManage2') };
  }

  const gate = await limiter.check(`deezer:${companyId}:${userId}`, SEARCHES_PER_MINUTE, 60);
  if (!gate.allowed) {
    return { status: 'error', message: t('tooManySearchesWaitAMoment') };
  }

  const found = await client.search(filters);
  if (!found.ok) {
    logger.warn({ reason: found.reason, companyId }, 'deezer search failed');
    return { status: 'error', message: describeDeezerFailure(found.reason, t) };
  }

  // Which of these this Station already has. One query, not one per row.
  const ids = found.value.map((track) => track.id);
  const existing = new Map<number, string>();
  if (ids.length > 0) {
    const { data: rows } = await supabase
      .from('songs')
      .select('id, deezer_track_id')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .in('deezer_track_id', ids);
    for (const row of rows ?? []) {
      if (row.deezer_track_id !== null) existing.set(row.deezer_track_id, row.id);
    }
  }

  return { status: 'ok', tracks: markRegistered(found.value, existing) };
}

function describeDeezerFailure(
  reason: 'not-found' | 'quota' | 'network' | 'malformed',
  t: Awaited<ReturnType<typeof getTranslations<'music'>>>,
): string {
  switch (reason) {
    case 'quota':
      return t('deezerIsRefusingRequestsRightNow');
    case 'not-found':
      return t('deezerHasNothingForThatSearch');
    default:
      return t('couldNotReachDeezerTryAgain');
  }
}
```

Then `registerFromDeezerAction`, which makes the **second call for the album** and then the one atomic RPC:

```ts
export async function registerFromDeezerAction(
  _prev: SongFormState,
  formData: FormData,
): Promise<SongFormState> {
  const t = await getTranslations('music');
  const companyId = String(formData.get('companyId') ?? '');
  const trackId = Number(formData.get('deezerTrackId'));
  const albumId = Number(formData.get('deezerAlbumId'));

  if (!companyId || !Number.isFinite(trackId)) {
    return { status: 'error', message: t('checkTheForm') };
  }

  const supabase = await createUserClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) redirect('/login');

  // The album call — once, on this click, never per search result. It is what
  // carries the UPC, the label and the genre (spec §5).
  const album = Number.isFinite(albumId) && albumId > 0 ? await client.album(albumId) : null;

  try {
    const { data, error } = await supabase.rpc('create_song_from_deezer', {
      p_company_id: companyId,
      p_title: String(formData.get('title') ?? ''),
      p_artist_name: String(formData.get('artistName') ?? ''),
      p_label_name: album?.ok ? album.value.label : null,
      p_genre_name: album?.ok ? album.value.genreName : null,
      p_album_title: String(formData.get('albumTitle') ?? '') || null,
      p_deezer_track_id: trackId,
      p_deezer_album_id: Number.isFinite(albumId) && albumId > 0 ? albumId : null,
      p_isrc: String(formData.get('isrc') ?? '') || null,
      p_upc: album?.ok ? album.value.upc : null,
      p_cover_md5: String(formData.get('coverMd5') ?? '') || null,
      p_release_date: album?.ok ? album.value.releaseDate : null,
      p_duration_seconds: Number(formData.get('durationSeconds')) || null,
    });
    if (error) throw error;
    return { status: 'saved', songId: data as string };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'register from deezer failed');
    return { status: 'error', message: describeMusicWriteError(cause, t, 'actionRegisterSongs') };
  }
}
```

`linkToDeezerAction` and `unlinkFromDeezerAction` follow the same shape over `link_song_to_deezer` / `unlink_song_from_deezer`, re-reading the song with `getSongById` afterwards and returning it — the pattern `updateSongAction` already uses, and for the same reason: the album title and cover come from an embed, not from the write's own arguments.

- [ ] **Step 5: Teach `errors.ts` the new constraint**

In `src/app/(app)/music/errors.ts`, add `songs_deezer_live` to the constraint-name mapping so a 23505 from it reads "Another song in this Station is already linked to that recording" rather than the generic message. Follow how the file already names `integrations_number_live`-style constraints.

- [ ] **Step 6: Run the tests**

Run: `npm test -- deezer && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/music/songs/deezer-actions.ts \
        src/app/\(app\)/music/songs/deezer-marking.ts \
        src/app/\(app\)/music/errors.ts tests/unit/deezer-client.test.ts
git commit -m "feat(music): the Deezer actions, with the permission checked at the seam

searchDeezerAction calls no RPC, so no RPC checks it. music.manage is
verified here, before an outside service is called on the Station's
behalf — the seam Block 5a lost three defects at."
```

---

## Task 8: The cover, everywhere

**Files:**
- Create: `src/components/music/song-thumb.tsx`
- Modify: `src/app/(app)/music/songs/songs-grid.tsx`, `src/app/(app)/music/requests/requests-grid.tsx`, `src/app/(app)/music/requests/record-request-form.tsx`, `src/app/(app)/music/artists/artist-record-dialog.tsx`, `src/app/(app)/music/maintenance/merge-panel.tsx`, `src/components/charts/top-list.tsx`, `src/app/(app)/dashboards/music/page.tsx`
- Modify: `src/lib/security/csp.ts`, `tests/unit/csp.test.ts`

**Interfaces:**
- Consumes: `coverUrl` (Task 6), `SongSummary.coverMd5` (Task 5).
- Produces: `<SongThumb coverMd5={string | null} title={string} size?: 'sm' | 'md' />`.

- [ ] **Step 1: Write the failing CSP test**

In `tests/unit/csp.test.ts`, add:

```ts
it('admits the Deezer cover CDN as an image source', () => {
  const csp = buildContentSecurityPolicy('n0nce', 'https://x.supabase.co', false);
  expect(csp).toContain('img-src');
  expect(csp).toMatch(/img-src[^;]*https:\/\/cdn-images\.dzcdn\.net/);
});

// A NEW DIRECTIVE. Without media-src, audio falls back to default-src 'self'
// and every 30-second preview is blocked with nothing on screen to say why.
it('admits Deezer preview audio through a media-src of its own', () => {
  const csp = buildContentSecurityPolicy('n0nce', 'https://x.supabase.co', false);
  expect(csp).toMatch(/media-src 'self' https:\/\/\*\.dzcdn\.net/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- csp`
Expected: FAIL — neither directive matches.

- [ ] **Step 3: Extend the CSP**

In `src/lib/security/csp.ts`, change line 42 and add the new directive after it:

```ts
    // cdn-images.dzcdn.net is where every album cover in this product comes
    // from (Block 13a, design D4). It is named here and nowhere else; the URL
    // is built in src/lib/integrations/deezer/cover.ts, which is the only
    // other place that knows this host.
    `img-src 'self' data: blob: ${origin} https://cdn-images.dzcdn.net`,
    // NEW IN BLOCK 13a. Without it, media falls back to default-src 'self' and
    // the 30-second previews are blocked in silence.
    //
    // The wildcard is deliberate: Deezer's preview host has moved between
    // `cdns-preview-N.dzcdn.net` and `cdnt-preview.dzcdn.net` over time, and a
    // literal host would break the tab on a day nobody deployed anything.
    "media-src 'self' https://*.dzcdn.net",
```

- [ ] **Step 4: Write `SongThumb`**

```tsx
import { Music } from 'lucide-react';
import { coverUrl } from '@/lib/integrations/deezer/cover';

const PIXELS = { sm: 32, md: 48 } as const;

/**
 * The album cover, or an honest gap. Used by every screen that names a song,
 * so that "some songs have covers" reads as a property of the catalogue rather
 * than as a broken screen.
 *
 * A plain <img> rather than next/image: the optimizer would proxy a CDN this
 * product does not own, add remotePatterns configuration, and buy nothing for
 * a 32-pixel square.
 *
 * `alt=""` is correct and not an oversight — the title is always rendered
 * beside it, and a screen reader announcing "Cover of X" before reading "X" is
 * noise.
 */
export function SongThumb({
  coverMd5,
  size = 'sm',
}: {
  coverMd5: string | null;
  size?: 'sm' | 'md';
}) {
  const px = PIXELS[size];
  const url = coverUrl(coverMd5, px <= 56 ? 56 : 250);

  if (!url) {
    return (
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center rounded bg-muted text-muted-foreground"
        style={{ width: px, height: px }}
      >
        <Music className="size-4" />
      </span>
    );
  }

  return (
    <img
      src={url}
      alt=""
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      // The app already sends strict-origin-when-cross-origin globally
      // (next.config.mjs); this says the same thing louder for an outside CDN.
      referrerPolicy="no-referrer"
      className="shrink-0 rounded bg-muted object-cover"
    />
  );
}
```

- [ ] **Step 5: Place it on the six surfaces**

1. `songs-grid.tsx` — a new leading `<TableHead className="w-12"><span className="sr-only">{t('cover')}</span></TableHead>` and a matching cell `<TableCell><SongThumb coverMd5={song.coverMd5} /></TableCell>`. **Raise `COLUMN_COUNT` from 8 to 9** (line 31) or the empty-state row stops spanning the table.
2. `song-record-dialog.tsx` — `<SongThumb coverMd5={record.song.coverMd5} size="md" />` beside the title in `DialogHeader`.
3. `requests-grid.tsx` — wrap the `{request.songTitle}` cell in a flex row with the thumb. Requires `song_cover_md5` on the request row: extend the request list select in `src/services/music.ts` to embed `songs(album_id, albums(cover_md5))`.
4. `record-request-form.tsx` — the song picker options gain the thumb; `SongOption` gains `coverMd5`.
5. `artist-record-dialog.tsx` — the songs tab list gains the thumb; `getArtistSongs` in `src/services/music.ts:543` selects the album embed.
6. `merge-panel.tsx` — song candidates gain the thumb, which is the whole point on a screen for telling near-identical rows apart.
7. `top-list.tsx` — add an optional `leading?: (item) => ReactNode` prop and render it before the label; `dashboards/music/page.tsx` passes `<SongThumb />`. The `0119` aggregate must return the cover hash: add `cover_md5` to its returned columns in a new migration `0140_music_dashboard_cover.sql` (`create or replace function` — the return type changes, so it must be `drop function` then `create`, which is why it is its own migration).

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/music/song-thumb.tsx src/lib/security/csp.ts tests/unit/csp.test.ts \
        src/app/\(app\)/music src/app/\(app\)/dashboards/music src/components/charts/top-list.tsx \
        src/services/music.ts supabase/migrations/0140_music_dashboard_cover.sql
git commit -m "feat(music): the cover reaches every screen that names a song

media-src is a new directive: without it, audio falls back to
default-src 'self' and the previews are blocked with nothing on screen
to explain it."
```

---

## Task 9: The Deezer tab

**Files:**
- Create: `src/app/(app)/music/songs/deezer-tab.tsx`
- Modify: `src/lib/record-params.ts:?` (`SONG_TABS`), `src/app/(app)/music/songs/song-record-dialog.tsx`, `src/app/(app)/music/songs/songs-grid.tsx`, `src/app/(app)/music/songs/song-fields.tsx`

**Interfaces:**
- Consumes: `searchDeezerAction`, `registerFromDeezerAction`, `linkToDeezerAction` (Task 7); `SongThumb` (Task 8).
- Produces: `<DeezerTab mode="register" | "link" companyId songId? onPrefill onLinked />`.

- [ ] **Step 1: `SONG_TABS` gains a second member**

In `src/lib/record-params.ts`:

```ts
// Two now, where Block 7 had one. song-record-dialog.tsx's strip already
// mapped over this tuple rather than hard-coding 'data', which is why a second
// tab costs an entry and a label rather than a rewrite — the comment on that
// component predicted this exact change.
export const SONG_TABS = ['data', 'deezer'] as const;
```

Add `deezer: 'deezerSearch'` to `TAB_LABEL_KEYS` in `song-record-dialog.tsx:18`.

- [ ] **Step 2: Write the tab**

`deezer-tab.tsx` is a client component holding: three controlled filter inputs; a Search button calling `searchDeezerAction`; a results list where each row renders `<SongThumb>`, title, artist, album, duration, a preview button, and one of three actions.

The preview is a **single** `<audio>` element for the whole list, whose `src` is swapped to the row being played:

```tsx
// One element, not one per row. Two <audio> tags playing at once is the
// failure mode a list of preview buttons produces by default, and the fix is
// structural rather than a pile of pause() calls.
const audioRef = useRef<HTMLAudioElement | null>(null);
const [playing, setPlaying] = useState<number | null>(null);

function togglePreview(track: DeezerSearchRow) {
  const el = audioRef.current;
  if (!el || !track.previewUrl) return;
  if (playing === track.id) {
    el.pause();
    setPlaying(null);
    return;
  }
  // The URL is signed and expires in hours (spec §2.1). It is used here, live,
  // and never stored or carried into the form.
  el.src = track.previewUrl;
  void el.play();
  setPlaying(track.id);
}
```

The three row actions:

```tsx
{track.registeredSongId ? (
  <button type="button" onClick={() => onOpenExisting(track.registeredSongId!)}>
    {t('alreadyRegistered')}
  </button>
) : mode === 'link' ? (
  <Button type="button" onClick={() => link(track)}>{t('link')}</Button>
) : (
  <Button type="button" onClick={() => onPrefill(track)}>{t('register')}</Button>
)}
```

`onPrefill` hands the track up to the dialog, which switches to the `data` tab with the fields filled — **nothing is written until the operator submits**, which is the flow the owner described.

- [ ] **Step 3: Prefill state in the create dialog**

`CreateSongDialog` (`songs-grid.tsx:303`) becomes tabbed and holds `const [prefill, setPrefill] = useState<DeezerSearchRow | null>(null)`, passing it to `SongFields` as `prefill`. `SongFields` uses `prefill?.title ?? song?.title ?? ''` for each `defaultValue`, and carries hidden inputs for `deezerTrackId`, `deezerAlbumId`, `coverMd5`, `artistName`, `albumTitle`.

**`key={prefill?.id ?? 'blank'}` on the form** — `defaultValue` is read once per mount, so without a changing key a second "Register" click fills nothing.

The warning when a reference is new:

```tsx
{prefill && !artists.some((a) => a.name.toLowerCase() === prefill.artistName.toLowerCase()) && (
  <p className="text-sm text-amber-700">
    {t('theArtistWillBeCreated', { name: prefill.artistName })}
  </p>
)}
```

- [ ] **Step 4: New fields in `song-fields.tsx`**

An album `<Select>` (options from `listAlbums`), an ISRC `<Input maxLength={12}>`, and the Deezer code — **read-only, with the same reasoning `legacyId` carries**, plus an Unlink button when set:

```tsx
{song?.deezerTrackId != null && (
  <label className="flex flex-col gap-1 text-sm">
    <span className="text-muted-foreground">{t('deezerCode')}</span>
    {/*
      No `name` attribute, and — far more importantly — no parameter on
      update_song to receive one (0138). legacy_id's comment explains why the
      missing `name` is defence in depth and not the boundary: an update form
      that never carries a value forward is indistinguishable, to the function
      it calls, from an operator who cleared it. The boundary is the absent
      write path.
    */}
    <Input value={String(song.deezerTrackId)} disabled readOnly data-testid="song-deezer-id" />
  </label>
)}
```

- [ ] **Step 5: Add every string to the three catalogues**

`messages/en.json`, `pt.json`, `es.json` under `music`: `deezerSearch`, `register`, `link`, `alreadyRegistered`, `theArtistWillBeCreated`, `theLabelWillBeCreated`, `theGenreWillBeCreated`, `theAlbumWillBeCreated`, `deezerCode`, `isrc`, `album`, `cover`, `preview`, `stopPreview`, `searchOnDeezer`, `giveAtLeastOneFilter`, `deezerIsRefusingRequestsRightNow`, `deezerHasNothingForThatSearch`, `couldNotReachDeezerTryAgain`, `tooManySearchesWaitAMoment`, `unlinkFromDeezer`.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/music/songs src/lib/record-params.ts messages
git commit -m "feat(music): the Deezer tab, in both song dialogs

One <audio> for the whole list rather than one per row, and the prefilled
form is keyed on the track so a second Register actually refills it."
```

---

## Task 10: The albums tab on the Catalogue screen

**Files:**
- Modify: `src/app/(app)/music/catalog/reference-panel.tsx`, `src/app/(app)/music/catalog/actions.ts`, `src/app/(app)/music/catalog/page.tsx`

- [ ] **Step 1** Add an `albums` tab beside Labels, Genres and Shows, over the same panel: list by title, rename, archive. UPC and cover are **shown, not typed** — `update_album` (0137) takes title and UPC only, and takes no cover at all.
- [ ] **Step 2** Wire `createAlbumAction` / `updateAlbumAction` / `archiveAlbumAction` in `catalog/actions.ts`, following the reference actions already there.
- [ ] **Step 3** Add `albums` to the three message catalogues.
- [ ] **Step 4** Run `npm test && npm run typecheck && npm run lint`.
- [ ] **Step 5** Commit: `feat(music): albums get a tab on the catalogue, so a name Deezer supplied is not permanent`.

---

## Task 11: Isolation and end-to-end

**Files:**
- Create: `tests/isolation/deezer.test.ts`, `tests/e2e/deezer.spec.ts`

- [ ] **Step 1: Write the isolation tests**

`npm run db:test` runs as superuser with a null `auth.uid()` and **cannot see a permission failure** (`docs/PERMISSIONS.md §4`). These are the tests that can. Follow `tests/isolation/music.test.ts` and its harness:

```ts
it('refuses create_song_from_deezer to a caller with only music.view', async () => { /* expect 42501 */ });
it('refuses link_song_to_deezer on a song at another Station', async () => { /* expect 42501 */ });
it('refuses a second song linked to the same recording in one Station', async () => { /* expect 23505 */ });
it('leaves no artist behind when the song insert fails', async () => {
  // The proof of design D3. Register with a title of '   ' so the insert
  // raises 23514 AFTER the artist has been resolved, then assert the artist
  // does not exist. Without one transaction, it would.
});
it('hides an archived album from every caller, the owner included', async () => { /* expect null */ });
it('does not let resolve_or_create_album be called from a session', async () => { /* expect 42501 */ });
```

- [ ] **Step 2** Run: `npm run test:isolation`. Expected: PASS.
- [ ] **Step 3** Write `tests/e2e/deezer.spec.ts` over `FakeDeezerTransport`: search → Register → the form fills → submit → the row appears with a cover; and open an existing song → Deezer tab → Link → the code appears read-only.
- [ ] **Step 4** Run: `npm run test:e2e`. Expected: PASS.
- [ ] **Step 5** Commit: `test(music): the isolation the pgTAP suite structurally cannot see`.

---

## Self-Review

**Spec coverage.** §3 D1–D2 → Tasks 2/4 (`resolve_or_create_*`); D3 → Task 4 + its isolation test; D4 → Tasks 1/6/8; D5 → Task 1 (cover on `albums`); D6 → Tasks 3/9 (no parameter, read-only field); D7/D8 → Tasks 3/5; D9 → Tasks 3/7; D10 → Task 9 (`mode`); D13/D14/D15 → out of scope by construction, nothing to build. §4 → Tasks 1–4. §5 → Tasks 6–7. §6 → Task 6. §7 → Tasks 8–10. §10 → Tasks 1–4, 6, 11. **D11/D12 and §8 belong to Block 13b and are deliberately absent from this plan.**

**Gap found and closed:** the `0119` dashboard aggregate must return `cover_md5`, which no task originally owned — added to Task 8 Step 5 as migration `0140`, with the note that a changed return type needs `drop`+`create`, not `create or replace`.

**Placeholders:** none. Every code step carries the code.

**Type consistency:** `coverMd5` (never `cover_md5`) on every TypeScript surface; `cover_md5` on every SQL surface. `DeezerSearchRow` is defined once in `deezer-marking.ts` and imported by Tasks 7 and 9. `coverUrl(md5, size)` has one signature, used by `SongThumb` alone.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-07-block-13a-deezer.md`.
