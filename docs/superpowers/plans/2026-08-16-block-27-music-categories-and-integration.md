# Block 27 — Music Categories and the Integration Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a song a category (a per-Station reference list with a screen, a
field, a column and a filter), give it a readable link to the same song in the
customer's own software, and give the sidebar a button that folds it to a rail
of icons.

**Architecture:** The category is a fifth `music_reference_kind`, so the trio of
doors in `0100` and the `ReferenceScreen` component from Block 20c serve it with
one enum value and two branches. The integration link is a separate table keyed
by the code already stored in `songs.internal_code`, resolved loosely so the
codes already in the database keep working. The sidebar preference is a
server-read cookie, like the disclosure state beside it.

**Tech Stack:** Next.js App Router (Server Components + Server Actions),
Supabase/Postgres with RLS and `SECURITY DEFINER` RPCs, `next-intl` (en/pt/es),
Zod, Tailwind, Vitest (unit + isolation), pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-block-27-music-categories-and-integration-design.md`

## Global Constraints

- **Language.** Code, comments, commit messages, migrations, tests and docs are
  in **English**. Only the three `messages/*.json` catalogues carry other
  languages. Never write Portuguese into a source file.
- **Three locales, always together.** Any key added to `messages/en.json` must be
  added to `messages/pt.json` and `messages/es.json` in the same commit.
  `tests/unit/i18n/` checks parity and checks that every `t('key')` call is a
  **literal string** — a call built from a variable is invisible to it, which is
  why kind-specific copy is passed down as plain props (`ReferenceScreenCopy`).
- **Migrations are append-only.** Never edit a migration that is already on
  `main`. The next free number is **0204**.
- **Copy the LIVE function body forward.** When recreating an RPC, start from
  the migration that most recently defined it, not from the original:
  `create_song` → `0140`; `update_song` → `0138`; `create_song_from_deezer` →
  `0139`; `assert_song_references_live` → `0103`; `archive_music_reference` and
  `music_reference_table` → `0100` (0103/0104 changed only comments on the
  former).
- **`DROP` resets a function's ACL; `CREATE OR REPLACE` keeps it.** Any recreate
  that changes a signature must be `drop function` + `create function` followed
  by its `revoke execute ... from public` and `grant execute ... to
  authenticated` again. `0102` records this the hard way.
- **The boundary is in the database.** Every RPC re-checks `has_permission` in
  its own body. UI gating is a courtesy and is described as one in comments.
- **No new permission.** `music.view` reads, `music.manage` writes, everywhere
  in this block.
- **Gate order**, run from the repo root:
  `npm run lint` → `npm run typecheck` → `npm run test` → `npm run db:reset` →
  `npm run db:test` → `npm run test:isolation` → `npm run test:e2e`.
  The reset before `db:test` is mandatory: a database left dirty by an e2e run
  produces two red gates that are not code.
- **`npm run db:types`** is regenerated in the same commit as any migration that
  changes the schema, and the regenerated
  `src/lib/supabase/database.types.ts` is committed with it.
- **New isolation test files must be added to `REQUIRED_TEST_FILES` in
  `scripts/verify-isolation-suite.mjs`** with a case floor, in the same commit.
  A file that is not listed can silently stop running.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `supabase/migrations/0204_music_category_kind.sql` | Adds `'CATEGORY'` to `music_reference_kind`. Nothing else — Postgres forbids using a new enum value in the transaction that adds it. |
| `supabase/migrations/0205_music_categories.sql` | `music_categories`, its RLS, `songs.category_id`, and the three functions that learn about the kind. |
| `supabase/migrations/0206_song_category_doors.sql` | `create_song`, `update_song`, `create_song_from_deezer` recreated with `p_category_id`. |
| `supabase/migrations/0207_song_integrations.sql` | `song_integrations`, its RLS, and `save_song_integration`. |
| `supabase/tests/57_music_categories.test.sql` | pgTAP for the table, the enum label, the column and the archive refusal's shape. |
| `supabase/tests/58_song_integrations.test.sql` | pgTAP for the table, the unique index and the door's privileges. |
| `src/app/(app)/catalog/categories/page.tsx` | The Categories screen — a thin page over `ReferenceScreen`. |
| `src/app/(app)/music/songs/integration-tab.tsx` | The Integration tab: the four fields, the shared-code warning, the import button. |
| `src/app/(app)/music/songs/integration-actions.ts` | `saveSongIntegrationAction` — the only write path from the tab. |
| `src/lib/song-integration-file.ts` | Parsing and validating an operator-supplied JSON file. Pure, no DOM, no server. |
| `src/lib/nav/collapse.ts` | The collapse cookie's name, lifetime and parse. Pure. |
| `tests/unit/song-integration-file.test.ts` | The JSON validator against hostile files. |
| `tests/unit/nav-collapse.test.ts` | The collapse cookie parse. |
| `tests/isolation/music-categories.test.ts` | Cross-Station boundaries pgTAP cannot reach. |
| `tests/isolation/song-integrations.test.ts` | The same, for the card and its door. |
| `tests/e2e/music-categories.spec.ts` | Register → pick → filter → refuse to archive. |
| `tests/e2e/song-integration.spec.ts` | Import a JSON file, save, reopen, read back. |
| `tests/e2e/sidebar-collapse.spec.ts` | Fold, reload, unfold. |

**Modified**

| Path | Change |
|---|---|
| `src/lib/auth/shell.ts` | Section order, Programmes moves, the Categories item. |
| `src/components/layout/app-shell.tsx` | `ICONS.folder`; the brand row gains the toggle; the rail's collapsed styling. |
| `src/components/layout/sidebar-nav.tsx` | Renders icon-only when collapsed. |
| `src/lib/nav/disclosure.ts` | Untouched — the collapse parse lives in its own module beside it. |
| `src/schemas/music.ts` | `'CATEGORY'` in `MUSIC_REFERENCE_KINDS`, `categoryId` on the song schemas, the integration schemas. |
| `src/services/music.ts` | `REFERENCE_TABLES`, `SONG_COLUMNS`, `SongRow`, `SongSummary`, `toSongSummary`, `SongListParams`, `createSong`, `updateSong`, and the new card reads/write. |
| `src/app/(app)/catalog/references/list-params.ts` | `ReferenceScreenKind` and `REFERENCE_SCREEN_PATHS`. |
| `src/app/(app)/catalog/references/actions.ts` | `REFERENCE_SCREEN_KINDS` and `ACTION_KEYS`. |
| `src/app/(app)/music/songs/list-params.ts` | `?category=` ↔ `state.categoryId`. |
| `src/app/(app)/music/songs/songs-filters.tsx` | The Category select. |
| `src/app/(app)/music/songs/songs-grid.tsx` | The Category column, `COLUMN_COUNT`, the `categories` prop. |
| `src/app/(app)/music/songs/song-fields.tsx` | The Category select; Internal code becomes Integration code. |
| `src/app/(app)/music/songs/song-record-dialog.tsx` | The third tab. |
| `src/app/(app)/music/songs/record.ts` | Reads the card and the shared-code count. |
| `src/app/(app)/music/songs/page.tsx` | Reads the category list, passes it down, passes the filter. |
| `src/app/(app)/music/songs/actions.ts` | `categoryId` through create and update. |
| `src/lib/record-params.ts` | `SONG_TABS` gains `'integration'`. |
| `messages/{en,pt,es}.json` | All new copy. |
| `scripts/verify-isolation-suite.mjs` | Two manifest entries. |
| `tests/e2e/nav-content.spec.ts` | The new ordering. |

---

## Task 1: The sidebar takes the owner's order, and Programmes joins the catalogue

Independent of every other task. Do it first so the rest of the block is
navigated the way it will ship.

**Files:**
- Modify: `src/components/layout/app-shell.tsx` (the `ICONS` map, ~line 62)
- Modify: `src/lib/auth/shell.ts` (the `sections` array, lines 47–396)
- Modify: `tests/e2e/nav-content.spec.ts` (lines ~76–110)

**Interfaces:**
- Consumes: nothing.
- Produces: `ICONS.folder` (a string of SVG path data), used by Task 4's nav
  item — which is already added here, pointing at `/catalog/categories`, a route
  Task 4 creates.

- [ ] **Step 1: Update the e2e ordering assertions first**

In `tests/e2e/nav-content.spec.ts`, replace the Audience block's ordering
assertion and add the two new ones. The Audience assertion currently reads
`['Members', 'Requests', 'Programmes']`:

```ts
  // Block 27. Programmes left Audience for Catalog on the owner's ruling, so
  // Audience is down to the two screens that are about people. Asserted as the
  // whole rendered list rather than one absent link, for the reason the Block 26
  // comment above gives: a move that only adds leaves the link rendered twice.
  const audienceLinks = await audience.getByRole('link').allInnerTexts();
  expect(audienceLinks).toEqual(['Members', 'Requests']);
```

In the Inventory block, change the expected list:

```ts
  const inventoryLinks = await inventory.getByRole('link').allInnerTexts();
  expect(inventoryLinks).toEqual(['Stock', 'Categories', 'Vendors', 'Movements']);
```

In the Catalog block, replace the individual `toBeVisible` checks with the whole
order, and keep the two absence checks that are already there:

```ts
  const catalogueLinks = await catalogue.getByRole('link').allInnerTexts();
  expect(catalogueLinks).toEqual([
    'Songs',
    'Artists',
    'Albums',
    'Categories',
    'Genres',
    'Record labels',
    'Programmes',
    'Maintenance',
  ]);
  await expect(catalogue.getByRole('link', { name: 'Categories' })).toHaveAttribute(
    'href',
    '/catalog/categories',
  );
```

- [ ] **Step 2: Run the e2e spec and watch it fail**

Run: `npx playwright test tests/e2e/nav-content.spec.ts`
Expected: FAIL — Audience still renders three links, Inventory still renders
Movements before Vendors, and Catalog has no Categories item.

- [ ] **Step 3: Add the folder glyph**

In `src/components/layout/app-shell.tsx`, add to `ICONS`, after `disc`:

```ts
  // A folder, for Block 27's Catalogue > Categories. Its own path rather than
  // reusing `tag`, which is Genres — the ADJACENT ROW OF THIS SAME SECTION, the
  // one case this file's rule forbids, because one icon on two neighbouring rows
  // reads as one link rendered twice. (Inventory > Categories keeps `tag`: that
  // section is a different one and the two never appear side by side, the same
  // non-adjacency that already lets `box` serve both Inventory and Pickups.)
  // Nothing else declared here means *the thing you file others under*.
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
```

- [ ] **Step 4: Reorder the sections**

In `src/lib/auth/shell.ts`:

1. In the `audience` section, **delete** the `/shows` item and the comment block
   above it (lines ~122–135). Leave Members and Requests.
2. In the `inventory` section, move the `/inventory/vendors` item so it sits
   **before** `/inventory/movements`, carrying its comment with it. Add one line
   to the Vendors comment recording the move:

```ts
        // Block 27, on the owner's ruling: Vendors now precedes Movements. The
        // section reads as three reference lists then the ledger that consumes
        // them, rather than the ledger interrupting the lists.
```

3. In the `catalog` section, set the items to this exact order — Songs, Artists,
   Albums, Categories, Genres, Record labels, Programmes, Maintenance — moving
   the existing `labels`, `genres` and `albums` entries rather than rewriting
   them, and inserting these two:

```ts
        // Block 27, on the owner's ruling. A category is the station's own
        // filing word for a recording, beside the genre rather than instead of
        // it: a genre says what the music IS, a category says where this Station
        // files it. ICONS.folder is new for this row — `tag` is Genres, directly
        // below, and this file's rule forbids one glyph on two adjacent rows.
        //
        // /catalog/categories redirects nobody by itself: it opens on whichever
        // Station listCompanyAccess resolves music.view in, the same courtesy
        // every item in this section already extends, and 0205's select policy
        // plus 0100's three doors re-check the permission themselves regardless.
        { href: '/catalog/categories', label: t('categories'), icon: ICONS.folder },
```

```ts
        // MOVED HERE FROM AUDIENCE IN BLOCK 27, on the owner's ruling, reversing
        // where Block 18 filed it. Both readings are true — a programme is made
        // for listeners, and it is also a slot the catalogue is played in — and
        // what settles it is the neighbour: a programme is edited when the
        // schedule is, which is the same errand as curating the songs above it.
        // Under Audience it sat beside Members, where the shared word was
        // "people" and nothing followed on from it.
        //
        // THE PERMISSION STILL DOES NOT MOVE WITH THE SCREEN, and now it agrees
        // with where the screen sits: `shows` carries one policy, gated on
        // music.view, which is this section's own permission. Block 18's §5
        // recorded that mismatch as a cost of filing it under Audience; the move
        // removes it.
        //
        // ICONS.radio travels with it and collides with nothing here: this
        // section holds music, users, disc, folder, tag, building and shield.
        // Its only other use is Overview > My stations, a distant section.
        { href: '/shows', label: t('programmes'), icon: ICONS.radio },
```

`t('categories')` already exists in the `nav` namespace (Inventory uses it), so
no catalogue change is needed here.

- [ ] **Step 5: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS. (`/catalog/categories` is a string literal in a `Route`-typed
field and Next has not generated its route type yet; if `typecheck` complains,
cast it `as Route` exactly as `genres/page.tsx` line ~148 already does, with the
same comment.)

- [ ] **Step 6: Run the e2e spec again**

Run: `npx playwright test tests/e2e/nav-content.spec.ts`
Expected: the Audience, Inventory and Catalog ordering assertions PASS. The
`/catalog/categories` href assertion passes (the link renders; the route 404s
until Task 4, which this spec does not visit).

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth/shell.ts src/components/layout/app-shell.tsx tests/e2e/nav-content.spec.ts
git commit -m "feat(nav): the owner's order, and Programmes joins the catalogue"
```

---

## Task 2: A category reaches the database

**Files:**
- Create: `supabase/migrations/0204_music_category_kind.sql`
- Create: `supabase/migrations/0205_music_categories.sql`
- Create: `supabase/tests/57_music_categories.test.sql`
- Create: `tests/isolation/music-categories.test.ts`
- Modify: `scripts/verify-isolation-suite.mjs`
- Modify: `src/lib/supabase/database.types.ts` (generated)

**Interfaces:**
- Consumes: `music_reference_kind`, `music_reference_table()`,
  `archive_music_reference()`, `assert_song_references_live()` — all from
  `0100`/`0103`.
- Produces: table `public.music_categories` (same columns as `music_genres`);
  column `public.songs.category_id uuid`; the enum label `'CATEGORY'`;
  `assert_song_references_live(uuid, uuid, uuid, uuid, uuid)` — a **five**
  argument version, the fifth being `p_category_id uuid default null`.

> **Why the helper changes shape.** `assert_song_references_live` (`0103`) is
> what stops a song naming an **archived** artist, label or genre: the composite
> foreign keys reference non-partial unique constraints, so they cannot see
> `deleted_at`. It also takes `FOR KEY SHARE` on each row, which is the half of
> the lock pair that makes `archive_music_reference`'s `FOR UPDATE` actually
> exclude a concurrent `create_song`. A category with no entry there would be
> the one reference of the five that a song could name after it was archived,
> and the one that could be archived out from under a song mid-insert. The
> parameter is added last and defaulted, so `0152`'s intake door keeps its
> four-argument call and resolves to the new function unchanged.

- [ ] **Step 1: Write the enum migration**

Create `supabase/migrations/0204_music_category_kind.sql`:

```sql
-- supabase/migrations/0204_music_category_kind.sql

-- Block 27. A fifth value for music_reference_kind, and NOTHING ELSE in this
-- file.
--
-- Postgres refuses to use a new enum value in the same transaction that adds
-- it, and Supabase runs each migration file in its own transaction — so
-- 0205's music_reference_table() branch, which returns a value of this type's
-- own vocabulary, must be a separate file or the whole migration fails with
-- "unsafe use of new value of enum type". 0082 and 0091 both paid for this
-- already, each with a one-line migration of its own.

alter type public.music_reference_kind add value 'CATEGORY';

comment on type public.music_reference_kind is
  'The five catalogue lists that are a name and nothing else. Not the merge''s kinds (0105) — that set drops CATEGORY and SHOW is in it, and adds SONG.';
```

- [ ] **Step 2: Write the table migration**

Create `supabase/migrations/0205_music_categories.sql`:

```sql
-- supabase/migrations/0205_music_categories.sql

-- Block 27. A category is music_genres with a different name, which is the
-- whole argument for making it a fifth music_reference_kind rather than a
-- record with doors of its own: 0100 exists precisely so that four tables with
-- identical columns share one trio of doors, and a fifth costs an enum value
-- (0204) and the two branches at the foot of this file.
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
  'A Station''s own filing words for a recording — the vocabulary its scheduling software uses, beside the genre rather than instead of it. Names are deliberately not unique, the same D2/D3 ruling music_genres carries: a duplicate is allowed and 0106''s merge is the cure. NOT public.prize_categories, which is the same word in the inventory domain and is governed by inventory.catalogue; one table for both would tie a stock label to a music permission.';

-- Non-partial, because a foreign key cannot reference a partial index — which
-- is exactly why an archived parent needs the explicit check in
-- assert_song_references_live below.
alter table public.music_categories
  add constraint music_categories_id_company_unique unique (id, company_id);

-- D7's shape, from 0098: unique WHEN PRESENT, per Station, so the many rows
-- with no handle do not collide.
create unique index music_categories_legacy_unique
  on public.music_categories (company_id, legacy_id) where legacy_id is not null;

create index music_categories_company_idx
  on public.music_categories (company_id, name) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- The column on songs.
-- ---------------------------------------------------------------------------

alter table public.songs add column category_id uuid;

alter table public.songs
  add constraint songs_category_company_fk
  foreign key (category_id, company_id)
  references public.music_categories (id, company_id);

comment on column public.songs.category_id is
  'Block 27. The Station''s own filing word for this recording. Nullable: the whole catalogue predates this column, and refusing to save a song without one would make every existing record unsavable.';

create index songs_category_idx on public.songs (category_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- RLS, exactly 0099's shape.
-- ---------------------------------------------------------------------------

alter table public.music_categories enable row level security;
revoke all on public.music_categories from anon, authenticated;
grant select on public.music_categories to authenticated;

create policy music_categories_select_music_view on public.music_categories
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));

-- ---------------------------------------------------------------------------
-- The three functions that learn about the kind.
-- ---------------------------------------------------------------------------

-- CREATE OR REPLACE, not DROP + CREATE: the signature is unchanged, so there is
-- no second overload to resolve to, and REPLACE keeps 0100's `revoke execute
-- ... from public` — this helper still holds EXECUTE for nobody.
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
  'Maps a reference kind to its table name, for the format(%I) in 0100''s three doors. Total over the enum: a value with no branch here returns null, and every caller formats that null into `public.""` and fails loudly rather than writing somewhere unintended. EXECUTE granted to nobody: it is only ever called from inside a SECURITY DEFINER body.';

-- 0100's body, with a fifth branch. Copied forward from 0100 rather than 0103,
-- which replaced assert_song_references_live and RESTATED THIS FUNCTION'S
-- COMMENT but left its body alone; 0104 corrected one sentence of that comment
-- and changed nothing executable. CREATE OR REPLACE for the reason above.
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
  -- Block 27. REFUSED, not detached, and the difference from
  -- archive_prize_category (0202/0203) is the point rather than an
  -- inconsistency: its three siblings above all refuse, and a fourth kind
  -- behaving differently INSIDE THIS SAME FUNCTION, chosen by an argument,
  -- would make one function mean two things.
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
  'Soft-deletes a genre, label, artist, category or show. Gated on music.manage. Never a DELETE — this project deletes nothing, and 0106''s merge history needs rows to keep pointing at. Refused while a live song (or, for a show, a live request) still names it, so no screen is left rendering a reference that RLS has made unreadable. Takes FOR UPDATE on the row before counting; that excludes a concurrent create_song only because 0103 makes assert_song_references_live take FOR KEY SHARE on the same row, and FOR KEY SHARE conflicts with FOR UPDATE and with nothing weaker. The two locks are a pair and neither works alone. Do not weaken this FOR UPDATE — FOR SHARE does not conflict with FOR KEY SHARE, so that change would reopen the race while both comments still claimed it was closed.';

-- ---------------------------------------------------------------------------
-- The live-reference check gains the fifth reference.
--
-- DROP + CREATE, not REPLACE: the signature changes. The parameter is added
-- LAST and DEFAULTED, so 0152's four-argument call site keeps resolving —
-- plpgsql resolves a call at execution time and there is no stale reference to
-- fix. The revoke below is restated because DROP RESETS THE ACL, which 0102
-- already recorded; without it the default ACL leaves every role holding
-- EXECUTE on a helper that takes row locks.
--
-- WITHOUT THIS, the category would be the one reference of the five a song
-- could name after it was archived: songs_category_company_fk references a
-- NON-PARTIAL unique constraint, so it cannot see deleted_at. And the FOR KEY
-- SHARE is the other half of archive_music_reference's FOR UPDATE — see 0103's
-- header for why neither half works alone.
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
  'Refuses an artist, label, genre or category that is missing, archived, or from another Station. SECURITY INVOKER, EXECUTE granted to nobody. The composite foreign keys prove the Station by themselves; what they cannot see is deleted_at, which is the half this covers. Each check takes FOR KEY SHARE on the row it reads (0103), the weakest row-lock mode that conflicts with archive_music_reference''s FOR UPDATE: without it the two could interleave and leave a live song naming an archived reference. It deliberately does not conflict with another FOR KEY SHARE, so concurrent song creation is not serialised. p_category_id is last and defaulted (0205) so 0152''s four-argument call resolves here unchanged.';
```

- [ ] **Step 3: Reset the database and confirm the migrations apply**

Run: `npm run db:reset`
Expected: every migration applies, ending at `0205`, with no error. If it fails
on `unsafe use of new value of enum type`, the two files have been merged into
one — split them again.

- [ ] **Step 4: Write the pgTAP suite**

Create `supabase/tests/57_music_categories.test.sql`:

```sql
begin;
select plan(16);

-- Block 27. What the structure has to say about itself. The cross-Station
-- claims are not here and cannot be: this session runs as superuser with a null
-- auth.uid(), where RLS never applies — tests/isolation/music-categories.test.ts
-- carries those, per this directory's standing note.

select has_table('public', 'music_categories', 'the category table exists');
select has_column('public', 'music_categories', 'company_id', 'it is per Station');
select has_column('public', 'music_categories', 'deleted_at', 'it soft-deletes');
select col_is_unique('public', 'music_categories', array['id', 'company_id'],
                     'a child can prove its Station in a constraint');

select has_column('public', 'songs', 'category_id', 'a song carries a category');
select col_is_fk('public', 'songs', array['category_id', 'company_id'],
                 'and cannot borrow one from another Station');

select ok(
  'CATEGORY' = any (enum_range(null::public.music_reference_kind)::text[]),
  'the kind vocabulary carries CATEGORY');

-- 0100's doors serve it with no new function. Asserting their absence is the
-- point: a bespoke create_music_category would mean the reuse silently did not
-- happen.
select hasnt_function('public', 'create_music_category', 'no bespoke create door was invented');
select hasnt_function('public', 'archive_music_category', 'no bespoke archive door was invented');

select has_function('public', 'assert_song_references_live',
                    array['uuid', 'uuid', 'uuid', 'uuid', 'uuid'],
                    'the live-reference check takes a category');
select hasnt_function('public', 'assert_song_references_live',
                      array['uuid', 'uuid', 'uuid', 'uuid'],
                      'and the four-argument version it replaces is gone');
-- DROP resets an ACL. Without 0205's restated revoke, every role would hold
-- EXECUTE on a helper that takes row locks.
select ok(
  not has_function_privilege('authenticated',
    'public.assert_song_references_live(uuid,uuid,uuid,uuid,uuid)', 'execute'),
  'and it is still callable by nobody but a SECURITY DEFINER body');

-- RLS ---------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.music_categories'::regclass),
  'row level security is on');
select ok(
  has_table_privilege('authenticated', 'public.music_categories', 'select'),
  'a member may read categories');
select ok(
  not has_table_privilege('authenticated', 'public.music_categories', 'insert'),
  'and may not insert one directly — 0100''s door is the only way in');
select ok(
  not has_table_privilege('anon', 'public.music_categories', 'select'),
  'and anon may read nothing');

select * from finish();
rollback;
```

- [ ] **Step 5: Run pgTAP**

Run: `npm run db:test`
Expected: `57_music_categories.test.sql` passes 16 of 16, and every pre-existing
file still passes.

- [ ] **Step 6: Write the isolation suite**

Create `tests/isolation/music-categories.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { addCompany, cleanupUsers, grantRoleWith, provisionCustomer, signInAs } from './harness';

afterAll(cleanupUsers);

/**
 * Block 27. What pgTAP cannot reach.
 *
 * `57_music_categories.test.sql` proves the shape against a session it sets by
 * hand, as superuser with a null auth.uid(), where RLS never applies. This suite
 * drives the same doors through a REAL JWT, a real role and a real membership,
 * which is the only way the cross-Station claims are actually tested.
 *
 * Per this directory's standing rule, the actor is a non-owner DELEGATE in every
 * case: Block 1c shipped two defects that thirteen reviews missed because every
 * scenario had the owner driving, and the owner's bypass hid the delegate's
 * failure.
 */
describe('music categories', () => {
  it('a category of one Station is invisible from another, inside the same Organization', async () => {
    const label = `music-category-isolation-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);

    // The delegate holds the permissions in BOTH Stations, so what separates
    // them below is the row's own company_id rather than a missing grant.
    const delegate = await grantRoleWith(
      customer,
      label,
      ['music.view', 'music.manage'],
      [customer.companyId, otherCompanyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const created = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'CATEGORY',
      p_name: `Sertanejo ${label}`,
    });
    expect(created.error).toBeNull();

    const here = await client
      .from('music_categories')
      .select('id,name')
      .eq('company_id', customer.companyId);
    expect(here.error).toBeNull();
    expect(here.data).toHaveLength(1);

    const there = await client
      .from('music_categories')
      .select('id')
      .eq('company_id', otherCompanyId);
    expect(there.error).toBeNull();
    expect(there.data).toHaveLength(0);
  });

  it('is refused for a delegate holding music.view alone, and writes nothing', async () => {
    const label = `music-category-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, ['music.view'], [customer.companyId]);
    const client = await signInAs(delegate.email, delegate.password);

    const attempt = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'CATEGORY',
      p_name: `Refused ${label}`,
    });
    expect(attempt.error?.code).toBe('42501');

    const rows = await client
      .from('music_categories')
      .select('id')
      .eq('company_id', customer.companyId);
    expect(rows.data).toHaveLength(0);
  });

  it('cannot be archived while a live song wears it, and can once the song lets go', async () => {
    const label = `music-category-inuse-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(
      customer,
      label,
      ['music.view', 'music.manage'],
      [customer.companyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const artist = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: `Artist ${label}`,
    });
    expect(artist.error).toBeNull();

    const category = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'CATEGORY',
      p_name: `Category ${label}`,
    });
    expect(category.error).toBeNull();

    const song = await client.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: `Song ${label}`,
      p_artist_id: artist.data,
      p_category_id: category.data,
    });
    expect(song.error).toBeNull();

    // 23503: the same refusal an artist or a genre in use gets, from the same
    // branch of the same function.
    const refused = await client.rpc('archive_music_reference', {
      p_kind: 'CATEGORY',
      p_id: category.data,
    });
    expect(refused.error?.code).toBe('23503');

    const detached = await client.rpc('update_song', {
      p_song_id: song.data,
      p_title: `Song ${label}`,
      p_artist_id: artist.data,
      p_category_id: null,
    });
    expect(detached.error).toBeNull();

    const archived = await client.rpc('archive_music_reference', {
      p_kind: 'CATEGORY',
      p_id: category.data,
    });
    expect(archived.error).toBeNull();
  });

  it('a song cannot borrow a category from another Station', async () => {
    const label = `music-category-crossed-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);
    const delegate = await grantRoleWith(
      customer,
      label,
      ['music.view', 'music.manage'],
      [customer.companyId, otherCompanyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const artist = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: `Artist ${label}`,
    });
    const foreign = await client.rpc('create_music_reference', {
      p_company_id: otherCompanyId,
      p_kind: 'CATEGORY',
      p_name: `Foreign ${label}`,
    });
    expect(foreign.error).toBeNull();

    // P0002 from assert_song_references_live, not a permission code: the
    // delegate holds music.manage in BOTH Stations and is still refused,
    // because the category is not this Station's.
    const attempt = await client.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: `Song ${label}`,
      p_artist_id: artist.data,
      p_category_id: foreign.data,
    });
    expect(attempt.error?.code).toBe('P0002');
  });

  it('a song cannot name an archived category', async () => {
    const label = `music-category-archived-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(
      customer,
      label,
      ['music.view', 'music.manage'],
      [customer.companyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const artist = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: `Artist ${label}`,
    });
    const category = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'CATEGORY',
      p_name: `Retired ${label}`,
    });
    expect((await client.rpc('archive_music_reference', {
      p_kind: 'CATEGORY',
      p_id: category.data,
    })).error).toBeNull();

    // The composite foreign key CANNOT catch this: it references
    // music_categories_id_company_unique, a non-partial constraint, so it
    // cannot see deleted_at. The refusal lives in assert_song_references_live
    // and nowhere else, which is why it is asserted here.
    const attempt = await client.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: `Song ${label}`,
      p_artist_id: artist.data,
      p_category_id: category.data,
    });
    expect(attempt.error?.code).toBe('P0002');
  });
});
```

> **Note for the implementer:** this suite calls `create_song` and `update_song`
> with `p_category_id`, which Task 3 adds. Write the file now and expect the last
> three cases to fail until Task 3 lands — or write the file in this task and
> move its commit to Task 3. Either is fine; what is not fine is deferring the
> cases.

- [ ] **Step 7: Add the manifest entry**

In `scripts/verify-isolation-suite.mjs`, in `REQUIRED_TEST_FILES`, after the
`music.test.ts` entry:

```js
  // Block 27. Five cases, and the floor is the full count because three of them
  // are the only proof of their property anywhere in this repository.
  //
  // The tenant boundary on `music_categories`: a category registered at one
  // Station is invisible from another INSIDE THE SAME ORGANIZATION, to a caller
  // who holds music.view and music.manage in both. 57_music_categories.test.sql
  // asserts the policy's shape and cannot assert this — it runs as superuser
  // with a null auth.uid() where RLS never applies.
  //
  // And the two sharper ones, both about a category the foreign key cannot judge:
  // a song naming an ARCHIVED category, and a song naming a category from
  // ANOTHER Station. songs_category_company_fk references a NON-PARTIAL unique
  // constraint — a foreign key cannot reference a partial index — so it cannot
  // see deleted_at. That refusal lives in assert_song_references_live's fifth
  // block and nowhere else, which means an edit that drops those four lines
  // would leave an archived category silently choosable again with every other
  // suite green.
  { path: 'tests/isolation/music-categories.test.ts', minTests: 5 },
```

- [ ] **Step 8: Regenerate the database types**

Run: `npm run db:types`
Expected: `src/lib/supabase/database.types.ts` gains `music_categories` and
`songs.category_id`, and `music_reference_kind` gains `'CATEGORY'`.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/0204_music_category_kind.sql \
        supabase/migrations/0205_music_categories.sql \
        supabase/tests/57_music_categories.test.sql \
        tests/isolation/music-categories.test.ts \
        scripts/verify-isolation-suite.mjs \
        src/lib/supabase/database.types.ts
git commit -m "feat(music): a category becomes the fifth reference kind, and the live-reference check learns it"
```

---

## Task 3: A song carries its category

**Files:**
- Create: `supabase/migrations/0206_song_category_doors.sql`
- Modify: `src/schemas/music.ts` (lines 15, 96–150)
- Modify: `src/services/music.ts` (lines 66–74, 410–530, ~640–710)
- Modify: `src/app/(app)/music/songs/song-fields.tsx`
- Modify: `src/app/(app)/music/songs/actions.ts`
- Modify: `src/app/(app)/music/songs/song-record-dialog.tsx`
- Modify: `src/app/(app)/music/songs/songs-grid.tsx`
- Modify: `src/app/(app)/music/songs/page.tsx`
- Modify: `messages/{en,pt,es}.json`

**Interfaces:**
- Consumes: `songs.category_id`, `assert_song_references_live(…, p_category_id)`
  from Task 2.
- Produces: `SongSummary.categoryId: string | null` and
  `SongSummary.categoryName: string | null`; `songFormSchema.categoryId` and
  `songUpdateSchema.categoryId` (both `optionalUuid`); `SongFields` gains a
  required `categories: ReferenceSummary[]` prop.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0206_song_category_doors.sql`. **Open `0140`
(`create_song`), `0138` (`update_song`) and `0139` (`create_song_from_deezer`)
and copy each body verbatim into this file**, then make exactly these changes to
each copy. Do not start from `0101` — it is three fixes behind, and recreating
from it would silently revert `0102`'s removal of `p_legacy_id`, `0138`'s ISRC
and Deezer columns and `0140`'s album handling.

For all three:

1. Add `p_category_id uuid default null` as the **last** parameter.
2. Pass it as the fifth argument to `assert_song_references_live(...)`.
3. Add `category_id` to the `insert` column list and `p_category_id` to its
   `values` (create paths), or `category_id = p_category_id` to the `set` list
   (update path).
4. Extend the function's `comment on function` to name the category.

Each is a `drop function` + `create function` because the signature changes, and
each needs its grants restated afterwards. The file's header and its foot:

```sql
-- supabase/migrations/0206_song_category_doors.sql

-- Block 27. The three doors that write a song learn its category.
--
-- EACH BODY IS COPIED FORWARD FROM ITS LIVE DEFINITION, not from 0101:
-- create_song from 0140, update_song from 0138, create_song_from_deezer from
-- 0139. Recreating from the original would silently revert 0102's removal of
-- p_legacy_id, 0138's ISRC and Deezer columns and 0140's album handling — a
-- mistake this project has made once and written down.
--
-- DROP + CREATE, not REPLACE: each signature changes. Postgres would otherwise
-- create a second overload and leave callers resolving to whichever matched,
-- which is worse than either version. The revoke/grant pairs at the foot are
-- restated because DROP RESETS THE ACL (0102).
--
-- p_category_id is LAST and DEFAULTED on all three, so every existing caller —
-- services/music.ts, 0152's intake doors, and any hand-written call — keeps
-- working unchanged and means "no category".

-- ... the three drop/create pairs ...

revoke execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text, uuid, text, uuid) from public;
grant  execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text, uuid, text, uuid) to authenticated;
```

> **Before writing the revoke/grant lines, read each function's real argument
> list out of its `0138`/`0139`/`0140` definition and spell the signature
> exactly.** A `revoke` naming a signature that does not exist is an error, and a
> `grant` that misses one leaves the door callable by nobody. After
> `npm run db:reset`, confirm with:
> `psql "$SUPABASE_DB_URL" -c "\df+ public.create_song"` — or simply run the
> isolation suite, whose first `create_song` call fails loudly on a missing
> grant.

- [ ] **Step 2: Reset and run the isolation suite from Task 2**

Run: `npm run db:reset && npx vitest run --config vitest.isolation.config.ts tests/isolation/music-categories.test.ts`
Expected: all five cases PASS, including the three that were failing.

- [ ] **Step 3: Widen the schemas**

In `src/schemas/music.ts`:

```ts
/**
 * The five short lists 0100's music_reference_kind carries since 0204. Not the
 * merge's kinds (MUSIC_MERGE_KINDS below): that set adds SONG and drops
 * CATEGORY — whether duplicate categories need collapsing is not yet known, and
 * a merge is the one operation here that destroys.
 */
export const MUSIC_REFERENCE_KINDS = ['GENRE', 'LABEL', 'ARTIST', 'SHOW', 'CATEGORY'] as const;
```

and in `songFormSchema`, directly after `genreId: optionalUuid,`:

```ts
  // Block 27. Optional, like the label and the genre beside it: the whole
  // catalogue predates the column, so requiring one would make every existing
  // song unsavable. optionalUuid rather than optionalText because an untouched
  // select posts '' and a uuid check refuses it before any transform could
  // normalise it away.
  categoryId: optionalUuid,
```

`songUpdateSchema` derives from `songFormSchema`, so it inherits the field with
no edit.

- [ ] **Step 4: Widen the service**

In `src/services/music.ts`:

1. `REFERENCE_TABLES` gains `CATEGORY: 'music_categories'` and its value union
   gains `'music_categories'`.
2. `SONG_COLUMNS` gains `category_id` and the embed. The string becomes:

```ts
const SONG_COLUMNS =
  'id, title, artist_id, label_id, genre_id, category_id, nationality, vocal, duration_seconds, internal_code, legacy_id, created_at, album_id, deezer_track_id, isrc, artists(name), record_labels(name), music_genres(name), music_categories(name), albums(title, cover_md5)';
```

3. `SongRow` gains `| 'category_id'` in the `Pick` union and, beside its three
   siblings:

```ts
  /** Null when the category row is hidden by RLS — an archived category — or when the song has none. Typed by hand for the reason SONG_COLUMNS' comment gives at length. */
  music_categories: { name: string } | null;
```

4. `SongSummary` gains, after `genreName`:

```ts
  categoryId: string | null;
  categoryName: string | null;
```

5. `toSongSummary` gains:

```ts
    categoryId: row.category_id,
    // `?.` for the same reason as the three above it: an archived category is
    // invisible through RLS while category_id still names it.
    categoryName: row.music_categories?.name ?? null,
```

6. `SongListParams` gains `categoryId?: string;`, and inside `listSongsPage`'s
   `build()`, beside the genre filter:

```ts
    if (params.categoryId) q = q.eq('category_id', params.categoryId);
```

7. `createSong` and `updateSong` each gain `p_category_id: input.categoryId,` in
   their `rpc(...)` payloads, beside `p_genre_id`.

- [ ] **Step 5: Add the field to the form**

In `src/app/(app)/music/songs/song-fields.tsx`, add `categories:
ReferenceSummary[]` to the props and its JSDoc, then insert this block directly
after the genre block and before the album block:

```tsx
      {/*
        A select on BOTH paths, unlike the four fields above it. Those become
        text inputs under a Deezer prefill because Deezer names them and the
        named thing often does not exist in this Station yet, so the write
        resolves or creates by name. Deezer carries no category at all — there is
        no name to resolve and nothing to create — so the operator picks from
        this Station's own list either way.
      */}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('category')}</span>
        <Select name="categoryId" defaultValue={song?.categoryId ?? ''} disabled={disabled}>
          <option value="">{t('noCategory')}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </label>
```

- [ ] **Step 6: Thread the prop**

`SongFields` is rendered in four places. Add `categories={categories}` to every
one, and `categories` to the props of each component in the chain:

- `song-record-dialog.tsx`: `SongRecordDialog` props, `SongDataForm` props, and
  both `<SongFields …>` call sites (the editable one and the read-only one).
- `songs-grid.tsx`: `SongsGrid` props, `CreateSongDialog` props, `SongCreateForm`
  props, and its `<SongFields …>` call site; also `<SongRecordDialog …>`.
- `page.tsx`: add `listMusicReferences(selected.id, 'CATEGORY')` to the
  `Promise.all`, declare `let categories: ReferenceSummary[];`, destructure it in
  order, and pass `categories={categories}` to `<SongsGrid …>`.

- [ ] **Step 7: Send it through the actions**

In `src/app/(app)/music/songs/actions.ts`, add `categoryId: formData.get('categoryId'),`
to the object passed to `songFormSchema.safeParse` in the create action and to
`songUpdateSchema.safeParse` in the update action, beside `genreId`.

- [ ] **Step 8: Add the copy**

`messages/en.json`, `music` namespace: `"category": "Category"`,
`"noCategory": "No category"`.
`messages/pt.json`: `"category": "Categoria"`, `"noCategory": "Sem categoria"`.
`messages/es.json`: `"category": "Categoría"`, `"noCategory": "Sin categoría"`.

- [ ] **Step 9: Run the gates**

Run: `npm run lint && npm run typecheck && npm run test`
Expected: PASS, including the i18n parity and usage tests.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/0206_song_category_doors.sql src/schemas/music.ts \
        src/services/music.ts "src/app/(app)/music/songs" messages src/lib/supabase/database.types.ts
git commit -m "feat(music): a song carries a category, and the three doors that write one learn it"
```

---

## Task 4: The Categories screen

**Files:**
- Create: `src/app/(app)/catalog/categories/page.tsx`
- Modify: `src/app/(app)/catalog/references/list-params.ts` (lines 16–22)
- Modify: `src/app/(app)/catalog/references/actions.ts` (lines 53, 74–85)
- Modify: `messages/{en,pt,es}.json`
- Create: `tests/e2e/music-categories.spec.ts`

**Interfaces:**
- Consumes: `MUSIC_REFERENCE_KINDS` (Task 3), `ReferenceScreen`,
  `listMusicReferencesPage`.
- Produces: the route `/catalog/categories`, which Task 1's nav item points at.

- [ ] **Step 1: Widen the screen kind**

In `list-params.ts`:

```ts
/** The three kinds this screen renders. MusicReferenceKind also names ARTIST and SHOW; neither reaches this screen — Artists has its own screen, and Shows is /shows. */
export type ReferenceScreenKind = Extract<MusicReferenceKind, 'LABEL' | 'GENRE' | 'CATEGORY'>;

const REFERENCE_SCREEN_PATHS: Record<ReferenceScreenKind, string> = {
  LABEL: '/catalog/labels',
  GENRE: '/catalog/genres',
  CATEGORY: '/catalog/categories',
};
```

In `actions.ts`:

```ts
const REFERENCE_SCREEN_KINDS = ['LABEL', 'GENRE', 'CATEGORY'] as const;
```

and add to `ACTION_KEYS`:

```ts
  CATEGORY: {
    register: 'actionRegisterCategories',
    save: 'actionSaveThisCategory',
    archive: 'actionArchiveThisCategory',
  },
```

- [ ] **Step 2: Create the page**

Create `src/app/(app)/catalog/categories/page.tsx` as a **verbatim copy of
`src/app/(app)/catalog/genres/page.tsx`** with these substitutions and nothing
else changed:

| in `genres/page.tsx` | in `categories/page.tsx` |
|---|---|
| `const KIND = 'GENRE' as const;` | `const KIND = 'CATEGORY' as const;` |
| `GenresPage` | `CategoriesPage` |
| `'/catalog/genres'` | `'/catalog/categories'` |
| `'could not load the genres list'` | `'could not load the categories list'` |
| `t('genres')` (three places) | `t('musicCategories')` |
| the twelve `copy` values | the twelve below |

Replace the file's header comment with:

```tsx
/**
 * Block 27. Categories — a Station's own filing words for a recording, beside
 * the genre rather than instead of it.
 *
 * `genres/page.tsx` with a KIND and a `copy` object swapped, which is the whole
 * of design D2 and D4: this screen is not designed again. The Station switcher,
 * the URL-driven filter bar, the keyset paging, the pencil column and the
 * actions dropdown all come from ReferenceScreen.
 */
```

and the `copy` object with:

```tsx
  const copy: ReferenceScreenCopy = {
    title: t('musicCategories'),
    description: t('referenceCategoriesDescription'),
    createButton: t('registerCategory'),
    createDialogTitle: t('registerACategory'),
    archiveButton: t('archiveCategory'),
    archiveConfirmTitle: t('archiveThisCategoryQuestion'),
    readOnlyNotice: t('youDoNotHoldMusicManageForThisRecord'),
    emptyMessage: t('noCategoriesAreRegisteredInThis'),
    noMatchMessage: t('noCategoryMatchesTheseFilters'),
    countLabel: t('categoriesCountLabel', { count: page.total }),
    searchPlaceholder: t('categoryName'),
    searchAriaLabel: t('searchCategoriesByName'),
  };
```

- [ ] **Step 3: Add the copy in three languages**

`music` namespace. English:

```json
"musicCategories": "Categories",
"referenceCategoriesDescription": "How this station files its recordings. A song points at one, and the songs list filters by it.",
"registerCategory": "Register category",
"registerACategory": "Register a category",
"archiveCategory": "Archive category",
"archiveThisCategoryQuestion": "Archive this category?",
"noCategoriesAreRegisteredInThis": "No categories are registered in this station yet.",
"noCategoryMatchesTheseFilters": "No category matches these filters.",
"categoriesCountLabel": "{count, plural, one {# category} other {# categories}}",
"categoryName": "Category name",
"searchCategoriesByName": "Search categories by name",
"actionRegisterCategories": "register categories",
"actionSaveThisCategory": "save this category",
"actionArchiveThisCategory": "archive this category"
```

Portuguese:

```json
"musicCategories": "Categorias",
"referenceCategoriesDescription": "Como esta emissora classifica seu acervo. Uma música aponta para uma, e a lista de músicas filtra por ela.",
"registerCategory": "Cadastrar categoria",
"registerACategory": "Cadastrar uma categoria",
"archiveCategory": "Arquivar categoria",
"archiveThisCategoryQuestion": "Arquivar esta categoria?",
"noCategoriesAreRegisteredInThis": "Nenhuma categoria cadastrada nesta emissora ainda.",
"noCategoryMatchesTheseFilters": "Nenhuma categoria corresponde a estes filtros.",
"categoriesCountLabel": "{count, plural, one {# categoria} other {# categorias}}",
"categoryName": "Nome da categoria",
"searchCategoriesByName": "Buscar categorias por nome",
"actionRegisterCategories": "cadastrar categorias",
"actionSaveThisCategory": "salvar esta categoria",
"actionArchiveThisCategory": "arquivar esta categoria"
```

Spanish:

```json
"musicCategories": "Categorías",
"referenceCategoriesDescription": "Cómo esta emisora clasifica su catálogo. Una canción apunta a una, y la lista de canciones filtra por ella.",
"registerCategory": "Registrar categoría",
"registerACategory": "Registrar una categoría",
"archiveCategory": "Archivar categoría",
"archiveThisCategoryQuestion": "¿Archivar esta categoría?",
"noCategoriesAreRegisteredInThis": "Todavía no hay categorías registradas en esta emisora.",
"noCategoryMatchesTheseFilters": "Ninguna categoría coincide con estos filtros.",
"categoriesCountLabel": "{count, plural, one {# categoría} other {# categorías}}",
"categoryName": "Nombre de la categoría",
"searchCategoriesByName": "Buscar categorías por nombre",
"actionRegisterCategories": "registrar categorías",
"actionSaveThisCategory": "guardar esta categoría",
"actionArchiveThisCategory": "archivar esta categoría"
```

> `musicCategories`, not `categories`: the `music` namespace may already carry a
> `category` key from Task 3, and a `categories` key would read as its plural
> while meaning the screen title. Check for a collision before adding, and if
> `music.categories` already exists, keep `musicCategories`.

- [ ] **Step 4: Write the e2e journey**

Create `tests/e2e/music-categories.spec.ts`, modelled on
`tests/e2e/prize-categories.spec.ts` (read it first for the provisioning and
sign-in helpers this suite uses). The journey:

```ts
// 1. Sign in, open Catalog, click Categories.
// 2. Register "Trilha sonora".
// 3. Expect the row to appear with a pencil and an actions button.
// 4. Go to Songs, open the register dialog, expect "Trilha sonora" among the
//    Category select's options, register a song with it.
// 5. Expect the song's row to show "Trilha sonora" in the Category column.
// 6. Filter by it, expect exactly that song.
// 7. Return to Categories, try to archive it, expect a refusal message rather
//    than the row disappearing.
```

Every assertion selects by role and accessible name in English —
`playwright.config.ts` pins `locale: 'en-US'` for the suite — and reaching the
screen goes through `openNavSection(page, 'Catalog')` first, as every other spec
does.

- [ ] **Step 5: Run the gates**

Run: `npm run lint && npm run typecheck && npm run test && npx playwright test tests/e2e/music-categories.spec.ts`
Expected: PASS. Steps 4–6 of the journey depend on Task 5's column and filter; if
Task 5 has not landed, write them now and expect them red, then re-run at the end
of Task 5.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/catalog" messages tests/e2e/music-categories.spec.ts
git commit -m "feat(catalog): a Categories screen, on the component Labels and Genres already share"
```

---

## Task 5: The category becomes a column and a filter

**Files:**
- Modify: `src/app/(app)/music/songs/list-params.ts`
- Modify: `src/app/(app)/music/songs/songs-filters.tsx`
- Modify: `src/app/(app)/music/songs/songs-grid.tsx`
- Modify: `src/app/(app)/music/songs/page.tsx`
- Modify: `messages/{en,pt,es}.json`

**Interfaces:**
- Consumes: `SongSummary.categoryName`, `SongListParams.categoryId` (Task 3);
  `categories: ReferenceSummary[]` already reaching `page.tsx` (Task 3, step 6).
- Produces: `SongListState.categoryId`; the URL parameter `?category=<uuid>`.

- [ ] **Step 1: Extend the URL contract**

In `list-params.ts`: add `category?: string;` to `MusicSearchParams` (after
`genre`); add to `SongListState`:

```ts
  /** A category id; undefined means every category. */
  categoryId?: string;
```

add `categoryId: raw.category?.trim() || undefined,` to `parseSongListState`;
extend `hasActiveSongFilters`:

```ts
export function hasActiveSongFilters(state: SongListState): boolean {
  return Boolean(state.search || state.artistId || state.genreId || state.categoryId);
}
```

and add to `songHref`, after the genre line:

```ts
  if (state.categoryId) query.set('category', state.categoryId);
```

- [ ] **Step 2: Add the filter control**

In `songs-filters.tsx`: add `const ALL_CATEGORIES = '';` beside its two
siblings, `categories: ReferenceSummary[]` to the props, and this block after the
genre one:

```tsx
      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('category')}</span>
        <Select
          value={state.categoryId ?? ALL_CATEGORIES}
          onChange={(e) => navigate({ categoryId: e.target.value || undefined })}
          data-testid="song-category-filter"
        >
          <option value={ALL_CATEGORIES}>{t('allCategories')}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </label>
```

The "clear filters" `<Link>` at the foot of that component builds a `songHref`
from four named fields and deliberately omits every filter — leave it exactly as
it is, which is how it clears the new one too.

- [ ] **Step 3: Add the column**

In `songs-grid.tsx`:

```ts
/**
 * How many columns the empty-state row has to span, actions included. Ten since
 * Block 27 added the category — a number that has to be raised by hand with
 * every column, or the "no songs" row stops spanning the table.
 */
const COLUMN_COUNT = 10;
```

Add `<TableHead>{t('category')}</TableHead>` immediately after the Genre head,
and `<TableCell>{song.categoryName ?? '—'}</TableCell>` immediately after the
genre cell. `—` rather than blank, matching the label and genre cells beside it.

- [ ] **Step 4: Wire the page**

In `page.tsx`: pass `categoryId: state.categoryId,` inside the `listSongsPage`
call, and `categories={categories}` to `<SongsFilters …>`.

- [ ] **Step 5: Add the copy**

`music` namespace: `"allCategories"` — English `"All categories"`, Portuguese
`"Todas as categorias"`, Spanish `"Todas las categorías"`. (`category` already
exists from Task 3.)

- [ ] **Step 6: Run the gates and the journey**

Run: `npm run lint && npm run typecheck && npm run test && npx playwright test tests/e2e/music-categories.spec.ts`
Expected: PASS, all seven steps of the journey.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/music/songs" messages
git commit -m "feat(music): the songs list gains a category column and a category filter"
```

---

## Task 6: The card, its table and its door

**Files:**
- Create: `supabase/migrations/0207_song_integrations.sql`
- Create: `supabase/tests/58_song_integrations.test.sql`
- Create: `tests/isolation/song-integrations.test.ts`
- Modify: `scripts/verify-isolation-suite.mjs`
- Modify: `src/services/music.ts`
- Modify: `src/schemas/music.ts`
- Modify: `src/lib/supabase/database.types.ts` (generated)

**Interfaces:**
- Consumes: nothing from Tasks 1–5.
- Produces:
  - table `public.song_integrations (id, organization_id, company_id, code, title, artist_name, category_name, …)`
  - `save_song_integration(p_company_id uuid, p_code text, p_title text, p_artist text, p_category text) returns uuid`
  - `SongIntegration` — `{ id, code, title, artistName, categoryName }`, all
    strings except `title`/`artistName`/`categoryName` which are `string | null`
  - `getSongIntegration(companyId: string, code: string): Promise<SongIntegration | null>`
  - `countSongsSharingCode(companyId: string, code: string): Promise<number>`
  - `saveSongIntegration(input: SongIntegrationInput, accessToken: string): Promise<string>`
  - `songIntegrationSchema` — the Zod object Task 7 and Task 8 both parse with

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0207_song_integrations.sql`:

```sql
-- supabase/migrations/0207_song_integrations.sql

-- Block 27. One song AS IT EXISTS IN THE CUSTOMER'S OWN SYSTEM: their code,
-- their spelling of the title and the artist, and their word for the category.
--
-- NOT songs.external_id (0150). That column is Block 15's API-intake key —
-- the primary key of whichever system POSTs to us, unique per Station, written
-- by the intake doors and by nothing a person touches. This is the opposite
-- direction: a description the customer exports to US, of a catalogue we do not
-- write to. Two columns whose names both said "external" is a misreading
-- waiting to happen, which is why this table's key is called `code` and why
-- songs.internal_code keeps its name.
--
-- A TABLE RATHER THAN THREE COLUMNS ON `songs`, and the owner's own statement of
-- the problem is the reason: several PulchatX songs may point at ONE song in
-- their system. Columns would store the description once per song and let the
-- copies drift.
--
-- LINKED BY CODE, WITH NO FOREIGN KEY. songs.internal_code already holds codes
-- with nothing behind them — all of them, today — and a hard reference would
-- refuse to save every one of those songs. A code with no card is a legitimate,
-- permanent state.

create table public.song_integrations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  code            text not null,
  title           text,
  artist_name     text,
  category_name   text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint song_integrations_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint song_integrations_code_not_blank check (btrim(code) <> '')
);

comment on table public.song_integrations is
  'A song as the customer''s own scheduling software describes it, keyed by the code songs.internal_code carries. Several songs may resolve one card, which is why the three descriptive fields are here and not columns on `songs`. category_name is free text and deliberately not a reference to music_categories: it is the other system''s vocabulary, and forcing it into ours would either refuse an import or invent categories nobody asked for.';

-- Unique among LIVE rows only, so a card can be retired and its code reused —
-- the partial shape 0150 uses for its own external keys.
create unique index song_integrations_code_live
  on public.song_integrations (company_id, code) where deleted_at is null;

alter table public.song_integrations enable row level security;
revoke all on public.song_integrations from anon, authenticated;
grant select on public.song_integrations to authenticated;

create policy song_integrations_select_music_view on public.song_integrations
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));

-- ---------------------------------------------------------------------------
-- The one door. There is no archive and no delete, and the absence is the
-- decision: a card whose code no song carries is unreachable from every screen
-- and harms nothing. Adding a retire door the day the cards need managing is a
-- migration; guessing at one now is a screen nobody asked for.
-- ---------------------------------------------------------------------------

create function public.save_song_integration(
  p_company_id uuid,
  p_code       text,
  p_title      text default null,
  p_artist     text default null,
  p_category   text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_id       uuid;
  v_code     text := nullif(btrim(coalesce(p_code, '')), '');
  v_title    text := nullif(btrim(coalesce(p_title, '')), '');
  v_artist   text := nullif(btrim(coalesce(p_artist, '')), '');
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
begin
  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Before anything is read out of song_integrations: a caller who may not write
  -- here learns that, and learns nothing about which codes this Station holds.
  if not public.has_permission('music.manage', p_company_id) then
    raise log 'save_song_integration denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_code is null then
    raise exception 'the card needs an integration code' using errcode = '22023';
  end if;

  -- The columns are unbounded `text`; the form's maxLength is a courtesy a
  -- caller posting straight at this RPC never sees, and the JSON import is a
  -- FILE, which is exactly the kind of input that arrives long.
  if length(v_code) > 40 then
    raise exception 'an integration code is at most 40 characters' using errcode = '22023';
  end if;
  if length(coalesce(v_title, '')) > 200 then
    raise exception 'an integration title is at most 200 characters' using errcode = '22023';
  end if;
  if length(coalesce(v_artist, '')) > 160 then
    raise exception 'an integration artist is at most 160 characters' using errcode = '22023';
  end if;
  if length(coalesce(v_category, '')) > 160 then
    raise exception 'an integration category is at most 160 characters' using errcode = '22023';
  end if;

  -- Upsert on the live unique index. Every field is set on every call, the
  -- convention update_song and update_prize both follow: a partial submission
  -- blanks what it omits, which is what "the card says this" has to mean.
  insert into public.song_integrations
    (organization_id, company_id, code, title, artist_name, category_name, created_by)
  values
    (v_org, p_company_id, v_code, v_title, v_artist, v_category, v_actor)
  on conflict (company_id, code) where deleted_at is null
  do update set title         = excluded.title,
                artist_name   = excluded.artist_name,
                category_name = excluded.category_name,
                updated_at    = now()
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_song_integration', 'song_integrations', v_id, v_org, p_company_id,
     jsonb_build_object('code', v_code));

  return v_id;
end;
$$;

comment on function public.save_song_integration(uuid, text, text, text, text) is
  'Registers or corrects the card describing one song in the customer''s own system, keyed by (company_id, code). Gated on music.manage, checked before anything is read. Every field is set on every call, so an omitted title clears the stored one. The audit detail carries the code and NOT the three descriptive fields: they are the customer''s catalogue, not a decision anybody made, and a log of every title typed would grow without telling a reader anything they could act on.';

revoke execute on function public.save_song_integration(uuid, text, text, text, text) from public;
grant  execute on function public.save_song_integration(uuid, text, text, text, text) to authenticated;
```

- [ ] **Step 2: Reset and confirm**

Run: `npm run db:reset && npm run db:types`
Expected: applies cleanly; `database.types.ts` gains `song_integrations` and
`save_song_integration`.

- [ ] **Step 3: Write the pgTAP suite**

Create `supabase/tests/58_song_integrations.test.sql`:

```sql
begin;
select plan(11);

-- Block 27. The structure of the card and its one door. Every cross-Station and
-- upsert claim is in tests/isolation/song-integrations.test.ts, for the reason
-- every file in this directory gives: this session is superuser with a null
-- auth.uid(), where RLS never applies.

select has_table('public', 'song_integrations', 'the card table exists');
select has_column('public', 'song_integrations', 'code', 'keyed by the customer''s code');
select has_column('public', 'song_integrations', 'category_name',
                  'their word for the category, not ours');

-- Live rows only, so a retired card's code can be used again.
select has_index('public', 'song_integrations', 'song_integrations_code_live',
                 'one live card per code per Station');

-- The card is NOT songs.external_id (0150), and the column it is keyed against
-- is still there under its own name.
select has_column('public', 'songs', 'internal_code', 'the integration code keeps its column name');
select has_column('public', 'songs', 'external_id', 'and 0150''s intake key is untouched beside it');

select has_function('public', 'save_song_integration',
                    array['uuid', 'text', 'text', 'text', 'text'],
                    'the one door exists');
select ok(
  has_function_privilege('authenticated', 'public.save_song_integration(uuid,text,text,text,text)', 'execute'),
  'a member may write a card');
select ok(
  not has_function_privilege('anon', 'public.save_song_integration(uuid,text,text,text,text)', 'execute'),
  'anon may not');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.song_integrations'::regclass),
  'row level security is on');
select ok(
  not has_table_privilege('authenticated', 'public.song_integrations', 'insert'),
  'and the door is the only way in');

select * from finish();
rollback;
```

- [ ] **Step 4: Write the isolation suite**

Create `tests/isolation/song-integrations.test.ts` with four cases, in the shape
of `tests/isolation/music-categories.test.ts` from Task 2:

```ts
// 1. 'a card of one Station is invisible from another, inside the same Organization'
//    — a delegate holding music.view + music.manage in BOTH Stations writes a
//    card at A, reads one row at A and none at B.
// 2. 'is refused for a delegate holding music.view alone, and writes nothing'
//    — 42501, and a follow-up select returns nothing.
// 3. 'a second save on the same code corrects the card rather than adding one'
//    — save twice with different titles, expect one row and the second title.
//    This is the only proof anywhere that the upsert targets the partial index.
// 4. 'two songs may carry the same code and resolve one card'
//    — register two songs with the same internal_code, save one card, expect
//    both to resolve it. This is the owner's stated requirement and the reason
//    the three fields are not columns on `songs`.
```

- [ ] **Step 5: Add the manifest entry**

In `scripts/verify-isolation-suite.mjs`, after the Block 27 categories entry:

```js
  // Block 27. Four cases, and the floor is the full count because two of them
  // are the only proof of their property in this repository.
  //
  // The upsert targeting the PARTIAL unique index: `on conflict (company_id,
  // code) where deleted_at is null` is easy to write as a plain `on conflict
  // (company_id, code)`, which would not compile against a partial index at all
  // — and easy to "fix" by widening the index, which would then refuse to
  // register a card whose code a retired card once used. 58_song_integrations
  // .test.sql asserts the index exists; only a real write proves the door uses
  // it.
  //
  // And two songs resolving ONE card, which is the owner's stated requirement
  // and the whole reason the three descriptive fields are a table rather than
  // columns on `songs`. Nothing else asserts it.
  { path: 'tests/isolation/song-integrations.test.ts', minTests: 4 },
```

- [ ] **Step 6: Add the service layer**

In `src/schemas/music.ts`:

```ts
/**
 * The card describing one song in the customer's own system (0207). The bounds
 * are save_song_integration's own, restated here so a refusal the database would
 * make anyway arrives as a field message instead of a round trip — and so the
 * JSON import (src/lib/song-integration-file.ts) and the form validate against
 * ONE definition rather than two that could drift.
 */
export const songIntegrationSchema = z.object({
  code: z.string().trim().min(1, 'Give the card an integration code.').max(40),
  title: optionalText(200),
  artistName: optionalText(160),
  categoryName: optionalText(160),
});

export type SongIntegrationInput = z.infer<typeof songIntegrationSchema>;

/** What the tab posts: the card, plus the Station it belongs to. */
export const songIntegrationFormSchema = songIntegrationSchema.extend({
  companyId: z.string().uuid(),
});

export type SongIntegrationFormInput = z.infer<typeof songIntegrationFormSchema>;
```

In `src/services/music.ts`, add:

```ts
export interface SongIntegration {
  id: string;
  code: string;
  title: string | null;
  artistName: string | null;
  categoryName: string | null;
}

/**
 * The card for one code, or null when this Station has never described it.
 *
 * Resolved by code rather than by a foreign key (0207's own header says why),
 * so this is a lookup and not a join: the Songs list's SONG_COLUMNS deliberately
 * does not embed it — a per-row lookup on a list of fifty is fifty round trips,
 * and the card is only ever read on one open record.
 */
export async function getSongIntegration(
  companyId: string,
  code: string,
): Promise<SongIntegration | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('song_integrations')
    .select('id, code, title, artist_name, category_name')
    .eq('company_id', companyId)
    .eq('code', code)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new InternalError(`Could not read the integration card: ${error.message}`);
  if (!data) return null;

  return {
    id: data.id,
    code: data.code,
    title: data.title,
    artistName: data.artist_name,
    categoryName: data.category_name,
  };
}

/**
 * How many LIVE songs in this Station carry this code — the number the
 * Integration tab warns with before an edit, because correcting a card corrects
 * it for all of them.
 *
 * `head: true` with an exact count: the rows themselves are never wanted, and
 * RLS has already cut the table to the Stations this caller can read.
 */
export async function countSongsSharingCode(companyId: string, code: string): Promise<number> {
  const supabase = await createUserClient();
  const { count, error } = await supabase
    .from('songs')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('internal_code', code)
    .is('deleted_at', null);

  if (error) throw new InternalError(`Could not count songs sharing this code: ${error.message}`);
  return count ?? 0;
}

export async function saveSongIntegration(
  input: SongIntegrationFormInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('save_song_integration', {
    p_company_id: input.companyId,
    p_code: input.code,
    p_title: input.title,
    p_artist: input.artistName,
    p_category: input.categoryName,
  });
  if (error) throw mapMusicError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('save_song_integration returned no id');
  return data;
}
```

- [ ] **Step 7: Run the gates**

Run: `npm run lint && npm run typecheck && npm run test && npm run db:reset && npm run db:test && npm run test:isolation`
Expected: PASS, with the two new pgTAP files and the two new isolation files
reporting.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0207_song_integrations.sql supabase/tests/58_song_integrations.test.sql \
        tests/isolation/song-integrations.test.ts scripts/verify-isolation-suite.mjs \
        src/services/music.ts src/schemas/music.ts src/lib/supabase/database.types.ts
git commit -m "feat(music): a song gains a card describing it in the customer's own system"
```

---

## Task 7: The Integration tab

**Files:**
- Modify: `src/lib/record-params.ts` (`SONG_TABS`, line 129)
- Modify: `src/app/(app)/music/songs/record.ts`
- Create: `src/app/(app)/music/songs/integration-actions.ts`
- Create: `src/app/(app)/music/songs/integration-tab.tsx`
- Modify: `src/app/(app)/music/songs/song-record-dialog.tsx`
- Modify: `src/app/(app)/music/songs/song-fields.tsx`
- Modify: `messages/{en,pt,es}.json`

**Interfaces:**
- Consumes: `getSongIntegration`, `countSongsSharingCode`, `saveSongIntegration`,
  `songIntegrationFormSchema` (Task 6).
- Produces: `SongRecord` gains `integration: SongIntegration | null` and
  `sharedCodeCount: number`; `saveSongIntegrationAction(prev, formData):
  Promise<SongIntegrationState>` where
  `SongIntegrationState = { status: 'idle' | 'saved' | 'error'; message?: string; integration?: SongIntegration }`.

- [ ] **Step 1: Append the tab**

In `src/lib/record-params.ts`:

```ts
/**
 * Three since Block 27, where Block 13a made it two and Block 7 one. The strip
 * in song-record-dialog.tsx maps over this tuple rather than hard-coding names,
 * so each addition has cost an entry and a label rather than a rewrite — twice
 * now.
 *
 * APPENDED, never inserted: `data` must stay the tab an unknown `?tab=` falls
 * back to and the one a record opens on. PROMOTION_TABS' comment above records
 * what inserting once cost.
 */
export const SONG_TABS = ['data', 'deezer', 'integration'] as const;
```

- [ ] **Step 2: Widen the record read**

In `src/app/(app)/music/songs/record.ts`:

```ts
export interface SongRecord {
  companyId: string;
  song: SongSummary;
  /** The card for this song's integration code, or null when the code names none — or when the song has no code at all. */
  integration: SongIntegration | null;
  /**
   * How many live songs in this Station carry the same code, this one included.
   * The Integration tab says so before an edit: correcting a card corrects it for
   * every song resolving it, and a screen that quietly rewrote four other records
   * would be the defect this number exists to prevent.
   */
  sharedCodeCount: number;
}
```

and in `getSongRecordAction`, after `getSongById`:

```ts
    const code = found.song.internalCode;
    // Two reads rather than one, and only for an OPEN record: the card is
    // resolved by code with no foreign key (0207), so PostgREST cannot embed it,
    // and the Songs list deliberately does not carry it — a per-row lookup on a
    // page of fifty would be fifty round trips for a column nobody asked for.
    const [integration, sharedCodeCount] = code
      ? await Promise.all([
          getSongIntegration(found.companyId, code),
          countSongsSharingCode(found.companyId, code),
        ])
      : [null, 0];

    return {
      status: 'ok',
      record: { companyId: found.companyId, song: found.song, integration, sharedCodeCount },
    };
```

- [ ] **Step 3: Write the action**

Create `src/app/(app)/music/songs/integration-actions.ts`:

```ts
'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { songIntegrationFormSchema } from '@/schemas/music';
import { getSongIntegration, saveSongIntegration } from '@/services/music';
import type { SongIntegration } from '@/services/music';
import { describeMusicWriteError } from '../errors';

export interface SongIntegrationState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  integration?: SongIntegration;
}

/**
 * The one write path from the Integration tab, for a hand-typed edit and for a
 * form the JSON import filled alike — the import writes nothing of its own
 * (design D9), so there is one action here rather than two.
 *
 * No revalidatePath. The song record is a client-side read
 * (getSongRecordAction) keyed by an id useRecordDialog put in the URL through
 * the raw history API, which Next's router never learns about — the exact
 * situation music/songs/actions.ts records as the reason this screen patches
 * rows instead. The saved card is handed back so the tab renders what the
 * database now holds.
 */
export async function saveSongIntegrationAction(
  _prev: SongIntegrationState,
  formData: FormData,
): Promise<SongIntegrationState> {
  const parsed = songIntegrationFormSchema.safeParse({
    companyId: formData.get('companyId'),
    code: formData.get('code'),
    title: formData.get('title') || null,
    artistName: formData.get('artistName') || null,
    categoryName: formData.get('categoryName') || null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');

  try {
    await saveSongIntegration(parsed.data, token);
    const integration = await getSongIntegration(parsed.data.companyId, parsed.data.code);
    return { status: 'saved', integration: integration ?? undefined };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'save song integration failed');
    return {
      status: 'error',
      message: describeMusicWriteError(
        cause,
        await getTranslations('music'),
        // A literal key, not a lookup: tests/unit/i18n/usage.test.ts can only
        // see literal t('key') calls.
        (await getTranslations('music'))('actionSaveThisIntegrationCard'),
      ),
    };
  }
}
```

> Read `describeMusicWriteError`'s real signature in
> `src/app/(app)/music/errors.ts` before finishing this file and match it —
> the third argument in the reference actions is an already-resolved **phrase**,
> resolved by a literal `t(...)` at the call site. Resolve `t` once into a local
> and pass `t('actionSaveThisIntegrationCard')`.

- [ ] **Step 4: Write the tab**

Create `src/app/(app)/music/songs/integration-tab.tsx` — a client component with:

- a `<form action={action}>` carrying hidden `companyId`, and four `<Input>`s:
  `code` (maxLength 40, required), `title` (200), `artistName` (160),
  `categoryName` (160), defaulted from `record.integration` and, for `code`,
  from `record.song.internalCode`;
- above them, when `sharedCodeCount > 1`, a warning line:
  `{t('thisCodeIsAlsoUsedByOtherSongs', { count: sharedCodeCount - 1 })}`;
- when `record.integration === null` and the code is non-empty, a muted line:
  `{t('noCardIsRegisteredForThisCode')}`;
- a Save button disabled while pending, and the saved/error messages beside it,
  in the shape `SongDataForm` uses;
- the whole form rendered `disabled` with `{t('youDoNotHoldMusicManage2')}` above
  it when `manage` is false, exactly as the Song data tab does;
- the import button from Task 8 (leave a placeholder `null` here and add it
  there, or write both in Task 8 — do not ship a button that does nothing).

- [ ] **Step 5: Move the code field and wire the tab**

In `song-fields.tsx`: delete the `internalCode` block (lines ~301–309). It now
lives on the Integration tab for a record, and at the foot of the create form —
so add it back **inside a `{!song && (...)}` guard**, after the ISRC field, with
the new label:

```tsx
      {/*
        Block 27. On the CREATE form only. For a song that exists, this field is
        the first row of the Integration tab, where the three fields describing
        the card it points at sit with it. The create dialog has no tabs — the
        strip renders only once a record exists — and dropping the field here
        would remove a capability the screen has today.
      */}
      {!song && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('integrationCode')}</span>
          <Input name="internalCode" maxLength={40} disabled={disabled} />
        </label>
      )}
```

In `song-record-dialog.tsx`: add `integration: 'integrationTab'` to
`TAB_LABEL_KEYS`, and render the new tab:

```tsx
        {record && tab === 'integration' && (
          <IntegrationTab record={record} manage={manage} onSaved={(next) => setRecord({ ...record, integration: next })} />
        )}
```

- [ ] **Step 6: Add the copy**

`music` namespace, three languages:

| key | en | pt | es |
|---|---|---|---|
| `integrationTab` | Integration | Integração | Integración |
| `integrationCode` | Integration code | Código de integração | Código de integración |
| `integrationTitle` | Title | Título | Título |
| `integrationArtist` | Artist | Artista | Artista |
| `integrationCategory` | Category | Categoria | Categoría |
| `noCardIsRegisteredForThisCode` | No card is registered for this code yet. Fill the fields and save to register one. | Nenhuma ficha cadastrada para este código ainda. Preencha os campos e salve para cadastrar uma. | Todavía no hay ficha registrada para este código. Complete los campos y guarde para registrar una. |
| `thisCodeIsAlsoUsedByOtherSongs` | `{count, plural, one {# other song uses this code — saving changes what it shows too.} other {# other songs use this code — saving changes what they show too.}}` | `{count, plural, one {Outra # música usa este código — salvar muda o que ela mostra também.} other {Outras # músicas usam este código — salvar muda o que elas mostram também.}}` | `{count, plural, one {Otra # canción usa este código — guardar cambia lo que muestra también.} other {Otras # canciones usan este código — guardar cambia lo que muestran también.}}` |
| `actionSaveThisIntegrationCard` | save this integration card | salvar esta ficha de integração | guardar esta ficha de integración |

Also **change** the existing `music.internalCode` value from "Internal code" to
"Integration code" in all three, or delete it if nothing references it after this
task — check with `grep -rn "internalCode'" src`.

- [ ] **Step 7: Run the gates**

Run: `npm run lint && npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/record-params.ts "src/app/(app)/music/songs" messages
git commit -m "feat(music): an Integration tab, and the internal code becomes the integration code"
```

---

## Task 8: The JSON import and its validation

**Files:**
- Create: `src/lib/song-integration-file.ts`
- Create: `tests/unit/song-integration-file.test.ts`
- Modify: `src/app/(app)/music/songs/integration-tab.tsx`
- Modify: `messages/{en,pt,es}.json`
- Create: `tests/e2e/song-integration.spec.ts`

**Interfaces:**
- Consumes: `songIntegrationSchema` (Task 6).
- Produces: `MAX_INTEGRATION_FILE_BYTES = 64 * 1024`; and
  `parseIntegrationFile(text: string): IntegrationFileResult` where
  `IntegrationFileResult = { ok: true; card: SongIntegrationInput } | { ok: false; reason: 'unreadable' | 'empty' | 'many' | 'invalid'; count?: number; detail?: string }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/song-integration-file.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseIntegrationFile } from '@/lib/song-integration-file';

/**
 * Block 27. The file is the operator's, which means it is hostile input: nothing
 * here may throw, and nothing may reach the form that the RPC would not accept.
 *
 * The parse is the browser's convenience only. saveSongIntegrationAction runs
 * songIntegrationFormSchema again on the server and save_song_integration
 * re-checks permission and lengths in its own body — so a failure here is a
 * message, never a hole.
 */
describe('parseIntegrationFile', () => {
  it('accepts a bare object carrying the four fields', () => {
    const result = parseIntegrationFile(
      JSON.stringify({ code: 'A-1', title: 'Asa Branca', artistName: 'Luiz Gonzaga', categoryName: 'Forró' }),
    );
    expect(result).toEqual({
      ok: true,
      card: { code: 'A-1', title: 'Asa Branca', artistName: 'Luiz Gonzaga', categoryName: 'Forró' },
    });
  });

  it('accepts an array of exactly one', () => {
    const result = parseIntegrationFile(JSON.stringify([{ code: 'A-1' }]));
    expect(result.ok).toBe(true);
  });

  it('refuses an array of many, and says how many it found', () => {
    const result = parseIntegrationFile(JSON.stringify([{ code: 'A' }, { code: 'B' }, { code: 'C' }]));
    expect(result).toMatchObject({ ok: false, reason: 'many', count: 3 });
  });

  it('refuses an empty array', () => {
    expect(parseIntegrationFile('[]')).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('refuses malformed JSON without throwing', () => {
    expect(parseIntegrationFile('{ not json')).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('refuses a card with no code', () => {
    expect(parseIntegrationFile(JSON.stringify({ title: 'No code' }))).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses a code longer than the column accepts', () => {
    expect(parseIntegrationFile(JSON.stringify({ code: 'x'.repeat(41) }))).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('drops keys nobody asked for rather than accepting them', () => {
    const result = parseIntegrationFile(
      JSON.stringify({ code: 'A-1', title: 'T', isAdmin: true, companyId: 'other' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.card).sort()).toEqual(['code', 'title']);
  });

  it('does not let a file reach the prototype', () => {
    // JSON.parse makes __proto__ an own property rather than a prototype write,
    // so this passes today by the parser's own behaviour. Asserted anyway: "the
    // parser happens to be safe" is not a thing to depend on silently, and the
    // card must be a fresh object regardless of what arrived.
    const result = parseIntegrationFile('{"code":"A-1","__proto__":{"polluted":true}}');
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (result.ok) expect(Object.getPrototypeOf(result.card)).toBe(Object.prototype);
  });

  it('strips control characters and trims', () => {
    const result = parseIntegrationFile(JSON.stringify({ code: '  A-1   ', title: 'AB' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card).toMatchObject({ code: 'A-1', title: 'AB' });
  });

  it('refuses a top-level value that is neither an object nor an array', () => {
    expect(parseIntegrationFile('"just a string"')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parseIntegrationFile('null')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses a non-string field rather than coercing it', () => {
    expect(parseIntegrationFile(JSON.stringify({ code: 12345 }))).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/song-integration-file.test.ts`
Expected: FAIL — `Cannot find module '@/lib/song-integration-file'`.

- [ ] **Step 3: Write the parser**

Create `src/lib/song-integration-file.ts`:

```ts
import { songIntegrationSchema } from '@/schemas/music';
import type { SongIntegrationInput } from '@/schemas/music';

/**
 * Block 27. One card, from a file the operator's own software wrote.
 *
 * THIS IS NOT A SECURITY BOUNDARY AND IS NOT WRITTEN AS ONE. It runs in the
 * browser, so a determined caller simply does not run it;
 * saveSongIntegrationAction parses the same schema again on the server and
 * save_song_integration re-checks permission and every length in its own body.
 * What this buys is that an honest mistake — the wrong file, an export with
 * thirty columns, a truncated download — becomes a sentence on the screen
 * instead of a round trip that fails with the database's own wording.
 *
 * Nothing here throws. Every unreadable shape is a `reason` the tab can phrase.
 */

/** Checked against File.size BEFORE the file is read, so a huge file never becomes a string. One card does not need more. */
export const MAX_INTEGRATION_FILE_BYTES = 64 * 1024;

/** The only keys taken off the file. Anything else is dropped — an operator's export carrying thirty columns imports the four we asked for. */
const ALLOWED_KEYS = ['code', 'title', 'artistName', 'categoryName'] as const;

export type IntegrationFileResult =
  | { ok: true; card: SongIntegrationInput }
  | { ok: false; reason: 'unreadable' | 'empty' | 'many' | 'invalid'; count?: number };

/**
 * C0 and C1 control characters, which a pasted or badly-encoded export carries
 * and which no field here should ever hold: a newline inside a code makes two
 * codes that look identical on screen and are not.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[ --]/g;

function clean(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(CONTROL_CHARS, '').trim();
}

export function parseIntegrationFile(text: string): IntegrationFileResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) return { ok: false, reason: 'empty' };
    // The owner chose one card per file (design D10). More than one is refused
    // rather than guessed at — picking the first would silently import the wrong
    // song, which is worse than asking for a different file.
    if (raw.length > 1) return { ok: false, reason: 'many', count: raw.length };
    raw = raw[0];
  }

  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'invalid' };

  // Built key by key into a FRESH object rather than spread or Object.assign'd:
  // whatever arrived is never the thing that leaves, so `__proto__`,
  // `constructor` and anything else the file carried simply has no path onward.
  // (JSON.parse already makes `__proto__` an own property rather than a
  // prototype write, so this is defence in depth — written down because "the
  // parser happens to be safe" is not something to depend on silently.)
  const source = raw as Record<string, unknown>;
  const candidate: Record<string, unknown> = Object.create(null);
  for (const key of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    candidate[key] = clean(source[key]);
  }

  const parsed = songIntegrationSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: 'invalid' };

  // Zod returns its own fresh object, and `optionalText` turns a blank into
  // undefined — so the card carries only the keys that had a value.
  return { ok: true, card: parsed.data };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/song-integration-file.test.ts`
Expected: PASS, 12 of 12. If the "drops keys nobody asked for" case fails on
`Object.keys`, `Object.create(null)` is producing a null-prototype object that
Zod copies — the assertion on `Object.getPrototypeOf(result.card)` covers the
output, which is Zod's own object, not this one.

- [ ] **Step 5: Add the button to the tab**

In `integration-tab.tsx`, add a hidden `<input type="file" accept=".json,application/json">`
driven by a visible `<Button type="button">` (a bare file input cannot be styled
to match, and a `<label>` wrapping one is not reachable by keyboard as a button).
On change:

```tsx
  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset first, so choosing the SAME file twice fires change again.
    event.target.value = '';
    if (!file) return;

    // Checked against File.size BEFORE reading: a two-gigabyte file must never
    // become a string in memory, and `accept` on the input is a hint to the
    // picker that a determined caller can simply ignore.
    if (file.size > MAX_INTEGRATION_FILE_BYTES) {
      setImportMessage(t('thatFileIsTooLargeForOneCard'));
      return;
    }

    const result = parseIntegrationFile(await file.text());
    if (!result.ok) {
      setImportMessage(
        result.reason === 'many'
          ? t('thatFileCarriesCards', { count: result.count ?? 0 })
          : t('thatFileCouldNotBeRead'),
      );
      return;
    }

    // FILLS THE FORM AND WRITES NOTHING (design D9) — the Deezer prefill's own
    // contract, adopted for the same reason: an import that writes on open is an
    // import the operator cannot decline. The Save button below is the write.
    setDraft({
      code: result.card.code,
      title: result.card.title ?? '',
      artistName: result.card.artistName ?? '',
      categoryName: result.card.categoryName ?? '',
    });
    setImportMessage(t('filledFromTheFileReviewBeforeSaving'));
  }
```

The four `<Input>`s become controlled from `draft` so the import can fill them.

- [ ] **Step 6: Add the copy**

| key | en | pt | es |
|---|---|---|---|
| `importFromAFile` | Import from a file | Importar de um arquivo | Importar desde un archivo |
| `thatFileIsTooLargeForOneCard` | That file is too large for one card. A single record is a few hundred bytes. | Esse arquivo é grande demais para uma ficha. Um único registro tem algumas centenas de bytes. | Ese archivo es demasiado grande para una ficha. Un solo registro son unos cientos de bytes. |
| `thatFileCouldNotBeRead` | That file could not be read as one integration card. | Não foi possível ler esse arquivo como uma ficha de integração. | No se pudo leer ese archivo como una ficha de integración. |
| `thatFileCarriesCards` | `{count, plural, other {That file carries # cards. Export one song at a time.}}` | `{count, plural, other {Esse arquivo traz # fichas. Exporte uma música por vez.}}` | `{count, plural, other {Ese archivo trae # fichas. Exporte una canción a la vez.}}` |
| `filledFromTheFileReviewBeforeSaving` | Filled from the file. Review it before saving. | Preenchido a partir do arquivo. Revise antes de salvar. | Completado desde el archivo. Revíselo antes de guardar. |

- [ ] **Step 7: Write the e2e journey**

Create `tests/e2e/song-integration.spec.ts`:

```ts
// 1. Sign in, open Catalog > Songs, open a song's record, click Integration.
// 2. Set an input file from a fixture written at runtime into the test's tmp
//    dir: { "code": "EXT-1", "title": "Asa Branca", "artistName": "Luiz
//    Gonzaga", "categoryName": "Forró" }. Use setInputFiles on the hidden input.
// 3. Expect the four fields filled and the "review before saving" line.
// 4. Save. Expect "Saved."
// 5. Close the dialog, reopen the same song, click Integration, expect the four
//    values read back from the database.
// 6. Set a second fixture carrying an ARRAY OF THREE and expect the refusal
//    naming three, with the form's values unchanged — the import must not have
//    half-applied.
```

- [ ] **Step 8: Run the gates**

Run: `npm run lint && npm run typecheck && npm run test && npx playwright test tests/e2e/song-integration.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/song-integration-file.ts tests/unit/song-integration-file.test.ts \
        "src/app/(app)/music/songs/integration-tab.tsx" messages tests/e2e/song-integration.spec.ts
git commit -m "feat(music): a JSON file fills the integration card, and is trusted with nothing"
```

---

## Task 9: The sidebar folds

Independent of Tasks 2–8. Can be done any time after Task 1.

**Files:**
- Create: `src/lib/nav/collapse.ts`
- Create: `tests/unit/nav-collapse.test.ts`
- Modify: `src/lib/auth/shell.ts`
- Modify: `src/components/layout/app-shell.tsx`
- Modify: `src/components/layout/sidebar-nav.tsx`
- Modify: `messages/{en,pt,es}.json`
- Create: `tests/e2e/sidebar-collapse.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NAV_COLLAPSED_COOKIE`, `NAV_COLLAPSED_MAX_AGE`,
  `parseCollapsed(raw: string | undefined | null): boolean`;
  `getShellContext()` returns an added `collapsed: boolean`; `AppShell` and
  `SidebarNav` each take a `collapsed: boolean` prop.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/nav-collapse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseCollapsed } from '@/lib/nav/collapse';

/**
 * Block 27. The cookie is writable by the page — the client sets it on every
 * click so folding costs no round trip — so everything here is hostile input,
 * and every unreadable shape means "expanded". A sidebar that arrives folded
 * because of a garbled cookie is a sidebar somebody has to un-fold on a screen
 * whose navigation they cannot read.
 */
describe('parseCollapsed', () => {
  it('is expanded when nothing was ever set', () => {
    expect(parseCollapsed(undefined)).toBe(false);
    expect(parseCollapsed(null)).toBe(false);
    expect(parseCollapsed('')).toBe(false);
  });

  it('is collapsed only for the one value that means it', () => {
    expect(parseCollapsed('1')).toBe(true);
    expect(parseCollapsed('0')).toBe(false);
  });

  it('treats anything else as expanded rather than guessing', () => {
    expect(parseCollapsed('true')).toBe(false);
    expect(parseCollapsed('yes')).toBe(false);
    expect(parseCollapsed('1; drop table')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/nav-collapse.test.ts`
Expected: FAIL — `Cannot find module '@/lib/nav/collapse'`.

- [ ] **Step 3: Write the module**

Create `src/lib/nav/collapse.ts`:

```ts
/**
 * Block 27. Whether the sidebar is folded to a rail of icons.
 *
 * PURE, AND IN ITS OWN FILE ON PURPOSE — the same reason disclosure.ts beside it
 * gives: the sidebar is a client component and this repository has no
 * component-testing library (vitest runs in `node`, with no jsdom and no React
 * Testing Library), so a decision left inside sidebar-nav.tsx is checked by a
 * browser or by nothing.
 *
 * Its own module rather than three more exports in disclosure.ts, because it
 * answers a DIFFERENT question: which sections are open is about where the
 * caller was working, and this is about how much of the screen the chrome may
 * have. Folding must not disturb the disclosure state, and expanding must
 * restore exactly what was open before — which is easiest to keep true when the
 * two never share a value.
 */

/**
 * NOT HttpOnly, deliberately, on the same terms as NAV_COOKIE: the client writes
 * it directly on every click, which is why folding costs no round trip. It
 * carries no identity, no permission and no secret — the worst a forged value
 * can do is fold a sidebar the caller could fold by clicking.
 */
export const NAV_COLLAPSED_COOKIE = 'pulchatx_nav_collapsed';

/** A year. A sidebar preference that expires is a sidebar preference nobody set. */
export const NAV_COLLAPSED_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Exactly one value means collapsed. Everything else — absent, '0', 'true',
 * rubbish — means expanded, because the failure modes are not symmetric: a
 * sidebar that wrongly arrives EXPANDED costs one click, and one that wrongly
 * arrives FOLDED hides every label on a screen the caller may not know.
 */
export function parseCollapsed(raw: string | undefined | null): boolean {
  return raw === '1';
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/nav-collapse.test.ts`
Expected: PASS, 3 of 3.

- [ ] **Step 5: Read it on the server**

In `src/lib/auth/shell.ts`: import `NAV_COLLAPSED_COOKIE` and `parseCollapsed`,
add `collapsed: boolean` to the return type with this doc:

```ts
  /**
   * Block 27. Whether the sidebar is folded to a rail of icons — read on the
   * SERVER for the identical reason expandedSections is: read in the browser
   * instead, the sidebar arrives at full width and snaps narrow after
   * hydration, a flash on every navigation, on every screen, since the shell
   * wraps all of them.
   */
  collapsed: boolean;
```

resolve it beside the disclosure cookie:

```ts
  const cookieStore = await cookies();
  const expandedSections = parseExpanded(cookieStore.get(NAV_COOKIE)?.value);
  const collapsed = parseCollapsed(cookieStore.get(NAV_COLLAPSED_COOKIE)?.value);
```

and return it. Then find every caller of `getShellContext` (the member layout and
the admin layout — `grep -rn "getShellContext" src`) and pass `collapsed` through
to `<AppShell>`.

- [ ] **Step 6: Fold the chrome**

In `src/components/layout/app-shell.tsx`:

- add `collapsed: boolean` to `AppShell`'s props;
- the `<aside>` width becomes `collapsed ? 'w-[72px]' : 'w-[260px]'`;
- the brand row becomes a column when collapsed: the mark centred, the toggle
  beneath it; expanded, mark + wordmark left, toggle right;
- the footer becomes a centred vertical stack of avatar, `<SettingsMenu />` and
  the sign-out button when collapsed, hiding the name and role;
- pass `collapsed` down to `<SidebarNav>`.

The toggle is a small client component (it writes a cookie and reloads the
current route) — put it in `app-shell.tsx`'s own directory as
`sidebar-toggle.tsx`:

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { NAV_COLLAPSED_COOKIE, NAV_COLLAPSED_MAX_AGE } from '@/lib/nav/collapse';

/**
 * Writes the cookie and asks the server for the shell again.
 *
 * router.refresh() rather than local state: the width is decided on the server
 * (shell.ts) so the sidebar arrives correct rather than flashing, and a local
 * useState would mean two sources for one fact — the next full navigation would
 * take the server's answer and silently undo the click.
 */
export function SidebarToggle({ collapsed }: { collapsed: boolean }) {
  const t = useTranslations('shell');
  const router = useRouter();

  function toggle() {
    const next = collapsed ? '0' : '1';
    document.cookie = `${NAV_COLLAPSED_COOKIE}=${next}; path=/; max-age=${NAV_COLLAPSED_MAX_AGE}; samesite=lax`;
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={!collapsed}
      aria-label={collapsed ? t('expandTheSidebar') : t('collapseTheSidebar')}
      className="rounded-md p-2 text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-accent-foreground"
      data-testid="sidebar-toggle"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        <path d="M3 5h18M3 12h18M3 19h18" />
      </svg>
    </button>
  );
}
```

- [ ] **Step 7: Fold the nav**

In `src/components/layout/sidebar-nav.tsx`, add `collapsed: boolean` to the
props. When `collapsed` is true:

- do not render the section heading `<button>`s (there is nothing to disclose —
  every item is shown);
- render every section's items unconditionally, ignoring `open`;
- give each section wrapper `border-t border-sidebar-border pt-2 first:border-t-0 first:pt-0`;
- give each `<Link>` `justify-center` and no text child, with
  `aria-label={item.label}` and `title={item.label}` so the destination still has
  an accessible name.

Add this comment above the branch:

```tsx
        // Block 27. FOLDED, the disclosure disappears rather than being rendered
        // closed: a heading that says "Catalog" in 72 pixels says nothing, and a
        // rail whose sections are shut is a rail with nothing on it. Every item
        // is shown, which is the point of a rail — one click to anywhere. The
        // disclosure state is untouched underneath and comes back exactly as it
        // was when the sidebar unfolds.
```

- [ ] **Step 8: Add the copy**

`shell` namespace: `collapseTheSidebar` / `expandTheSidebar` — English "Collapse
the sidebar" / "Expand the sidebar"; Portuguese "Recolher o menu lateral" /
"Expandir o menu lateral"; Spanish "Contraer la barra lateral" / "Expandir la
barra lateral".

- [ ] **Step 9: Write the e2e journey**

Create `tests/e2e/sidebar-collapse.spec.ts`:

```ts
// 1. Sign in. Expect the sidebar at its full width and the "Songs" link to have
//    a visible text label.
// 2. Open the Catalog section, so there is disclosure state to preserve.
// 3. Click the toggle. Expect the aside to be ~72px wide, the section HEADING
//    'Catalog' to be gone, and the Songs link to still be reachable by its
//    accessible name (getByRole('link', { name: 'Songs' })) while showing no
//    text — the whole claim of an icon rail.
// 4. Reload. Expect it still folded — this is what the cookie is for, and the
//    only assertion that catches a preference kept in React state.
// 5. Click the toggle again. Expect full width, and Catalog STILL EXPANDED —
//    folding must not disturb the disclosure state.
```

- [ ] **Step 10: Run the gates**

Run: `npm run lint && npm run typecheck && npm run test && npx playwright test tests/e2e/sidebar-collapse.spec.ts tests/e2e/nav-content.spec.ts`
Expected: PASS. `nav-content.spec.ts` is included because it reads section
headings, which this task can break.

- [ ] **Step 11: Commit**

```bash
git add src/lib/nav/collapse.ts tests/unit/nav-collapse.test.ts src/lib/auth/shell.ts \
        src/components/layout messages tests/e2e/sidebar-collapse.spec.ts
git commit -m "feat(nav): the sidebar folds to a rail of icons, and remembers"
```

---

## Task 10: The whole-branch gate

**Files:** none created; fixes only.

- [ ] **Step 1: Run every gate in order, from a clean database**

```bash
npm run lint
npm run typecheck
npm run test
npm run db:reset
npm run db:test
npm run test:isolation
npm run test:e2e
```

Expected: all green. The `db:reset` before `db:test` is mandatory — a database
left dirty by an earlier e2e run produces two red gates that are not code.

- [ ] **Step 2: Confirm the isolation manifest actually ran the new files**

The suite refuses to exit 0 if a required file did not report. Read its summary
and confirm `tests/isolation/music-categories.test.ts` and
`tests/isolation/song-integrations.test.ts` both appear with their full case
counts. A silent absence here is the exact failure
`scripts/verify-isolation-suite.mjs` exists to catch.

- [ ] **Step 3: Confirm the migrations are committed**

```bash
git status --short
git log --oneline origin/main..HEAD -- supabase/migrations
```

Expected: four migrations (`0204`–`0207`) in the log and a clean working tree.
This project has shipped code without its migrations three times (Blocks 13a,
17b, 17c); the check costs one command.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin block-27-music-categories-and-integration
gh pr create --title "Block 27 — music categories, the integration card, and a folding sidebar" --body "..."
```

The body summarises the eight items, links the spec, and names the three
decisions a reviewer should check rather than rediscover: `internal_code` is not
renamed (D6), the card is linked loosely by code (D7), and
`assert_song_references_live` gained a fifth argument so an archived category
cannot be named by a song.

---

## Self-Review

**Spec coverage.** §3 → Task 1. §4.1 → Task 2. §4.2 → Task 4. §4.3 → Tasks 3 and
5. §5 → Tasks 6 and 7. §6 → Task 8. §7 → Task 9. §8 → the migrations in Tasks 2,
3 and 6. §10 → tests inside each task plus Task 10. §11 is out of scope and has
no task, correctly.

**One addition the spec did not foresee**, found while reading `0103`:
`assert_song_references_live` must gain a fifth parameter, or the category is the
one reference of five that a song could name after archiving — the composite
foreign key references a non-partial constraint and cannot see `deleted_at` — and
the `FOR KEY SHARE`/`FOR UPDATE` lock pair would not cover it. Task 2 does this
and the isolation suite pins both halves. The spec's §4.1 should be read as
including it.

**Type consistency.** `SongSummary.categoryId`/`categoryName` (Task 3) are what
Task 5's column renders. `SongIntegration` (Task 6) is what `SongRecord`
carries (Task 7) and what `saveSongIntegrationAction` returns.
`SongIntegrationInput` (Task 6) is what `parseIntegrationFile` produces (Task 8).
`ReferenceScreenKind` gains `'CATEGORY'` in Task 4 and depends on
`MUSIC_REFERENCE_KINDS` gaining it in Task 3 — Task 3 must land first, and does.
`parseCollapsed`/`NAV_COLLAPSED_COOKIE` are used only by Task 9's own files.
