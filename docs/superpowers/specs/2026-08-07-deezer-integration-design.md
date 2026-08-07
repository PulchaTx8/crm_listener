# Block 13 — Deezer, albums, covers, and the external player

**Date:** 2026-08-07
**Status:** approved
**Blocks:** 13a (Deezer, albums and covers), 13b (the external player)

---

## 1. What this is for

A song reaches the catalogue by hand today: somebody types a title, picks an
artist, and the record carries nothing an outside system could recognise it by.
Two consequences the owner asked to close on 2026-08-07:

- **No cover art anywhere.** Every screen that names a song shows text alone.
- **No link to the recording.** Nothing ties a row in `songs` to the actual
  media, so a title typed twice with different spellings is two records with no
  way to tell they are one song.

This block adds a **Deezer** tab to the song dialogs — search by title, artist
and album; register with one click — and carries the cover through every screen
that mentions a song. A second, smaller block lets the operator play the local
audio file for a song through a program running on their own machine.

**Songs typed by hand keep working exactly as they do now.** Every column this
block adds is optional. The two ways of registering a song coexist; that was a
requirement, not an accident.

---

## 2. Why Deezer and not Spotify

The request named Spotify. It was changed to Deezer mid-design, and the
verification behind the change is worth keeping, because it decided several
things below. Both APIs were queried live on 2026-08-07:

| | Spotify | Deezer |
| --- | --- | --- |
| Credentials to search the catalogue | client id + secret, OAuth token | **none** |
| ISRC | second call (`/tracks/{id}`) | **in the search result** |
| UPC | second call | in the album |
| Record label | second call | in the album |
| Genre | artist only, usually empty | **in the album** |
| Duration | milliseconds | **seconds** |
| 30-second preview | withdrawn for new apps | **URL in the search result** |
| Rate limit | per `client_id`, undocumented | per **IP**, 50 requests / 5s |

Deezer needs no credential for search, track and album — this was proven by
calling it, not assumed. That single fact removed an entire sub-block from this
design (§9).

### 2.1 Two Deezer behaviours that will cause bugs if forgotten

**Errors arrive as HTTP 200.** `GET /track/999999999999` answers `200` with
`{"error":{"type":"DataException","message":"no data","code":800}}` in the body.
Code that trusts `response.ok` treats a failure as a success. The client MUST
parse the body and check for `error` before anything else, on every call.

**Preview URLs are signed and expire.** A preview comes back as
`https://cdnt-preview.dzcdn.net/api/1/1/…mp3?hdnea=exp=1786109053~acl=…~hmac=…`
— a validity stamp measured in hours. **It must never be stored.** It is usable
only live, in the search results the operator is looking at. This closes the
door on a Deezer play button on the song record; it costs nothing, because the
30-second preview was only ever asked for in the search window.

---

## 3. Decisions

Every one of these was decided by the owner on 2026-08-07. They are recorded
with their reasons because several reverse an earlier position, and a reader who
finds only the conclusion will re-open the question.

**D1 — The artist is created if it does not exist.** `songs.artist_id` is NOT
NULL and `artists` is per Station, so a Deezer track whose artist is not in this
Station's catalogue cannot be saved at all. Registering resolves the artist by
name (case- and accent-insensitive) and creates it when absent. Without this,
most imports stop halfway and the tab is not worth having.

**D2 — Label, genre and album are created the same way.** Deezer supplies all
three, so all three follow D1's rule. (Under Spotify this was decided the other
way for genre, because Spotify has no usable genre. Deezer does; the decision
was revisited on that new fact.)

**D3 — Resolve-or-create is atomic with the insert.** All four references and
the song are written inside one RPC, in one transaction. A song that fails after
its references were created would leave up to four orphan rows in the Station's
catalogue with nothing to explain them.

**D4 — The cover is stored as `cover_md5`, not as a URL.** Deezer returns
`md5_image`; every size is built from it
(`https://cdn-images.dzcdn.net/images/cover/{md5}/{W}x{H}-000000-80-0-0.jpg`).
Storing the hash means a CDN host change is a one-line code fix rather than a
migration over data, and it removes the need for a check constraint pinning a
URL — a column whose value goes straight into `<img src>` is otherwise a vector.

**D5 — The cover belongs to the album, not to the song.** One join, one row per
album, no duplication. A song with no album shows a music-note icon.

**D6 — `deezer_track_id` is read-only in the interface.** It appears on the
record and cannot be typed. Code and cover travel together, and a hand-typed
code would leave the cover pointing at another album with nothing noticing. The
enforcement is **the absence of a write path**, not a field with no `name`
attribute: `update_song` gains no parameter for it. `0102` already paid for this
lesson once with `legacy_id`.

**D7 — `isrc` and `album` ARE hand-editable.** Not every song comes from Deezer,
and the ISRC is the code the radio industry actually uses. Both go through
`update_song` normally.

**D8 — No unique constraint on `isrc`.** It is hand-editable (D7), and a unique
index would turn a typo into a locked door. The duplicate guard lives on
`deezer_track_id`, which no human types.

**D9 — Duplicates are refused in the database and announced in the interface.**
A partial unique index on `(company_id, deezer_track_id)` refuses the second
write even from two tabs open at once; the search results mark an already-
registered track with a link to its record instead of a register button.

**D10 — The Deezer tab exists in both dialogs.** Registering *and* editing. On
the edit dialog the button reads "Link" and writes only code, cover and album,
leaving typed fields alone. Without it the existing catalogue — and everything
Block 9's import will bring — never gets a cover, and every screen ends up half
illustrated.

**D11 — PulchaTX has no player of its own for local files.** A single button
sends a command to an external program on the operator's machine; play, stop and
progress belong to that program. This reverses an earlier request for a progress
bar on the song record, on the owner's instruction of 2026-08-07.

**D12 — The player port lives on `profiles`, like the interface language.** The
external program runs on the operator's machine, so its port is a property of
the person, not of the Station. It follows `0135`'s pattern exactly, including
the column-scoped grant. Disclosed limitation: one person using two machines
with different ports has a single value, exactly as they have a single language.

**D13 — Album merging is out of scope.** `0105` gives songs, artists, labels,
genres and shows a merge; albums do not get one in this block. Recorded as a
known door rather than left to be discovered.

**D14 — No bulk matching of the existing catalogue.** Covers reach old songs one
at a time, through D10's Link button. A background job that guesses which Deezer
track a typed title means would write wrong covers at scale, silently.

**D15 — Nationality, vocal and internal code are never filled from Deezer.**
Deezer carries none of the three. They stay blank for the operator to decide.

---

## 4. Data model

### 4.1 `albums` — new, per Station

Same shape as `artists`: `organization_id` + `company_id`, the composite foreign
key against `companies (id, organization_id)`, and the unique `(id, company_id)`
pair so `songs` proves its Station in a constraint rather than a trigger.

| column | notes |
| --- | --- |
| `title` | not blank |
| `upc` | optional, `^[0-9]{12,14}$` |
| `deezer_album_id` | optional, `bigint` — Deezer ids are numbers |
| `cover_md5` | optional, D4 |
| `release_date` | optional |
| `legacy_id` | Block 9's ETL handle, as every reference table has |

`unique (company_id, deezer_album_id) where deleted_at is null and
deezer_album_id is not null` — partial, in the shape `0057` established, so
archiving and re-registering stays possible.

### 4.2 `songs` — four new columns

| column | notes |
| --- | --- |
| `album_id` | composite FK `(album_id, company_id) → albums (id, company_id)` |
| `deezer_track_id` | `bigint`, read-only in the interface (D6) |
| `isrc` | hand-editable (D7), `^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$` |
| `audio_filename` | Block 13b — the name typed for the external player |

`unique (company_id, deezer_track_id) where deleted_at is null and
deezer_track_id is not null` (D9).

### 4.3 Doors

- `create_song_from_deezer(...)` — D3's atomic resolve-or-create for artist,
  label, genre and album, then the insert.
- `link_song_to_deezer(...)` / `unlink_song_from_deezer(...)` — D6's only write
  path for the code and the cover.
- `update_song` gains `p_album_id` and `p_isrc`. It gains **nothing** for
  `deezer_track_id` (D6).
- `create_album` / `update_album` / `archive_album`, matching the trio `0100`
  gives the other reference lists.

Reference locking (`0103`) must be honoured by the resolve-or-create path: that
migration exists to close the window where a song is written naming an artist
another transaction is archiving.

---

## 5. What Deezer fills in

| Field on the record | Source |
| --- | --- |
| Title | `track.title` — the full title, so "(Ao Vivo)" survives |
| Artist | `track.artist.name` → resolved or created (D1) |
| Album | `track.album.title` + `upc`, `cover_md5`, `deezer_album_id` |
| Record label | `album.label` → resolved or created (D2) |
| Genre | `album.genres.data[0].name` → resolved or created (D2) |
| Duration | `track.duration` — already in seconds |
| ISRC | `track.isrc` — present in the search result |
| Deezer code | `track.id` |
| Nationality, vocal, internal code | **blank** (D15) |

One extra call, `GET /album/{id}`, on the register click only — never per search
result. It is what carries UPC, label and genre.

---

## 6. The integration layer

`src/lib/integrations/deezer/`, in the shape `whatsapp/` already uses: a
`DeezerTransport` interface, a real implementation and a `fake.ts`, so CI proves
the whole block with no network.

- **Search:** `GET /search` with `track:"…" artist:"…" album:"…"`. All three
  filters empty searches nothing — the tab asks for at least one.
- **Error rule:** parse the body and check `error` before `response.ok` (§2.1).
- **Our own rate limiter first.** Deezer's limit is per IP, and every Station
  shares this server's IP — so per-Station credentials would have bought no
  isolation even if Deezer had credentials. `InMemoryRateLimiter`, keyed by
  Station and person, is what keeps one radio from starving another.
- **Four distinct failure messages:** rate limited (ours), quota exceeded
  (theirs, `code: 4`), not found (`code: 800`), and network failure. "It didn't
  work" sends the operator to support; these four say what to do.

---

## 7. Screens

**The Deezer tab**, in both dialogs (D10). Three filters, results showing cover,
title, artist, album and duration, each with the 30-second preview (one playing
at a time) and a button: **Register** (fills the record tab and returns to it,
saving nothing until the operator submits), **Link** on the edit dialog, or
**Already registered** with a link to the existing record (D9).

When the artist, label, genre or album do not yet exist, the filled record says
so before saving — "The artist *Caetano Veloso* will be created".

**Albums** get a fourth tab on the Catalogue screen, beside Labels, Genres and
Shows, over the same reference panel: rename and archive, with UPC and cover
shown but not typed. Without it a name Deezer supplied is permanent, since the
register path is the only other way one is ever created.

**The cover**, through one `SongThumb` component, on: the Songs grid, the song
record, the Requests grid and its song picker, the Artist record's songs tab,
the Music dashboard's top list, and the merge panel in Maintenance — where
telling two near-identical rows apart is the entire purpose of the screen. The
dashboard costs the most: `0119`'s aggregate returns title and count today and
must carry the cover hash.

**Content Security Policy** (`src/lib/security/csp.ts`), and the Block 11b test
that pins it:

- `img-src` += `https://cdn-images.dzcdn.net`
- `media-src 'self' https://*.dzcdn.net` — a **new directive**; without it media
  falls back to `default-src 'self'` and every preview is blocked. The wildcard
  is deliberate: Deezer's preview host has moved between `cdns-preview-N` and
  `cdnt-preview` over time.
- `connect-src` += `http://localhost:* http://127.0.0.1:*` (Block 13b). A port
  wildcard rather than a number, because the port is per-person (D12) and the
  CSP is built in middleware, which cannot afford a database read per request to
  learn it. The cost is that the page may open a connection to any port on the
  operator's own machine; the page is ours and the machine is theirs.

**Language.** Every new string is a catalogue key in the three locales Block 12c
left. No translator in a module body — that took a whole route down once.

---

## 8. Block 13b — the external player

A single Go executable the radio runs on its own machine. It owns its folders,
its own play/stop controls, and the resolution from a filename to a path.
PulchaTX only names the file.

```
GET  http://localhost:<port>/health   → {"ok":true,"version":"1.0.0"}
POST http://localhost:<port>/play     ← {"songfile":"The River.mp3"}
                                      → {"ok":true} | {"ok":false,"error":"not_found"}
POST http://localhost:<port>/stop
```

- `/health` is what makes the button appear only when the player is running,
  instead of failing on click. `not_found` is how a mistyped filename reveals
  itself without going to air.
- **CORS with preflight.** A JSON POST is not a simple request; without an
  `OPTIONS` handler and `Access-Control-Allow-Origin` the browser refuses before
  anything leaves.
- **`127.0.0.1` only, never `0.0.0.0`.** A local HTTP server is an attack
  surface on the operator's machine. Because the program plays audio rather than
  serving file contents to the page, the worst a hostile page can do is make the
  speakers play — which is why no pairing token is required here; it would have
  been mandatory in the design where the browser read the files.
- **An HTTPS page may talk to `http://localhost`.** Browsers treat `localhost`
  and `127.0.0.1` as potentially trustworthy, so mixed-content blocking does not
  apply. This is the stone this approach usually breaks on, and it does not
  break here. Safari is stricter; Chrome and Edge — a Windows radio station's
  browsers — work.

In PulchaTX: `songs.audio_filename` and its field on the record;
`profiles.player_port` following `0135` (nullable — unset means no button —
with a column-scoped `grant update`, and the action reading the row back because
RLS refuses in silence); a port field beside the language selector; and a
**Play** button on the song record, the songs list and the requests list.

---

## 9. What was designed and then removed

An earlier version of this design carried a third block: a `station.settings`
permission, an encrypted per-Station credentials table, an AES-256-GCM module,
and a configuration popup on the Station card. Two later decisions emptied it —
Deezer needs no credentials, and the music folder moved into the external
program. Building it anyway would have produced exactly what
`docs/PERMISSIONS.md §4` warns about: *"If nothing reads a permission, it is not
a permission, it is a comment in a table."* It is deferred until a real
integration needs a key, when it can arrive with the isolation test that proves
it.

---

## 10. How it is proved

- **pgTAP:** the new columns, both partial unique indexes, the format checks, and
  every new door.
- **Isolation, separately** — pgTAP runs as superuser with a null `auth.uid()`
  and cannot see a permission failure. Own tests: a caller without `music.manage`
  is refused by the Deezer register path; a song, album or cover belonging to
  another Station is unreachable.
- **Unit:** the search query builder, the track→record mapping, the cover URL
  builder, the four failure messages, and — named explicitly because it is the
  one that will be forgotten — **a Deezer error body arriving with HTTP 200**.
- **End to end**, over `fake.ts`: search, register, and the new song appearing in
  the list with its cover; and linking an old song.
- Block 13b: the executable's own tests, plus a PulchaTX test that the Play
  button stays hidden when `/health` does not answer.

## 11. Risks, stated rather than discovered

1. **Deezer's rate limit is per IP and shared by every Station.** Our own
   limiter is the only isolation available. If the platform grows past it, the
   answer is caching search results, not more credentials.
2. **Preview URLs expire** (§2.1). Anyone who later tries to store one will get
   a link that works in testing and is dead in production a day later.
3. **Deezer's genres are coarse and in English** ("Pop", "Rock"). They land
   beside whatever the radio already uses in Portuguese. The operator can change
   the genre before saving; nobody is stopped.
4. **Album covers can disappear** from the CDN. The music-note fallback already
   covers it.
5. **The external player is a second product** with its own release, its own
   Windows support burden, and a version skew to manage against the contract in
   §8.
