# The external intake API

Two endpoints an outside application can call to put a song in a Station's
catalogue and to record what a listener asked for. Introduced in Block 15; the
design and the reasoning behind every rule below are in
`docs/superpowers/specs/2026-08-09-external-intake-api-design.md`.

```
POST /api/v1/songs           register a song's record with every dependency
POST /api/v1/music-requests  record a music request, registering the song if needed
```

---

## 1. Authentication

Every call carries a per-Station key as a bearer token:

```
Authorization: Bearer ptx_<43 characters>
```

**A key is a bearer token.** Whoever holds it can write to that Station within
the key's scopes. It is scoped to one Station, revocable on its own, and may
carry an expiry — but nothing about it is tied to an IP address, and there is no
allowlist in this version.

The database stores only the SHA-256 of the secret. **The secret is shown once,
at issue, and cannot be shown again** — there is nothing anywhere that could
show it.

### Issuing and revoking

From the platform console: **/admin/stations → choose the customer → open a Station → API keys**.
Issue asks for a name, the scopes, and an optional expiry date. Revoked keys stay
on the list, because "when did this key die?" is a question somebody asks during
an incident.

For a local development stack there is `node scripts/issue-api-key.mjs`. It is
local-only on purpose: a script that could reach the hosted project would be the
one path in this codebase that mints a production credential from a shell.

### Scopes

A scope is a permission code, the same vocabulary the roles screen uses.

| Scope | What it allows |
| --- | --- |
| `music.manage` | register or complete a song |
| `music.request` | record a music request |
| `members.create` | register a listener, or link a known one to this Station |

`POST /api/v1/songs` needs `music.manage`.
`POST /api/v1/music-requests` needs `music.request` always, and the other two
only when the call actually has to create a song or a listener — so a key can be
issued that records requests for listeners the Station already knows and touches
neither the catalogue nor the audience.

---

## 2. `POST /api/v1/songs`

```bash
curl -X POST https://pulchatx.com/api/v1/songs \
  -H "Authorization: Bearer ptx_…" \
  -H "Content-Type: application/json" \
  -d '{
    "external_id": "ML-88213",
    "title": "Deixa a Vida Me Levar",
    "artist": "Zeca Pagodinho",
    "label": "Universal Music",
    "genre": "Samba",
    "nationality": "DOMESTIC",
    "vocal": "MALE",
    "duration_seconds": 245,
    "isrc": "BRUM70200123",
    "album": {
      "title": "Água da Minha Sede",
      "release_date": "2002-08-13",
      "upc": "0044006560021",
      "cover_md5": "2e018122cb56986277102d2041a592c2",
      "deezer_album_id": 302127
    },
    "deezer_track_id": 3135556
  }'
```

`title` and `artist` are required; everything else is optional. **An unknown
field is a 422**, never ignored — for an automation, a mistyped field name has to
fail on the first test run rather than disappear for six months.

```json
// 201 created · 200 the song was already there
{
  "song_id": "…",
  "created": true,
  "filled": ["isrc", "album_id"],
  "references": {
    "artist": { "id": "…", "created": false },
    "label":  { "id": "…", "created": true },
    "genre":  { "id": "…", "created": false },
    "album":  { "id": "…", "created": true }
  }
}
```

`filled` names the columns this call actually wrote on a song that already
existed. Each `created` says whether the reference had to be made. Both exist so
that "where did this artist come from?" has an answer six months later without
opening the audit trail.

### Deduplication

Checked in this order, and nothing else is on the list:

1. **`external_id`** — the primary key of the row in *your* system.
2. **`deezer_track_id`** — the recording.
3. Neither matched → a new song is created.

**Not the ISRC.** That column is hand-editable in the product, and one operator's
typo would silently attach your song to the wrong record.

**Not title + artist.** A re-recording, a live version and a remix are the same
artist and the same title; the catalogue allows that duplicate on purpose and the
product has a merge screen for the ones that are genuinely the same.

### When the song already exists

Only empty columns are filled. **A field that already has a value is never
overwritten, even when your payload disagrees.** Somebody who has curated a
record for a year is not corrected by a catalogue. `title` and `artist` are never
touched at all — they are the record's identity.

---

## 3. `POST /api/v1/music-requests`

Built for an application attending listeners on WhatsApp: the listener asks for a
song, the application searches Deezer, and the chosen result is posted here.

```bash
curl -X POST https://pulchatx.com/api/v1/music-requests \
  -H "Authorization: Bearer ptx_…" \
  -H "Content-Type: application/json" \
  -d '{
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
  }'
```

Cut the chosen item out of Deezer's `data[]` and send it. Fields this product
does not use — `link`, `preview`, `rank`, `cover_*`, `picture_*`, `explicit_*`,
`tracklist`, `type` — are ignored, and **unknown fields inside `song.deezer` are
accepted** so the integration does not break the day Deezer adds one. Everywhere
else the body is strict.

The flat fields of §2 also work inside `song`, and **win** over `song.deezer`
where both are present.

```json
// 201 recorded · 200 this external_id was already recorded
{
  "request_id": "…",
  "song":     { "id": "…", "created": true, "filled": [] },
  "listener": { "id": "…", "created": true, "linked": true }
}
```

### What happens on the way

1. **The listener** is found by phone within the Organization. If they are not
   known, `listener.name` is **required** — a request for a listener with no name
   is refused rather than registering a nameless person.
2. A listener who has exercised data erasure is refused and never recreated.
3. **The song** is registered by §2's rules exactly.
4. **`show`** is resolved by name and **never created**. An unknown name is a 422:
   programmes are the one catalogue entity with no merge tool, so an API creating
   them from typed names would breed duplicates with no cure.
5. The request is recorded with channel `API`.

### The phone number is stored in one form, whatever you send

Since Block 30d, `listener.phone` is passed through the same canonicalisation
every other door in this product uses — an international number, digits with
a leading `+`. Send the international form and nothing changes for you, which
is what the `+5511999998888` in the example above already was. **Send a bare
national number for a Station this product has a verified rule for — Brazil,
Portugal, Spain, the US or Canada — and it is prefixed before it is looked up
or stored**, not registered as a second listener: `8199998888` reaching a
Brazilian Station is looked up and written as `+558199998888`, the identical
row a `+55`-prefixed call for the same person would reach. For a Station with
no country recorded, or a country this product has no verified rule for yet,
the digits are stored exactly as sent — unprefixed rather than guessed at,
because a wrong prefix is the duplicate listener this change exists to
prevent, and an unprefixed number is no worse than what this API already
stored before Block 30d.

### What the server fetches for you

Deezer's `/search` carries no record label, genre, UPC or release date. When
`song.deezer.album.id` is present, **this server calls `/album/{id}` itself** — so
your application makes one Deezer call, not two.

That lookup is best effort: if Deezer is slow or refuses, the song is registered
without those four fields and the request is still recorded. It is skipped
entirely when you already sent a label and a genre.

**Send `md5_image`, never a cover URL.** This product stores the hash and builds
every image size from it, so a URL would be discarded.

### Retries

Send `external_id` on the request. A repeat of the same id returns the request
that already exists with `"created": false`, and writes nothing. Without it,
every POST records a new request — which is correct for a listener genuinely
asking twice, and wrong for a network retry.

---

## 4. Errors

```json
{
  "error": {
    "code": "listener_name_required",
    "message": "A listener not yet registered must arrive with a name.",
    "details": [{ "path": "listener.name", "message": "Required" }]
  }
}
```

Read the `code`. It is the machine contract and does not change meaning; the
message is for a human reading a log.

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `malformed_json` | the body is not JSON |
| 401 | `unauthorized` | no key, or a key that is unknown, revoked, expired, or belongs to a Station that is gone or suspended |
| 403 | `forbidden_scope` | the key is valid but lacks the scope; the message names it |
| 409 | `listener_anonymized` | that listener has exercised erasure |
| 413 | `payload_too_large` | over 256 KB |
| 415 | `unsupported_media_type` | `Content-Type` is not `application/json` |
| 422 | `invalid_payload` | the body was refused; `details` names the paths |
| 422 | `listener_name_required` | a listener not yet registered arrived without a name |
| 422 | `show_not_found` | no programme with that name in this Station |
| 429 | `rate_limited` | see `Retry-After` |
| 500 | `internal` | our fault; the request id is in the response header |

The four causes behind a 401 are one answer on purpose: a caller probing with a
stolen key learns nothing about which it was.

### Request ids

Every response carries `X-Request-Id`. Send your own and it is echoed; send none
and one is minted. Quote it when reporting a problem — without it, "it failed
yesterday around two" cannot be traced.

---

## 5. Limits

| | |
| --- | --- |
| `POST /api/v1/songs` | 120 requests per minute, per key |
| `POST /api/v1/music-requests` | 60 requests per minute, per key |
| Body size | 256 KB |

A 429 carries `Retry-After` in seconds. The window is fixed by the first call
that opens it and is never extended by a blocked one.
