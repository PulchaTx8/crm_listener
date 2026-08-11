# Block 17b — A listener on the Station's own site asks for a song

**Date:** 2026-08-11
**Status:** awaiting review
**Block:** 17b (the second of three; 17a shipped, 17c is untouched)

---

## 1. What this is for

17a put a visitor through the door: they type a telephone number into an
`<iframe>` on the Station's own website, prove it with a code over WhatsApp, and
land on a menu with two buttons. Both buttons are disabled.

This block enables the first one. A listener searches Deezer from inside the
widget, picks a recording, optionally writes the station a note, and the request
lands in `music_requests` with channel `WEB` — the same table the presenter's
screen has always read, so a request that arrived through a website and one
typed by an operator are the same kind of thing by the time anybody looks at
them.

---

## 2. What 17a promised, and what is actually inherited

§2 of the 17a design says, in writing:

> `api_record_music_request` (0152) already resolves a listener, registers a song
> out of a Deezer payload and records the request — 17b is a screen and an enum
> value.

**That is not true, and the difference is this block's shape.** Reading the
migration rather than the sentence about it:

| what 17a expected | what 0152 actually is |
| --- | --- |
| a reusable door | gated on `p_credential_id` and `api_credential_scopes` — the widget has no API credential, it has a signed cookie |
| records the request | hardcodes `channel = 'API'`; `WEB` is not a value of `music_request_channel` at all |
| resolves the listener | **already done** — `WidgetClaims` (17a, D5) carries `memberId`, `companyId`, `organizationId` and `phone` |

So the first half of `api_record_music_request` — find, create, link the listener
— is work this block does **not** repeat, because 17a's verification already did
it. And the second half cannot be called, because its front door is a credential
this caller does not hold.

What is genuinely inherited is **`apply_song_intake`** (0152), the song core that
`api_register_song` and `api_record_music_request` both call so that "registering
a song" cannot come to mean two different things at two doors. This block becomes
a third caller of it, and that is the whole of the reuse.

**The lesson is worth keeping**, because it will recur in 17c: a prose claim
about reuse in a design document is a hypothesis about a function's signature.
17c's inheritance of `whatsapp_conversation_steps` (0066) is asserted in exactly
the same voice and has not been checked.

---

## 3. Decisions

Each of these is the owner's, taken on 2026-08-11, and recorded because none of
them is derivable from the code.

**D1 — The search is Deezer, always.** Not the Station's catalogue with Deezer as
a fallback, and not the catalogue alone. A listener types what they want to hear
and gets Deezer's answer. The catalogue therefore grows from what the public
asks for, and `apply_song_intake` is what keeps that from becoming a pile of
duplicates: it resolves an existing recording by ISRC, by `deezer_track_id` and
by title-and-artist before it creates anything.

**D2 — The ceiling is an interval between requests, configurable per Station.**
Not "N requests per day". The operator sets **days, hours and minutes**; a
listener who has just asked for a song waits that long before asking again. All
three zero means no ceiling at all.

**D3 — The note is recorded and only the operator sees it.** A radio request
arrives with "play it for my mother" attached, so the field exists. Nothing
publishes it anywhere automatically; it appears on the operator's requests screen
and a person decides what to do with it.

**D4 — The browser sends a Deezer track id, not a record.** The server fetches
the track and its album from Deezer and builds the payload itself.

**D5 — A web request carries no programme.** `music_requests.show_id` stays null.

**D6 — The interval looks only at channel `WEB`.** An operator recording a
request on a listener's behalf does not spend that listener's web quota.

---

## 4. The ceiling, and why it is an interval

The obvious model is a counter: *N requests per calendar day, reset at midnight*.
It was designed and discarded, and the reasons are worth keeping because the
counter model looks more natural than it is.

**An interval needs no timezone.** A counter reset "at midnight" has to pick
whose midnight. `companies.timezone` exists (`not null`, default
`America/Sao_Paulo`), so the counter version was `date_trunc('day', now() at time
zone co.timezone) at time zone co.timezone` — correct, and the kind of expression
that passes every test written at 14:00 and fails in production at 21:00. An
interval is relative. The column drops out of the query entirely.

**An interval needs no counting.** The check is one comparison against the most
recent `WEB` request by that listener at that Station, over an index that already
exists (`music_requests_member_idx`).

**An interval can say how long is left.** A counter refuses with "you have
reached the limit". An interval refuses with the number of seconds remaining, so
the screen says *you can ask again in 12 minutes*.

### Storage

```sql
alter table public.widget_installations
  add column music_request_cooldown interval not null default '0';
```

**`not null` with zero meaning "no ceiling", rather than nullable.** Both spell
"unlimited"; having both is two representations of one fact, and it is always the
second one that some future `where` clause forgets. The three form fields map
straight onto it:

```sql
make_interval(days => $1, hours => $2, mins => $3)
```

and come back by `extract(day|hour|minute from …)`. Postgres does not silently
normalise across those units — `make_interval(hours => 36)` stays `36:00:00`
rather than becoming `1 day 12:00:00` — so the operator reads back the numbers
they typed.

### The consequence the owner should see in writing

With a one-day interval, a listener who asked at 23:50 waits until 23:50 the
following day. They do **not** get a fresh allowance ten minutes later. That is
the difference between an interval and a calendar reset, and it is the behaviour
this block ships.

---

## 5. The doors

Three things are added at the database and transport boundary. All three are
`security definer` where they touch the database, granted to `service_role`
alone, and revoked from `public` — the shape 0161 established for every widget
door.

### 5.1 `widget_music_request_wait(p_public_key, p_member_id) returns integer`

Read-only. Seconds remaining, `0` when the listener may ask now.

**It applies steps 1 to 3 of §5.2 and refuses by the same names.** It does not
return `0` for a session it cannot verify: "you may ask now" followed by a
refusal at submit is a worse answer than the refusal itself, and a door that
answers a stranger's question about a listener at another Station is a door that
leaks whether that listener exists.

**Why a second door exists at all.** Without it the visitor searches, picks a
recording, writes a note, submits — and only then learns they must wait two
hours. The ceiling is still enforced inside the write, because a guard that only
the screen respects is not a guard; this one exists so that nobody is invited to
do work that is going to be refused.

### 5.2 `widget_record_music_request(...)`

The write. It refuses in this order, and the order is the design:

1. **Installation, by public key.** Unknown, disabled, archived, and a suspended
   Station are one answer — `unknown_installation` — which is the choice 0161 and
   0164 already made: probing teaches nothing the iframe's `src` did not say.
   `company_id` and `organization_id` are **derived here** and never taken from
   the caller.
2. **The listener belongs to the Station this key names.** The signed session
   already proves it; the door proves it again against the database. This is the
   guard `api_record_music_request` states in its own comment — a door that
   trusts a caller-supplied `company_id` is one bug in a route away from writing
   into another Station — and the widget's cookie has `Path=/w`, one path for
   every installation this deployment serves.
3. **Anonymised listeners are refused** (`listener_anonymized`) and never
   recreated under a fresh row, which is 0034's erasure and the same rule
   `api_record_music_request` and `create_music_request` already keep.
4. **`select … from public.members where id = … for update`**, then the interval
   check. The lock is the point: without it two simultaneous submissions both
   read the same "last request" and both pass, which is a ceiling in name only.
   It is the cure `widget_verify_code` uses for its five-attempt ceiling, for the
   same reason.
5. **`apply_song_intake`** resolves or creates the recording.
6. **The insert**: `channel = 'WEB'`, `show_id` null (D5), `created_by` null,
   `listener_note` from the argument.
7. **`audit_logs`** with `actor_id` null. 0129 says in writing that a null there
   does not mean "the system did it"; a website visitor is not an `auth.users`
   row and must not become one just to give an insert somebody to name.

### 5.3 `track(id)` on the Deezer transport

New, and the sibling of the `album(id)` that already exists. Needed by D4: the
browser sends an integer, so the server has to be able to turn an integer into a
recording. Deezer's `GET /track/<id>` is the call the client module's own header
documents as its verified example of an error arriving with HTTP 200.

Two Deezer calls happen on submit — `track(id)` then `album(albumId)` — and none
per search result, which is the rule `album()`'s existing comment already states.

---

## 6. The screen

`menu.tsx` gains the state of which panel is open and stops rendering its first
button `disabled`. `request-song.tsx` holds the steps: **search → choose → note →
done**.

- **Search** debounces at 400 ms and needs two characters, so a typist does not
  become a load generator against Deezer or against this product's own rate
  limiter.
- **Results** show cover, title, artist and album. `img-src` in
  `src/lib/security/csp.ts` already allows `https://cdn-images.dzcdn.net` (Block
  13a), and the widget goes through the same middleware, so covers need no
  policy change.
- **The note** is a 500-character `textarea` with a counter. The same 500 is the
  column's `check`, so a refusal from the database is never the first news of it.
- **The wait**, when there is one, is shown on opening the panel and again in any
  refusal, in words rather than in seconds.

The actions live in a new `music-actions.ts` beside the existing `actions.ts`,
which is already 28 KB. The songs screen sets the precedent by keeping
`deezer-actions.ts` separate from its own `actions.ts`.

Both actions call `readSessionFor` — never `readSession`. That function exists
precisely because it answers "we minted this session **here**", and 17a's own
comment predicts this block as the place the distinction gets forgotten.

---

## 7. Refusals, by name

The pattern 0161 established: a reason the screen can act on, not one generic
failure.

| reason | what the visitor is told |
| --- | --- |
| `unknown_installation` | this widget is not available |
| `no_session` | identify again (the 30-minute session expired) |
| `listener_anonymized` | this listener's data was erased |
| `cooldown` | you can ask again in *N* |
| `deezer_unavailable` | search is not reachable, try again |
| `deezer_quota` | search is busy, try again shortly |
| `not_found` | that recording could not be read |

The Deezer client already separates quota (`4`, `700`) from not-found (`800`),
and they are different instructions to a human being — wait, versus pick
something else. Every string goes through the 12c catalogue in all three
languages, error messages included.

---

## 8. How it is proved

| suite | what it pins |
| --- | --- |
| pgTAP | a session from another Station refused; an anonymised listener refused; the interval **at its boundary** — one second inside refuses, one second outside passes; **zero means unlimited**; `channel = 'WEB'`; `show_id` null; the audit row with `actor_id` null; `listener_note` over 500 rejected |
| unit | the Zod schemas; the action's mapping of each Deezer failure; `track()` against an injected `fetch`, including the HTTP-200 error body; the interval decomposed to days/hours/minutes and back |
| isolation | `widget_installations` still unreadable to `anon` and `authenticated` after the new column |
| e2e | identify → search → choose → note → submit, and the request appearing on the operator's screen with its note and its channel |

**The boundary test is the one that matters.** A `>` that should be `>=` lives
exactly there, and it survives any test written with a comfortable interval.

---

## 9. Migrations

Two files, because they must be two transactions.

**`0166_widget_music_channel.sql`** — `alter type public.music_request_channel
add value 'WEB'`, alone. `ALTER TYPE … ADD VALUE` cannot share a transaction with
a statement that uses the value; 0082, 0091, 0151 and 0160 each paid for that
rule, and 0160's header states it.

**`0167_widget_music_request.sql`** — everything that uses it:

- `music_requests.listener_note text` + `check (length(listener_note) <= 500)`
- `widget_installations.music_request_cooldown interval not null default '0'`
- `widget_music_request_wait(…)` and `widget_record_music_request(…)`, both
  granted to `service_role` only
- column and function comments, in the voice the schema already uses

---

## 10. Application files

| file | change |
| --- | --- |
| `src/lib/integrations/deezer/transport.ts` | `track(id)` on the interface |
| `src/lib/integrations/deezer/client.ts` | its implementation |
| `src/app/(widget)/w/[publicKey]/music-actions.ts` | new — `searchSongs`, `requestSong` |
| `src/app/(widget)/w/[publicKey]/menu.tsx` | the first button enables; panel state |
| `src/app/(widget)/w/[publicKey]/request-song.tsx` | new — the four steps |
| `src/app/(app)/music/requests/requests-grid.tsx` | the note becomes visible to the operator |
| `src/app/(admin)/admin/stations/widget-tab.tsx` | days / hours / minutes fields |
| `messages/{en,pt-BR,es}.json` | every string, three languages |

---

## 11. What was considered and removed

- **Counting requests per calendar day** — §4. It needs a timezone, a count, and
  it cannot say how long is left.
- **A route handler under `/w` for search** — 17a decided in writing that this
  surface is one page. A server action adds no public route.
- **Calling Deezer from the browser** — no rate limiter, the widget's traffic
  pattern exposed, and `connect-src` would have to be opened for it.
- **Resolving songs at search time** so results could show "already in the
  catalogue" — it would make typing in a search box a way to write to the
  catalogue, which is the flood D1 accepts in one place and should not accept in
  another.
- **Two calls, register-then-request**, mirroring Block 15's two endpoints — it
  brings their half-state along: a song created for a request that never arrived.
- **Publishing the note anywhere automatically** — D3. Moderation, length, and
  what happens when somebody writes something unbroadcastable is a block, not a
  field.

---

## 12. Risks, stated rather than discovered

**A Station with no ceiling has no per-listener ceiling.** Zero is the default
and D2 makes it meaningful, so the only brake is 17a's WhatsApp verification: a
verified listener can fill the presenter's queue. The IP limiter stays, and it
cannot tell two listeners on one network apart. This is the owner's decision, and
the console tab is where it is undone.

**The catalogue grows from public input.** D1 accepts this. `apply_song_intake`
deduplicates, and duplicates that survive land on the merge screen the music
block already has — but the first Station to use this will see its catalogue
change shape.

**Deezer is a third party with a quota.** When it refuses, search stops working
and the widget says so by name. Nothing queues, and nothing retries.

**A tampered payload is no longer possible, but a tampered *choice* is.** D4
means the browser cannot invent a title, but it can send the id of any recording
on Deezer. That is the same thing as searching for it, so it is not a hole — it
is worth writing down so nobody later reads D4 as more protection than it is.
