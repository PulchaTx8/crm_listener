# Block 20c — The catalogue stops being tabs

**Status:** design agreed with the owner, 2026-08-13.
**Last of three:** the owner's list of 2026-08-12 carries nine items. Block 20a
took 1 and 2 (the widget defects); Block 20b took 3, 4, 8 and 9 (the
navigation). This block takes **5, 6 and 7**, and finishes the list.

---

## 1. What this is for

Three of the owner's items are one change seen from three sides.

**Item 5** asked that Gravadoras, Gêneros and Álbuns stop being tabs of
`/music/catalog` and become entries of their own, and that the "Catálogo"
sub-item disappear. **Item 6** asked that the three screens follow the Músicas
screen — a filtered list with a Cadastrar button opening a popup. **Item 7**
asked that the album record carry a thumbnail.

Block 20b did the sidebar half and, in doing so, made the mistake this block
undoes. It pointed the three new entries at `/music/catalog?tab=labels` and
friends — addresses that already answered — so the navigation could be final
without building anything. The owner's ruling on 2026-08-13: *"o grande erro
cometido é não ter eliminado a tab"*. They were right. The tabs did not stop
existing; they were linked to from three places, and the query string cost a
defect a real route could not have had (20b's design, §2 D2 amendment).

So this block starts with the routes.

---

## 2. Decisions

The owner's, taken 2026-08-13.

**D1 — Three real routes, and the old address is deleted.**
`/catalog/labels`, `/catalog/genres`, `/catalog/albums`. **`/music/catalog`
ceases to exist and does not redirect** — the owner's explicit choice over a
redirect. Nothing in the codebase links to it except the sidebar, which moves
with it; an operator holding a bookmark gets a not-found page.

The three addresses leave `/music/` entirely, as the owner specified. Músicas,
Artistas and Manutenção keep `/music/songs`, `/music/artists` and
`/music/maintenance`: the owner named three addresses, the other three work, and
moving them would break links for no gain.

**D2 — Gravadoras and Gêneros are ONE screen, rendered twice.** The two records
are identical — a name and a legacy identifier, nothing else. The database
already says so: migration 0100 built a single trio of functions for four
identical tables, arguing in writing that twelve near-identical bodies would be
"twelve places for one fix to be applied to eleven". Two near-identical screens
would be the same mistake one layer up. One component, parameterised by kind;
each route is a thin page supplying its own kind, title and copy.

**D3 — Álbuns is its own screen.** Five columns against two, a record dialog with
four editable fields, and a picture. Sharing a component with the reference
screens would mean a component with two shapes, which is two components wearing
one name.

**D4 — The album's picture has two sources, in this order:** `thumb_url` if the
operator uploaded one; otherwise the Deezer cover via `cover_md5`; otherwise
nothing. An album registered from Deezer therefore arrives with a picture at no
cost, and an album typed by hand can be given one. The owner rejected both
single-source alternatives, and the reason holds: Deezer-only leaves hand-typed
albums permanently blank, upload-only makes an operator re-upload a cover the
system already has.

**D5 — One block, one PR.** The owner chose a single delivery over splitting the
reference screens from the album work.

**D6 — The record dialog offers what an operator can meaningfully type.** For an
album: **título, UPC, data de lançamento, imagem**. `deezer_album_id` and
`cover_md5` are written by the Deezer registration path and are not typed here —
they are facts about a third party's catalogue, not fields of this record.
`legacy_id` follows the rule the reference screens already record: setting one
is a create, not an edit.

---

## 3. The routes

```
/catalog/labels    Gravadoras
/catalog/genres    Gêneros
/catalog/albums    Álbuns
```

`src/app/(app)/music/catalog/` is deleted entirely — `page.tsx`,
`reference-tabs.tsx`, `reference-panel.tsx` and `actions.ts`. What survives of
it moves: `actions.ts`'s three server actions are the doors the new screens
still need, and `reference-panel.tsx`'s archive-confirmation dialog is the shape
the new screens' own archive follows.

The sidebar's three `href`s change from `?tab=` to these, in
`src/lib/auth/shell.ts`. **That deletes the highlight defect 20b's design
records** rather than working around it: with plain paths, the active-link test
is the same comparison every other item uses, and `sidebar-nav.tsx`'s
query-matching branch — added in 20b solely for these three — is removed with
them.

---

## 4. Gravadoras and Gêneros

One component, following the Artistas screen, which is the closest existing
model: a filtered list, a Cadastrar button, a record dialog, an archive
confirmation.

What differs from Artistas, and why it is less work than it looks: the record is
**one editable field**. So the dialog is a title, a name input, and the archive
button — no tabs, no related-records panel.

The filter is a name search. Paging follows the Songs and Artists pattern rather
than reading the list whole as the tabs did: a Station with two hundred genres
should not receive two hundred rows, and "the list is short today" is not a
property the code can rely on.

The write doors are unchanged: the `create/update/archive_music_reference` trio
already does exactly what these screens need.

**The read is a NEW function, and the existing one must not be touched.**
`listMusicReferences` returns a whole list, and `music/requests/page.tsx` calls
it to build the programme `<select>` on the song-request screen — a select needs
every option, so paging it would silently truncate a control whose whole purpose
is to offer the full set. The paged screens get `listMusicReferencesPage`
alongside it, following `listSongsPage`'s shape.

`listAlbums` looked like it would be in the opposite position: `music/catalog/page.tsx`
was its only known caller, and that file is deleted here. But "only one caller"
was a fact about today, not a guarantee — checking for callers before deleting
found a second one, `music/songs/page.tsx`'s album picker, which survives this
block. So `listAlbums` stays, unremoved, alongside the new `listAlbumsPage`.

---

## 5. Álbuns

Its own screen, same outward shape: filter, Cadastrar, record dialog, archive.

The grid shows the picture, the title, the release date and the UPC. The record
dialog edits título, UPC and data de lançamento, and carries the picture control
(§6).

**`update_album` must be widened, and this is where the block's one real trap
is.** Its signature is `update_album(p_album_id, p_title)` — **not** the
three-argument version 0137 created. Migration 0141 dropped the UPC parameter
deliberately, and its reasoning binds this block: on a one-field row *"an
omitted parameter is indistinguishable, to the RPC, from a cleared one"*. So
the widened door takes **all four arguments with no defaults** on `p_upc` and
`p_release_date` — a caller that omits one fails loudly instead of quietly
emptying a column. (`create_album` keeps its defaults: creating a record with
fields left blank is a real intention; updating one by accident is not.)

Widening means a new argument list, and in
PostgreSQL **`create or replace` does not change an argument list: it creates a
SECOND overload, and existing callers go on resolving to the old one, silently.**
This project has been caught by exactly that (Block 4b's memory records it, and
records that `::regprocedure` does not detect it either — it resolves the
signature you wrote and ignores the twins). The migration must therefore
`drop function` the old signature explicitly and prove the drop, not assume it.

---

## 6. The picture

**A new column** `albums.thumb_url`, matching `promotions.thumb_url` (0144),
`prizes` and `companies.thumb_url` (0153) and `shows.thumb_url` (0175).

**A new artwork slot,** `album-covers`, added in three places that must agree:

1. `ArtworkSlot` in `src/lib/storage/artwork-keys.ts`;
2. `may_write_artwork` (0143), whose own comment states the rule — *"An unknown
   prefix is refused rather than allowed. Adding a slot means adding it here,
   which is the point."* The permission is **`music.manage`**, the same one
   every other album door takes;
3. the upload path itself.

The key is `album-covers/<company_id>/<album_id>`, with the Station as the
**second** segment because `may_write_artwork` reads
`storage.foldername(name)[2]` and decides from the path alone. No file
extension, for the reason `artworkKey` already documents: an extensionless key
makes "uploading again replaces the last one" structural rather than hopeful,
and the consequence — every upload must set `contentType` explicitly — is
load-bearing and already carried by the services that call it.

The stored address carries the `?v=<epoch ms>` stamp `artworkUrl` already
appends, so a replaced picture is not served stale from the CDN.

**Rendering follows D4's order.** The existing `SongThumb` component draws a
Deezer cover from a `coverMd5` and is used on five screens; the album's picture
is a different question — two sources with a precedence — so it gets its own
small component rather than widening `SongThumb` into something that means two
things.

---

## 7. What this block does not touch

- **Músicas, Artistas and Manutenção.** Their routes, screens and records are
  unchanged.
- **The Deezer registration path.** It goes on writing `deezer_album_id` and
  `cover_md5`; this block only reads them.
- **`albums`' other columns.** `upc`, `release_date` and `legacy_id` already
  exist; only `thumb_url` is added.
- **The sidebar's structure.** 20b settled the items and their order. Only three
  `href`s change, and the query-matching branch that existed for them goes away.
- **Permissions.** Everything here is `music.view` to read and `music.manage` to
  write, exactly as the tabs were.

---

## 8. Verification

The eight gates in the order `portoes-e-banco-local-sujo` records: typecheck,
lint, unit, `db:reset`, `db:test`, `seed:branding`, e2e, isolation.

`db:test` carries the real weight here, because this block ships a migration:
pgTAP must prove the widened `update_album` writes what it is given, that the
**old signature is gone** rather than shadowed, and that `may_write_artwork`
answers true for an `album-covers` path under `music.manage` and false without
it — including for a caller who holds it in a different Station.

`tests/e2e/music-catalogue.spec.ts` drives the screens the tabs used to serve
and is rewritten with them. The journey worth keeping is the one that proves a
screen exists at its own address, registers a record through the popup, finds it
in the list, filters to it, and archives it.

One e2e assertion is this block's own: **the three sidebar items highlight**.
That is the defect 20b left, and a plain-path route is what fixes it, so the
proof belongs here.

---

## 9. After this block

The owner's nine items are finished. What remains open, recorded so it is not
lost:

- **A misconfigured promotion is invisible to its operator** (from 20a): a
  promotion whose question has no alternatives is withheld from the widget, and
  nothing on the operator's screen says so. Real, out of scope there and here.
- **The audience dashboard as the front door** (20b's withdrawn D6): wanted, and
  blocked on deciding what a member with no audience permission sees.
