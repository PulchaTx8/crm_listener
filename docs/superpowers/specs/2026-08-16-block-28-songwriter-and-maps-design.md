# Block 28 — A songwriter where a category was, listeners on a map, and more than one Station at once

**Status:** design agreed with the owner, 2026-08-16.
**Scope:** the owner's list of 2026-08-16 (second list), four items — Block 27's
music Category renamed to Songwriter, a map of listeners by place on the
Audience overview, a map of the most-requested song by place on the Music
overview, and a Dashboards control that consolidates any chosen set of Stations
rather than one or all.
**Depends on:** Block 3 (`members` and its `neighbourhood`/`city`/`state`
columns, `0031`), Block 4a (`promotions.requested_fields` and the
`promotion_requested_field` enum, `0040`), Block 5b (the conversation engine
that asks for those fields), Block 6b/8b/11b (the worker tick's drain pattern),
Block 8a (`get_audience_dashboard` and its two siblings, the period contract,
the consolidated toggle), Block 11b (the CSP this block has to widen), Block 13a
(the Deezer transport, the shape the Google client copies), Block 27
(`music_categories`, `songs.category_id`, `music_reference_kind`'s fifth value —
all of it renamed here).

---

## 1. What this is for

**A category was the wrong word.** Block 27 shipped a per-Station reference list
called Category, and the owner meant *songwriter* — the person who wrote the
song. The functionality was right; the name was not. It ships renamed all the
way down, because a schema that says one thing while the screen says another is
a misreading waiting for whoever reads it next.

**Nobody can see where the listeners are.** Every promotion entry can ask a
listener for their city and their neighbourhood, and thousands of them have
answered — `members.city` and `members.neighbourhood` have been filling up since
Block 3. Nothing reads them. A station manager cannot answer "which
neighbourhoods listen to me", and a small station — the case the owner named —
cannot see its own city broken up at all.

**A network cannot look at part of itself.** The Dashboards already consolidate,
but only in two positions: this Station, or every Station. A group with eight
radios and three in one state has no way to look at the three.

---

## 2. What already exists and is reused

Stated first, because most of this block is already built and the risk is
rebuilding it.

- **`get_audience_dashboard(p_company_ids uuid[], …)` has always taken a SET.**
  So has `periodHref`, which writes a repeated `?companyId=` key, and so has
  each dashboard page, which reads `getAll`, validates every id against the
  Stations the caller can actually reach, and passes the array down. **Item 9 is
  a control, not a feature** — the database, the URL and the pages have
  supported an arbitrary subset since Block 8a. See D7.
- **The geography is already collected.** `members` carries `neighbourhood`,
  `city`, `state` and `postal_code` (`0031`), and the conversation engine
  already asks for the first two ("Em qual cidade você mora?", "Em qual bairro
  você mora?") whenever a promotion names them in `requested_fields`. No new
  question is added for city or neighbourhood, and nothing is read out of
  `participation_answers`. See D4.
- **The worker tick's drain pattern** (`drainStorageErasures`,
  `drainReportRuns`) is where geocoding goes: each drain wrapped in its own
  `try`/`catch` so one failure shows up as a standing count rather than losing
  the others. A third drain joins them and needs no new mechanism.
- **The Deezer transport** (`src/lib/integrations/deezer/`) is the shape the
  Google client copies: an interface, a real implementation, a fake for the
  suite, and an env flag that decides which. Nothing in the test suites will
  ever talk to Google.
- **`ReferenceScreen`** carries the Songwriters screen with a `KIND` and a copy
  object, exactly as it carried Categories. The rename does not touch its shape.
- **`music.view` / `music.manage`** stay the permissions for the songwriter
  list, and **`reports.consolidated`** stays the permission for looking at more
  than one Station. No new permission is introduced anywhere in this block.
- **`0102`'s and `0208`'s rule** — a `CREATE OR REPLACE` cannot rename a
  parameter, and a `DROP` resets an ACL — governs every function recreated in §3.

---

## 3. Item 1 — Category becomes Songwriter

### 3.1 It renames all the way down

Block 27's PR #77 merged at 19:10 UTC on 2026-08-16 (`b3e1f94`) and is
**deployed**, so `0204`–`0208` are on `main` and are never edited in place. The
rename is new migrations.

| was | becomes |
|---|---|
| `music_categories` | `songwriters` |
| `songs.category_id` | `songs.songwriter_id` |
| `music_reference_kind`'s `'CATEGORY'` | `'SONGWRITER'` |
| `/catalog/categories` | `/catalog/songwriters` |
| `?category=<id>` | `?songwriter=<id>` |

Indexes, constraints and the RLS policy are renamed with them
(`music_categories_id_company_unique` → `songwriters_id_company_unique`,
`songs_category_company_fk` → `songs_songwriter_company_fk`, and so on). Leaving
them would put the old word in eight places the next reader would find.

**`ALTER TYPE … RENAME VALUE` runs inside a transaction**, unlike `ADD VALUE` —
so the trap `0204` paid for does not repeat here, and the rename needs no
migration of its own for that reason. It gets one anyway, for a different one:
see §8.

### 3.2 Six functions are recreated

`music_reference_table`, `archive_music_reference`,
`assert_song_references_live`, `create_song`, `update_song` and
`create_song_from_deezer` all name the old word — in a returned string, in a
branch, or in a parameter called `p_category_id`.

The four that carry that parameter are `DROP` + `CREATE`, because **a
`CREATE OR REPLACE` cannot change the name of an input parameter** — Postgres
refuses it outright — and supabase-js calls every RPC with *named* arguments, so
`p_category_id` → `p_songwriter_id` is a break the service layer must move with.
Each gets its `revoke`/`grant` pair restated, because `DROP` resets an ACL
(`0102`).

Each body is copied forward from its live definition — `0208` for `update_song`,
`0206` for `create_song` and `create_song_from_deezer`, `0205` for the other
three. Not from `0101`, and not from `0140`.

### 3.3 The old route is not redirected

`/catalog/categories` has existed for hours. Nobody has a bookmark, and a
redirect would be a permanent apology for a name that was never used. It goes.

### 3.4 The glyph changes with the word

Block 27 gave Categories `ICONS.folder` — *the thing you file others under*.
A songwriter is a person, and a folder no longer says anything true. **`ICONS.pen`
is new**: nothing declared means *who wrote it*, and the near miss is
`ICONS.users` (Artists), which is two rows up in the same section and means the
performer — the very distinction this rename exists to make.

### 3.5 One songwriter per song

The owner's words: "as funcionalidades e localização não mudam, só troque o
nome". So it stays a single nullable reference, exactly as the category was.

Recorded because the objection is obvious and will be raised: a song usually has
*several* writers. Making that true is a join table, a different edit form and a
different column on the list — a feature, not a rename, and its own block if it
is ever wanted.

---

## 4. The country

Geocoding a place name worldwide needs a country. Nothing in this product has
one — not the Station, not the listener — and without it "Santiago" is Chile,
Spain or Cuba.

**`companies.country`** and **`members.country`**, both ISO 3166-1 alpha-2, both
nullable. The Station's qualifies every geocode for that Station's listeners and
decides where its map opens. The listener's covers the diaspora — the Brazilian
in Portugal listening to a Maranhão station — which is why the owner asked for
both.

**The listener's country is an OPTIONAL requested field**, not a new mandatory
question. `promotion_requested_field` gains `'country'` and
`station_message_key` gains `'COUNTRY'`, so a Station that wants it asks for it
and a Station that does not is unchanged. Every field in that conversation costs
drop-off, and a question nobody needs is a listener who stops answering.

**When a listener has no country, they inherit the Station's.** That is the
common case and it is right: a station in São Luís has essentially no listeners
outside Brazil, and treating a blank as "unknown" would empty the map for every
Station that never asks.

---

## 5. Google, and the place cache

### 5.1 Two keys, and they must be two

| variable | where it lives | restriction |
|---|---|---|
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | the browser, by definition | HTTP referrer (`pulchatx.com`) |
| `GOOGLE_GEOCODING_KEY` | the server only, never in the bundle | IP |

One key for both would mean the key that draws the map — which is readable by
anyone who views source — is also the key that spends the owner's geocoding
quota. The owner has created both and set them in production under exactly these
names.

Both are `.optional()` in `src/lib/env.ts`, the shape every other integration in
this codebase uses, so a deployment without them boots. See D6 for what the
screen does then.

### 5.2 Geocoding is a place-level cache, drained by the worker

`geocoded_places` holds `(country, state, city, neighbourhood) → (latitude,
longitude)`, keyed by a **normalised** form of those four parts: folded to lower
case, accents stripped, runs of whitespace collapsed, and a short list of noise
words removed so `Cohab`, `COHAB` and `Bairro da Cohab ` are one key. The
normaliser is pure and unit-tested; it is the part most likely to be wrong and
the cheapest to pin.

**A place is geocoded once, ever, for the whole platform.** A station with fifty
thousand listeners has perhaps three hundred distinct neighbourhoods, so what is
billed is new place names — dozens a month, not thousands. This is what makes
the integration cheap, and it is why the cache is **not** scoped by Station:
"Cohab, São Luís, MA, BR" is the same coordinate for everybody.

**Nothing personal crosses the boundary.** What is sent to Google is a place
name assembled from four columns. No listener id, no name, no phone, no address
line. This is a direct consequence of caching by place rather than geocoding per
listener, and it is the main reason the design is shaped this way.

**The work happens in the worker tick**, as a third drain beside
`drainStorageErasures` and `drainReportRuns`, wrapped in its own `try`/`catch`
for the same reason they are: a listener waiting on a WhatsApp reply must not
wait because a map was warming up. A failed geocode is recorded on the row
(`failed_at`, `failure_reason`) and retried with a bound, never in a tight loop.

### 5.3 The client is isolated

`src/lib/integrations/google/` with the Deezer shape: a transport interface, a
real implementation, a fake, and the fake selected by `GOOGLE_FAKE=1` for the
suites. Swapping providers — the MapTiler conversation the owner deferred — is
one file.

### 5.4 The CSP has to widen

Block 11b's CSP is nonce-based and its e2e asserts **zero violations**. Google
Maps needs `maps.googleapis.com` and `maps.gstatic.com` reachable.

**Only `img-src` and `connect-src` gain hosts.** `script-src` already carries
`'strict-dynamic'`, and a browser that understands it **ignores host
allowlists in that directive entirely** — so adding Google there would be a line
that looks like it is doing something and is not. What actually loads the Maps
library is the nonce: a nonced `<script>` may load further scripts under
`strict-dynamic`, which is the whole reason that keyword is there. `img-src`
already has a precedent for an external host (`cdn-images.dzcdn.net`, Block
13a), and this follows it.

The zero-violations spec is what proves the widening is right rather than merely
present, and what fails loudly if it is too narrow.

---

## 6. Items 7 and 8 — the two maps

### 6.1 What is drawn

One circle per place, at the centre of the neighbourhood — or of the city, when
the neighbourhood is unknown — sized by the quantity:

- **Audience overview** — distinct listeners with a place. **The same
  population the Listeners card already counts**, which is not a detail: that
  card is a STOCK, `member_company_links` with `linked_at` before the window's
  end, not everyone who did something during it. Block 8a's D12b settled that
  every figure on the panel counts the same people and wrote out at length what
  happens when two cards silently disagree — a map counting a flow beside a card
  counting a stock would reproduce exactly that, and each number would be
  individually true. So the map filters that same set down to the rows with a
  place, and nothing else changes.
- **Music overview** — the most-requested song in each place, with its count,
  over the same window. `music_requests` joins to `members`, which is where the
  place is. This one IS a flow, and legitimately: a request happened at a time.
  It sits on the Music panel, whose own figures are flows.

The map opens framed on the Station's country; when the result contains a single
city it frames that city, which is the small-station case the owner named.
Beneath it, the same figures as a ranked table by city and by neighbourhood —
which is where the fine-grained numbers are actually read, and what renders when
there is no map (D6).

### 6.2 What is NOT drawn, and why

A dot per listener, as in the owner's second reference image, would need the
listener's **address** geocoded. `members.address_line` exists, so it is
technically possible — and it would mean sending a person's home address to a
third party and plotting where they live. That is a different product decision
with a different LGPD answer, and it is out of scope rather than forgotten.

### 6.3 The screen states its own coverage

A place exists only for listeners whose promotion asked for one, so **every one
of these maps is partial by construction**. The card says so — "1,240 of 3,900
listeners have a neighbourhood" — rather than drawing a partial picture as if it
were the whole. Without that line an operator reads a map of a quarter of their
audience as a map of their audience.

**3,900 is the Listeners card's own number**, which is the other half of §6.1's
rule: the coverage line is what makes the relationship between the two visible
instead of leaving an operator to wonder why the map looks thin. A denominator
of its own would be a third population on a panel that has settled on one.

### 6.4 No privacy floor

A neighbourhood with one listener is plotted.

This was raised as a concern — a single-listener point in a small neighbourhood
identifies a person — and **the owner decided to show everything, with no
minimum**. Recorded here as a decision rather than an omission, so that whoever
revisits it knows it was weighed. Changing it later is one predicate in two
aggregate functions.

### 6.5 Two new functions, not two widened ones

`get_audience_geography` and `get_music_geography`, each taking the same
`(p_company_ids, p_preset, p_from, p_to)` the existing dashboards take, each
`SECURITY INVOKER` and each re-checking `reports.consolidated` for every id when
more than one is named — the D3 rule Block 8a settled.

Separate from `get_audience_dashboard` rather than folded into its `jsonb`,
for two reasons: widening those is a `DROP` + `CREATE` on the longest functions
in the schema for a payload most callers do not need, and a map that fails must
not take the cards down with it.

---

## 7. Item 9 — any set of Stations

`ConsolidatedToggle` — two links, "this Station" and "all Stations" — becomes
`StationSelection`, where each Station pill toggles. The URL it builds is the one
that already exists: `?companyId=a&companyId=b`. No migration, no RPC change, no
service change.

What must survive the change, because it exists today and is easy to drop:

- the eligibility check (`reports.consolidated` resolved by a second
  `listCompanyAccess`, computed by the page and not the control);
- the `complete` flag, which is what stops the label claiming "All stations"
  when the list was capped at fifty or narrowed by a search box;
- the period, the Station search and every other URL parameter travelling
  through `periodHref` unchanged.

The boundary does not move: the three dashboard functions re-check the
permission for every id named, whatever this control ever rendered.

---

## 8. Migrations, in order

**`0209_place_and_songwriter_vocabulary.sql`** — `ALTER TYPE` only, and nothing
that uses the results: `music_reference_kind`'s `'CATEGORY'` renamed to
`'SONGWRITER'`, `'country'` added to `promotion_requested_field`, `'COUNTRY'`
added to `station_message_key`. The rename would be legal beside its own uses,
but the two additions are not, and the house convention since `0082` is that
enum vocabulary lands in a migration that does nothing else.

**`0210_songwriters_rename.sql`** — the table, the column, the indexes, the
constraints and the policy.

**`0211_songwriter_doors.sql`** — the six functions, each copied forward from its
live definition, four of them `DROP` + `CREATE` with their grants restated.

**`0212_country.sql`** — `companies.country`, `members.country`, and the four
doors that must carry it, each copied forward from its **live** definition
rather than from where it was first written: `create_member` (`0074`, not
`0034`), `update_member` (`0073`, not `0034`), `apply_member_creation` (`0061`,
the conversation's own path) and `update_company_profile` (`0155`, not `0153`).
Two of those live definitions are three migrations away from the file that
introduced them, which is exactly the trap `0206` recorded.

**`0213_geocoded_places.sql`** — the cache table, its unique key, its RLS, and
the door the worker claims rows through.

**`0214_dashboard_geography.sql`** — `get_audience_geography` and
`get_music_geography`.

`npm run db:types` is regenerated in the same commit as each schema change.

---

## 9. Decisions

**D1 — The rename goes to the database.** The alternative was relabelling the
UI and leaving `music_categories` underneath. Rejected: the whole cost of this
block's rename is one afternoon of careful migrations, and the cost of the
mismatch is paid by every person who reads the schema afterwards.

**D2 — `songwriters`, one word.** Not `song_writers`, not `composers`. English
spells it as one word, and `composer` is a narrower term that would read wrong
for popular music.

**D3 — One songwriter per song**, per the owner's own framing (§3.5).

**D4 — The maps read `members`, not `participation_answers`.** The owner
described the data as collected "via Quiz e Poll", which is true of the
mechanism — the entry conversation is what asks — but the answers land on the
member record, which is where they are already normalised, deduplicated across
promotions and reachable by a join. Reading the answers instead would count the
same listener once per entry.

**D5 — The place cache is global, not per Station.** A coordinate is a fact
about the world. Scoping it per tenant would multiply the billed calls by the
number of Stations sharing a city, for no privacy gain: the table holds place
names and coordinates, and no personal data at all.

**D6 — Without a key, the map degrades and nothing breaks.** Both variables are
optional. When `NEXT_PUBLIC_GOOGLE_MAPS_KEY` is absent, the card renders the
ranked tables and one line saying the map integration is not configured. When
`GOOGLE_GEOCODING_KEY` is absent, the worker's drain reports zero and writes
nothing. This is what let the block be built and tested before the key existed,
and it is the same shape `WHATSAPP_ACCESS_TOKEN` already has.

**D7 — Item 9 changes a control and nothing else.** The set has been supported
end to end since Block 8a; anything else this touches would be scope invented
rather than requested.

**D8 — Two new geography functions rather than widening the dashboards** (§6.5).

**D9 — No privacy floor**, on the owner's explicit decision (§6.4).

**D10 — The listener's country is optional and inherits the Station's** (§4).

**D11 — The audience map counts the Listeners card's population, a stock.**
Found by reading `0118` rather than by reasoning about maps: that card counts
`member_company_links` as of the window's end, and Block 8a's D12b makes "every
figure on this panel counts the same people" a rule with a long comment behind
it. A map of everyone who entered a promotion during the window would be a
perfectly defensible number that contradicts the card beside it — which is the
specific failure that rule exists to prevent.

---

## 10. Testing

**pgTAP** — the rename is complete: `songwriters` exists, `music_categories`
does **not**, `songs.songwriter_id` exists, `songs.category_id` does **not**, and
`music_reference_kind` carries `SONGWRITER` and not `CATEGORY`. Asserting the
absences is the half that catches a rename done to nine places out of ten.
Also: the four functions no longer accept `p_category_id`; `companies.country`
and `members.country` exist; `geocoded_places` has its unique key and its RLS;
the two geography functions exist and are `SECURITY INVOKER`.

**Isolation** — the cross-Station boundary on the geography aggregates (a place
belonging to Station A's listeners must not appear for Station B), the
`reports.consolidated` refusal when a second id is named without it, and the
worker's drain claiming a row exactly once. New files join
`REQUIRED_TEST_FILES` in `scripts/verify-isolation-suite.mjs` with a case floor,
in the same commit.

**Unit** — the place normaliser, which is where `Cohab`, `COHAB` and `Bairro da
Cohab ` must produce one key and `Cohab` in two different cities must not; the
Google transport's fake against a malformed response, a zero-results response
and a quota error; the country-inheritance rule.

**e2e** — register a songwriter and pick it on a song, on the renamed route;
select three Stations and read a consolidated figure that is not any one of
them; and open the Audience overview with the map key absent and find the ranked
table plus the "not configured" line rather than a broken card. The CSP spec's
zero-violations assertion covers the widened policy.

Gate order unchanged: `lint`, `typecheck`, `test`, `db:reset`, `db:test`,
`test:isolation`, then e2e as `CI=1 npx playwright test --workers=1` — the
configuration that gives an honest verdict locally.

---

## 11. Out of scope, stated rather than discovered

- **A dot per listener** (§6.2) — needs address geocoding and a separate LGPD
  decision.
- **A map on the Promotions overview.** Two were asked for; two are delivered.
- **Static map images.** The cost of Google Maps is dominated by map *loads*,
  not by geocoding. If it grows, the answer is a static image by default with
  the live map behind a click. Not built now; the client boundary in §5.3 is
  where it would go.
- **Several songwriters per song** (§3.5).
- **Backfilling `members.country`** for listeners registered before this block.
  They inherit their Station's country at read time, which is correct for
  essentially all of them.
- **Neighbourhood polygons.** There is no practical worldwide dataset of
  neighbourhood boundaries; the circle at the centroid is what the data supports.

---

## 12. Delivery

One branch, `block-28-songwriter-and-maps`, one PR, in the rhythm Blocks 24 and
27 used.

**The order inside it is chosen, not incidental**, because only half of this
depends on something outside the repository:

1. **Item 1**, the rename — depends on nothing.
2. **Item 9**, the Station pills — depends on nothing, and touches no migration.
3. **The country** (§4) — the prerequisite the maps cannot start without.
4. **The place cache and the worker drain** (§5) — testable in full against the
   fake transport, with no key.
5. **Items 7 and 8**, the maps themselves.

If the Google keys turn out to be wrong, missing or restricted differently than
expected, the first four are finished and the fifth degrades to its ranked table
(D6) rather than the block stalling. The owner has confirmed both variables are
already set in production under the names in §5.1.
