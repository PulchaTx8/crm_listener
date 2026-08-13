# Block 20c — Catalogue Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/music/catalog`'s three tabs with three real screens at
`/catalog/labels`, `/catalog/genres` and `/catalog/albums`, each a filtered
paged list with a Cadastrar button opening a popup, and give the album record a
thumbnail with two sources.

**Architecture:** The database work comes first, because everything else depends
on a widened `update_album` and a new `thumb_url`. Then the services, then two
screen families — one component rendered by the two identical reference routes,
one bespoke screen for albums. The old tabbed screen and its route are deleted
last, in the same commit that repoints the sidebar, because that is the moment
the product changes.

**Tech Stack:** Next.js 15 App Router (Server Components + Server Actions),
React 19, next-intl, Supabase Postgres (pgTAP), Supabase Storage, Playwright,
Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-13-block-20c-catalogue-screens-design.md`.
  Every decision traces to a D-number in its §2.
- **Branch:** `block-19-whatsapp-entry`, already checked out. Do not create a
  branch, do not merge. Blocks 20a and 20b are on it and PR #65 is open; these
  commits join the same branch.
- **Language:** code, comments, commit messages in English. User-facing copy in
  `messages/pt.json`, `en.json` and `es.json` — all three, always.
  `tests/unit/i18n/catalogue.test.ts` compares the three to each other.
- **Message keys are single-quoted literals at the call site, never composed.**
  `tests/unit/i18n/usage.test.ts` reads the AST for literal keys only.
- **The e2e suite runs in English.** `playwright.config.ts` pins
  `locale: 'en-US'` deliberately. Section labels are `Catalog` (no `-ue`) and
  `Inventory` (`Stock` is the item inside it). Read `messages/en.json`'s `nav`
  object rather than guessing.
- **Never rebuild a SQL function from an older migration's text.** Read the live
  definition — `select pg_get_functiondef('public.may_write_artwork(text)'::regprocedure);`
  — and edit that. This project has silently reverted later fixes that way.
- **`create or replace` does NOT change a function's argument list.** It creates
  a SECOND overload, and existing callers go on resolving to the old one,
  silently. `::regprocedure` does not detect it either — it resolves the
  signature you name and ignores the twins. Widening a signature means
  `drop function` on the old one, and proving the drop.
- **A migration must travel with the deploy.** This project has shipped code
  ahead of its migrations three times.
- **Gate order:** typecheck, lint, unit, `db:reset`, `db:test`,
  `seed:branding`, e2e, isolation. `db:test` before the e2e and isolation
  suites, never after; `seed:branding` after `db:reset` because the reset
  empties Storage and `login.spec.ts` asserts the branding image.
- **The isolation suite crashes about two runs in five** from a documented,
  undiagnosed flake. On an incomplete run, re-run **once** from a clean
  database; if the **same file** drops out twice, stop and report. Never weaken
  `scripts/verify-isolation-suite.mjs`.
- **Do not dispatch sub-agents.** An earlier block lost time to a helper that
  ran `git stash`, deleted a file and committed autonomously.
- Commit after every task. Do not push until the final task.

---

## File Structure

**Created:**

- `supabase/migrations/0187_album_covers.sql` — `albums.thumb_url`, the widened
  `update_album` (old signature dropped), `set_album_cover`, and
  `may_write_artwork` gaining the `album-covers` slot. Task 1.
- `supabase/tests/49_album_covers.test.sql` — its pgTAP. Task 1.
- `src/app/(app)/catalog/references/` — the component both reference routes
  render: `reference-screen.tsx`, `references-grid.tsx`,
  `reference-record-dialog.tsx`, `references-filters.tsx`, `list-params.ts`,
  `actions.ts`. Task 3.
- `src/app/(app)/catalog/labels/page.tsx`, `src/app/(app)/catalog/genres/page.tsx`
  — thin pages supplying kind, title and copy. Task 3.
- `src/app/(app)/catalog/albums/` — `page.tsx`, `albums-grid.tsx`,
  `album-record-dialog.tsx`, `albums-filters.tsx`, `list-params.ts`,
  `actions.ts`, `record.ts`, `album-thumb.tsx`. Task 4.
- `tests/e2e/catalog-screens.spec.ts` — the journeys. Task 5.

**Modified:**

- `src/services/music.ts` — `listMusicReferencesPage`, `listAlbumsPage`,
  `uploadAlbumCover`, `clearAlbumCover`. Task 2.
- `src/lib/storage/artwork-keys.ts` — the `album-covers` slot. Task 2.
- `src/lib/auth/shell.ts` — the three `href`s. Task 5.
- `src/components/layout/sidebar-nav.tsx` — the query-matching branch 20b added
  for those three `href`s is removed. Task 5.
- `messages/pt.json`, `en.json`, `es.json` — the new screens' copy. Tasks 3, 4.

**Deleted:**

- `src/app/(app)/music/catalog/` entirely, and
  `tests/e2e/music-catalogue.spec.ts` (replaced). Task 5.

---

## Task 1: The migration

**Files:**
- Create: `supabase/migrations/0187_album_covers.sql`
- Create: `supabase/tests/49_album_covers.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces, all used by Task 2:
  - `albums.thumb_url text`
  - `update_album(p_album_id uuid, p_title text, p_upc text, p_release_date date)` — no defaults on the last two, and the old `(uuid, text)` version **gone**
  - `set_album_cover(p_album_id uuid, p_url text default null)`
  - `may_write_artwork` answering true for `album-covers/<company>/<album>` under `music.manage`

- [ ] **Step 1: Read the live definitions**

Do not copy bodies from `0137_album_rpcs.sql` or `0143_artwork_bucket.sql`.

```bash
npx supabase db psql -c "select pg_get_functiondef('public.update_album(uuid,text)'::regprocedure);"
npx supabase db psql -c "select pg_get_functiondef('public.may_write_artwork(text)'::regprocedure);"
```

If `npx supabase db psql` is unavailable, connect with `psql` directly —
`scripts/db-reset.mjs` shows how this project assembles the local connection
string. Save both; they are the base text you edit.

Also read **`supabase/migrations/0145_prize_photo.sql`**, which defines
`set_prize_photo` and the artwork delete queue. `set_album_cover` follows it
exactly, including how clearing enqueues the object for the worker rather than
deleting it — the bucket gives `authenticated` no delete policy, deliberately.
Read `set_prize_photo`'s LIVE definition too, not only 0145's text: 0153 also
touches this area, and the live body is the one that is true.

- [ ] **Step 2: Write the failing pgTAP**

Create `supabase/tests/49_album_covers.test.sql`, following the style of
`supabase/tests/42_widget_promotions.test.sql`: `begin; select plan(N);`,
literal uuids in their own range, numbered section comments explaining *why*,
`select * from finish(); rollback;`.

The assertions, in this order:

```sql
-- 1. The old two-argument update_album is GONE, not shadowed.
--
-- THE ASSERTION THIS FILE EXISTS FOR. `create or replace` does not change an
-- argument list -- it adds an overload, and every existing caller goes on
-- resolving to the old one in silence. ::regprocedure cannot see that: it
-- resolves the signature written and ignores the twins. Only a count over
-- pg_proc can. Block 4b paid for this once.
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_album'),
  1::bigint, 'exactly one update_album exists, not two');

select is(
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_album'),
  'uuid, text, text, date', 'and it is the widened one');

-- 2. thumb_url exists and is nullable.
select has_column('public', 'albums', 'thumb_url', 'albums carries a cover URL');
select col_is_null('public', 'albums', 'thumb_url', 'and an album without one is ordinary');

-- 3. may_write_artwork accepts an album-covers path under music.manage and
--    refuses it without.
```

For assertion 3, **`supabase/tests/29_artwork_bucket.test.sql` already exercises
`may_write_artwork`** for the promotion and prize slots. Read it and copy its
fixture shape — the caller, the permission grant, and how it asserts both the
true and the false side. Do not invent a second way to set up a permitted
caller; a fixture that differs from the one already proving the neighbouring
slots is a fixture nobody can compare against.

Add your `album-covers` assertions to **that file** rather than to the new one
if its fixtures make it the natural home — decide by reading it, and say which
you chose and why in your report.

Add assertions that `update_album` actually writes the release date, and that
`set_album_cover` sets and clears `thumb_url`. Both need a caller holding
`music.manage`; reuse the same fixture.

- [ ] **Step 3: Run it and watch it fail**

```bash
npm run db:reset
npm run db:test
```

Expected: FAIL — `update_album`'s identity arguments are `uuid, text, text`, and
`thumb_url` does not exist.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0187_album_covers.sql`. Header, in the house voice:

```sql
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
-- THE PICTURE HAS TWO SOURCES AND ONE COLUMN. `cover_md5` (0136) is Deezer's
-- and stays exactly as it is; `thumb_url` is the operator's own upload. The
-- screen prefers the upload and falls back to the cover -- so an album
-- registered from Deezer arrives with a picture at no cost, and one typed by
-- hand can be given one. Nothing merges them in the database, because they are
-- facts from two different places and only the screen has an opinion about
-- which to show.
```

Then, in order:

1. `alter table public.albums add column thumb_url text;` with a comment saying
   what it is and that `cover_md5` is a different thing.
2. `drop function public.update_album(uuid, text);` — explicit, before the
   create, with a comment naming the trap.
3. `create function public.update_album(p_album_id uuid, p_title text, p_upc text, p_release_date date)` — **no defaults on the last two**, the live body from Step 1 plus `upc` and `release_date` in the UPDATE. Keep its `music.manage` check, its `security definer`, and its `set search_path`.

   **The absence of defaults is the point, and it is 0141's ruling, not a style
   choice.** That migration dropped the UPC parameter 0137 had, because on a
   one-field row *"an omitted parameter is indistinguishable, to the RPC, from
   a cleared one"*. A `default null` here would resurrect exactly that: a
   caller sending two arguments would silently empty two columns. With no
   default, such a caller fails at the call. Say this in the header and in
   `comment on function`, naming 0141, so the next person to add a convenience
   default meets the reason not to.

   Note the starting signature is `(uuid, text)` — 0141 already removed the
   third argument — so the drop in step 2 names `(uuid, text)`. Confirm against
   the live database rather than trusting this sentence.
4. `create function public.set_album_cover(p_album_id uuid, p_url text default null)` — modelled on `set_prize_photo`: `music.manage` checked, sets `thumb_url = p_url`, and when `p_url` is null enqueues the old object for the worker to delete rather than deleting it. Read `set_prize_photo`'s live definition and follow it; **the parameter is omitted rather than passed null when clearing**, which is why it carries `default null`.
5. `create or replace function public.may_write_artwork(p_name text)` — the live body from Step 1 with one branch added before the final `return false`:

```sql
  -- Block 20c. An album's cover takes the music catalogue's permission, the
  -- same one every other album door takes (0137). An operator who runs
  -- promotions is not thereby somebody who edits the music catalogue.
  if v_slot = 'album-covers' then
    return public.has_permission('music.manage', v_company::uuid);
  end if;
```

6. `comment on function` for both new/changed functions, and the `revoke`/`grant`
   pair restated for each, as 0143 and 0137 do.

- [ ] **Step 5: Run it and watch it pass**

```bash
npm run db:reset
npm run db:test
```

Expected: PASS, including every pre-existing assertion. Watch particularly for
tests that call `update_album` — if any exist, they must still pass, which is
what the new default argument is for.

- [ ] **Step 6: Regenerate the database types**

```bash
npm run db:types
```

Expected: `src/lib/supabase/database.types.ts` changes — `thumb_url` on
`albums`, the new `set_album_cover`, and `update_album`'s new argument. Commit
the regenerated file.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0187_album_covers.sql supabase/tests/49_album_covers.test.sql src/lib/supabase/database.types.ts
git commit -F- <<'EOF'
feat(20c): the album gets a picture, and update_album two fields it never had

The widening is a DROP and a CREATE, not a replace: create or replace does not
change an argument list, it adds an overload, and callers compiled against the
old signature go on resolving to it in silence. ::regprocedure cannot see that
either, which is why the test counts rows in pg_proc. Block 4b found it the
expensive way.

The picture has two sources and one column. cover_md5 is Deezer's and is
untouched; thumb_url is the operator's own upload. Nothing merges them in the
database -- they are facts from two different places, and only the screen has
an opinion about which to show.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 2: The services

**Files:**
- Modify: `src/services/music.ts`
- Modify: `src/lib/storage/artwork-keys.ts`
- Test: `tests/unit/` — a new file for whatever is pure

**Interfaces:**
- Consumes: Task 1's `set_album_cover`, widened `update_album`, `thumb_url`.
- Produces, used by Tasks 3 and 4:
  - `listMusicReferencesPage(params: ReferenceListParams): Promise<ReferenceListPage>`
  - `listAlbumsPage(params: AlbumListParams): Promise<AlbumListPage>`
  - `uploadAlbumCover(accessToken: string, input: { companyId: string; albumId: string; file: File }): Promise<string>`
  - `clearAlbumCover(accessToken: string, albumId: string): Promise<void>`
  - `ArtworkSlot` gains `'album-covers'`

- [ ] **Step 1: Add the artwork slot**

In `src/lib/storage/artwork-keys.ts`, extend the `ArtworkSlot` union:

```ts
  // Block 20c. The album's own cover, keyed `album-covers/<company_id>/<album_id>`.
  // Distinct from `cover_md5`, which is Deezer's and is not stored here at all:
  // this slot holds only what an operator uploaded.
  | 'album-covers'
```

The company id stays the SECOND segment, because `may_write_artwork` reads
`storage.foldername(name)[2]`. `artworkKey` already enforces that ordering; do
not add a second key builder.

- [ ] **Step 2: Write the failing service tests**

`listMusicReferencesPage` and `listAlbumsPage` talk to Supabase and are not
unit-testable here — this repository tests those through e2e. What IS pure is
the key and URL arithmetic, and it already has a home. Add to the existing
artwork-keys test file if one exists (`grep -rl "artworkKey" tests/unit/`), or
create `tests/unit/artwork-keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { artworkKey } from '@/lib/storage/artwork-keys';

describe('artworkKey for album covers', () => {
  /**
   * The company id is the SECOND segment because may_write_artwork (0143)
   * reads storage.foldername(name)[2] and decides from the path alone. Get
   * the order wrong and the policy asks has_permission about a slot name.
   */
  it('puts the Station second and the album third', () => {
    expect(artworkKey('album-covers', 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002'))
      .toBe('album-covers/c0000000-0000-0000-0000-000000000001/a0000000-0000-0000-0000-000000000002');
  });

  /**
   * No extension, deliberately: that is what makes "uploading again replaces
   * the last one" structural rather than hopeful.
   */
  it('carries no file extension', () => {
    expect(artworkKey('album-covers', 'c1', 'a1')).not.toMatch(/\.(jpg|jpeg|png)$/);
  });
});
```

- [ ] **Step 3: Run them**

```bash
npm run test -- tests/unit/artwork-keys.test.ts
```

Expected: PASS once Step 1 is in (the union widened; `artworkKey` itself is
unchanged). If it fails to typecheck before Step 1, that IS the red.

- [ ] **Step 4: Write the two paged readers**

In `src/services/music.ts`, add `listMusicReferencesPage` and `listAlbumsPage`,
**modelled on `listArtistsPage`** in the same file — same keyset shape, same
`build()` helper for the row read and the count read, same handling of
`cursorSide`/`direction`, same reuse of `SONG_PAGE_SIZE` and
`SONG_SEARCH_MAX_LENGTH`.

`listMusicReferencesPage` takes a `kind` (`MusicReferenceKind`) and reads the
table that kind names, exactly as `listMusicReferences` already does; sorts by
`name`; searches `name`.

`listAlbumsPage` reads `albums`, selecting `id, title, upc, release_date, legacy_id, cover_md5, thumb_url`; sorts by `title`; searches `title`.

**Leave `listMusicReferences` exactly as it is.** `music/requests/page.tsx`
calls it to build the programme `<select>`, and a select needs every option —
paging it would silently truncate the control whose whole purpose is to offer
the full set. Add a comment on the new function saying so, so nobody
"consolidates" the two later.

`listAlbums` becomes unused once Task 5 deletes `music/catalog/page.tsx`.
**Check for other callers before removing it** (`grep -rn "listAlbums" src/`),
and remove it in Task 5 with the screen that used it, not here.

- [ ] **Step 5: Write the upload pair**

Add to `src/services/music.ts`, modelled on `uploadPrizePhoto` and
`clearPrizePhoto` in `src/services/inventory.ts` — read both first:

- `uploadAlbumCover` validates with `describeArtworkRejection` before uploading
  anything, builds the key with `artworkKey('album-covers', companyId, albumId)`,
  uploads with `contentType: input.file.type` and `upsert: true`, then calls
  `set_album_cover` with `artworkPublicUrl(getUserSupabaseConfig().url, key, Date.now())`.
- `clearAlbumCover` calls `set_album_cover` with `p_url` **omitted**, not null.

Both take `accessToken` first and use `asCaller`, like their models. Carry the
two comments their models carry and that are load-bearing here too: the content
type is not optional because the key has no extension, and nothing deletes the
object — the bucket gives `authenticated` no delete policy and a worker drains
the queue.

- [ ] **Step 6: Typecheck, lint, unit**

```bash
npm run typecheck
npm run lint
npm run test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/music.ts src/lib/storage/artwork-keys.ts tests/unit/
git commit -F- <<'EOF'
feat(20c): paged readers for the catalogue, and the album cover's two doors

listMusicReferences is deliberately NOT paged and deliberately NOT replaced:
music/requests/page.tsx calls it to build the programme select, and a select
needs every option -- paging it would silently truncate the one control whose
purpose is to offer the full set. listMusicReferencesPage sits beside it.

The upload pair follows the prize photograph exactly, including the two
comments that are load-bearing rather than decorative: contentType is not
optional because the key carries no extension, and nothing here deletes
anything -- the bucket gives authenticated no delete policy, and a worker
drains the queue.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 3: Gravadoras and Gêneros — one screen, two routes

**Files:**
- Create: `src/app/(app)/catalog/references/list-params.ts`, `actions.ts`,
  `reference-screen.tsx`, `references-filters.tsx`, `references-grid.tsx`,
  `reference-record-dialog.tsx`
- Create: `src/app/(app)/catalog/labels/page.tsx`,
  `src/app/(app)/catalog/genres/page.tsx`
- Modify: `messages/pt.json`, `messages/en.json`, `messages/es.json`

**Interfaces:**
- Consumes: `listMusicReferencesPage` from Task 2.
- Produces: two routes reachable by URL. The sidebar still points at
  `/music/catalog?tab=…` until Task 5 — that is expected, not a bug.

**The model is the Artists screen**, `src/app/(app)/music/artists/`. Read all
seven of its files before writing anything: `page.tsx`, `list-params.ts`,
`artists-filters.tsx`, `artists-grid.tsx`, `artist-record-dialog.tsx`,
`actions.ts`, `record.ts`. This screen is that one with a thinner record.

**D2: one component, rendered twice.** `reference-screen.tsx` takes the kind and
the copy; `labels/page.tsx` and `genres/page.tsx` are thin Server Components
that resolve access, read the page and render it. Everything else — grid,
filters, dialog, actions — is shared and kind-agnostic. Two near-identical
screens would be the mistake migration 0100 argues against in writing.

- [ ] **Step 1: Write the failing e2e**

Add to a new `tests/e2e/catalog-screens.spec.ts` (Task 5 fills it out; start it
here). Model the sign-in on `tests/e2e/music-catalogue.spec.ts`, which
provisions an owner with music permissions — reuse `tests/e2e/provision.ts`.

```ts
test('a record label is registered, found and archived on its own screen', async ({ page }) => {
  // Sign in as an owner with music.manage.

  // The screen exists at its own address -- the whole of item 5.
  await page.goto('/catalog/labels');
  await expect(page.getByRole('heading', { name: 'Record labels' })).toBeVisible();

  await page.getByTestId('reference-create').click();
  await page.getByTestId('reference-name').fill('Selo Teste 20c');
  await page.getByTestId('reference-save').click();

  await expect(page.getByTestId('references-grid')).toContainText('Selo Teste 20c');

  // The filter narrows to it, and away from it.
  await page.getByTestId('references-search').fill('Selo Teste 20c');
  await page.getByTestId('references-search-submit').click();
  await expect(page.getByTestId('references-grid')).toContainText('Selo Teste 20c');

  await page.getByTestId('references-search').fill('nothing matches this');
  await page.getByTestId('references-search-submit').click();
  await expect(page.getByTestId('references-grid')).not.toContainText('Selo Teste 20c');
});
```

English, because the suite is pinned to `en-US`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test tests/e2e/catalog-screens.spec.ts
```

Expected: FAIL — `/catalog/labels` does not exist, so the heading never appears.

- [ ] **Step 3: Write `list-params.ts`**

Copy the shape of `src/app/(app)/music/artists/list-params.ts` exactly:
`ReferenceSearchParams`, `ReferenceListState`, `ReferenceCursor`,
`DEFAULT_REFERENCE_SORT`, `defaultDirectionFor`, and the parse/build helpers.
One filter only — `q`, a name search — as the artists file already has, and for
the same reason it gives: there is nothing else to filter these by.

Carry the `stationSearch` field and its comment. Dropping it puts a capped
Station list back to its first page on the next sort click, silently moving the
caller to somebody else's catalogue.

- [ ] **Step 4: Write `actions.ts`**

Three server actions — create, update, archive — each parsing against the
schemas in `src/schemas/music.ts` and calling
`create_music_reference` / `update_music_reference` / `archive_music_reference`.
`src/app/(app)/music/catalog/actions.ts` already does exactly this; read it and
carry across what still applies. It is deleted in Task 5, so this is a move, not
a duplicate.

`revalidatePath` is the right call here, as it was there and for the reason that
file records: these screens hold no keyset position the operator would lose. Use
the new paths.

- [ ] **Step 5: Write the screen**

`reference-screen.tsx` renders `PageHeader`, the Station switcher, the filters,
the grid and the Cadastrar button. `references-grid.tsx` and
`references-filters.tsx` follow `artists-grid.tsx` and `artists-filters.tsx`.
`reference-record-dialog.tsx` follows `artist-record-dialog.tsx` but holds one
field, a save button and an archive button — no tabs and no related-records
panel, because the record is a name.

The archive confirmation follows the one in
`src/app/(app)/music/catalog/reference-panel.tsx`: a styled `<Dialog>` with a
stable `data-testid`, never `window.confirm`.

Give every control the `data-testid` the Step 1 test uses:
`reference-create`, `reference-name`, `reference-save`, `references-grid`,
`references-search`, `references-search-submit`.

- [ ] **Step 6: Write the two pages**

`labels/page.tsx` and `genres/page.tsx`: resolve the caller and the Station with
`listCompanyAccess(supabase, 'music.view', stationSearch)` exactly as
`music/catalog/page.tsx` does today, read the page with
`listMusicReferencesPage`, and render `ReferenceScreen` with the kind and copy.
Keep `export const dynamic = 'force-dynamic'` and the two redirect branches the
existing page carries — the no-match-search branch BEFORE the no-access
redirect, so a search can always be undone.

- [ ] **Step 7: Add the copy to all three catalogues**

Under `music`, new keys for the two screens' titles and descriptions, the
Cadastrar button, the dialog's title and the filter's label. English titles must
be exactly `Record labels` and `Genres` — the Step 1 test asserts the heading,
and `nav.labels`/`nav.genres` already carry those words.

- [ ] **Step 8: Run the gates that see this**

```bash
npm run typecheck
npm run lint
npm run test -- tests/unit/i18n
npx playwright test tests/e2e/catalog-screens.spec.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/catalog" messages/ tests/e2e/catalog-screens.spec.ts
git commit -F- <<'EOF'
feat(20c): record labels and genres get screens of their own

One component rendered by two routes, because the two records are identical --
a name and a legacy handle. Migration 0100 already argued this at the database
layer: four identical tables got one trio of functions, because twelve
near-identical bodies would be twelve places for a fix to be applied to eleven.
Two near-identical screens would be the same mistake one layer up.

The sidebar still points at the old tabs; it is repointed when the old screen
is deleted, which is the moment the product actually changes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 4: Álbuns

**Files:**
- Create: `src/app/(app)/catalog/albums/list-params.ts`, `record.ts`,
  `actions.ts`, `albums-filters.tsx`, `albums-grid.tsx`,
  `album-record-dialog.tsx`, `album-thumb.tsx`, `page.tsx`
- Modify: `messages/pt.json`, `messages/en.json`, `messages/es.json`
- Test: `tests/e2e/catalog-screens.spec.ts`

**Interfaces:**
- Consumes: `listAlbumsPage`, `uploadAlbumCover`, `clearAlbumCover` from Task 2;
  the widened `update_album` and `set_album_cover` from Task 1.
- Produces: `/catalog/albums`.

- [ ] **Step 1: Write the failing e2e**

Append to `tests/e2e/catalog-screens.spec.ts`:

```ts
test('an album is registered with its details and carries a picture', async ({ page }) => {
  // Sign in as an owner with music.manage.

  await page.goto('/catalog/albums');
  await expect(page.getByRole('heading', { name: 'Albums' })).toBeVisible();

  await page.getByTestId('album-create').click();
  await page.getByTestId('album-title').fill('Álbum Teste 20c');
  await page.getByTestId('album-upc').fill('123456789012');
  await page.getByTestId('album-release-date').fill('2026-03-01');
  await page.getByTestId('album-save').click();

  await expect(page.getByTestId('albums-grid')).toContainText('Álbum Teste 20c');

  // D6: the release date is a field this screen can actually write. Before
  // Block 20c, update_album had no parameter to send it to -- so an assertion
  // that only checked the title would have passed against the old door.
  await expect(page.getByTestId('albums-grid')).toContainText('2026');
});
```

The picture is proved separately below, because a file upload needs a fixture.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test tests/e2e/catalog-screens.spec.ts -g "carries a picture"
```

Expected: FAIL — `/catalog/albums` does not exist.

- [ ] **Step 3: Write `album-thumb.tsx`**

```tsx
/**
 * The album's picture, from whichever source has one.
 *
 * Block 20c, D4. TWO SOURCES AND AN ORDER: `thumbUrl` is what an operator
 * uploaded and wins; `coverMd5` is Deezer's, which an album registered from
 * there already carries; neither means an empty frame rather than a broken
 * image. Nothing merges them in the database — they are facts from two
 * different places, and this component is the only thing with an opinion about
 * which to show.
 *
 * NOT a widening of SongThumb (music/songs/song-fields.tsx). That one answers
 * "draw this Deezer cover" and is used on five screens; teaching it a second
 * source would make it mean two things, and every existing caller would carry
 * a prop it never sets.
 */
```

It renders a plain `<img>` for the Deezer CDN address — the same
`https://cdn-images.dzcdn.net/images/cover/<md5>/56x56-000000-80-0-0.jpg` shape
`SongThumb` uses, which `img-src` in `src/lib/security/csp.ts` has allowed since
Block 13a — and for `thumbUrl` too, since the artwork bucket is on this
deployment's own Supabase host. Check `csp.ts` allows that host before
assuming; if it does not, say so in your report rather than widening the policy
on your own.

- [ ] **Step 4: Write the record and the list params**

`record.ts` follows `src/app/(app)/music/artists/record.ts` — the record-dialog
URL contract. `list-params.ts` follows the artists one, with `q` searching the
title.

- [ ] **Step 5: Write the actions**

`actions.ts`: create, update, archive, plus the two picture actions. Create and
update call `create_album` and the widened `update_album`; the picture actions
call `uploadAlbumCover` and `clearAlbumCover`. Validate with a schema in
`src/schemas/music.ts` alongside the existing album schema if there is one —
check first (`grep -n "album" src/schemas/music.ts`).

The upload action takes the `File` from `FormData` and passes the caller's
access token, as the prize-photo action does. Read
`src/app/(app)/inventory/[prizeId]/actions.ts` (or wherever the prize photo
action lives — `grep -rn "uploadPrizePhoto" src/app/`) and follow it.

- [ ] **Step 6: Write the grid, filters, dialog and page**

Following `artists-grid.tsx`, `artists-filters.tsx`, `artist-record-dialog.tsx`
and `artists/page.tsx`. The grid shows the picture, the title, the release date
and the UPC. The dialog edits título, UPC and data de lançamento, and carries
the picture control — upload and remove.

`deezer_album_id` and `cover_md5` are NOT editable fields (D6): they are facts
about a third party's catalogue, written by the Deezer path. Show the Deezer
cover if that is what the picture resolves to, but do not offer to edit either
value.

Give every control the `data-testid` Step 1 uses: `album-create`,
`album-title`, `album-upc`, `album-release-date`, `album-save`, `albums-grid`.

- [ ] **Step 7: Add an e2e for the picture**

A second test that uploads a small PNG through the dialog and asserts the grid
shows an image for that album. Playwright's `setInputFiles` takes a buffer, so
no fixture file is needed:

```ts
await page.getByTestId('album-cover-input').setInputFiles({
  name: 'cover.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
});
```

Assert the album's row then has an `img` whose `src` contains `album-covers`.
That is what proves the upload reached the bucket under the right key rather
than merely that a form submitted.

- [ ] **Step 8: Add the copy, then run the gates**

All three catalogues. English heading exactly `Albums`.

```bash
npm run typecheck
npm run lint
npm run test -- tests/unit/i18n
npx playwright test tests/e2e/catalog-screens.spec.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/catalog/albums" messages/ tests/e2e/catalog-screens.spec.ts src/schemas/music.ts
git commit -F- <<'EOF'
feat(20c): the albums screen, with a picture that has two sources

thumb_url wins, cover_md5 falls back, and neither means an empty frame. Nothing
merges them in the database: they are facts from two different places, and only
the screen has an opinion about which to show.

The release date is now writable, which it was not before this block --
update_album had no parameter to send it to. The journey asserts it, because a
test that only checked the title would have passed against the old door.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 5: The old screen is deleted and the sidebar repointed

**Files:**
- Delete: `src/app/(app)/music/catalog/` (all four files)
- Delete: `tests/e2e/music-catalogue.spec.ts`
- Modify: `src/lib/auth/shell.ts`, `src/components/layout/sidebar-nav.tsx`,
  `src/services/music.ts` (remove `listAlbums`), `tests/e2e/nav-content.spec.ts`
- Test: `tests/e2e/catalog-screens.spec.ts`

**This is the commit where the product changes**, so it lands atomically: the
old address stops answering, the sidebar points at the new ones, and 20b's
query-matching branch — which existed only for those three `href`s — goes with
them.

- [ ] **Step 1: Write the failing assertion**

In `tests/e2e/nav-content.spec.ts`, extend the catalogue section's assertions:

```ts
// Block 20c. The three items point at real routes now, and therefore
// HIGHLIGHT -- which they could not do while their hrefs carried ?tab=,
// because the active-link test compares a pathname and a pathname never has
// a query string. This assertion is the one 20b could not make.
await openNavSection(page, 'Catalog');
await page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Genres' }).click();
await expect(page).toHaveURL(/\/catalog\/genres$/);
await expect(
  page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Genres' }),
).toHaveAttribute('aria-current', 'page');
await expect(
  page.locator('[data-nav-section="catalog"]').getByRole('link', { name: 'Albums' }),
).not.toHaveAttribute('aria-current', 'page');
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test tests/e2e/nav-content.spec.ts
```

Expected: FAIL — the link still points at `/music/catalog?tab=genres`, so the
URL assertion fails.

- [ ] **Step 3: Repoint the sidebar**

In `src/lib/auth/shell.ts`, change the three `href`s to `/catalog/labels`,
`/catalog/genres`, `/catalog/albums`. Rewrite the comment above them: it
currently explains that the addresses already answer and that 20c will replace
what they render. That is now history — say instead that these are the routes,
and that the `?tab=` version was an interim the design's §2 D2 amendment
records.

- [ ] **Step 4: Remove the query-matching branch**

In `src/components/layout/sidebar-nav.tsx`, remove the `useSearchParams()`
query-matching added in Block 20b for those three hrefs, restoring the plain
`pathname === item.href || pathname.startsWith(item.href + '/')` comparison.

**Check no other item's href carries a query string first** (`grep -n "href: '" src/lib/auth/shell.ts`).
If one does, keep the branch and say so in your report — removing it would break
that item silently.

Also remove the now-unused `useSearchParams` import.

- [ ] **Step 5: Delete the old screen**

```bash
git rm -r "src/app/(app)/music/catalog"
git rm tests/e2e/music-catalogue.spec.ts
```

D1: `/music/catalog` does not redirect. Nothing replaces the route.

Then remove `listAlbums` from `src/services/music.ts` — but **grep for callers
first** (`grep -rn "listAlbums" src/`), and if anything other than the deleted
page uses it, keep it and say so.

- [ ] **Step 6: Carry across whatever the deleted spec proved**

`tests/e2e/music-catalogue.spec.ts` covered the tabbed screen. Before deleting
it, read it and check every behaviour it asserted is covered by
`catalog-screens.spec.ts` — the register/find/archive journey, the Station
switcher, the permission-less caller. Add whatever is missing. Deleting a spec
without carrying its assertions across is how coverage vanishes silently.

- [ ] **Step 7: Run the whole e2e suite**

```bash
npm run db:reset && npm run seed:branding && npm run test:e2e
```

Expected: PASS. This is the gate that catches anything still pointing at the
deleted route.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -F- <<'EOF'
fix(20c): the tabs are gone, and the sidebar points at real routes

/music/catalog is deleted rather than redirected -- the owner's explicit choice.
Nothing in the codebase linked to it except the sidebar, which moves in this
same commit, because this is the moment the product changes.

20b's query-matching branch goes with them. It existed only because those three
hrefs carried ?tab=, and the active-link test compares a pathname, which never
has a query string. Plain routes delete that defect rather than working around
it, and the nav journey now asserts the highlight 20b could not.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 6: The gates, the documentation, and the push

**Files:**
- Modify: whichever file under `docs/` describes the catalogue screen or its
  address — Step 1 finds it.

- [ ] **Step 1: Update the documentation that names the old screen**

```bash
grep -rln "music/catalog" docs/*.md
```

`docs/block-7a-runbook.md` is known to describe **Music → Catalog**, or
`/music/catalog`, as where genres and record labels live. That is now false.
Update what the search finds, in each document's own voice. Historical block
reports (`docs/block-*-report.md`) describe what was true when they were
written and are NOT updated — only living operator references are. If you are
unsure which a file is, say so in your report rather than guessing.

- [ ] **Step 2: Run every gate, in the order that works**

```bash
npm run typecheck
npm run lint
npm run test
npm run db:reset
npm run db:test
npm run seed:branding
npm run test:e2e
npm run test:isolation
```

`db:test` before the e2e and isolation suites, never after. Report the actual
output of any failure rather than re-running until it passes. On an incomplete
isolation run, re-run once from a clean database; if the same file drops out
twice, stop and report.

**Run the long suites in the FOREGROUND** with a generous tool timeout — a
backgrounded run gives you nothing to wait on and costs a round trip per glance.

- [ ] **Step 3: Commit the documentation**

```bash
git add docs/
git commit -F- <<'EOF'
docs(20c): the runbook stops sending operators to a screen that is gone

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

Skip entirely if Step 1 found nothing to change.

- [ ] **Step 4: Push**

```bash
git push
```

This adds to PR #65, open from this branch. Do not open a second one.

- [ ] **Step 5: Report**

State, in the final report:

1. A one-line result for each of the eight gates.
2. **That migration `0187` exists and must reach the hosted database with the
   deploy** — this project has shipped code ahead of its migrations three times.
3. Whether the isolation suite needed a re-run, and which file dropped out.
4. What documentation Step 1 found and what changed.
5. Whether anything the deleted `music-catalogue.spec.ts` proved is now
   uncovered.
