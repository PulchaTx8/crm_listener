# Block 7 — Music: the catalogue, the requests, and the first merge — Design Spec

**Date:** 2026-08-03
**Status:** approved by the owner
**Amends:** the master spec (`docs/superpowers/specs/2026-07-25-crm-radios-multitenant-design.md`) — §11's Block 7 loses the dashboard to Block 8 and the migration to Block 9; a WhatsApp music-request block is recorded that §11 never named
**Depends on:** Block 1c (per-Company roles), Block 3 (members — a request names one)

---

## 1. What this block is for

§4.2 calls the Music domain a **gap**: it is absent from §22 of the original
spec and must be modelled from scratch (decision D3). Nothing music-related
exists in this codebase today — no migration, no service, no screen.

This block builds the Station's music catalogue, the record of what listeners
asked for, and the first merge mechanism this codebase has ever had.

**It does not build the Music dashboard** (Block 8) or the legacy migration
(Block 9). See §8.

---

## 2. Decisions

### D1 — Every table is per Station, exactly as §4.2 says

All six carry `organization_id` **and** `company_id`. A group with five Stations
maintains five catalogues, and registers "Caetano Veloso" five times.

The alternative considered and rejected was the Block 3 shape — the catalogue
shared across the Organization, access per Station — on the grounds that an
artist is a fact about the world rather than about a Station. The owner ruled
for isolation on 2026-08-03: no Station sees or edits another's catalogue, and
there is no argument about who may edit a shared artist.

**Consequence:** every uniqueness is scoped by `company_id`, there is no
cross-Station dedup to write, and this block is shaped like Block 2 (inventory,
per Station) rather than Block 3 (members, org-shared with dedup). The ETL of
Block 9 replicates the same acervo once per Station.

### D2 — A duplicate song is allowed, and fixed afterwards

No unique index on `songs`. The same title by the same artist may be registered
twice, and the maintenance screen merges them.

Rejected: `unique (company_id, artist_id, normalised title)`. It prevents the
duplicate at the source and costs the model its honesty — a re-recording, a
live version and a remix are the same artist and title, and the ETL would meet
that wall while importing a real acervo.

Also rejected: allowing duplicates and only archiving them. Archiving leaves
the requests pointing at the archived row, so Block 8's "most requested" keeps
counting a split history until somebody notices.

### D3 — Merging moves the children, and covers all four catalogue entities

Songs, artists, record labels and genres all merge. Genres and labels are short
lists chosen from a select and duplicate rarely, but a duplicated genre splits
Block 8's "most requested category" exactly as a duplicated song splits "most
requested", and there was no reason to leave one of the four without a cure.

| door | what migrates to the winner |
|---|---|
| `merge_songs` | `music_requests.song_id` |
| `merge_artists` | `songs.artist_id` |
| `merge_record_labels` | `songs.label_id` |
| `merge_music_genres` | `songs.genre_id` |

**This is the first merge in this codebase.** A listener merge was ruled for on
2026-08-01 (a maintenance screen under the Audience menu) and never built. What
this block chooses is the shape that merge will inherit — it moves
participations, winners and documents, which is more delicate than music but is
the same act.

### D4 — Merging takes many losers at once, and is atomic

`merge_songs(p_winner_id, p_loser_ids uuid[], p_reason)`. The operator filters,
selects the duplicates, sends them to a staging area and names the one that
stays. Three duplicates are one operation, not two.

All of it in one transaction: either every loser migrates or none does. This is
deliberately the opposite of Block 6d's sweep, which commits per winner —
there, an unattended sweep must not let one bad row stop every Station; here,
one operator pressed one button, and half a merge is worse than none.

### D5 — A request names a listener, and it has no state

`member_id` is **required**. Every request belongs to a registered listener, so
the manual-entry form has to find or create one, reusing Block 3's machinery.

`song_id` is required too: a request points at a catalogued song, never at free
text. `show_id` is optional — not every request arrives inside a programme.

There is **no status column**. A request is a historical fact: this person asked
for this song on this day. The screen lists and filters and carries no action,
like Block 6d's Movements screen. `deleted_at` exists only so a mistyped manual
entry can be withdrawn.

Rejected: `PENDING → PLAYED | REJECTED`, which turns the screen into a studio
queue and forces Block 8 to choose between counting requests and counting
plays — two different questions that would then look like one.

### D6 — The listener's identity follows the rule 6c settled

`list_music_requests` is `SECURITY DEFINER`, so it re-states by hand what RLS
would otherwise do:

- `music.view` at the Station or `42501`, never an empty page;
- the listener's name and phone only to a caller holding `members.view`, and
  **the list still lists without it**, with those columns null;
- a search term with no `members.view` returns nothing at all, because
  searching a field you may not read is an oracle.

This is not a new decision. It is what `list_participations` (Block 6c) and
`list_pickups` (Block 6d) already do, and the reason is written out in `0090`.

### D7 — `legacy_id`, so Block 9 does not need a migration of its own

`songs.legacy_id text`, nullable, **unique when present, per Station**.

Without it, an ETL that runs twice duplicates the entire acervo, because D2
removed every other uniqueness. This does not contradict D2: that decision was
about human duplicates — the same song typed twice by an operator is still
allowed. `legacy_id` says only that one row of the old system imports once.

The same column goes on `artists`, `record_labels`, `music_genres`, `shows` and
`music_requests` for the same reason — on requests most of all, since they are
the highest-volume thing Block 9 imports and a doubled request history is
exactly what Block 8 would then report.

### D8 — Four permissions, and the destructive one is separate

- `music.view` — see the catalogue and the requests
- `music.manage` — create and edit the catalogue
- `music.request` — record a request by hand
- `music.merge` — merge

`music.merge` is its own code because it is the only one that destroys.
Whoever builds a catalogue should not acquire the power to collapse it by
implication — the same separation Block 6d made between
`winners.reopen_deadline` and `winners.return`, and Block 2 between
`inventory.entry` and `inventory.exit`.

---

## 3. The data

The six domain tables §4.2 names, plus `music_merges` (§3.4), which this block
adds and §4.2 never anticipated because §4.2 never anticipated merging.

All of them carry `organization_id`, `company_id`, `created_at`,
`updated_at` and `deleted_at`, with the composite foreign key against
`companies (id, organization_id)` and the `unique (id, company_id)` pair that
lets a child prove its Station in one constraint rather than a trigger — the
shape Block 2 established for prizes (`0025`) and Block 4a for promotions
(`0040`).

### 3.1 The four simple ones

`music_genres`, `record_labels`, `artists`, `shows` — a name, and `legacy_id`.

### 3.2 `songs`

```
title          text, not blank
artist_id      -> artists        NOT NULL
label_id       -> record_labels  nullable
genre_id       -> music_genres   nullable
nationality    DOMESTIC | INTERNATIONAL              nullable
vocal          MALE | FEMALE | DUO | GROUP | INSTRUMENTAL   nullable
duration_seconds  integer > 0                        nullable
internal_code  text                                  nullable
legacy_id      text, unique per Station when present
```

`artist_id` is required because a song without an artist is a draft, not a
record. Label and genre are optional because the legacy source may not carry
them.

`vocal` has five values and not the two §4.2 named: a sertanejo duo, a band and
an instrumental track have no honest value among MALE and FEMALE, and Block 8's
indicator would then count over a badly classified acervo.

Duration is whole seconds rather than an `interval`, following the ledger's
choice of an integer quantity in Block 2 — it removes a class of formatting
error and every consumer formats it the same way.

**Deliberately absent: the `status` §4.2 lists.** Nobody here knows what it
means in `catalog_medias` — it could be "cleared for airplay", it could be a
soft delete under another name. Inventing the column now and discovering later
that it meant something else is worse than not having it. Recorded for Block 9
to check against the real source (§8).

### 3.3 `music_requests`

```
member_id     -> members   NOT NULL
song_id       -> songs     NOT NULL
show_id       -> shows     nullable
channel       MANUAL | IMPORT
requested_at  timestamptz
legacy_id     text, unique per Station when present
```

`legacy_id` is here for the same reason it is on the catalogue tables (D7), and
it matters more here than anywhere: requests are the highest-volume table Block
9 will import, and without a handle a second run doubles the entire request
history — which is precisely the number Block 8's dashboard reports.

`channel` mirrors `participation_source` (`0052`), which is also `MANUAL |
IMPORT`. The WhatsApp block adds `WHATSAPP` in a one-line migration of its own,
the way Block 6d added two enum values in `0091` — and for the same Postgres
reason, in a file that does nothing else.

### 3.4 `music_merges`

Who won, who left, of what kind, the reason (mandatory), the actor and when.

It is what answers, six months later, why a song vanished from the catalogue.
Without it a merge is indistinguishable from somebody having deleted the wrong
record.

---

## 4. The merge

**One private core, four public doors.**

Each door — `merge_songs`, `merge_artists`, `merge_record_labels`,
`merge_music_genres` — is `SECURITY DEFINER`, checks `music.merge` at the
Station **before revealing whether the records exist**, and delegates. That
ordering is the rule Block 6d settled in `0093`: an unknown id and an
unauthorised Station answer identically.

The core `apply_music_merge(p_kind, p_winner_id, p_loser_ids, p_reason)` is
private — `SECURITY INVOKER`, `execute` granted to nobody — in the shape of
`apply_winner_transition`. It does what is the same for all four:

- locks the winner and every loser, ordered by id, so two concurrent merges
  cannot cross;
- refuses a winner that appears among the losers;
- refuses records belonging to **different Stations** — checked in the database,
  not on the screen;
- refuses if any record is already deleted;
- repoints the children (the only part that varies: four one-line `update`s);
- writes one `music_merges` row per loser;
- soft-deletes each loser. **Never a `delete`** — this project deletes nothing,
  and the history row needs something to keep pointing at.

---

## 5. The screens

```
Music
  Songs        /music/songs        list with filters, record dialog
  Artists      /music/artists      list with filters, record dialog
  Catalog      /music/catalog      record labels, genres, shows (tabs)
  Requests     /music/requests     list with filters, manual entry
  Maintenance  /music/maintenance  selection and merge
```

Songs and Artists each get a screen because both are lists an operator works in
daily, with filters, and their forms are records rather than single fields —
the popup pattern Block 3c established.

Labels, genres and shows share one screen with tabs: they are short lists of
names chosen from a select, and three menu items for three one-field forms
would swell the sidebar for nothing. Shows are not music metadata, and sit
there for the same practical reason.

### 5.1 Maintenance

The operator filters a list of one kind, ticks the duplicates, and the ticked
rows collect in a staging area. There they name the one that stays, give the
mandatory reason, and merge.

**The staging area lives on the screen, not in the database.** It disappears if
the operator leaves without merging. Persisting a merge basket across sessions
would be a table and a synchronisation problem for a flow that lasts a minute.

---

## 6. Verification

The standing gates: Vitest, pgTAP, the isolation suite, Playwright,
`lint`/`typecheck`/`build`.

**The proofs that are not obvious:**

*The merge actually moves the children.* Counting the requests pointing at the
winner before and after — not merely asserting the loser's `deleted_at`. A test
that checks only the soft delete passes over a function that forgot its
`update`, and the operator finds out from Block 8's dashboard.

*A cross-Station merge is refused.* This is the tenant boundary, and **only the
isolation suite proves it** — with a real user's JWT, in the same task that
writes the function, which is the lesson Block 6c paid five commits for.

*The loser leaves the lists and its history survives.* Two assertions, not one.

*The merge is atomic.* Force one loser to fail and assert that **none** of them
migrated — proved by mutation, not by reading.

*A caller with `music.view` and without `members.view`* still gets every request
row, with the listener columns null, and gets nothing at all when they search.

---

## 7. The two passes

**7a — the acervo.** The six tables, RLS, the four permissions, the navigation,
and the two catalogue screens (Songs, Artists, Catalog). It stands on its own:
at the end of it an operator has built the Station's entire catalogue.

**7b — the requests and the cleanup.** `music_merges`, the four doors, the
requests screen with manual entry, and the maintenance screen.

The cut is there and nowhere else because of the proof: **merging a song is only
testable once there are requests to migrate.** A merge tested over an empty
catalogue passes green while exercising nothing — the defect Block 6d had sent
back repeatedly, in more than one task, and which `docs/block-6d-report.md`
records. Putting requests and merging in the same pass means the test that the
requests move is born with the function that moves them.

---

## 8. Out of scope, and what the other blocks inherit

**The Music dashboard is Block 8's**, whole. §11 promised it in both places;
Block 8 is where the period filter in the Station's timezone (L2), the charts
and the efficient aggregate queries are built for all three dashboards at once.

**The legacy migration is Block 9's**, whole. §11 promised it in both places,
and Block 9 is the ETL block — a single versioned Node script (N13) reading SQL
Server. What it inherits from here:

- `catalog_medias.status` was not modelled. Check it against the real source and
  decide (§3.2).
- A legacy request with no valid listener must either create one or be dropped,
  because `member_id` is required (D5).
- Catalogues are per Station (D1), so the acervo replicates once per Station.
- `legacy_id` is the idempotency handle (D7). Without using it, a second run
  duplicates everything, because D2 removed every other uniqueness.

**The WhatsApp music request is its own block, and §11 never named it.** The
legacy system has the flow — a `#musica` hashtag, a catalogue search, a list of
results to choose from, a retry counter, giving up, and a confirmation. It is
conversation-engine work on Block 5b's machinery, not catalogue work, and it
adds `WHATSAPP` to `music_requests.channel`. Recorded here so it is not lost;
its position is the owner's to set.

**The listener merge**, ruled for on 2026-08-01 and still unbuilt, should reuse
this block's core (D3).
