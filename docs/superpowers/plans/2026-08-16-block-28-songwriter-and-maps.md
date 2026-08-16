# Block 28 — Songwriter, Maps and Station Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename Block 27's music Category to Songwriter down to the schema, put
listeners and their most-requested songs on a map of the world, and let the
Dashboards consolidate any chosen set of Stations.

**Architecture:** The rename is new migrations over a deployed schema. The maps
read `members.city`/`members.neighbourhood`, which the entry conversation
already fills, geocoded once per distinct place into a global cache drained by
the worker; Google Maps draws them, isolated behind a transport the way Deezer
is. Station selection changes a control only — the array has travelled from URL
to RPC since Block 8a.

**Tech Stack:** Next.js App Router, Supabase/Postgres with RLS and
`SECURITY DEFINER` RPCs, Google Maps Platform (Maps JavaScript API + Geocoding
API), `next-intl` (en/pt/es), Zod, Vitest (unit + isolation), pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-block-28-songwriter-and-maps-design.md`

## Global Constraints

- **THE RENAME MUST NOT TOUCH INVENTORY.** `prize_categories`,
  `/inventory/categories`, `prizes.category_id`, `save_prize_category`,
  `archive_prize_category`, `PRIZE_CATEGORY_TABS`, `schemas/inventory.ts`,
  `services/inventory.ts` and every file under `src/app/(app)/inventory/` keep
  the word *category*. It is a different domain, governed by
  `inventory.catalogue`, and the two were deliberately kept apart in Block 27
  (`0205`'s own table comment says so). **A global find-and-replace on
  "category" breaks a shipped, deployed feature.** Every rename step below names
  its files explicitly for this reason.
- **`song_integrations.category_name` is NOT renamed either.** That column holds
  the CUSTOMER's word for the category of a song in THEIR system (Block 27,
  `0207`). It never referred to our reference list, and the Integration tab's
  "Category" label stays. Renaming it would import our vocabulary into a field
  that exists to carry theirs.
- **Language.** Code, comments, commit messages, migrations, tests and docs in
  **English**. Only `messages/*.json` carries other languages.
- **Three locales, always together.** A key added to `messages/en.json` is added
  to `pt.json` and `es.json` in the same commit. `tests/unit/i18n/` checks
  parity and that every `t('key')` argument is a literal — **and it reads
  comments too**, so a quoted example of a translation call inside a doc comment
  fails it (Block 27 paid for that).
- **Migrations are append-only.** `0204`–`0208` merged and deployed on
  2026-08-16 (`b3e1f94`) and are never edited. Next free number is **0209**.
- **Copy the LIVE function body forward.** `update_song` → `0208`; `create_song`
  and `create_song_from_deezer` → `0206`; `music_reference_table`,
  `archive_music_reference`, `assert_song_references_live` → `0205`;
  `create_member` → `0074`; `update_member` → `0073`; `apply_member_creation` →
  `0061`; `update_company_profile` → `0155`.
- **`CREATE OR REPLACE` cannot rename an input parameter** and **`DROP` resets a
  function's ACL.** Any signature change is `drop` + `create` followed by its
  `revoke ... from public` and `grant ... to authenticated`.
- **`ALTER TYPE ... ADD VALUE` cannot be used in the transaction that adds it;
  `ALTER TYPE ... RENAME VALUE` can.** Enum vocabulary lands in a migration that
  does nothing else.
- **The boundary is in the database.** UI gating is a courtesy and is commented
  as one.
- **No new permission.** `music.view`/`music.manage` for songwriters,
  `reports.consolidated` for looking at more than one Station.
- **Nothing in any test suite may reach Google.** The transport is faked by
  `GOOGLE_FAKE=1`, the way `DEEZER_FAKE=1` already works.
- **Gate order:** `npm run lint` → `typecheck` → `test` → `db:reset` →
  `db:test` → `test:isolation` → `CI=1 npx playwright test --workers=1`.
  The reset before `db:test` is mandatory. The e2e configuration is not
  optional either — plain `next dev` fails journeys on cold route compilation
  and those are not defects (see `crash-isolation-e-compilacao-fria`).
- **`npm run db:types`** regenerated in the same commit as any schema change.
- **New isolation files** join `REQUIRED_TEST_FILES` in
  `scripts/verify-isolation-suite.mjs` with a case floor, same commit.
- **Kill a stray dev server before running e2e.** `netstat -ano | grep ":3000"`;
  a `node.exe` holding it at multi-GB is a zombie from an interrupted run and
  makes the whole suite fail against it.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `supabase/migrations/0209_place_and_songwriter_vocabulary.sql` | `ALTER TYPE` only: rename `CATEGORY`→`SONGWRITER`, add `'country'` and `'COUNTRY'`. |
| `supabase/migrations/0210_songwriters_rename.sql` | Table, column, indexes, constraints, policy. |
| `supabase/migrations/0211_songwriter_doors.sql` | The six functions recreated. |
| `supabase/migrations/0212_country.sql` | `companies.country`, `members.country`, four doors. |
| `supabase/migrations/0213_geocoded_places.sql` | The place cache, its RLS, and the worker's claim door. |
| `supabase/migrations/0214_dashboard_geography.sql` | `get_audience_geography`, `get_music_geography`. |
| `supabase/tests/59_songwriters.test.sql` | The rename is complete — the new names exist and the old ones do not. |
| `supabase/tests/60_country_and_places.test.sql` | Country columns, the cache, the two geography functions. |
| `src/app/(app)/catalog/songwriters/page.tsx` | The renamed screen (git-moved from `categories/`). |
| `src/lib/places/normalise.ts` | Turns four columns into one cache key. Pure. |
| `src/lib/integrations/google/transport.ts` | The seam: `GeocodeTransport`, `GeocodeResult`. |
| `src/lib/integrations/google/client.ts` | The real Geocoding API client. |
| `src/lib/integrations/google/fake.ts` | Fixtures, selected by `GOOGLE_FAKE=1`. |
| `src/lib/integrations/google/index.ts` | Chooses one, on `DEEZER`'s pattern. |
| `src/services/places.ts` | `drainGeocodeQueue`, the worker's third drain. |
| `src/services/geography.ts` | Reads the two geography aggregates. |
| `src/app/(app)/dashboards/station-selection.tsx` | Multi-select pills, replacing `consolidated-toggle.tsx`. |
| `src/app/(app)/dashboards/geography-panel.tsx` | Map + ranked tables + coverage line, shared by both dashboards. |
| `src/app/(app)/dashboards/place-map.tsx` | The Google Maps client component. |
| `tests/unit/place-normalise.test.ts` | The cache key. |
| `tests/unit/google-geocode.test.ts` | The transport against malformed, empty and quota responses. |
| `tests/isolation/songwriters.test.ts` | Cross-Station boundary on the renamed kind. |
| `tests/isolation/geography.test.ts` | The aggregates' tenancy and `reports.consolidated`. |
| `tests/e2e/songwriters.spec.ts` | Register, pick, filter, on the renamed route (git-moved). |
| `tests/e2e/dashboards-geography.spec.ts` | Three Stations consolidated; the map absent without a key. |

**Modified** — `src/schemas/music.ts`, `src/services/music.ts`,
`src/app/(app)/catalog/references/{list-params,actions}.ts`,
`src/app/(app)/music/songs/{list-params,page,song-fields,songs-filters,songs-grid,actions}.ts(x)`,
`src/lib/auth/shell.ts`, `src/components/layout/app-shell.tsx` (`ICONS.pen`),
`src/lib/security/csp.ts`, `src/lib/env.ts`, `.env.example`,
`src/app/api/worker/tick/route.ts`, `src/app/(app)/dashboards/{audience,music}/page.tsx`,
`src/services/members.ts`, the members form, `messages/{en,pt,es}.json`,
`scripts/verify-isolation-suite.mjs`, `supabase/tests/15_music_rpcs.test.sql`,
`supabase/tests/57_music_categories.test.sql` (renamed to `57_songwriters`… see
Task 2), `tests/e2e/nav-content.spec.ts`, `tests/isolation/music-categories.test.ts`.

---

## Task 1: The rename reaches the database

**Files:**
- Create: `supabase/migrations/0209_place_and_songwriter_vocabulary.sql`
- Create: `supabase/migrations/0210_songwriters_rename.sql`
- Create: `supabase/migrations/0211_songwriter_doors.sql`
- Modify: `src/lib/supabase/database.types.ts` (generated)

**Interfaces:**
- Consumes: everything Block 27 built.
- Produces: table `public.songwriters`; column `public.songs.songwriter_id`;
  enum label `'SONGWRITER'`; and six functions whose fourth-or-fifth parameter
  is now `p_songwriter_id`.

- [ ] **Step 1: The vocabulary migration**

Create `0209_place_and_songwriter_vocabulary.sql`. Three `ALTER TYPE` statements
and nothing else:

```sql
-- supabase/migrations/0209_place_and_songwriter_vocabulary.sql

-- Block 28. Three vocabulary changes, and NOTHING that uses their results.
--
-- The rename below would be legal beside its own uses — ALTER TYPE ... RENAME
-- VALUE does not create a value, so it carries none of ADD VALUE's restriction.
-- The two additions are not, and the house convention since 0082 (and again at
-- 0204, three migrations ago) is that enum vocabulary lands in a file that does
-- nothing else. Keeping all three here means one rule to remember rather than
-- two.

-- Block 27 shipped this as CATEGORY four migrations ago; the owner meant the
-- person who WROTE the song. Renaming the value rather than adding a sixth and
-- migrating rows: nothing outside 0205's own table refers to it, and a spare
-- CATEGORY left in the enum would be a value with no table behind it.
alter type public.music_reference_kind rename value 'CATEGORY' to 'SONGWRITER';

-- Block 28. A listener may declare a country of their own — the diaspora case:
-- a Brazilian in Portugal listening to a Maranhão station. Lower case, matching
-- this enum's seven existing values (0040).
alter type public.promotion_requested_field add value 'country';

-- The prompt that asks for it. Upper case, matching 0109's own values.
alter type public.station_message_key add value 'COUNTRY';
```

- [ ] **Step 2: Apply it and confirm the rename took**

Run: `npm run db:reset`
Expected: applies cleanly. Then:
`docker exec supabase_db_CRM_-_LISTENER psql -U postgres -d postgres -c "select unnest(enum_range(null::public.music_reference_kind))"`
Expected: `GENRE, LABEL, ARTIST, SHOW, SONGWRITER`.

- [ ] **Step 3: The table and column migration**

Create `0210_songwriters_rename.sql`:

```sql
-- supabase/migrations/0210_songwriters_rename.sql

-- Block 28. The table and the column Block 27 named for a category.
--
-- INVENTORY IS NOT TOUCHED. public.prize_categories, prizes.category_id,
-- save_prize_category and archive_prize_category keep their names: that is a
-- different domain governed by inventory.catalogue, and 0205's own table
-- comment records that the two were kept apart deliberately. The two words were
-- always going to look like one thing to a find-and-replace; they are not.
--
-- The indexes, constraints and the policy are renamed too. Leaving them would
-- put "category" in eight places a reader would find while looking for why the
-- table is called something else.

alter table public.music_categories rename to songwriters;

alter table public.songwriters
  rename constraint music_categories_company_org_fk to songwriters_company_org_fk;
alter table public.songwriters
  rename constraint music_categories_name_not_blank to songwriters_name_not_blank;
alter table public.songwriters
  rename constraint music_categories_id_company_unique to songwriters_id_company_unique;

alter index public.music_categories_legacy_unique rename to songwriters_legacy_unique;
alter index public.music_categories_company_idx   rename to songwriters_company_idx;

alter policy music_categories_select_music_view on public.songwriters
  rename to songwriters_select_music_view;

comment on table public.songwriters is
  'The people who WROTE a Station''s songs, one per song (Block 28, D3). Shipped in Block 27 as music_categories and renamed here: the owner meant songwriter, and a schema saying one thing while the screen says another is a misreading waiting for whoever reads it next. Names are deliberately not unique, the same D2/D3 ruling music_genres carries. NOT public.prize_categories, which is a different domain governed by inventory.catalogue.';

alter table public.songs rename column category_id to songwriter_id;

alter table public.songs
  rename constraint songs_category_company_fk to songs_songwriter_company_fk;
alter index public.songs_category_idx rename to songs_songwriter_idx;

comment on column public.songs.songwriter_id is
  'Block 27 as category_id, Block 28 under its right name. Nullable: the whole catalogue predates the column, so requiring one would make every existing song unsavable — the same reason label_id and genre_id are nullable (0098).';
```

- [ ] **Step 4: The six functions**

Create `0211_songwriter_doors.sql`. **Open the live definition of each and copy
the body verbatim before editing it:**

| function | live in | change |
|---|---|---|
| `music_reference_table` | `0205` | branch returns `'songwriters'`, `when 'SONGWRITER'` |
| `archive_music_reference` | `0205` | `elsif p_kind = 'SONGWRITER'` counting `songs.songwriter_id` |
| `assert_song_references_live` | `0205` | `p_category_id` → `p_songwriter_id`, `music_categories` → `songwriters` |
| `create_song` | `0206` | `p_category_id` → `p_songwriter_id`, insert column |
| `update_song` | **`0208`** | same, plus the `v_before`/audit keys |
| `create_song_from_deezer` | `0206` | same |

The first two are `create or replace` — no signature change, and REPLACE keeps
their ACL. The last four are `drop function` + `create function` with their
`revoke`/`grant` pairs restated, because **a replace cannot rename a parameter**
(Postgres refuses outright) and **a drop resets the ACL** (`0102`).

Header for the file:

```sql
-- supabase/migrations/0211_songwriter_doors.sql

-- Block 28. The six functions that name the old word — in a returned string, in
-- a branch, or in a parameter.
--
-- FOUR OF THEM ARE DROP + CREATE, and not by preference: `create or replace`
-- REFUSES to change the name of an input parameter, and supabase-js calls every
-- RPC with NAMED arguments — so p_category_id → p_songwriter_id is a break the
-- service layer moves with in Task 2, and there is no in-place edit that would
-- have avoided it. Each revoke/grant pair is restated because DROP resets an
-- ACL (0102).
--
-- Each body is copied forward from its LIVE definition: update_song from 0208,
-- create_song and create_song_from_deezer from 0206, the other three from 0205.
-- Not from 0101, and not from 0140 — this project has recreated a function from
-- the wrong migration before and written it down.
```

Also update the audit `detail` keys: `create_song` and `update_song` write
`'category_id'` into `audit_logs`. Rename those keys to `'songwriter_id'` and
say so in a comment — the trail is read by people, and a key naming a column
that no longer exists is worse than no key.

- [ ] **Step 5: Reset, regenerate types, confirm nothing of the old name survives**

```bash
npm run db:reset && npm run db:types
docker exec supabase_db_CRM_-_LISTENER psql -U postgres -d postgres -c "\d public.songs" | grep -i category
```
Expected: the `\d` output shows **no** `category_id`. `database.types.ts` gains
`songwriters` and `songs.songwriter_id` and loses `music_categories`.
`npm run typecheck` will now fail across the files Task 2 fixes — that is the
point of the split.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0209_place_and_songwriter_vocabulary.sql \
        supabase/migrations/0210_songwriters_rename.sql \
        supabase/migrations/0211_songwriter_doors.sql \
        src/lib/supabase/database.types.ts
git commit -m "feat(music): a category becomes a songwriter, in the schema"
```

---

## Task 2: The rename reaches the screen

**Files:**
- Move: `src/app/(app)/catalog/categories/` → `src/app/(app)/catalog/songwriters/`
- Move: `tests/e2e/music-categories.spec.ts` → `tests/e2e/songwriters.spec.ts`
- Move: `tests/isolation/music-categories.test.ts` → `tests/isolation/songwriters.test.ts`
- Move: `supabase/tests/57_music_categories.test.sql` → `supabase/tests/57_songwriters.test.sql`
- Modify: `src/schemas/music.ts`, `src/services/music.ts`,
  `src/app/(app)/catalog/references/{list-params,actions}.ts`,
  `src/app/(app)/music/songs/{list-params,page,song-fields,songs-filters,songs-grid,actions}.ts(x)`,
  `src/lib/auth/shell.ts`, `src/components/layout/app-shell.tsx`,
  `messages/{en,pt,es}.json`, `scripts/verify-isolation-suite.mjs`,
  `supabase/tests/15_music_rpcs.test.sql`, `tests/e2e/nav-content.spec.ts`
- Create: `supabase/tests/59_songwriters.test.sql`

**Interfaces:**
- Consumes: Task 1's schema.
- Produces: `SongSummary.songwriterId` / `.songwriterName`;
  `MUSIC_REFERENCE_KINDS` containing `'SONGWRITER'`; `ReferenceScreenKind`
  containing `'SONGWRITER'`; route `/catalog/songwriters`; URL parameter
  `?songwriter=`.

- [ ] **Step 1: Move the four files with `git mv`**

```bash
git mv "src/app/(app)/catalog/categories" "src/app/(app)/catalog/songwriters"
git mv tests/e2e/music-categories.spec.ts tests/e2e/songwriters.spec.ts
git mv tests/isolation/music-categories.test.ts tests/isolation/songwriters.test.ts
git mv supabase/tests/57_music_categories.test.sql supabase/tests/57_songwriters.test.sql
```

`git mv`, not delete-and-create: the history of four files written hours ago is
the only record of why they look the way they do.

- [ ] **Step 2: Rename the identifiers, file by file**

**Do NOT run a repository-wide replace.** These are the only files that change,
and every other file matching "category" belongs to inventory:

| file | change |
|---|---|
| `src/schemas/music.ts` | `MUSIC_REFERENCE_KINDS`: `'CATEGORY'` → `'SONGWRITER'`; `songFormSchema.categoryId` → `songwriterId`. **Leave `songIntegrationSchema.categoryName` alone** — that is the customer's word (Global Constraints). |
| `src/services/music.ts` | `REFERENCE_TABLES.SONGWRITER: 'songwriters'`; `SONG_COLUMNS` gains `songwriter_id, songwriters(name)` and loses the old pair; `SongRow`, `SongSummary`, `toSongSummary`, `SongListParams.songwriterId`, the `.eq('songwriter_id', …)` filter, and `p_songwriter_id` in `createSong`/`updateSong`. |
| `catalog/references/list-params.ts` | `ReferenceScreenKind`, `REFERENCE_SCREEN_PATHS.SONGWRITER: '/catalog/songwriters'`. |
| `catalog/references/actions.ts` | `REFERENCE_SCREEN_KINDS`, `ACTION_KEYS.SONGWRITER`. |
| `catalog/songwriters/page.tsx` | `KIND = 'SONGWRITER'`, `CategoriesPage` → `SongwritersPage`, the route literal, the twelve copy keys, the log message. |
| `music/songs/list-params.ts` | `MusicSearchParams.songwriter`, `SongListState.songwriterId`, `parseSongListState`, `hasActiveSongFilters`, `songHref`. |
| `music/songs/{page,songs-filters,songs-grid,song-fields}.tsx` | the prop, the select, the column, the filter, `listMusicReferences(…, 'SONGWRITER')`. |
| `music/songs/actions.ts` | `songwriterId: formData.get('songwriterId')` in both actions. |
| `src/lib/auth/shell.ts` | href, label key, and `ICONS.pen`. |

- [ ] **Step 3: The new glyph**

In `app-shell.tsx`, replace `folder` with:

```ts
  // A pen, for Block 28's Catalogue > Songwriters. It replaces the `folder`
  // Block 27 gave the same row, and the swap is the point rather than a tidy-up:
  // a folder means *the thing you file others under*, which is what a category
  // was and what a songwriter is not. The near miss is `users` (Artists), two
  // rows up in this same section — and Artists is the PERFORMER, which is the
  // very distinction this rename exists to make, so the two must not share a
  // glyph even at two rows' distance.
  pen: 'M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.586 7.586M11 11a2 2 0 1 0 4 0 2 2 0 0 0-4 0z',
```

`folder` is deleted, not left orphaned — nothing else uses it, and an unused
glyph in that map is a claim that something needs it.

- [ ] **Step 4: The copy, in three languages**

Rename the twelve `music.*` keys Block 27 added (`categories`,
`referenceCategoriesDescription`, `registerCategory`, `registerACategory`,
`archiveCategory`, `archiveThisCategoryQuestion`,
`noCategoriesAreRegisteredInThis`, `noCategoryMatchesTheseFilters`,
`categoriesCountLabel`, `categoryName`, `searchCategoriesByName`, plus
`category`, `noCategory`, `allCategories` and the three `action*` keys) to their
songwriter equivalents.

| key | en | pt | es |
|---|---|---|---|
| `songwriters` | Songwriters | Compositores | Compositores |
| `songwriter` | Songwriter | Compositor | Compositor |
| `noSongwriter` | No songwriter | Sem compositor | Sin compositor |
| `allSongwriters` | All songwriters | Todos os compositores | Todos los compositores |
| `referenceSongwritersDescription` | Who wrote the songs in this station's catalogue. A song points at one, and the songs list filters by it. | Quem escreveu as músicas do acervo desta emissora. Uma música aponta para um, e a lista de músicas filtra por ele. | Quién escribió las canciones del catálogo de esta emisora. Una canción apunta a uno, y la lista de canciones filtra por él. |
| `registerSongwriter` | Register songwriter | Cadastrar compositor | Registrar compositor |
| `registerASongwriter` | Register a songwriter | Cadastrar um compositor | Registrar un compositor |
| `archiveSongwriter` | Archive songwriter… | Arquivar compositor… | Archivar compositor… |
| `archiveThisSongwriterQuestion` | Archive this songwriter? | Arquivar este compositor? | ¿Archivar este compositor? |
| `noSongwritersAreRegisteredInThis` | No songwriters are registered in this station yet. | Nenhum compositor cadastrado nesta emissora ainda. | Todavía no hay compositores registrados en esta emisora. |
| `noSongwriterMatchesTheseFilters` | No songwriter matches these filters. | Nenhum compositor corresponde a estes filtros. | Ningún compositor coincide con estos filtros. |
| `songwritersCountLabel` | `{count, plural, one {songwriter} other {songwriters}}` | `{count, plural, one {compositor} other {compositores}}` | `{count, plural, one {compositor} other {compositores}}` |
| `songwriterName` | Songwriter name | Nome do compositor | Nombre del compositor |
| `searchSongwritersByName` | Search songwriters by name | Buscar compositores por nome | Buscar compositores por nombre |
| `actionRegisterSongwriters` | register songwriters | cadastrar compositores | registrar compositores |
| `actionSaveThisSongwriter` | save this songwriter | salvar este compositor | guardar este compositor |
| `actionArchiveThisSongwriter` | archive this songwriter | arquivar este compositor | archivar este compositor |

The ellipsis on `archiveSongwriter` is not decoration — it opens a confirmation,
and its two siblings (`archiveGenre`, `archiveLabel`) spell it the same way. The
e2e selects on the exact string.

`nav.categories` **stays**: Inventory still has a Categories item. Add
`nav.songwriters`.

- [ ] **Step 5: The tests that name the old word**

- `supabase/tests/15_music_rpcs.test.sql`: the pinned enum array becomes
  `array['GENRE', 'LABEL', 'ARTIST', 'SHOW', 'SONGWRITER']`.
- `supabase/tests/57_songwriters.test.sql` (moved): every `music_categories` →
  `songwriters`, `category_id` → `songwriter_id`, `p_category_id` →
  `p_songwriter_id`, and the `hasnt_function` signatures.
- `tests/isolation/songwriters.test.ts` (moved): `p_kind: 'SONGWRITER'`,
  `p_songwriter_id`, `.from('songwriters')`.
- `tests/e2e/songwriters.spec.ts` (moved): the route, the headings, the copy,
  `select[name="songwriterId"]`, `song-songwriter-filter`.
- `tests/e2e/nav-content.spec.ts`: the Catalog list becomes
  `['Songs', 'Artists', 'Albums', 'Songwriters', 'Genres', 'Record labels', 'Programmes', 'Maintenance']`
  and the href assertion becomes `/catalog/songwriters`. **The Inventory list is
  untouched** — it still reads `['Stock', 'Categories', 'Vendors', 'Movements']`.
- `scripts/verify-isolation-suite.mjs`: the manifest path and its comment.

- [ ] **Step 6: The test that proves the rename is complete**

Create `supabase/tests/59_songwriters.test.sql`. **Asserting the ABSENCES is the
whole point** — a rename applied to nine places out of ten passes every positive
test:

```sql
begin;
select plan(12);

-- Block 28. A rename is only finished when the old name is gone, so half of
-- this file asserts absences. A rename applied to nine places out of ten
-- satisfies every positive assertion in 57_songwriters.test.sql.

select has_table('public', 'songwriters', 'the table has the new name');
select hasnt_table('public', 'music_categories', 'and not the old one');

select has_column('public', 'songs', 'songwriter_id', 'the column has the new name');
select hasnt_column('public', 'songs', 'category_id', 'and not the old one');

select ok(
  'SONGWRITER' = any (enum_range(null::public.music_reference_kind)::text[]),
  'the kind vocabulary carries SONGWRITER');
select ok(
  not ('CATEGORY' = any (enum_range(null::public.music_reference_kind)::text[])),
  'and no longer carries CATEGORY');

-- The four doors whose PARAMETER changed. hasnt_function on the old signature
-- is what catches a create_or_replace that silently left a second overload.
select hasnt_function('public', 'create_song',
  array['uuid','text','uuid','uuid','uuid','music_nationality','music_vocal',
        'integer','text','text','uuid','text','uuid'],
  'no create_song overload survives with the old parameter list');
select hasnt_function('public', 'update_song',
  array['uuid','text','uuid','uuid','uuid','music_nationality','music_vocal',
        'integer','uuid','text','uuid'],
  'nor update_song');

-- INVENTORY IS UNTOUCHED. These four are the guard against a find-and-replace
-- that went one directory too far, and they are the reason this file exists in
-- a block that renames nothing of theirs.
select has_table('public', 'prize_categories', 'inventory keeps its categories');
select has_column('public', 'prizes', 'category_id', 'and its column');
select has_function('public', 'save_prize_category', array['uuid','text','uuid'],
                    'and its register door');
select has_function('public', 'archive_prize_category', array['uuid'],
                    'and its archive door');

select * from finish();
rollback;
```

- [ ] **Step 7: Run every gate**

```bash
npm run lint && npm run typecheck && npm run test
npm run db:reset && npm run db:test && npm run test:isolation
CI=1 npx playwright test tests/e2e/songwriters.spec.ts tests/e2e/nav-content.spec.ts --workers=1
```
Expected: all green. `db:test` should report 62 files.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(catalog): the category becomes a songwriter, on screen and in every name"
```

---

## Task 3: Any set of Stations

Independent of every other task. No migration, no RPC, no service change.

**Files:**
- Create: `src/app/(app)/dashboards/station-selection.tsx`
- Delete: `src/app/(app)/dashboards/consolidated-toggle.tsx`
- Modify: the three `dashboards/*/page.tsx`, `messages/{en,pt,es}.json`

**Interfaces:**
- Consumes: `periodHref(base, selection, companyIds)` — unchanged.
- Produces: `StationSelection`, taking the props `ConsolidatedToggle` took plus
  `viewable: ViewableCompany[]` and `selectedIds: string[]`.

- [ ] **Step 1: Read what must survive**

Open `consolidated-toggle.tsx` and keep, verbatim in the new component's header,
the reasoning for: the eligibility being computed by the page rather than the
control; and the `complete` flag, which stops the label claiming "All stations"
when the list was capped at fifty or narrowed by a search box (whole-branch
review, Important B7). Both are load-bearing and neither is obvious.

- [ ] **Step 2: Write the control**

Each eligible Station renders a pill that toggles its own id in the selection
and links to `periodHref(base, period, nextIds)`. Rules:

- **A selection of zero is not a selection.** Unselecting the last pill links to
  the caller's own single Station rather than to an empty array — the RPC raises
  `22023` for an empty set (`0118`), and a control that can produce a broken URL
  is a control that will.
- The pills are `<Link>`s, not checkboxes, for the reason the toggle already
  gives: a chosen view is a URL somebody can send, exactly like a chosen period.
- A caller who holds `reports.consolidated` in only one Station sees no pills at
  all — one Station is not a selection either.
- Keep an "All stations" shortcut beside them, with the `complete` caveat.

- [ ] **Step 3: Wire the three pages**

Each already computes `consolidatedEligible` and `companyIds`. Pass both, plus
`viewable`, to `StationSelection` in place of `ConsolidatedToggle`.

- [ ] **Step 4: Copy**

`selectStations` — en "Stations shown", pt "Emissoras exibidas", es "Emisoras
mostradas"; `stationsSelected` — `{count, plural, one {# station} other {# stations}}`
and its translations.

- [ ] **Step 5: Test**

Extend `tests/e2e/dashboards.spec.ts`'s consolidated journey (it already
provisions five Stations): select two of them, assert the URL carries both
`companyId` keys, and assert the listeners figure differs from either Station's
own. That last assertion is the one that proves consolidation happened rather
than a label changing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(dashboards): any set of Stations, not one or all"
```

---

## Task 4: The country

**Files:**
- Create: `supabase/migrations/0212_country.sql`
- Modify: `src/lib/conversation/engine.ts`, `src/schemas/members.ts`,
  `src/services/members.ts`, the members form and record dialog,
  the Station record dialog, `messages/{en,pt,es}.json`
- Create: `supabase/tests/60_country_and_places.test.sql` (the country half)

**Interfaces:**
- Produces: `companies.country`, `members.country` (both `text`, both nullable,
  both ISO 3166-1 alpha-2 by check constraint);
  `create_member`/`update_member`/`apply_member_creation`/`update_company_profile`
  each with a trailing `p_country text default null`.

- [ ] **Step 1: The migration**

Columns, each with a check constraint of exactly two upper-case letters, and the
four doors recreated from their **live** definitions (`0074`, `0073`, `0061`,
`0155`). All four are `drop` + `create` — a new parameter changes the signature —
with grants restated.

```sql
alter table public.companies add column country text;
alter table public.members   add column country text;

alter table public.companies add constraint companies_country_shape
  check (country is null or country ~ '^[A-Z]{2}$');
alter table public.members add constraint members_country_shape
  check (country is null or country ~ '^[A-Z]{2}$');

comment on column public.companies.country is
  'ISO 3166-1 alpha-2. Block 28: it qualifies every geocode for this Station''s listeners and decides where its map opens. Nullable, because every Station that exists predates it — a Station without one has its listeners geocoded without a country hint, which is worse but not broken.';
comment on column public.members.country is
  'ISO 3166-1 alpha-2, and OPTIONAL in every sense: the promotion decides whether to ask (promotion_requested_field ''country''), and a listener without one inherits their Station''s. Block 28, D10 — the diaspora case is real but rare, and a question nobody needs is a listener who stops answering.';
```

- [ ] **Step 2: The conversation asks for it, when asked to**

`src/lib/conversation/engine.ts` already maps every `RequestedField` to a prompt
and a message key, and its own comment promises that a ninth field "fails to
compile HERE as well". Add `country` to `FIELD_PROMPTS` ("Em qual país você
mora?"), `FIELD_MESSAGE_KEYS` (`'COUNTRY'`) and `SYSTEM_MESSAGE_DEFAULTS`. The
compiler will name anything missed.

- [ ] **Step 3: The two forms**

The Station record dialog gains a Country select (ISO alpha-2, rendered as
names). The member record dialog gains one in its address block, beside State.
Both optional.

- [ ] **Step 4: pgTAP**

`60_country_and_places.test.sql`, first half: both columns exist, both check
constraints refuse `'bra'` and accept `'BR'`, and the four doors take the new
parameter.

- [ ] **Step 5: Gates and commit**

```bash
npm run db:reset && npm run db:types && npm run lint && npm run typecheck && npm run test && npm run db:test
git add -A && git commit -m "feat(members): a country on the Station and on the listener"
```

---

## Task 5: The place cache, the Google client and the worker drain

**Files:**
- Create: `supabase/migrations/0213_geocoded_places.sql`
- Create: `src/lib/places/normalise.ts`, `tests/unit/place-normalise.test.ts`
- Create: `src/lib/integrations/google/{transport,client,fake,index}.ts`,
  `tests/unit/google-geocode.test.ts`
- Create: `src/services/places.ts`
- Modify: `src/lib/env.ts`, `.env.example`, `src/app/api/worker/tick/route.ts`

**Interfaces:**
- Produces: `normalisePlaceKey({country, state, city, neighbourhood}): string`;
  `GeocodeTransport.lookup(query: string): Promise<GeocodeResult | null>`;
  `drainGeocodeQueue(supabase): Promise<{ resolved: number; failed: number; skipped: number }>`.

- [ ] **Step 1: Write the normaliser's failing tests**

```ts
// The key is the whole cache. Get it wrong one way and every listener is a
// separate place; wrong the other and two different Cohabs share a coordinate.
it('folds case, accents and whitespace into one key', () => {
  const a = normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: 'Cohab' });
  const b = normalisePlaceKey({ country: 'br', state: 'ma', city: 'SAO LUIS', neighbourhood: '  COHAB ' });
  expect(a).toBe(b);
});

it('keeps two different cities apart even when the neighbourhood matches', () => {
  expect(normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: 'Centro' }))
    .not.toBe(normalisePlaceKey({ country: 'BR', state: 'SP', city: 'Santos', neighbourhood: 'Centro' }));
});

it('drops the noise a person types in front of a name', () => {
  expect(normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: 'Bairro da Cohab' }))
    .toBe(normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: 'Cohab' }));
});

it('treats a missing neighbourhood as a city-level place, not as an empty one', () => {
  const cityOnly = normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: null });
  expect(cityOnly).not.toContain('||');
  expect(cityOnly).not.toBe(
    normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: '' }),
  );
});
```

Run: `npx vitest run tests/unit/place-normalise.test.ts` — expect a missing
module.

> The fourth case is a decision, not a detail: decide whether `null` and `''`
> are the same place before writing the function, and make the test say so. The
> assertion above says they are NOT the same key; if that is wrong, change the
> test first.

- [ ] **Step 2: Write the normaliser**

Fold to lower case, `normalize('NFD')` + strip combining marks, collapse
whitespace, remove a short leading-noise list (`bairro`, `barrio`, `bairro do`,
`bairro da`, `vila` is **not** in it — "Vila Nova" is a name), join the four
parts with a separator that cannot appear in a place name.

- [ ] **Step 3: The transport, its fake and its unit tests**

`GeocodeResult = { latitude: number; longitude: number; precision: 'neighbourhood' | 'city' | 'region' | 'country' }`.
The client calls the Geocoding API with `GOOGLE_GEOCODING_KEY`. Test it against
a well-formed response, `ZERO_RESULTS` (→ `null`, not an error — the place is
real, Google just does not know it), `OVER_QUERY_LIMIT` (→ throw, so the drain
stops rather than burning the quota), and a malformed body.

> **Read `deezer/client.ts` first.** Block 13a records that Deezer reports errors
> with HTTP 200 and a body field; check whether Google does the same before
> deciding what "an error" is here.

- [ ] **Step 4: The table and its door**

`geocoded_places (id, place_key unique, country, state, city, neighbourhood,
latitude, longitude, precision, provider, resolved_at, failed_at,
failure_reason, attempts)`. RLS on; `grant select to authenticated` with a
policy of `using (true)` and a comment saying why that is safe here: the table
holds place names and coordinates, no tenant data and no personal data, and the
alternative — a `SECURITY DEFINER` read — would hide a join the two
`SECURITY INVOKER` aggregates in Task 6 need to make.

The door `claim_places_to_geocode(p_limit int)` returns rows never resolved and
not failed too recently, `for update skip locked`, so two ticks cannot claim the
same place.

- [ ] **Step 5: The drain**

`drainGeocodeQueue` in `src/services/places.ts`: claim a bounded batch, look each
up, write the coordinate or the failure. Joined into the tick beside
`drainReportRuns`, in its own `try`/`catch`, for the reason that file already
states twice.

- [ ] **Step 6: Env**

`NEXT_PUBLIC_GOOGLE_MAPS_KEY` and `GOOGLE_GEOCODING_KEY`, both
`z.string().min(1).optional()`, plus `GOOGLE_FAKE`. Add all three to
`.env.example` with the restriction each key needs (referrer / IP) written
beside it.

- [ ] **Step 7: Gates and commit**

---

## Task 6: The two geography aggregates

**Files:**
- Create: `supabase/migrations/0214_dashboard_geography.sql`
- Create: `src/services/geography.ts`, `tests/isolation/geography.test.ts`
- Modify: `supabase/tests/60_country_and_places.test.sql`,
  `scripts/verify-isolation-suite.mjs`

- [ ] **Step 1: The functions**

`get_audience_geography(p_company_ids uuid[], p_preset text, p_from date, p_to date)`
and `get_music_geography(...)`, both `stable`, both `SECURITY INVOKER`, both
re-checking `reports.consolidated` for every id when more than one is named —
copy that guard from `get_audience_dashboard` (`0118`) rather than re-deriving
it.

**The audience one counts the Listeners card's population.** Read `0118`'s own
`member_company_links … linked_at < to_at` block and filter it, do not write a
new count: Block 8a's D12b makes "every figure on this panel counts the same
people" a rule, and a map counting a flow beside a card counting a stock is the
exact failure it exists to prevent (spec D11).

Each returns `jsonb`: `{ places: [{ key, city, neighbourhood, latitude,
longitude, count, top_song? }], with_place, total }` — the last two feed the
coverage line.

- [ ] **Step 2: The isolation cases**

At minimum: a place belonging to Station A's listeners does not appear for
Station B; naming a second id without `reports.consolidated` is refused; the
audience total equals `get_audience_dashboard`'s listeners figure for the same
window (the assertion that pins D11 and would fail the moment somebody
"improves" the count).

- [ ] **Step 3: Manifest, gates, commit**

---

## Task 7: The maps

**Files:**
- Create: `src/app/(app)/dashboards/{geography-panel,place-map}.tsx`
- Modify: `src/app/(app)/dashboards/{audience,music}/page.tsx`,
  `src/lib/security/csp.ts`, `messages/{en,pt,es}.json`
- Create: `tests/e2e/dashboards-geography.spec.ts`

- [ ] **Step 1: The CSP**

Add `https://maps.googleapis.com https://maps.gstatic.com` to **`img-src` and
`connect-src` only**.

**Not to `script-src`.** That directive carries `'strict-dynamic'`, and a
browser that understands it **ignores host allowlists there entirely** — adding
Google would be a line that reads as protection and does nothing. What loads the
library is the nonce: a nonced `<script>` may load further scripts under
`strict-dynamic`, which is why that keyword is there. Write this in the comment,
because the next person will try to add it.

- [ ] **Step 2: The panel**

`GeographyPanel` (Server Component) renders the coverage line, the ranked tables
by city and by neighbourhood, and — only when `NEXT_PUBLIC_GOOGLE_MAPS_KEY` is
set — `PlaceMap`. Without the key: one muted line saying the map is not
configured, and the tables unchanged. That is what makes the block finishable
before a key exists and is design D6.

- [ ] **Step 3: The map**

`PlaceMap` is a client component. Load the Maps library from a nonced script,
place one circle per place sized by `count`, fit the bounds to the places (or to
the Station's country when there are none). The Music panel's marker carries the
song title and count in its label.

- [ ] **Step 4: The journey**

`tests/e2e/dashboards-geography.spec.ts` runs with **no** map key (the suite
sets none), so it asserts the degraded path end to end: the coverage line names
both numbers, the neighbourhood table lists the seeded places, and the
"not configured" line is present. Assert **no** request to `maps.googleapis.com`
was made, which is the claim that the key gate actually gates.

- [ ] **Step 5: Gates and commit**

---

## Task 8: The whole-branch gate

- [ ] **Step 1: Kill any stray dev server**

`netstat -ano | grep ":3000"` → `taskkill //PID <pid> //F`. A multi-GB `node.exe`
holding that port is a zombie from an interrupted run, and every e2e will fail
against it in a way that looks like a regression.

- [ ] **Step 2: Every gate, in order, from a clean database**

```bash
npm run lint && npm run typecheck && npm run test
npm run db:reset && npm run seed:branding
npm run db:test
npm run test:isolation
CI=1 npx playwright test --workers=1
```

`seed:branding` after the reset, or `login.spec.ts` fails on a missing hero
image. The isolation suite's `Worker exited unexpectedly` is a known open flake
(~2 runs in 5) — re-run it, and only investigate if the same file fails twice.

- [ ] **Step 3: Confirm the migrations are committed**

```bash
git status --short
git log --oneline origin/main..HEAD -- supabase/migrations
```
Expected: six migrations, `0209`–`0214`, and a clean tree. This project has
shipped code without its migrations three times.

- [ ] **Step 4: Push and open the PR**

Write the body to a file and pass `--body-file` — a heredoc with backticks and
apostrophes breaks the shell. Name in it: that inventory categories were
deliberately untouched, that `song_integrations.category_name` was too, and the
two owner decisions (no privacy floor, one songwriter per song).

---

## Self-Review

**Spec coverage.** §3 → Tasks 1–2. §4 → Task 4. §5 → Task 5. §6 → Tasks 6–7.
§7 → Task 3. §8 → the migrations in Tasks 1, 4, 5, 6. §10 → tests inside each
task plus Task 8. §11 out of scope, no task, correctly.

**Two things the plan found that the spec had wrong**, both now corrected in the
spec: the live definitions of the member and company doors are `0073`/`0074`/
`0155`, not `0034`/`0153`; and `script-src` must NOT gain the Google hosts,
because `'strict-dynamic'` makes host allowlists in that directive inert.

**Type consistency.** `SongSummary.songwriterId`/`songwriterName` (Task 2) are
what the grid renders and what `?songwriter=` filters. `normalisePlaceKey`
(Task 5) produces the key `geocoded_places.place_key` stores and the key Task 6's
aggregates join on. `GeocodeTransport` (Task 5) is consumed only by
`drainGeocodeQueue`. `StationSelection` (Task 3) consumes `periodHref` unchanged.

**The one thing a reviewer should check hardest:** that nothing under
`src/app/(app)/inventory/`, `schemas/inventory.ts`, `services/inventory.ts` or
`prize_categories` changed. `59_songwriters.test.sql`'s last four assertions
exist for that, and `git diff --stat` should show no inventory file at all.
