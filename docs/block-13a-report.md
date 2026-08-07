# Block 13a — Deezer, Albums and Covers — Verification Report

**Branched from:** `main` (`c25380d`). **Six migrations, `0136`–`0141`.** PR base is `main`.

---

## 1. What shipped

The song dialogs have a **Deezer tab**. Filter by title, artist and album; play
the 30-second preview; click Register and the record fills in. One submit
writes the song **and the artist, the record label, the genre and the album it
needed**, in one transaction, into a Station that held none of them.

Songs typed by hand keep working exactly as before. Every column this block
adds is optional; the two ways of registering a song coexist permanently, which
was the requirement rather than a concession.

**Album covers reach six screens**: the Songs grid and record, the Requests list
and its song picker, the Artist record's songs tab, the Music dashboard's top
ten, and the merge panel — where telling two near-identical rows apart is the
whole purpose of the page.

`albums` is a new table. `songs` gained `album_id`, `deezer_track_id` and a
hand-editable `isrc`.

---

## 2. The API was chosen by measuring it, not by reading about it

The request named Spotify. Both APIs were queried live on 2026-08-07, and the
result changed the design:

| | Spotify | Deezer |
| --- | --- | --- |
| Credentials to search | client id + secret, OAuth token | **none** |
| ISRC | second call | **in the search result** |
| UPC / label / genre | second call / second call / absent in practice | **all three in the album** |
| Duration | milliseconds | **seconds** |
| 30-second preview | withdrawn for new apps | **URL in the search result** |

Deezer needing no credential is what **removed an entire sub-block** from this
design — a `station.settings` permission, an encrypted per-Station credentials
table and an AES module, all designed and then deleted (§9 of the spec). They
would have been exactly what `docs/PERMISSIONS.md §4` warns about: *"If nothing
reads a permission, it is not a permission, it is a comment in a table."*

### 2.1 Two Deezer behaviours that are written down because they cost time

**Errors arrive as HTTP 200.** `GET /track/999999999999` answers `200` with
`{"error":{"type":"DataException","code":800}}` in the body. `response.ok` is
true for a request that found nothing. Every call in `client.ts` inspects the
body **before** the status, and the test that pins it is named for the trap.

**Preview URLs are signed and expire.** They carry `hdnea=exp=…~hmac=…`, valid
for hours. Nothing may store one — it works in testing and is dead in
production the next day. That is stated on the field itself, where somebody
about to add a column for it will read it.

---

## 3. Four defects this block found in itself

Each was found by building the thing, not by reading the plan, and each is the
same defect the codebase has already paid for once.

**3.1 `update_song` needed DROP + CREATE, not CREATE OR REPLACE.** Two new
parameters change the signature, and a replace leaves Postgres holding **both
overloads** — every nine-argument caller silently resolving to the old body.
`0102`'s own header warns about this; the plan said `create or replace` anyway.
`0138` drops first, and `28_albums.test.sql` counts across every overload of the
name so a future replace cannot pass the check.

**3.2 `create_song` could not take the Deezer columns.** `0101` wraps its insert
in a handler that reports **every** `unique_violation` as a legacy-id collision
— true until `0138` added a second unique index. Reusing it would have reported
duplicate recordings as legacy-id errors: a precise-sounding message about the
wrong column. Hence a separate door, `0139`.

**3.3 The create form discarded what was typed into it.** `SongFields` is one
component shared by the create dialog and the edit form, deliberately. The
moment the album select and the ISRC input were added, the create dialog
rendered two controls that accepted input and threw it away, because
`create_song` had no parameter for either. `0140` adds them. The alternative —
hiding the fields on create — would have been the false affordance that
component's own `disabled` prop exists to avoid.

**3.4 `update_album` would have erased every UPC.** `0137` gave it a `p_upc`
defaulting to null, following the house convention that an update sets every
field on every call. The catalogue panel that edits albums is a **one-field
row**. Every rename would have called it with `p_upc` omitted, taking the SQL
default, and written it: the first rename of any Deezer-registered album would
silently have erased its UPC. This is `0102`'s legacy-id defect exactly, one
block later and one table over, and `0141` applies the same fix — remove the
write path rather than re-forward the value from a hidden field.

---

## 4. Two interface decisions that reversed during the build

**The album lookup moved from submit to the Register click.** The album is what
carries the record label and the genre. Looked up at submit time, those two
arrived *out of the write* — filled in by the system after the operator had
reviewed a form that never showed them. Resolved before the form opens, they
are ordinary fields: visible, editable, and whatever is left in them is what
gets written.

**Artist, label, genre and album are selects on the ordinary path and text
inputs on the Deezer path.** A select would have been a lie there: the artist
Deezer names very often does not exist in this Station yet, so there is no
option to select — and an operator who changed it would have watched the change
discarded, because the write goes by name. Two controls, two honest behaviours,
rather than one control meaning different things depending on how the dialog
was opened.

---

## 5. What the tests can and cannot see

**pgTAP: 1,436 across 30 files.** `28_albums.test.sql` adds 33, and states at
its own top what it structurally cannot see: it runs as superuser with a null
`auth.uid()`, so `has_permission` is false everywhere and the three public doors
answer 42501 before reaching their bodies.

**Isolation: 30 files, 299 cases, every file above its floor.**
`tests/isolation/deezer.test.ts` adds 11, and two of them prove things no
permission check could:

- **The orphan case is design D3 itself.** A blank title raises *after* the
  artist has been resolved and inserted. In one transaction that insert
  unwinds; from four round trips in Node it would not, and the Station would be
  left holding an artist nobody registered.
- **The duplicate case reads the constraint NAME** off the 23505, because
  `songs_deezer_live` is what the application tells apart from
  `songs_legacy_unique` to say which of the two happened.

One finding is written into that file where it will be read again: **a caller
holding `music.manage` alone can write a song and then cannot read it back.**
The select policies gate on `music.view`, a separate code. The first draft
granted `music.manage` only and read `null` from every read-back, which looked
like a broken RPC and was the schema behaving exactly as designed.

**Unit: 936 across 75 files.** Including the HTTP-200-error case, the cover URL
builder refusing anything that is not a 32-character hex hash, and the album
embed arriving null while `album_id` is still set.

**End to end: 48 of 48.** A new journey registers a song from Deezer into an
**empty** Station — no artist, no label, no genre, no album — and then links one
typed by hand. A spec that seeded an artist first would have passed over the
whole reason the door exists.

---

## 6. Three things found in the repository, not in this block

**6.1 The e2e suite could not pass locally, and it was the worker count.** A
full run failed 24 of 48, every failure sitting on `/login`. Two Supabase rate
limits were raised and **reverted on the evidence** — a probe ran 120
create-and-sign-in pairs with no ceiling — before the interleaved test numbers
showed Playwright running a dozen journeys at once against `next dev`, which
compiles each route on first request. At `--workers=1` the same suite passes 48
of 48. `playwright.config.ts` now sets `workers: isCI ? undefined : 1`, keeping
CI parallel because CI builds for production and has nothing left to compile.

**6.2 `15_music_rpcs.test.sql` passes or fails depending on what ran before
it.** It reads `select vocal from public.songs where title = 'Águas de Março'`
with no Station scope, and `music-catalogue.spec.ts` creates a song with that
exact title and leaves it behind. After a full e2e run the subquery returns more
than one row and the file dies mid-plan. **Not touched** — it is not this
block's file — but it will keep costing somebody the same confusing failure
until its read is scoped.

**6.3 The isolation suite's documented flake is real.** Its runner's header
records "six crashes in fifteen full runs" with no cause found. Observed again
here: three consecutive runs reported 29, 27 and 28 of 30 files with **zero
failures**, then a clean 30 of 30. `tests/isolation/deezer.test.ts` passed 3 of
3 on its own, 11 cases each time.

---

## 7. What was deliberately left out

**Album merging.** `0105` gives songs, artists, labels, genres and shows a
merge; albums do not get one. Recorded rather than left to be discovered.

**Bulk matching of the existing catalogue.** Covers reach old songs one at a
time, through the Link button. A background job guessing which Deezer track a
typed title means would write wrong covers at scale, silently.

**Nationality, vocal and internal code** are never filled from Deezer. It
carries none of the three, and Block 8's indicators count over the first two — a
guessed value produces a number that looks right and is not.

**Block 13b, the external player**, is not in this block. Its contract is in
§8 of the spec. One thing to verify there before anything depends on it: the CSP
carries `upgrade-insecure-requests`, which rewrites `http://` to `https://`.
Browsers exclude loopback addresses from that rewrite, but that needs proving
rather than assuming.

---

## 8. Verification

| | |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx next lint` | no warnings or errors |
| `npx vitest run` | 936 passed, 75 files |
| `supabase test db` | 1,436 passed, 30 files |
| `npm run test:isolation` | 299 passed, 30 files, every one accounted for |
| `npx playwright test` | 48 passed |

pgTAP must be run against a freshly reset database — see §6.2.
