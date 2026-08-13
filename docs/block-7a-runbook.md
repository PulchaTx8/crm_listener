# Block 7a — The Music Catalogue

**Audience:** whoever operates a Station, and whoever gets asked "why can't
I see the other Station's songs" or "why does this song show up twice?"

Before this block, a Station's music — its genres, record labels, artists,
shows and songs — had no home in this system. This block gives it one:
three screens where an operator registers, edits and archives the whole
acervo, one Station at a time.

---

## 1. Where it lives

**Catalog → Songs**, or `/music/songs` — every song a Station has registered,
with its artist, label, genre, duration and internal code. This is the
grid an operator opens to add a new song or fix one that was entered wrong.

**Catalog → Artists**, or `/music/artists` — every artist. Opening an
artist's record shows two tabs: the artist's own data, and every song
registered against them — the second tab is how you check "does this
artist already have songs in the catalogue?" before registering a new one.

**Catalog → Labels** (`/catalog/labels`) and **Catalog → Genres**
(`/catalog/genres`) — each its own screen now, not a tab of a shared page.
Block 20c retired the old tabbed `/music/catalog` screen entirely: it is
deleted, not redirected, so a bookmark or an old link to it now goes
nowhere. Labels and Genres are still name-and-nothing-else lists — a
filtered, paged table with a **Register** button that opens a popup to
create a row, and a click on any row's name reopens that same popup to
rename or archive it. There is no more inline, in-the-row editing. (Shows
left this group earlier still, in Block 18: a programme is now its own
record, reached from Audience, not a name in a list here.)

**Catalog → Albums** (`/catalog/albums`) — new in Block 20c. An album is
not a bare name: it carries a cover thumbnail (pulled from Deezer when the
album was matched there, or uploaded by hand otherwise) alongside its
title, so it gets the same filtered, paged grid Songs and Artists use,
Register button and popup included.

All of the above sit under the **Catalog** section in the sidebar (renamed
from "Music" in Block 20b), between Promotions and Templates. The section
is visible to every member, including someone holding no music permission
anywhere — opening any of these pages without `music.view` at the selected
Station redirects away. The link being visible is a courtesy; the actual
boundary is enforced twice over, underneath the screen, described next.

---

## 2. Which permission unlocks what

```sql
select code, module, label from public.permissions where module = 'music' order by display_order;
```

A healthy install returns exactly these four rows:

| code | module | label |
|---|---|---|
| `music.view` | music | See the music catalogue |
| `music.manage` | music | Register and edit the catalogue |
| `music.request` | music | Record a music request |
| `music.merge` | music | Merge duplicated records |

(Confirmed against this project's own local database while writing this
document — the query above returned exactly these four rows, in this
order.)

| Permission | Unlocks, today |
|---|---|
| `music.view` | Opens every screen listed in §1, read-only. Without it, none of them loads — a caller lacking it at every Station is redirected, and even holding it, a caller cannot read a Station's catalogue they hold nothing at. |
| `music.manage` | Register, edit and archive genres, labels, artists and songs, on their respective screens (§1). Every write is checked again inside the database, on every call — a role holding `music.manage` in the UI carries no more weight than the database is willing to honour. |
| `music.request` | **Does nothing yet.** The permission exists and can be assigned in a role today, at zero present capability — the door it will guard (recording a request by hand) is 7b's. Assigning it now costs nothing and grants nothing; a role that holds it will gain a real capability silently the day 7b ships, the same way this project has shipped a few permissions ahead of their door before. |
| `music.merge` | **Does nothing yet**, for the same reason — the merge itself, the one operation in this domain that actually destroys data (it folds duplicate records into one), is 7b's. It is kept as its own separate code on purpose: whoever can build a catalogue should not automatically acquire the power to collapse it. |

---

## 3. Why a Station cannot see another Station's catalogue

**This is deliberate, not a bug to report.** Every table in this domain —
genres, labels, artists, shows, songs, and the not-yet-active requests
table — belongs to exactly one Station. A group operating five Stations
keeps **five separate catalogues**, and registering "Caetano Veloso" once
at each of the five Stations is five rows, not a conflict.

This was the owner's own ruling for this block, against the alternative of
one catalogue shared across the whole group with access controlled per
Station. The consequence an operator will actually meet: an artist, a
song, a genre registered at Station A simply is not there when Station B
is selected — not hidden, not filtered, genuinely a separate row that does
not exist yet at Station B. If a listener requests the same song at two of
a group's Stations, that song has to be registered at both.

---

## 4. Why a duplicate song is allowed

Registering "Sozinho" by the same artist twice — a re-recording, a live
version, a remix, or simply the same operator entering it twice by
mistake — is **allowed**. Nothing on the Songs screen or underneath it
refuses a duplicate title by the same artist. This holds for genres,
labels, artists and shows too: nothing stops the same name being
registered more than once at a Station.

This is a deliberate trade, not an oversight: a real acervo genuinely
contains re-recordings and legitimate near-duplicates, and a system that
refused every duplicate on sight would refuse real music along with the
mistakes. The cure — a **merge**, which folds a duplicate into the record
it should have been all along — is **not in this screen**. It is 7b's own
door (guarded by the `music.merge` permission above), and it is the one
operation in this whole domain that actually deletes something.

**Until 7b ships, a duplicate stays a duplicate.** If you register the same
song twice by mistake today, the fix is to archive the one that should not
have been kept (§5 below covers when archiving is refused) — there is no
merge yet to fold the two together and keep both their histories.

---

## 5. Why an artist cannot be archived while songs name them

Archiving an artist who still has live songs registered against them is
refused, with a message naming the count:

> *"You cannot archive this artist yet — it still has other records
> registered against it. Move or archive them first."*

(The same sentence appears for a label, a genre or a show that a live song
still names — the message is shared across all four, so it never says
"songs" specifically, even when a song is the thing in the way.)

**What to do instead:** open the artist's record, go to the **Songs** tab,
and either re-assign each song to a different artist (editing the song
directly, on the Songs screen) or archive each song first. Once nothing
live points at the artist any more, archiving the artist succeeds.

This exists to protect the catalogue from a silent gap: a song naming an
artist that no longer exists would be an orphan reference nothing else in
this system checks for later. The refusal is enforced in the database, not
only on the screen — even an operator who could somehow bypass the Artists
screen entirely would meet the identical refusal calling the write
directly.

---

## 6. The legacy handle, and why it cannot be edited

Every genre, label, artist, show and song can carry a **legacy id** — a
short text handle that exists so Block 9's import can recognise a record
it has already brought in from the old system on a second run. On Artists,
and on the Labels and Genres screens' Register popup, the field is present
and can be typed into **when a record is first created** (this is mainly
for the import to use, but nothing stops an operator typing one by hand);
on Songs it is not offered at creation at all. On **every screen, once a
record exists, the legacy id can never be changed again** — it shows on the
record, read-only, and there is no path, on any screen, that writes a new
value into it.

**Why it is locked after creation:** this handle is the only thing that
stops a re-import from creating the same record twice. If it could be
edited or accidentally cleared after the fact, the next import run would no
longer recognise a record it had already brought in, and would create a
duplicate copy of it — and because nothing else about a record has to be
unique (§4 above), nothing would catch that duplicate happening. So the
handle is fixed the moment a record is created and never touched again by
any screen in this system. If a legacy id looks wrong, that is a question
for whoever runs the import, not something to fix from the catalogue
screens.

---

## 7. Refusals you may meet

| Message | Cause |
|---|---|
| *"a name is required"* | The name field was blank or only whitespace. |
| *"You cannot archive this [entity] yet — it still has other records registered against it. Move or archive them first."* | Something live still points at the record you tried to archive (§5). |
| *"a record with legacy id '...' already exists in this station"* | Two records are trying to carry the same legacy handle at the same Station — should only happen from the import, never from hand entry, since the legacy field is not editable through any screen (§6). |
| A generic "could not load" / "could not save" sentence, with no specific reason named | An unexpected fault, not a refusal — worth reporting rather than retrying blindly. |
| The page redirects away, or the screen never loads | `music.view` is missing for the selected Station — check the role assigned at that Station, not the account overall (§2, §3). |

---

## 8. What is not here yet

- **Requests.** A listener asking for a song by name has nowhere to be
  recorded yet — the table exists underneath, but no screen and no door
  write to it until 7b.
- **Merging duplicates.** Covered in §4 — the cure for a duplicate is 7b's.
- **An "archived" filter.** There is no way, on any of the screens in §1,
  to see a record that has been archived — an archived row is not merely
  hidden, it genuinely cannot be read back through any of these screens
  once archived, by design.
- **Searching songs by artist name.** The Songs screen's search box looks
  at the song's own title and internal code, not the artist's name — to
  find a song by its artist, open the Artists screen instead and use that
  artist's own Songs tab.
