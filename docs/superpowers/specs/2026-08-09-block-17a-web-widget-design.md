# Block 17a — The public door, and a visitor this product can name

**Date:** 2026-08-09
**Status:** awaiting review
**Block:** 17a (the first of three; see §2 for the split)

---

## 1. What this is for

Every Station has a website of its own, and a listener who is standing on it
cannot do anything. To request a song or to enter a promotion they have to leave
and open WhatsApp, which is the one door this product has ever had.

This block opens a second door: a page this product serves, embedded in an
`<iframe>` on the Station's own site, which identifies the visitor and hands them
a menu. It does **not** yet take a music request or a promotion entry — those are
17b and 17c, and they are built on top of what this block proves.

What ships here is the part everything else rests on, and the part that is
dangerous to get wrong: a public URL, a hole in this product's anti-framing
defences, and a verified telephone number.

---

## 2. Why three blocks, and what is in this one

The widget needs five things that do not exist. Two of them are screens; three of
them are a security boundary.

| | |
| --- | --- |
| **17a** | the installation and its public key, the framing exception, the WhatsApp verification code, the visitor session, the listener and their consent, and the console tab that configures it |
| **17b** | Deezer search inside the widget, and the request recorded with channel `WEB` |
| **17c** | the promotion list, the step walker, and the participation recorded with source `WEB` |

17b and 17c are independent of each other and **both depend entirely** on 17a. A
single block would mean the first defect in the public door is discovered after
two screens have been built on top of it.

The reuse is what makes 17b and 17c small. `api_record_music_request` (0152)
already resolves a listener, registers a song out of a Deezer payload and records
the request — 17b is a screen and an enum value. `whatsapp_conversation_steps`
(0066) already computes the step list from `(promotion, member)` and knows
nothing about WhatsApp — 17c walks the same list, so a promotion configured once
works through both doors with no second implementation.

---

## 3. Decisions

All decided with the owner on 2026-08-09.

**D1 — The identification is verified, always, for both flows.** A code travels
over WhatsApp and the visitor types it back. The alternative considered and
rejected was verifying only for promotions, on the reasoning that a music request
is low-stakes; the owner chose one identification rather than two, so the phone
number this product holds means the same thing whichever door it came through.

The problem this solves is not hypothetical and it is the reason the block exists
in this shape. On WhatsApp the number is **proved** — the message arrived from it.
On a web form anybody types anything. Without verification, a visitor enters a
promotion under a neighbour's number, the draw runs, and the prize comes out in
the wrong name; worse, they fill in a CPF and an address belonging to somebody who
never consented, which is an LGPD exposure with this product's name on it.

**D2 — The code travels outward: this product sends it.** The visitor never
leaves the page. It costs a Meta AUTHENTICATION-category template per Station and
a per-conversation charge.
Rejected: a `wa.me` deep link with a prefilled word, which the existing webhook
would recognise. It needs no Meta approval, costs nothing, and opens the 24-hour
service window as a bonus — but it sends the visitor out of the site, needs
WhatsApp Web on a desktop, and returning to the tab is where people are lost. It
also means teaching `ingest_whatsapp_event` a second kind of inbound message,
which is the most delicate code in this repository.

**D3 — A promotion asks for what a promotion declares.** `promotion_requested_field`
(0040) has held the eight fields since the promotions block, and every promotion
already names the ones it wants. The widget walks that list and nothing else.
Rejected: making CPF mandatory on the web. It would make the same promotion
collect different things through the two doors, and the operator's screen would
show WhatsApp entrants with no CPF beside web entrants with one, for one
promotion, with nothing on the row to explain it.

This decision belongs to 17c, and is recorded here because it is what makes 17c
small enough to be its own block.

**D4 — The public key is not a secret, and is named so it cannot be mistaken for
one.** It sits in the `src` of an `<iframe>` on a public web page. The column is
`public_key`, and its comment says in writing that it identifies a Station and
authenticates nobody. Everything that actually defends this door is elsewhere:
the origin allowlist, the rate limits, and the code of §6.

**D5 — The visitor's session is a signed token, not a row.** A session table
would be one row per visitor per visit carrying a telephone number — a new
retention obligation, with a sweep and a pruning story attached, for state that
lives thirty minutes. An HMAC stores nothing and therefore has no retention story
at all.

**D6 — The frame-ancestors lookup is cached for 60 seconds per instance, and
only on document requests.** The alternative is a database round trip on every
widget page load, from the Edge runtime, before anything renders. With
`output: 'standalone'` each instance holds its own cache.

The cache cuts both ways and the second direction is the one that matters. An
origin just **added** may not frame for up to a minute — harmless lag. An origin
just **removed**, or an installation just disabled, may keep framing for up to a
minute — a real window, bounded and accepted. Sixty seconds is the whole argument
for the number: long enough to make the cache worth having, short enough that
revocation is a wait rather than an incident. Anybody lengthening it is trading
away the second sentence, not the first.

**D7 — This block records the consent that covers identification, and not the
promotion's consent step.** The promotion's consent is the first entry in the
list `whatsapp_conversation_steps` builds, and it is walked in 17c. Writing it
here would put 17c's rule in a block that does not test it.

**D8 — The code is enqueued through the outbox, not sent from the request.**
It costs up to one worker tick — roughly ten seconds — before the message leaves.
Paid deliberately: `outbox_messages` (0059) already carries the dedupe key that
collapses a double-click into one send, already has the retention story for a
telephone number in the clear, and already retries. A direct Graph call from the
route handler would be faster and would put a phone number somewhere with none of
those three.

---

## 4. The installation

### 4.1 The table

```sql
create table public.widget_installations (
  id, organization_id, company_id,     -- the Station, with the composite FK
  public_key      text not null,       -- NOT A SECRET. See D4.
  enabled         boolean not null default false,
  allowed_origins text[] not null default '{}',
  created_by, created_at, updated_at, deleted_at
);
```

One per Station, held by a partial unique index on `company_id where deleted_at
is null` — the shape `message_templates` (0110) uses, and for the same reason its
comment gives: without the partial, archiving a stale installation would leave
the console unable to create its replacement.

RLS enabled, **no policy**, the shape `integrations` (0057) and `api_credentials`
(0148) both use. This schema revokes the default ACL, so
`createServiceClient().from('widget_installations')` fails with 42501 by design
and every reader is inside a `SECURITY DEFINER` body.

`enabled` defaults to **false**. A Station that has just been given an
installation is not yet serving a widget to the public; somebody has to say so.

`allowed_origins` holds full origins (`https://radio.com.br`), validated on write
against `^https?://` with no path and no trailing slash — the shape
`prizes.photo_url` (0145) and `companies.thumb_url` (0153) already use for the
same class of value. An empty array means the widget frames nowhere, which is the
correct meaning of "no origins are allowed" and not a synonym for "any".

### 4.2 The route

`/w/<publicKey>`, in a new `(widget)` route group with a layout that draws none of
the application chrome.

A one-segment prefix on purpose: it has to be excluded by name in two places
(`next.config.mjs`'s header source and the middleware matcher), and a prefix that
appears in a regex twice should be short and unmistakable.

### 4.3 The framing exception

This is the most delicate change in the block. Two defences stand in the way, both
placed deliberately in Block 11a, and the comment on each one says the other
exists and that letting them disagree "is the shape of an accident":

- `frame-ancestors 'none'` — `src/lib/security/csp.ts:69`
- `X-Frame-Options: DENY` — `next.config.mjs:109`

**`X-Frame-Options` cannot be relaxed by a later rule.** Next applies every
matching `headers()` entry and the browser obeys the strictest. The global
`source: '/:path*'` therefore becomes `'/((?!w/).*)'`. There is no other way to do
this, and a second entry for `/w/:path*` that "overrides" it does not work — it
would ship a widget that frames nowhere and looks like a browser bug.

`frame-ancestors` is per-Station, so it must come from the database, and the
middleware runs on the Edge. It gains a branch for `/w/`, placed **before the
Supabase client is constructed** — exactly where `middleware.ts:95` already puts
the `/` redirect, and for the reason that comment gives: an anonymous visitor must
not pay a `getUser()` round trip whose answer is discarded.

The branch:

1. Only for document requests (`GET`, `accept:` contains `text/html`). The server
   action POSTs from inside the frame carry no framing question and skip it.
2. Reads the installation's origins through a `SECURITY DEFINER` RPC callable by
   `anon`, cached 60 seconds in module scope (D6).

   **`anon` is not a new privilege class here but it is a new shape.** The role
   already reaches two things — inserting a `contact_requests` row (0006) and
   reading the branding bucket (0146) — and neither is a function. This is the
   first `SECURITY DEFINER` body granted to `anon`, so it is written to the
   standard that implies: it takes a public key, it returns an origin list and a
   boolean, and it returns nothing else. No Station name, no id, no count. What
   an unauthenticated caller can learn from it by guessing keys is which keys
   exist, which is what a key in an iframe `src` already tells them.
3. Builds the policy with `frame-ancestors <origins>` instead of `'none'`.
4. **An unknown, disabled or origin-less key gets `'none'` and the ordinary
   404.** The refusal is the default, reached by every path that is not a
   successful lookup, including a failed one — a cache miss that cannot reach the
   database must not fall open.

`buildContentSecurityPolicy` gains a parameter for this and stays a pure
function, which is the whole reason it was extracted in Block 11b: the policy is
the thing most likely to decay one keyword at a time, and a policy nobody can
assert is a policy that will.

---

## 5. The console tab

`/admin/stations` → the customer → the Station → a new **Widget** tab.

Enable and disable, the origin list, the public key shown and copyable (it is not
a secret), and the ready-made `<iframe>` snippet.

This follows D9 of Block 15 without restating the argument: the console edits, the
product displays. There is no widget settings screen at `/app` and no gear on the
Station card.

**The tab says, plainly, when the Station has not registered a `WEB_VERIFICATION`
template.** Without that line the console shows an enabled widget that will never
send a code, and the failure surfaces to a listener rather than to an operator.
The template itself is registered on the Templates screen that already exists —
no new screen for it.

---

## 6. The verification code

### 6.1 The table

```sql
create table public.widget_verifications (
  id, organization_id, company_id, installation_id,
  phone        text not null,          -- normalised, the members convention
  code_hash    text not null,          -- sha256 hex, CHECK ^[0-9a-f]{64}$
  attempts     integer not null default 0,
  expires_at   timestamptz not null,   -- ten minutes
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
```

`code_hash`'s CHECK mirrors `api_credentials.token_hash` (0148) and
`webhook_events.external_id` (0058), which refuse a raw identifier by shape.

Six digits, generated with `crypto.randomInt` in Node and **hashed before
anything reaches the database** — the rule the WhatsApp webhook follows for the
`wamid`, whose comment gives the reason: an argument passed to an RPC lands in
query logs and in backups.

**No constant-time comparison, and that is correct rather than an oversight** —
the same argument `src/lib/api/credentials.ts:41` already writes down. What
arrives is hashed before anything happens and what is stored is a hash, so the
lookup is an indexed equality. What protects a six-digit code is not the clock: it
is the ceiling of five attempts and the ten-minute expiry, both of which are
stated here so nobody later "hardens" this into a scan.

A row is burned on the fifth wrong attempt and a new code must be requested.

### 6.2 The send

`enqueue_whatsapp_outbound` (0071, extended by 0111 to carry a template) with a
new `template_purpose` value, `WEB_VERIFICATION`. `message_templates` (0110) says
in its own comment that "a later block adds a second rather than renaming this
one, because Task 4 references it by name" — this is that block.

Drained by the existing worker tick, so the message leaves within roughly ten
seconds (D8).

### 6.3 The limits

**This is the endpoint that spends money.** Whoever calls it makes Meta bill the
Station, so it carries the tightest limits in the product:

| | |
| --- | --- |
| per phone | one code every 60s, five per hour |
| per IP | ten per hour |
| per Station | an hourly ceiling, so one abuser cannot burn one Station's budget |

`PostgresRateLimiter`, never the in-memory one — the reasoning Block 15 already
recorded: with `output: 'standalone'` there may be several instances, each with
its own counter, which is acceptable for a person clicking and not for a script.

The per-Station ceiling is the one that is not about fairness. Without it, a
script requesting codes for a thousand invented numbers produces a bill rather
than an outage, and a bill is discovered a month later.

---

## 7. The session

On a correct code, an HMAC signed with an environment secret, carrying
`{installationId, companyId, memberId, phone, exp}`, valid thirty minutes, in a
cookie:

```
HttpOnly; Secure; SameSite=None; Partitioned; Path=/w
```

**`SameSite=None` is mandatory**, not a preference. A `Lax` cookie is not sent
inside a third-party iframe, so the widget would identify a visitor and then fail
to know who they were on the next click — which reads as this product being
broken, not as a cookie policy.

**`Partitioned` is mandatory for the same class of reason.** Chrome is removing
unpartitioned third-party cookies; CHIPS is how a legitimate embedded widget keeps
state, scoped to the pair (embedding site, this site), which is exactly the scope
this session should have had anyway.

Verified in Playwright from a genuinely foreign origin (§9), because neither
attribute does anything observable in a same-origin test.

---

## 8. The listener, and the menu

A `SECURITY DEFINER` door resolves or creates the listener through the `0061`
cores — `apply_member_lookup`, the upsert, and the link core — the same three the
WhatsApp door and the Block 15 API door already use. Nothing new decides who a
listener is.

An anonymised listener is refused and never recreated, the rule every door in this
system holds: recording fresh activity against somebody who exercised erasure is
precisely what the erasure was for.

The consent recorded here covers identification — the basis for holding a name and
a telephone number — and not the promotion's own consent step (D7).

`member_consent_type` (0032) holds three values and none of them is this one:
`rules` is agreement to a *promotion's* rules, which is 17c's business. A fourth,
`identification`, is added, and the row carries `origin = 'web-widget'` so an
audit can tell a number typed on a Station's website apart from one that arrived
over WhatsApp. The table has been append-only since 0032 — a withdrawal is a new
row — and nothing here changes that.

The menu has two buttons, disabled until 17b and 17c land.

---

## 9. How it is proved

**pgTAP** — `39_widget_installations.test.sql`, `40_widget_verification.test.sql`:
a disabled installation refused; an expired code; the fifth attempt burning the
row; a code issued against Station A failing to verify at Station B; the listener
link written; an anonymised listener refused.

**Vitest** — the HMAC session forged, expired and tampered with; code generation
and hashing; the origin-list parser; the new branch of
`buildContentSecurityPolicy`, including the refusal path.

**Playwright** — the whole identification **inside an iframe served from a foreign
origin**. This is the only configuration in which the cookie attributes and
`frame-ancestors` are exercised at all; a same-origin test passes while proving
nothing, which is the same lesson Block 16 recorded about its own journeys.

**The isolation suite** — a session minted for Station A writes nothing into
Station B.

---

## 10. Migrations

| | |
| --- | --- |
| `0159` | `widget_installations`; RLS on, no policy |
| `0160` | `template_purpose add value 'WEB_VERIFICATION'` and `member_consent_type add value 'identification'` — **the two `ADD VALUE`s and nothing else** |
| `0161` | `widget_verifications`, and the doors: lookup by key, request a code, verify a code, identify |
| `0162` | the console doors, gated on `is_platform_admin()` |

`0160` carries no statement other than the two, for the Postgres reason 0082,
0091 and 0151 already paid for: `ADD VALUE` cannot share a transaction with a
statement that **uses** the value. The two may share this file because neither
uses the other's; `0161` uses both, and is a separate file therefore a separate
transaction.

---

## 11. Application files

- `src/app/(widget)/w/[publicKey]/` — the page, the layout, the server actions
- `src/lib/widget/` — the session HMAC, the code generation and hashing, the
  origin-list parsing
- `src/services/widget-installations.ts`
- `src/schemas/widget.ts`
- `src/lib/security/csp.ts` — the `frame-ancestors` parameter
- `src/middleware.ts` — the `/w/` branch, above the Supabase client
- `next.config.mjs` — the header source becomes `'/((?!w/).*)'`
- `src/app/(admin)/admin/stations/` — the Widget tab
- `messages/*.json` — three languages

---

## 12. What was considered and removed

- **Verifying only for promotions** (D1). The owner chose one identification.
- **The `wa.me` inbound code** (D2). Free and approval-less, but it sends the
  visitor away from the site and teaches `ingest_whatsapp_event` a second kind of
  message.
- **Mandatory CPF on the web** (D3).
- **A session table** (D5).
- **A per-request origin lookup** (D6).
- **A settings screen at `/app`** — the console edits, following Block 15's D9.

---

## 13. Risks, stated rather than discovered

**The authentication template is per Station.** Every new radio has a Meta
approval step before its widget can work at all. §5's warning line exists so that
this is discovered in the console rather than by a listener staring at a box that
never fills.

**The framing hole is a real hole.** `/w/` is the one route in this product that
may be embedded, and the allowlist is what keeps it to the Stations' own sites. A
mistake in §4.3 does not fail loudly — it produces a widget that frames anywhere,
and nothing on any screen would say so. This is why the CSP builder is a pure
function with its own tests, and why the refusal is the default branch.

**Third-party cookie policy is a moving target.** `Partitioned` is the current
answer. If it changes, the widget breaks in a browser release rather than in a
deployment, with nothing in our logs to say why.

**The code costs money.** §6.3's limits are the whole defence. They are the first
thing to check when a Station reports an unexpected Meta bill, and the per-Station
ceiling is what turns that from a bill into a rate-limit log line.

**A verified number is not a verified person.** Somebody holding a handset is who
this proves. A shared family phone enters a promotion once, and that is the same
truth the WhatsApp door has always had — stated here so nobody reads
"verified" as more than it is.
