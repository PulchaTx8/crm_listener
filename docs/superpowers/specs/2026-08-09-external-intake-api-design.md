# Block 15 — The external intake API, and the Station's own record

**Date:** 2026-08-09
**Status:** awaiting review
**Block:** 15 (one block; see §12 for why it was not split)

---

## 1. What this is for

Two things a listener-facing automation cannot do today, and one gap on the
Station itself.

An outside application — an AI attendant answering listeners on WhatsApp, or
another radio system that already holds a music catalogue — has **no way in**.
Every write in this product ends at a `SECURITY DEFINER` RPC that asks
`has_permission(...)`, which is `has_permission_for(auth.uid(), ...)`. A machine
has no `auth.uid()`. The whole of the product's write surface is therefore
reachable only from a browser holding a session cookie.

This block opens two doors, and only two:

| | |
| --- | --- |
| `POST /api/v1/songs` | register a song's record with every dependency it names |
| `POST /api/v1/music-requests` | record that a listener asked for a song, registering the song if it is not there |

Both authenticate on a **per-Station API key**, held in the database and
revocable one at a time.

The third part is smaller and unrelated to the API except that it lands in the
same console: a **Station has no record of its own**. `companies` carries a
name, a status and a timezone, and nothing else — no address, no dial frequency,
no picture. The card at `/app` shows three fields because there are only three
fields. This block gives the Station the columns a radio station actually has,
edits them from the platform console, and shows them on the card.

---

## 2. The two consumers, in the owner's words

Recorded because the whole shape of §5 and §6 follows from the difference
between them.

**Consumer A — another system sends its catalogue.** It already holds a primary
key in its own table. That key travels in the payload and is stored on the
song's record as an external code, so the same row sent twice is the same song
here.

**Consumer B — an AI attendant on WhatsApp.** A listener asks for a song. The
external application searches **Deezer** by title and/or artist, shows the
listener the results, and posts the chosen one. It holds no key of its own; what
it holds is Deezer's. It must not have to call Deezer twice.

---

## 3. Decisions

All decided with the owner on 2026-08-09.

**D1 — The API key is the subject; it does not borrow a person's identity.**
A credential row carries the Station and a set of scopes which **are permission
codes**, foreign-keyed to `public.permissions`. The API doors check the
credential's scope instead of `has_permission`.
Rejected: binding each key to a robot `auth.users` row and gating on
`has_permission_for` (0121). It needs a `company_membership` and a role, so the
robot **appears on the Team screen as if it were a person** — and the day
somebody tidies that user away, the automation stops with a 403 nobody will
connect to the cause.
`audit_logs.actor_id` is left null and the credential is named in `detail`. That
column has been nullable since 0004 for exactly this class of caller, and 0129
states in writing that a null there does not mean "the system did it".

**D2 — Two endpoints, not one.** The two consumers want different outcomes from
the same facts, and one endpoint with a mode flag would be two endpoints wearing
one name.

**D3 — On a match, fill the gaps; never overwrite.** A song already in the
catalogue keeps every field that has a value, even when the payload disagrees.
Only `NULL` columns are filled. This is the rule `link_song_to_deezer` (0139)
already applies, and its comment is the reasoning: *somebody who has curated a
record for a year is not corrected by a catalogue.*

**D4 — The deduplication ladder is `external_id`, then `deezer_track_id`, and
nothing else.** Not ISRC: 0138's D8 refused a unique index there because the
column is hand-editable and a typo would become *"a door nobody can open"* —
matching on it has the same defect inverted, silently attaching a new request to
the wrong song. Not title + artist: 0098's D2 allows duplicates deliberately (a
re-recording, a live version, a remix), and the cure is 7b's merge screen.

**D5 — `external_id` gets its own column; it does not reuse `legacy_id`.**
`legacy_id` is reserved for Block 9's ETL over the legacy system. Two sources
sharing one unique index would collide on values that mean different things, and
the collision would surface as *"this song already exists"* on a record that has
nothing to do with it.

**D6 — A new listener must arrive with a name, or the request is refused.**
The external application attends on WhatsApp, so it holds the phone and the
profile name. A missing name is its bug; this API refuses rather than creating a
nameless listener. The owner's own framing: *"esse vai ser um erro tratado no
próprio aplicativo externo, mas deixo aqui a observação."*

**D7 — The server enriches from Deezer; the external application calls Deezer
once.** A `/search` result carries no record label, genre, UPC or release date —
verified against the payload the owner supplied on 2026-08-09. When
`song.deezer.album.id` arrives, this server calls `/album/{id}` itself, **best
effort**: a failure there registers the song without those fields rather than
failing a listener's request over an optional column. This copies
`prefillFromDeezerAction` exactly, including its refusal to make a second call
to `/track/{id}`.

**D8 — The API doors do not share an insert body with `create_song_from_deezer`.**
They share the two resolvers (`resolve_or_create_reference` 0139,
`resolve_or_create_album` 0137) and nothing more. The UI door deliberately lets
`songs_deezer_live` raise `23505` so the screen can say *"another song is
already linked to that recording"*; the API door must be idempotent. Opposite
semantics on purpose, so a shared body would have to branch on caller — which is
two functions with extra steps.

**D9 — Station configuration lives in `/admin/customers` only.** No gear on the
card, no settings dialog at `/app`, no `/api-keys` screen. The card **displays**;
the console **edits**. This follows 0130's reasoning for the WhatsApp
integration: the account being configured belongs to the platform.

**D10 — Name and timezone stay where they are.** Not touched by this block.

**D11 — Frequency is structured, not free text.** `broadcast_band` enum
(`FM`/`AM`/`WEB`) plus `frequency_khz` integer. FM 98.5 MHz stores `98500`; AM
1200 kHz stores `1200` — one unit, an integer, no floating-point rounding. A
web-only station is band `WEB` with a null frequency.

**D12 — Coordinates are recorded, not shown on the card.** Two `numeric(9,6)`
columns. No PostGIS: two columns answer *where is this Station*, and PostGIS
earns its place the day there is a distance query. No geocoding: deriving the
point from the address is another external service with a key, a cost and a
quota.

---

## 4. Authentication

### 4.1 The tables

```sql
create table public.api_credentials (
  id, organization_id, company_id,     -- the Station, with the composite FK
  name          text not null,         -- "Deezer automation"
  token_prefix  text not null,         -- 12 visible chars, to tell keys apart
  token_hash    text not null,         -- sha256 hex, CHECK ^[0-9a-f]{64}$
  expires_at, last_used_at,
  revoked_at, revoked_by,
  created_by, created_at, updated_at
);

create table public.api_credential_scopes (
  credential_id   uuid references public.api_credentials (id) on delete cascade,
  permission_code text references public.permissions (code),
  primary key (credential_id, permission_code)
);
```

The scopes are a **child table rather than a `text[]`** so the permission code is
a real foreign key. An invented scope is refused by Postgres, not by a trigger
somebody can forget to write.

`token_hash`'s CHECK mirrors `webhook_events.external_id` (0058), which refuses a
raw identifier by shape.

RLS enabled, **no policy** — the shape `integrations` (0057) uses. Its comment
carries the warning worth restating: bypassing RLS is not a table privilege, this
schema revokes the default ACL, so `createServiceClient().from('api_credentials')`
**will fail with 42501**. Every reader is inside a `SECURITY DEFINER` body.

### 4.2 The key, and the request path

Format `ptx_<32 random bytes, base64url>`, presented as
`Authorization: Bearer ptx_…`. **Shown once, at issue.** The database holds only
the hash, so "show it again" is not a feature that was withheld.

1. The route extracts the token and **hashes it in Node** before anything else.
   The raw token never reaches the database, not even as an RPC argument — the
   rule the WhatsApp webhook already follows for the `wamid`, whose comment gives
   the reason: an RPC argument lands in query logs and in backups.
2. `authenticate_api_credential(p_token_hash, p_scope)` — `SECURITY DEFINER`,
   `execute` granted to `service_role` alone. Returns the credential, the
   Organization and the Station, or nothing.
3. **401** for: no header, malformed header, unknown hash, revoked, expired,
   Station archived or suspended. **403** when the credential is valid but lacks
   the scope, with `details` naming which. The split is deliberate — a caller
   already holding a valid key learns nothing from the 403 that it did not
   already know, and an integrator needs to tell the two apart.
4. `last_used_at` is written **amortised**: only when the stored value is older
   than 60 seconds. Otherwise every request is an `UPDATE` on one hot row.

**On constant time.** There is no secret-to-secret comparison here. What arrives
is hashed before anything happens and what is stored is a hash, so the lookup is
an indexed equality over a SHA-256 of a high-entropy secret. `timingSafeEqual` in
`/api/worker/tick` exists because *that* secret lives in the environment and is
compared directly. This paragraph goes into the code, so nobody later "fixes" an
index lookup into a scan.

### 4.3 Issue and revoke

`issue_api_credential`, `revoke_api_credential`, `list_api_credentials`, all
gated on `is_platform_admin()` — which the `/admin` layout already requires. The
secret is generated in Node with `crypto.randomBytes`; only its hash and prefix
reach the RPC.

---

## 5. `POST /api/v1/songs`

Scope: `music.manage`.

```json
{
  "external_id": "ML-88213",
  "title": "Deixa a Vida Me Levar",
  "artist": "Zeca Pagodinho",
  "label": "Universal Music",
  "genre": "Samba",
  "nationality": "DOMESTIC",
  "vocal": "MALE",
  "duration_seconds": 245,
  "isrc": "BRUM70200123",
  "internal_code": "A-1042",
  "album": {
    "title": "Água da Minha Sede",
    "release_date": "2002-08-13",
    "upc": "0044006560021",
    "cover_md5": "…",
    "deezer_album_id": 302127
  },
  "deezer_track_id": 3135556
}
```

`title` and `artist` are required; everything else is optional. The schema is
**strict** — an unknown field is a 422, never silently ignored. For an
automation, a mistyped field name must fail on the first test run rather than
disappear for six months.

**The ladder (D4):** `external_id` → `deezer_track_id` → create.

**On a match (D3):** only `NULL` columns are filled — label, genre, album, ISRC,
duration, nationality, vocal, internal code, and `external_id` itself if the row
had none. `title` and `artist_id` are never touched: they are the record's
identity.

The dependencies go through `resolve_or_create_reference` (0139) and
`resolve_or_create_album` (0137), which match on a case-folded name and create
only on a miss. `resolve_or_create_album` already prefers the Deezer album id
over the folded title and already gap-fills a hand-typed album — exactly the
rule this block wanted, written five migrations ago.

```json
// 201 created · 200 matched
{ "song_id": "…", "created": true, "filled": ["isrc", "album_id"],
  "references": {
    "artist": { "id": "…", "created": false },
    "label":  { "id": "…", "created": true  },
    "genre":  { "id": "…", "created": false },
    "album":  { "id": "…", "created": true  } } }
```

`filled` and each `created` exist for support: six months on, *"where did this
artist come from?"* has an answer without opening the audit trail.

---

## 6. `POST /api/v1/music-requests`

Scopes: `music.request` **always**; `music.manage` only if the song must be
created; `members.create` only if the listener must be. Least privilege, so a key
can be issued that records requests without touching the catalogue.

```json
{
  "external_id": "req-99120",
  "listener": { "phone": "+5511999998888", "name": "Maria Silva" },
  "requested_at": "2026-08-09T14:30:00Z",
  "show": "Programa da Tarde",
  "song": {
    "deezer": {
      "id": 3135556,
      "title": "Harder, Better, Faster, Stronger",
      "duration": 224,
      "artist": { "name": "Daft Punk" },
      "album": { "id": 302127, "title": "Discovery",
                 "md5_image": "2e018122cb56986277102d2041a592c2" }
    }
  }
}
```

The external application cuts the chosen item out of Deezer's `data[]` and sends
it. `link`, `preview`, `rank`, `cover_*`, `picture_*`, `explicit_*`, `tracklist`,
`type`, `readable`, `title_short` are ignored.

**One deliberate exception to strictness:** inside `song.deezer`, unknown fields
are accepted. It is a third party's object and Deezer may add to it; the
integration must not break the day it does. Everywhere else, strict.

The flat fields of §5 remain valid inside `song` and **win** over `song.deezer`
where both are present: whoever was explicit meant it.

`external_id` on the request itself is optional and maps to a new
`music_requests.external_id` with a partial unique index per Station. An
automation will retry; without this, a retry is a second request. A listener
genuinely asking twice is still two requests, because the application would send
two different ids.

**The flow, in one transaction:**

1. Resolve the listener by normalised phone within the Organization, through
   0061's `apply_member_*` cores — the same ones the WhatsApp door uses.
2. Found → ensure the `member_company_links` row for this Station. Not found →
   the name is required; without it, `422 listener_name_required` (D6).
3. Anonymised listener → `409 listener_anonymized`, and no re-creation.
   Recording fresh activity against somebody who exercised erasure is precisely
   what the erasure was for; `create_music_request` already excludes them.
4. The song, by §5's rules.
5. `show`, if present: **resolved by folded name, never created**. Unknown →
   `422 show_not_found`. `shows` is the one catalogue entity with no merge door
   (0098 says so in its own table comment), so an API creating programmes from
   typed names would breed duplicates with no cure.
6. Insert with channel `API`.

**`API`, not `WHATSAPP`.** 0098 reserved `WHATSAPP` for this product's own bot.
What arrives here came over HTTP from a third party; that it attends on WhatsApp
is the third party's story. The column answers *how it reached us*.

```json
// 201
{ "request_id": "…",
  "song":     { "id": "…", "created": true, "filled": [] },
  "listener": { "id": "…", "created": true, "linked": true } }
```

---

## 7. Errors, limits, standardisation

One body shape, stable machine-readable codes in English:

```json
{ "error": { "code": "listener_name_required",
             "message": "A new listener must have a name.",
             "details": [{ "path": "listener.name", "message": "Required" }] } }
```

| HTTP | `code` |
| --- | --- |
| 400 | `malformed_json` |
| 401 | `unauthorized` |
| 403 | `forbidden_scope` |
| 409 | `listener_anonymized` |
| 413 / 415 | `payload_too_large` / `unsupported_media_type` |
| 422 | `invalid_payload`, `listener_name_required`, `show_not_found` |
| 429 | `rate_limited` (with `Retry-After`) |
| 500 | `internal` |

**Raw Postgres text never leaves.** `describeMusicReadError` already writes the
rule down: *InternalError means the fault is ours, not theirs, and its message may
carry a raw database error — not something to show.*

Every response carries `X-Request-Id`, echoed if supplied and logged either way.
Without it, *"it failed yesterday around 2pm"* is not investigable.

**Rate limiting uses `PostgresRateLimiter`, not `InMemoryRateLimiter`.** The
Deezer tab uses the in-memory one and its comment admits the cost: with
`output: 'standalone'` there may be several instances, each with its own counter.
Acceptable for one person clicking; not for an automation. Keyed
`api:<credential_id>` — 120/min on §5, 60/min on §6.

A **second limiter guards Deezer**, keyed by Station: Deezer's quota is per IP and
every Station shares this server's address.

An oversized body is refused on `content-length` **before it is read**, as the
webhook does. `Content-Type: application/json` is required.

---

## 8. The Station's own record

### 8.1 New columns on `companies`

Address — the same seven names `members` (0031) already uses, so there is not a
second address shape in one database:
`address_line`, `address_number`, `address_complement`, `neighbourhood`, `city`,
`state`, `postal_code`, all nullable `text`.

Frequency (D11) — `broadcast_band` enum (`FM`/`AM`/`WEB`) and `frequency_khz`
integer, both nullable.

Coordinates (D12) — `latitude` and `longitude` `numeric(9,6)`, with a range CHECK
on each and a **pair CHECK**: both null or both set. Half a coordinate is worse
than none, and this is the shape the archival CHECKs across this schema already
use.

Picture — `thumb_url text` with `CHECK (thumb_url is null or thumb_url ~ '^https?://')`,
mirroring `prizes.photo_url` (0145).

### 8.2 The two writers, and why they are two

`update_company_profile(...)` — gated `is_platform_admin()`, following the house
convention that **every field is written on every call, never merged**
(`update_prize`, `update_role`, `update_song`).

`set_company_thumb(p_company_id, p_url default null)` — **separate, because of
that convention.** 0144 and 0145 both document the defect: a field-wholesale
update would clear a picture uploaded before the next Save. Clearing enqueues
`enqueue_artwork_erasure`, drained by the worker tick, so the object does not
outlive the column.

### 8.3 Storage

Slot `station-thumbs`, key `station-thumbs/<company_id>/thumb`, in the existing
`artwork` bucket. **No file extension in the key** — that absence is what makes
"upload again replaces" structural rather than hopeful; the load-bearing
consequence is that `contentType` must be set explicitly on every upload. The
stored URL carries `?v=<epoch ms>` or the CDN keeps serving the old picture.

`may_write_artwork` (0143) gains a `station-thumbs` branch returning
`is_platform_admin()`. Its own comment asks for this out loud: *an unknown prefix
is refused, so adding a slot means adding it here.*

### 8.4 Screens

**`/admin/customers`** — the record dialog already exists and already has tabs
(`Customer`, `Stations`, `Owner`, validated server-side through `CUSTOMER_TABS`).

- The **Customer** tab gains a form: thumb, address, frequency, coordinates, and
  a Save. It has never had one, and the dialog's comment says why: *"no migration
  defines update_company or a rename, so there is nothing on a Station that this
  console may edit."* That sentence stops being true in this block and **is
  updated in the same change** — leaving it would put a lie in the code, and
  those cost the most later.
- A new **API keys** tab: list, issue, revoke. The secret is shown once.

**`/app`** — the card gains the thumb (or the name's initial), the frequency, the
full address, and keeps name, status and timezone. Coordinates are not shown
(D12). No gear, no dialog (D9).

Two hardcoded English strings in that file escaped Block 12's language
migration — *"No station is linked to your account yet"* and *"Suspended — no
data is available…"*. The card is being rewritten anyway; both go to the three
languages.

---

## 9. Migrations

| | |
| --- | --- |
| `0148` | `api_credentials` and `api_credential_scopes`; RLS on, no policy |
| `0149` | `authenticate_`, `issue_`, `revoke_`, `list_api_credentials` |
| `0150` | `external_id` on `songs` and on `music_requests`, each with a partial unique index per Station |
| `0151` | `alter type music_request_channel add value 'API'` — **alone in its file** |
| `0152` | the two API doors, over one private intake core shared **between them** — not with `create_song_from_deezer` (D8), because §6 registers a song by §5's rules |
| `0153` | the Station's columns, `update_company_profile`, `set_company_thumb`, the `may_write_artwork` branch |

`0151` is alone for a Postgres reason 0082 and 0091 already paid for: `ADD VALUE`
cannot share a transaction with a statement that uses the value. Separate files
are separate transactions.

---

## 10. Application files

- `src/app/api/v1/songs/route.ts`, `src/app/api/v1/music-requests/route.ts`
- `src/lib/api/` — bearer parsing and hashing, the error taxonomy and SQLSTATE
  mapping, the response envelope and `X-Request-Id`
- `src/schemas/api.ts` — both bodies, strict except inside `song.deezer`
- `src/services/api-credentials.ts`, `src/services/company-profile.ts`
- `src/app/(admin)/admin/customers/` — the Customer tab form, the API keys tab
- `src/app/(app)/app/page.tsx` — the card
- `src/middleware.ts` — `api/v1/` added to the matcher exclusion
- `messages/*.json` — three languages

**The middleware exclusion is not housekeeping.** The middleware runs
`supabase.auth.getUser()` on every request and then 307s a caller with no cookie
to `/login`. Its own comment records that this is how the webhook route broke
once, and that no unit test catches it — the tests import the handler and call it
directly.

---

## 11. How it is proved

**pgTAP** — `33_api_credentials.test.sql`, `34_api_intake.test.sql`,
`35_company_profile.test.sql`: the scope gate; a revoked and an expired key; a
suspended Station; each rung of the ladder; gap-fill that does **not** overwrite;
the anonymised listener; the unknown programme; `may_write_artwork` refusing a
foreign Station's thumb path.

**Vitest** — the schemas (strictness, and the `song.deezer` exception), bearer
parsing, hashing, the error mapping, the Deezer enrichment falling back cleanly
when `/album/{id}` fails.

**The isolation suite** — the test that matters most: a key issued for Station A
writes nothing into Station B, on both endpoints.

**Playwright** — issuing a key and seeing the secret once, revoking it, uploading
and removing a thumb, and the card rendering it.

**Docs** — `docs/API.md` with both contracts and the error table; a section in
`docs/SECURITY.md`.

---

## 12. What was considered and removed

- **A shared insert body between `create_song_from_deezer` and the API door**
  (D8). Opposite semantics on purpose.
- **A gear on the station card, a settings dialog at `/app`, and an `/api-keys`
  screen.** All three were designed and then cut when the owner moved Station
  configuration back to the platform console (D9).
- **Editing name and timezone** (D10).
- **`deezer_artist_id` on `artists`.** The gain appears only when two spellings
  diverge, and 7b's merge already covers that.
- **A second Deezer call to `/track/{id}` for the ISRC.** The product's own tab
  does not make it; songs registered from a search live without an ISRC and the
  operator types it. Matching that beats diverging from it.
- **Splitting into 15a and 15b.** Proposed while the screens were a gear, a
  dialog and a new route; withdrawn once D9 shrank the interface to two tabs in a
  dialog that already exists.

---

## 13. Risks, stated rather than discovered

**A key is a bearer token.** Whoever holds it writes to that Station within its
scopes. Mitigated by per-Station scoping, per-credential revocation, optional
expiry, and `last_used_at` — not eliminated. There is no IP allowlist in this
block; it can be a column later.

**The Deezer enrichment sits in the request path.** A slow Deezer makes a
listener's request slower. It is best-effort and never fatal (D7), but the
latency is real. If it becomes a problem, the enrichment moves to the worker tick
and the song is completed a few seconds after the request is recorded.

**Gap-fill can preserve a wrong value.** D3 means a field somebody typed
incorrectly is never corrected by the API. That is the intended trade — the
alternative silently overwrites curated data — and the maintenance screen is
where a human fixes it.

**`external_id` is trusted as sent.** Two different rows in the calling system
sharing one id would merge into one song here. Nothing in this API can detect
that; it is a fault on the sending side, and it is named here so it is not
discovered in support.
