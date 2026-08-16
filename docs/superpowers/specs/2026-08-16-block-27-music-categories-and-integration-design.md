# Block 27 — A category for a song, a card from the customer's own system, and a sidebar that folds

**Status:** design agreed with the owner, 2026-08-16.
**Scope:** the owner's list of 2026-08-16, eight items — a Categories screen
under Catalog, Programmes moved out of Audience, two sections reordered, a
Category field on a song, an Integration tab holding the renamed Integration
code plus three fields describing that song in the customer's own system, a JSON
file that fills those fields, and a button that folds the sidebar to a rail of
icons.
**Depends on:** Block 7a (`music_genres`, `record_labels`, `artists`, `shows`,
`songs`, the four `music.*` permissions, `music_reference_kind` and the trio of
doors in `0100`), Block 7b (the merge screen, which this block deliberately does
not extend), Block 13a (`create_song_from_deezer`, `link_song_to_deezer`, the
Deezer tab and the second entry in `SONG_TABS`), Block 15 (`songs.external_id`,
which this block must not be confused with — see D6), Block 18 (`/shows`, the
screen being moved), Block 20b (`SidebarNav`, the disclosure cookie and
`src/lib/nav/disclosure.ts`), Block 20c (`ReferenceScreen` and its two thin
pages, the vehicle for the new screen), Block 26 (`/inventory/categories`, the
screen the owner named as the pattern, and the nav ordering it established).

---

## 1. What this is for

Four jobs arrived in one list, and they stay four jobs.

**A song has no category.** It has a genre, a label, an album and an artist, and
the owner's stations file their acervo by something else as well — a
category, which is the word their own scheduling software uses. Today that word
lives in the operator's head. So it becomes a reference list per Station, with a
screen of its own, a field on the song, and a column and a filter on the list
where an operator would go looking for it.

**The sidebar has drifted from how the work reads.** Programmes is filed under
Audience, where Block 18 put it on the argument that a programme is made for
listeners. It is also, plainly, part of the catalogue — the thing a song is
played on — and the owner wants it beside the songs. Two sections get their
order settled at the same time.

**A station already has a music system, and the two do not speak.** Every
customer runs their own scheduling or automation software with its own song
list. Linking a PulchatX song to the record in that other system is done today
by an operator squinting at a code field called "Internal code" with no
indication of what it points at. The block gives the code a name that says what
it is, three fields that describe the far side of the link in words a person can
read, and a JSON file so those words do not have to be typed.

**The sidebar cannot be got out of the way.** 260 pixels of chrome on every
screen, and no way to reclaim them.

---

## 2. What already exists and is reused

Stated first, because the risk in a list like this is rebuilding what is built.

- **`ReferenceScreen` (Block 20c, `src/app/(app)/catalog/references/`) is the
  Categories screen.** It already carries the Station switcher, the URL-driven
  filter bar, keyset paging, the record-as-a-modal, the pencil column and the
  actions dropdown — everything the owner's item 1 asks for. `genres/page.tsx`
  and `labels/page.tsx` are the same file with a `KIND` and a `copy` object
  swapped; `categories/page.tsx` is a third. The screen is not designed again.
- **`music_reference_kind` and the trio of doors in `0100`** already register,
  rename and archive a named list, discriminated on a kind, with the table name
  resolved by `music_reference_table()`. A fifth kind costs an enum value, a
  branch in that function, a branch in `archive_music_reference`'s in-use count,
  and nothing else. See D1.
- **`SONG_TABS` (`src/lib/record-params.ts`) is already a tuple the dialog maps
  over.** Its own comment predicted a third entry costing "an entry and a label,
  not a rewrite", which is what the Integration tab costs.
- **`songs.internal_code` already exists**, unbounded `text`, no unique index,
  hand-editable, searched by the Songs list alongside the title. It is the
  Integration code. Nothing is migrated, nothing is renamed in the database.
  See D6.
- **The Deezer prefill is the model for the JSON import.** `DeezerPrefill`
  (`song-fields.tsx`) fills the form and writes nothing; the operator reviews
  and submits. The JSON import behaves identically, for the same reason. See D9.
- **`src/lib/nav/disclosure.ts`** already holds the sidebar's pure decisions and
  the pattern for a nav preference: a non-HttpOnly cookie, written by the client
  on the click, read on the SERVER inside `getShellContext` so the sidebar
  arrives in the right state instead of flashing after hydration. The collapse
  preference joins it. See D11.
- **`import-form.tsx` (Block 4c, participations)** is the precedent for a file
  the operator supplies: read in the browser, parsed there, validated against a
  schema, and never trusted — the write is a separate, gated step.
- **`music.view` and `music.manage`** are the permissions for everything here.
  No new permission is introduced, on the reasoning `0199` records for vendors
  and Block 18's §5 for `/shows`. See D3.

---

## 3. The navigation (items 2, 3, 4)

One file, `src/lib/auth/shell.ts`. No route changes, no file moves, no
redirects.

**Catalog** becomes, in order: Songs, Artists, Albums, **Categories**, Genres,
Record labels, **Programmes**, Maintenance.

**Audience** keeps Members and Requests.

**Inventory** becomes: Stock, Categories, **Vendors**, Movements — Vendors and
Movements swap.

Record labels was absent from the owner's written order and is not being
removed; the owner placed it after Genres when asked. Maintenance stays last for
the reason that file already records: it is the only destructive screen in the
section, and a sidebar is read top to bottom.

Three consequences the file's own rules force:

**Categories cannot wear `ICONS.tag`.** That glyph is Genres, which sits on the
adjacent row of this same section — the exact case the house rule forbids, since
one icon on two neighbouring rows reads as one link rendered twice. Inventory >
Categories keeps `tag` (its neighbours are `box`, `building` and `inbox`, and
the two sections never appear side by side, the same non-adjacency that already
lets `box` serve both Inventory and Pickups). Music > Categories gets a new
glyph: a folder, which is unused anywhere in `ICONS` and is the one shape in the
vocabulary that means *a thing you file others under*.

**Programmes keeps `ICONS.radio`.** In Audience it was chosen against the
section's other rows; in Catalog its only clash would be with `music` (Songs),
`users` (Artists), `disc` (Albums), `tag` (Genres), `building` (Record labels)
and `shield` (Maintenance), none of which it is. `radio`'s only other use is
Overview > My stations, a distant section.

**`activeSectionKey` changes its answer for `/shows`.** It resolves the owning
section by the longest matching href, so moving the item moves which heading
opens by itself when an operator is standing on that screen. That is the
intended behaviour and it is also an assertion in the navigation e2e suite,
which moves with it.

---

## 4. Music categories (items 1, 5)

### 4.1 The table and the doors

`music_categories` is `music_genres` with a different name: `organization_id`
and `company_id`, the composite foreign key against `companies (id,
organization_id)`, `unique (id, company_id)` so a child proves its Station in a
constraint, a name that cannot be blank, `legacy_id` unique per Station when
present, soft delete, and the `(company_id, name) where deleted_at is null`
index every list on this product opens on.

`music_reference_kind` gains `'CATEGORY'`; `music_reference_table()` gains the
branch mapping it to `music_categories`. `create_music_reference`,
`update_music_reference` and `archive_music_reference` then serve it with no
further change except one: `archive_music_reference`'s in-use count needs a
`CATEGORY` branch counting live songs whose `category_id` is this row.

That refusal is deliberate and is the opposite of what `archive_prize_category`
(`0202`) does to prizes wearing an archived label. The two differ because the
tables differ: `0202` detaches, because `prizes.category_id` has no other guard
and a prize left pointing at an unreadable row would render as uncategorised
anyway. Here the house already answered the question three times — ARTIST, LABEL
and GENRE are all refused while a live song names them — and a fourth reference
kind behaving differently from its three siblings inside the *same function*
would be the inconsistency, not the consistency. See D2.

RLS follows `0099` exactly: `enable row level security`, `revoke all from anon,
authenticated`, `grant select to authenticated`, and one policy —
`deleted_at is null and public.has_permission('music.view', company_id)`.

### 4.2 The screen

`ReferenceScreenKind` widens from `'LABEL' | 'GENRE'` to include `'CATEGORY'`;
`REFERENCE_SCREEN_PATHS` gains `/catalog/categories`; `REFERENCE_TABLES`
(`services/music.ts`) and `MUSIC_REFERENCE_KINDS` (`schemas/music.ts`) gain the
fifth entry. `catalog/categories/page.tsx` is `genres/page.tsx` with `KIND` and
`copy` swapped — twelve literal `t('key')` calls, one per copy field, which is
the shape `ReferenceScreenCopy`'s own comment demands so that the i18n usage
test can see them.

### 4.3 The field, the column and the filter

`songs.category_id uuid` nullable, with `foreign key (category_id, company_id)
references music_categories (id, company_id)` — the constraint that makes "no
Station can point at another's category" true in Postgres rather than in a
screen — and `songs_category_idx on songs (category_id) where deleted_at is
null`.

On the **Song data** tab, a `<select>` labelled Category directly below Genre,
with a "no category" empty option, exactly like Genre's.

On the **Deezer path** the select stays a select rather than becoming a
by-name text input like artist, label, genre and album. Those four are text
inputs because Deezer names them and the named thing very often does not exist
in this Station yet, so `create_song_from_deezer` resolves or creates by name.
Deezer carries no category at all, so there is no name to resolve and nothing to
create: the operator picks from this Station's own list, on both paths.
`create_song_from_deezer` gains `p_category_id`.

On the **Songs list**, a Category column beside Genre, and a Category filter in
the bar above it — `?category=<id>` parsed into `state.categoryId`, mirroring
`?genre=` in every particular including `hasActiveSongFilters`. Without them the
Categories screen would be a list nothing reads.

`create_song` and `update_song` gain `p_category_id`, set on every call like
every other column they take. Both are recreated from their **live**
definitions — `0140` for `create_song`, `0138` for `update_song`, `0139` for
`create_song_from_deezer` — never from `0101`, which is three fixes behind.

---

## 5. The Integration tab and the external record (item 6)

### 5.1 What the tab is

A third entry appended to `SONG_TABS`: `['data', 'deezer', 'integration']`.
Appended, never inserted — `data` must stay the tab an unknown `?tab=` falls
back to, and `PROMOTION_TABS`' own comment in that file records what inserting
once cost.

The tab shows four fields: **Integration code**, **Title**, **Artist**,
**Category**. The first belongs to the song. The other three belong to the
*card* — the record of that song in the customer's own system.

`Internal code` leaves the Song data tab and arrives here under the new label.

The create dialog has no tabs — the strip renders only once a record exists — so
it keeps the code field at the foot of its form under the same new label:
dropping it would remove a capability the screen has today. It does **not** gain
the three card fields. A song being registered has no record to open yet, and
the card is a separate row with its own door; it is filled from the Integration
tab afterwards. `SongFields` is shared between the two dialogs, so the Category
select from §4.3 does appear in both.

### 5.2 Where the three fields live

`song_integrations`, one row per song **in the customer's system**, per Station:

| column | meaning |
|---|---|
| `code` | the customer's own identifier — what `songs.internal_code` holds |
| `title` | how their system spells the title |
| `artist_name` | how their system spells the artist |
| `category_name` | how their system categorises it — free text, *not* `music_categories` |

`unique (company_id, code) where deleted_at is null`. Organization and company
columns, composite foreign key and RLS exactly as §4.1, gated on `music.view`.

`category_name` is text and not a foreign key into `music_categories`
deliberately: it is the other system's vocabulary, and forcing it into ours
would either refuse an import or silently invent categories nobody asked for.

The link is **by code, with no foreign key**: a song resolves its card by
`(company_id, internal_code)`. Several songs may carry the same code and resolve
the same card, which is what the owner described and is the whole reason the
three fields are not columns on `songs`. See D7 for why the link is loose.

`save_song_integration(p_company_id, p_code, p_title, p_artist, p_category)` is
the one door: `SECURITY DEFINER`, gated on `music.manage` checked before
anything is read, upsert on `(company_id, code)`, every field set on every call
in the house convention, lengths bounded in the body because the form's
`maxLength` is a courtesy a caller posting straight at the RPC never sees, and
an `audit_logs` row like every other write.

### 5.3 What the tab does

Reading a record already costs one query (`getSongRecordAction`). It gains two
more: the card for this song's code, and the count of live songs in this Station
carrying the same code.

That count is why the tab can be honest. Editing the three fields edits a shared
card, so the tab says so before the operator saves — *"this code is also used by
N other songs"* — and says nothing when N is zero. A screen that quietly
rewrites four other records is the defect this sentence exists to prevent.

A code with no card shows the three fields blank and a line saying no card is
registered for it. Saving them registers one.

---

## 6. The JSON import and its validation (item 7)

A button on the Integration tab opens a file picker. The file carries **one**
card — a bare object, or an array of exactly one element. More than one is
refused with a message naming how many were found.

**It fills the form and writes nothing.** The operator reviews and submits, and
the submit is the same `save_song_integration` a hand-typed edit uses. This is
the Deezer prefill's contract, adopted for the same reason: an import that
writes on open is an import the operator cannot decline.

The validation, item by item, because the owner asked for it explicitly:

1. **Size is checked before the file is read.** 64 KB, against `File.size`, so a
   two-gigabyte file never becomes a string in memory.
2. **`JSON.parse` inside `try`/`catch`.** A malformed file is a sentence on the
   screen, never an error boundary.
3. **A Zod schema in `src/schemas/music.ts`** — the four known keys and no
   others, each a string, each bounded to its column's own limit, `code`
   required and non-blank after trimming. Unknown keys are stripped, not
   accepted: an operator's file that carries thirty fields imports the four we
   asked for.
4. **`__proto__`, `constructor` and `prototype` are dropped explicitly** before
   validation, and the validated result is always a fresh object — never
   `Object.assign` onto anything that already exists. `JSON.parse` makes
   `__proto__` an own property rather than a prototype write, so this is defence
   in depth rather than the only guard; it is written down because "the parser
   happens to be safe" is not a thing to rely on silently.
5. **Control characters stripped, values trimmed**, so a pasted export cannot
   put a newline in the middle of a code.
6. **The same schema runs again inside the Server Action**, before the RPC. The
   browser check is convenience; a hand-crafted POST meets the identical
   validation, and then `save_song_integration` re-checks permission and lengths
   in its own body. The boundary is in the database, as everywhere else on this
   product.
7. **Nothing is rendered as HTML.** React escapes by default and no part of this
   path uses `dangerouslySetInnerHTML`.
8. **The file is never uploaded and never stored.** It is read in the browser
   with `File.text()` and discarded.

`accept=".json,application/json"` is a hint to the file picker and is treated as
one — the content decides, not the extension.

---

## 7. The collapsible sidebar (item 8)

**The button goes at the top**, in the brand row, and the reason is mechanical
rather than aesthetic. The footer already carries an avatar, a name, a role, a
settings gear and a sign-out form inside 260 pixels; when the rail narrows, that
footer must itself become a stack of icons. A control whose home disappears in
the state it produces is in the wrong place.

Expanded (`w-[260px]`, unchanged): mark and wordmark on the left, toggle on the
right.

Collapsed (`w-[72px]`): the mark centred with the toggle beneath it; section
heading buttons hidden; every item rendered as its icon alone, centred, with
`aria-label` and `title` carrying the label it no longer shows; a hairline rule
between one section's icons and the next. Every destination stays one click
away, which is the point of a rail. The footer becomes avatar, gear and sign-out
stacked and centred.

The disclosure state is untouched — collapsing is a different question from
which sections are open, and expanding restores exactly what was open before.

Persistence is a cookie, `pulchatx_nav_collapsed`, on the same terms as
`NAV_COOKIE`: not HttpOnly, written by the client on the click so folding costs
no round trip, carrying no identity and no secret, and **read on the server** in
`getShellContext` and passed down beside `expandedSections`. Read in the browser
instead, the sidebar would arrive at full width and snap narrow after
hydration — a flash on every navigation, on every screen. The parse lives in
`src/lib/nav/disclosure.ts` for the reason that module exists: the sidebar is a
client component and this repository has no component-testing library, so a
decision left inside `sidebar-nav.tsx` is checked by a browser or by nothing.

The mobile header below `md` is unaffected: the sidebar is already hidden there.

---

## 8. Migrations, in order

**`0204_music_category_kind.sql`** — `alter type public.music_reference_kind add
value 'CATEGORY';` and its comment, and **nothing else**. Postgres refuses to
use a new enum value in the transaction that adds it, and Supabase runs each
migration file in its own transaction. `0082` and `0091` both paid for this
already.

**`0205_music_categories.sql`** — the `music_categories` table, its indexes and
constraints, RLS and grant per `0099`; `songs.category_id` with its composite
foreign key and index; `music_reference_table()` recreated with the CATEGORY
branch; `archive_music_reference` recreated with the CATEGORY in-use count.

**`0206_song_category_doors.sql`** — `create_song`, `update_song` and
`create_song_from_deezer` recreated with `p_category_id`, **each copied forward
from its live definition** (`0140`, `0138`, `0139` respectively). Recreating
from `0101` would silently revert `0102`'s removal of `p_legacy_id`, `0138`'s
ISRC and Deezer columns and `0140`'s album handling — a failure this project has
made once and written down.

**`0207_song_integrations.sql`** — the table, its indexes, RLS and grant, and
`save_song_integration`.

`npm run db:types` is regenerated afterwards, and the regenerated file is part
of the same commit as the migration that changed the schema — not a later
tidy-up.

---

## 9. Decisions

**D1 — A category is a fifth `music_reference_kind`, not a new mechanism.** The
alternative was a bespoke table with its own three RPCs, which is what
`prize_categories` has. Rejected because `0100` exists precisely to stop that:
four tables with identical columns behind one trio of doors, so one fix is
applied in one place. A fifth costs an enum value and two branches.

**D2 — Archiving a category in use is refused, not detached.** Its three
siblings inside the same function refuse; a fourth that detached would make
`archive_music_reference` mean two different things depending on an argument.
`0202` detaches for prizes and that stays right there, for the reason that file
gives.

**D3 — No new permission.** `music.view` reads and `music.manage` writes,
everywhere in this block including the Integration tab and the JSON import. A
`categories.*` or `integration.*` pair would be a permissions migration plus
every role every customer has already configured, none of which would grant it —
so the feature would ship hidden from everyone.

**D4 — The Categories screen is `ReferenceScreen`, not a new one.** The owner
asked for "the pattern of the other screens", and this is literally that
component. A second layout for the same job is a second thing to maintain.

**D5 — Category appears as a column and a filter on the Songs list.** The
owner's items 1 and 5 asked only for the screen and the field. Without the
column and the filter the screen would be a list that changes nothing an
operator can see, which is the shape Block 26 named as the reason
`/inventory/categories` had to exist at all.

**D6 — The Integration code is `songs.internal_code`; the column is not
renamed.** `songs.external_id` already exists and means something else — Block
15's API-intake key, unique per Station, belonging to whichever system POSTs to
us. Two columns whose names both say "external" is a misreading waiting to
happen, and renaming `internal_code` would ripple through `0101`, `0138`,
`0140`, `0150`, `0152`, the intake API, the services layer and the Songs search
for a label change. The column keeps its name and gains a comment saying what it
is called on screen and why.

**D7 — The card is linked by code, with no foreign key.** A hard reference would
refuse to save every song that already carries an `internal_code` with no card
behind it — which is all of them, today. A code with no card is a legitimate,
permanent state and renders as one.

**D8 — Three fields on a shared card, not three columns on the song.** The owner
stated that several PulchatX songs may point at one song in their system.
Columns on `songs` would store that description once per song and let the copies
drift; a card keyed by code stores it once. The cost is that editing it changes
what four other songs display, which is why §5.3 makes the tab say so.

**D9 — The JSON fills the form and does not write.** Same contract as the Deezer
prefill, and the reason is the same: the operator has to be able to look at what
arrived and decline it.

**D10 — One card per file.** The owner chose this over a bulk load. The schema
does not depend on the choice: `song_integrations` is keyed by code, so the day
a bulk import is wanted it is a second action over the same table and the same
validation, with no migration.

**D11 — The collapse preference is a server-read cookie.** Identical reasoning
to `expandedSections` (Block 20b, D5), and the same file holds the parse.

**D12 — Collapsed shows every item as an icon, not one icon per section with a
flyout.** The owner asked for "apenas os ícones dos menus", which is the flat
rail. A flyout is a popover with positioning and keyboard handling to get right,
and it hides destinations behind a hover — the opposite of what a rail is for.

---

## 10. Testing

**pgTAP (`npm run db:test`)** — `music_categories` exists with its constraints,
RLS enabled, the grant and the policy present; `music_reference_kind` carries
the CATEGORY label; `songs.category_id` and its composite foreign key; the four
`music.*` permissions unchanged; `song_integrations` and its unique index;
`save_song_integration` present, `SECURITY DEFINER`, and executable by
`authenticated` and not by `public`.

`music_reference_table()`'s CATEGORY branch is deliberately *not* asserted
here — `0100` grants EXECUTE on it to nobody, and the pgTAP session is not a
superuser, a limitation Block 7a already hit and recorded. It is exercised
through `create_music_reference` in the isolation suite instead, which is the
only way any caller reaches it anyway.

**Isolation (`npm run test:isolation`)** — the boundaries pgTAP cannot see,
because a policy written `using (true)` satisfies "a policy exists":
`create_music_reference` for a CATEGORY at a Station the caller holds nothing in
answers 42501; `archive_music_reference` refuses a category a live song wears
with 23503, and succeeds once the song is moved off it; a category from Station
A cannot be attached to a song in Station B (Postgres refuses at the composite
foreign key, before any RPC gets a say); `save_song_integration` answers 42501
without `music.manage` and upserts rather than duplicating on a second call with
the same code; `song_integrations` rows of another Station are invisible.
Any new file in this suite joins the manifest in
`scripts/verify-isolation-suite.mjs`, with its case floor — a file that is not
listed can stop running and the gate will still pass.

**Unit (`npm run test`)** — the JSON schema against a valid file, a malformed
one, an array of three, an object carrying `__proto__`, an over-long field, a
blank code, and a file of unknown keys; the collapse-cookie parse against
absent, `'1'`, `'0'` and rubbish; `activeSectionKey` against `/shows` now that
it belongs to Catalog; the i18n usage and parity tests over the new keys in all
three locales.

**e2e (`npm run test:e2e`)** — register a category, see it in the Song data
select, save a song with it, see it in the Songs column, filter by it, then try
to archive it and be refused; open a song's Integration tab, import a JSON file,
save, reopen and read it back; collapse the sidebar, reload, find it still
collapsed, expand it and find the same sections open as before.

Gate order: `lint`, `typecheck`, `test`, then `db:reset` before `db:test`, then
`test:isolation`, then `test:e2e`. The reset before `db:test` is not optional —
a local database left dirty by an e2e run produces two red gates that are not
code.

---

## 11. Out of scope, stated rather than discovered

- **Category does not join the merge screen.** `music_merge_kind` stays at four
  (SONG, ARTIST, LABEL, GENRE). Adding a fifth is a core branch and a screen
  option, and whether duplicate categories are a real problem is not yet known.
- **`song_integrations` has no screen and no delete door.** A card whose code no
  song carries is unreachable and harmless. If the cards ever need listing, the
  table is already shaped for `ReferenceScreen`'s treatment.
- **No bulk JSON import** (D10).
- **No lookup against the customer's system over HTTP.** The link is a file the
  customer exports, not an API we call.
- **`prize_categories` is not merged with `music_categories`.** They are
  different words in different domains that happen to be spelled alike; one
  table would tie an inventory label to a music permission.

---

## 12. Delivery

One branch, `block-27-music-categories-and-integration`, one PR, in the rhythm
Block 24 used for its eight items. Commits are per task, not per file.
