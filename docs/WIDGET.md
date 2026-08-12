# The web widget

One route a Station embeds on its own site: a page this product serves inside
an `<iframe>`, which identifies a visitor over WhatsApp — the number is
proved, not typed — and hands them a menu. Introduced in Block 17a; the design
and the reasoning behind every rule below are in
`docs/superpowers/specs/2026-08-09-block-17a-web-widget-design.md`.

```
GET /w/<publicKey>   the page a Station's website embeds in an <iframe>
```

It does not yet take a music request or a promotion entry — the menu shows
two buttons and both are disabled. That is 17b and 17c, built on top of what
this page proves.

---

## 1. Before anything: `WIDGET_SESSION_SECRET`

The widget signs its visitor session with an HMAC (design D5) rather than
storing a row, and the key for that HMAC is `WIDGET_SESSION_SECRET` — a plain
environment variable, checked in `src/lib/env.ts`:

```
WIDGET_SESSION_SECRET: z.string().min(32).optional()
```

**It is set nowhere in this repository except `playwright.config.ts`**, which
invents a fixed value for the e2e run only. It is not in `.env`, and
deliberately not in `.env.example` — that file already omits
`WORKER_TICK_SECRET` and `WHATSAPP_APP_SECRET` for the same reason (it is not
an inventory of every variable a deployment might need), so this is the
document where the omission gets said in writing: **a widget deployment needs
`WIDGET_SESSION_SECRET`, and nothing else configures it.**

Without it, both server actions in `src/app/(widget)/w/[publicKey]/actions.ts`
refuse before the database is touched:

```
logger.error('widget: WIDGET_SESSION_SECRET is not configured; refusing to send a code');
```

That line reaches a server log and nothing else on the request path. The page
itself renders normally — the identify form shows, a phone number can be
typed, the button can be pressed — and what a visitor sees is "This is
temporarily unavailable. Try again in a few minutes." There is nothing on
screen distinguishing this from a real outage, because from the visitor's side
there is nothing to distinguish.

**A developer running `npm run dev` with no `WIDGET_SESSION_SECRET` set gets
exactly this: a widget that looks broken, with the only diagnostic sitting in
a server log they may not be watching.** Set it before running the widget
locally — 32 characters at minimum, any value:

```
WIDGET_SESSION_SECRET=<32+ random characters>
```

The 32-character floor is not arbitrary: this secret is compared byte-for-byte
inside an HMAC (`src/lib/widget/session.ts`) rather than hashed first, unlike
the API tokens `docs/API.md` describes, so it needs real entropy rather than
mere non-emptiness.

---

## 2. Installing a widget for a Station

From the platform console: **/admin/stations → the customer → the Station →
the Widget tab.**

The tab writes `enabled` and the origin allowlist, and shows the public key
and a ready-made `<iframe>` snippet once the first save has created the row:

```html
<iframe
  src="https://pulchatx.com/w/pw_<key>"
  width="360"
  height="520"
  style="border:0"
></iframe>
```

That is the whole of what a Station's webmaster pastes onto their own site.
The console edits, the widget itself is what runs at `/w/<publicKey>` — there
is no widget settings screen at `/app` and no gear on the Station card
(following D9 of Block 15).

**`enabled` defaults to false.** A Station that has just been given an
installation is not yet serving a widget to the public until somebody says so.

**The public key is not a secret**, and the tab says so: it identifies a
Station inside an `<iframe src>` a third party pastes onto their own public
page, and it authenticates nobody. Everything that actually defends the door
is elsewhere — the origin allowlist below, the rate limits in §6, and the
verification code itself.

---

## 3. The origin allowlist, and that empty means nowhere

`allowed_origins` holds full origins — `https://radio.com.br` — one per line
or comma-separated in the console's textarea. Each entry is checked against
the same grammar the database's CHECK constraint enforces (`0159`, mirrored in
`src/lib/widget/origins.ts` so the console refuses a bad entry before the
database ever sees it): a scheme and a host, with an optional port, and
**nothing else** — no path, no trailing slash, no query string. A trailing
slash never matches what a browser sends as the ancestor origin, and the
failure it causes is a widget that silently does not load.

**An empty allowlist means the widget frames nowhere.** It is not a synonym
for "any" and is never treated as one — the function that turns a validated
origin list into the CSP's `frame-ancestors` value returns `'none'` for an
empty list, on purpose, because the tempting shortcut ("stay open until
somebody configures it") would make every widget with no origins set
embeddable from any site on the internet, with nothing on any screen saying
so.

The console stops at the first invalid line and names it back, rather than
collecting every bad one — there is one text field to report against, and an
operator fixing one line will hit the next bad line on the next save anyway.

---

## 4. The per-Station template, or the widget can never send a code

Every new radio needs an approved Meta `AUTHENTICATION`-category template
before its widget can send a single verification code. The template's
`template_purpose` is `WEB_VERIFICATION`, and it is registered per Station on
the **Templates** screen that already exists (`/templates/whatsapp`), which
carries one card per purpose — there is no second screen for it.

*(Worth knowing if you are reading old task reports: that card did not exist
until the block's fix wave. `TEMPLATE_PURPOSES` was a hand-written array
holding `PICKUP_REMINDER` alone, so the screen rendered no card and the
registration schema refused the value, and no operator could register this
template through any path at all. The purpose list is now derived from the
generated `template_purpose` enum, so a third value cannot be added to the
database without this screen failing to compile.)*

**The Widget tab warns, plainly, when the Station has no such template
registered**, regardless of whether the widget is enabled — an operator about
to flip a Station's widget on is exactly who benefits from seeing this first.
Without that warning the console would show an enabled widget that will never
send a code, and the failure would surface to a listener instead of an
operator: a visitor who requests a code at a Station with no approved template
sees "this station cannot send codes" and nothing arrives, ever.

This costs a per-conversation Meta charge on every code actually sent — see
the limits below.

---

## 5. What a visitor sees

The page has exactly two states, decided server-side with no round trip: a
visitor this deployment cannot name (by a valid, non-expired session cookie
scoped to this installation) gets the identify form; one it can gets the menu.

**An unknown key, a disabled installation, an archived one, a suspended
Station and a blocked Organization all get a plain 404** — one answer for five
causes, deliberately, so probing a public key learns nothing an `<iframe src>`
did not already say. The last two matter for a second reason: a distinct
refusal would publish a customer's billing status to anybody who loads their
home page.

**Suspension and blocking are read live, at the door, and there is nothing to
switch back on afterwards.** `suspend_company` sets `companies.status` and
blocking an Organization sets `organizations.suspended_at`; neither touches
`widget_installations.enabled`, and `0164` joins both conditions into all
three widget doors rather than having those functions disable the installation.
So releasing a customer restores their widget with no console step — and,
before `0164`, a Station suspended for non-payment went on framing, went on
billing its owner for verification codes, and went on writing listeners into a
blocked Organization until somebody remembered to disable the installation by
hand.

**An installation with no origins configured is a different case, and it
does not 404.** `widget_frame_context` (`0161`, rewritten by `0164`) decides
whether an installation is `found` by matching the key, `enabled`, `deleted_at
is null`, an active Station and an unblocked Organization — it never looks at
`allowed_origins`. So the page exists, is enabled,
and answers normally: visited directly, at its own URL, it renders the
identify form exactly like any other widget. What refuses is *framing*, not
the page — the allowlist is read separately to build the CSP's
`frame-ancestors` value, and an empty list becomes `'none'`
(`frameAncestorsValue`, `src/lib/widget/origins.ts`), so the page cannot be
framed by anything at all.

**This is the first thing to check when a widget loads fine at its own URL
but stays blank inside an iframe on the Station's site**: open the console's
Widget tab and look at the origin list before looking anywhere else. A page
that works alone and a blank iframe is the signature of an empty or wrong
allowlist, not of a broken installation.

**The identify flow:**

1. The visitor types a phone number **and a name — both always** — and asks for
   a code. `identifySchema` and `verifySchema` (`src/schemas/widget.ts`) both
   require the name and the input is `required`, so the door's `name_required`
   refusal is unreachable from the widget: it exists for a caller that is not
   this page. A returning listener types their name again and it is discarded,
   because `widget_verify_code` only uses it on the branch that registers
   somebody new. Asking a returning visitor for something already known is the
   price of not stashing a name in the database, or in a second cookie, before
   the number has been proved theirs.
2. The code is six digits, generated in Node and hashed before it reaches the
   database. It is enqueued through the outbox and drained by the existing
   worker tick — roughly ten seconds before it actually leaves (design D8),
   paid deliberately for the dedupe key and retry behaviour the outbox already
   has.
3. The visitor types the six digits back. Five wrong attempts burn the code; a
   new one has to be requested. Ten minutes is the expiry either way.
4. On a correct code, the browser receives a signed session cookie
   (`pw_session`) valid thirty minutes:
   ```
   HttpOnly; Secure; SameSite=None; Partitioned; Path=/w
   ```
   `SameSite=None` and `Partitioned` are both mandatory rather than a
   preference — a `Lax` cookie is not sent inside a third-party iframe at all,
   and `Partitioned` (CHIPS) is how the session keeps working as browsers
   remove unpartitioned third-party cookies.
5. Identified, the visitor sees a menu with two buttons — **Request a song**
   and **Enter a promotion** — both disabled, with a tooltip saying only that
   they are coming soon. Building either here would put a screen in this
   block that does not test it; they are 17b and 17c.

---

## 6. Limits, because this is the endpoint that spends money

Whoever calls the request-a-code action makes Meta bill the Station, so it
carries the tightest limits in the product:

| | |
| --- | --- |
| per phone | one code every 60 seconds, five per hour |
| per IP | ten per hour |
| per Station | 200 per hour |

The per-Station ceiling is the one that is not about fairness: without it, a
script requesting codes for a thousand invented numbers produces a bill rather
than an outage, and a bill is discovered a month later. All of it runs on
`PostgresRateLimiter`, never the in-memory one — `output: 'standalone'` means
several instances may be running, each with its own counter, and an
in-memory limit would multiply every number above by however many containers
happen to be up.

Every rate-limit refusal reaches the visitor as "too many requests", with no
distinction between which limit was hit — a script gains nothing from knowing
which of four counters stopped it.

---

## 7. Two operational traps

Both of these cost a full end-to-end run to diagnose the first time, and
neither is discoverable from its own failure message.

**`npm run db:reset` empties Storage, and nothing re-seeds the branding
hero.** The sign-in screen's picture lives in the `branding` bucket, put there
by `npm run seed:branding` — not by `supabase/seed.sql`, because SQL cannot
put bytes in a bucket. A `db:reset` run leaves that bucket empty, and
`tests/e2e/login.spec.ts` then fails on
`img[src*="/storage/v1/object/public/branding/login-hero.png"]` never becoming
visible. The failure reads like a branding regression. It is not — re-run
`npm run seed:branding` and the suite goes green again. Anyone resetting the
database mid-session should expect this and re-seed before running
`login.spec.ts`.

**`tests/e2e/dashboards.spec.ts` has a cold-compiler flake that passes
warm.** `next dev` compiles each route on its first request rather than
ahead of time, and the first Playwright journey to reach an uncompiled
`/app/dashboards/*` route can miss its assertion's timeout waiting on that
compile — the same signature `playwright.config.ts` already documents at
length for why the local suite runs at `--workers: 1` (a cold compiler can
fail 24 of 48 journeys at once, all of them looking like a broken sign-in).
Running `dashboards.spec.ts` a second time, warm, against a server that has
already compiled those routes once, passes. This is not a regression in
anything the widget touches — it is a property of the local dev server the
whole e2e suite already lives with.

---

## 8. Block 17b — asking for a song

The menu's first button works. A listener searches Deezer inside the widget,
picks a recording, may leave a note, and it lands in `music_requests` with
channel `WEB` — the same table the presenter's screen has always read.

**The search is Deezer, always** (D1). Not the Station's catalogue with Deezer
behind it. The catalogue therefore grows from what the public asks for, and
`apply_song_intake` — the same core Block 15's two endpoints call — is what
keeps that from becoming a pile of duplicates: it resolves by ISRC, by
`deezer_track_id` and by title-and-artist before it creates anything.

**The browser sends an integer, never a record** (D4). It posts a
`deezer_track_id`; the server asks Deezer what that recording is. Nothing the
client sends describes the song, so nothing the client sends can name what lands
in a Station's catalogue.

### The wait between requests

`widget_installations.music_request_cooldown` is an **interval**, not a count per
day. The console tab has three boxes — days, hours, minutes — and **all three at
zero means no ceiling at all**, which is the column's default.

An interval was chosen over "N per day" for three reasons worth keeping: it needs
no timezone (a daily reset has to pick whose midnight), it needs no counting (one
comparison against the listener's most recent `WEB` request), and it can say how
long is left, so the widget says *you can ask again in 12 minutes* rather than
*you have reached the limit*.

**One consequence to know before setting it:** with a one-day interval, a
listener who asked at 23:50 waits until 23:50 the next day. They do not get a
fresh allowance ten minutes later.

The ceiling counts only `channel = 'WEB'` (D6) — an operator recording a request
on a listener's behalf does not spend that listener's web quota.

### Where each guard lives, and why

| guard | where | why not the other place |
| --- | --- | --- |
| the cooldown | `widget_record_music_request` (0167) | atomic with the insert, and the member row is locked before it is read — without that lock two simultaneous submissions both pass |
| per-IP limits | the server actions | the database has no idea what an IP address is |
| the wait shown on opening the panel | `widget_music_request_wait` (0167) | courtesy, not enforcement: it exists so nobody searches, chooses and writes a note before learning they must wait |

### The note

`music_requests.listener_note`, up to 500 characters, and **only the operator
sees it** (D3). Nothing publishes it anywhere automatically. It appears under the
song title on `/music/requests`, clamped to two lines with the whole text in the
element's `title`. Moderation — and what happens when somebody writes something
unbroadcastable — is deliberately not built.

### What has no ceiling by default

A Station that never sets a cooldown has **no per-listener ceiling**. The brakes
that remain are 17a's WhatsApp verification and the per-IP limiter, and the
second cannot tell two listeners on one network apart. This is the owner's
decision, and the console tab is where it is undone.

---

## 9. Block 17c — entering a promotion

The menu's second button works. A listener reads a promotion's rules, agrees,
answers whatever it asks, and the entry lands in `participations` with source
`WEB` — the same table the operator's screen, the draw and every report read.

### A promotion now says which doors it takes part through

`promotions` carries **two** flags: `whatsapp_enabled` and **`web_enabled`**. The
operator ticks either, both, or neither, on the promotion's Participation tab.

**This replaced a constraint, and the replacement is the interesting part.**
`promotions_whatsapp_shape` forbade requested fields and art on a promotion
without WhatsApp — true while WhatsApp was the only thing that could ask a
listener anything, and false the moment a second door existed. It is now two
constraints:

| constraint | says |
| --- | --- |
| `promotions_conversational_shape` | art and requested fields need **some** door |
| `promotions_whatsapp_fields` | the hashtag and the button labels are WhatsApp's alone |

Two rather than one widened condition, so an operator who forgot a hashtag is
not told the same thing as one who put art on a promotion that converses
nowhere. **Art is erased when the last door is switched off**, which is what
0144 always did when WhatsApp was the only one.

### Two conditions to appear in the widget

`web_enabled` **and** a rules text. They say different things — where the
promotion belongs, and what this door requires as content — and **ticking the box
does not make the rules mandatory**: a promotion can be saved for the web while
somebody writes the wording, and the form says it is not visible yet.

**On the day this ships, every Station's widget list is empty.** `web_enabled`
defaults to false and no promotion has rules. That is the design working, and it
will look like a defect to anybody who has not read this.

### What the door writes, and the one divergence

`widget_enter_promotion` does what `complete_conversation` (0071) does — the
field values onto `members` through the shared `apply_member_field_values`, one
confirmation per field answered, then `apply_participation(..., 'WEB', answers)`
— **plus a `rules` consent row, which the WhatsApp flow does not write at all.**

That divergence is deliberate: there is now a rules text that was displayed and
agreed to. **The owner has ruled that WhatsApp will record the same consent when
that door is next worked on.** Until then the two differ, in writing.

Declining is a real path: it writes `promotion_refusals` stamped `WEB` and
nothing else.

### The guard that matters most

**The door recomputes the step list server-side.** The screen is not the
authority on what a promotion asks — a promotion edited while somebody had the
widget open would otherwise be answered wrongly, and a crafted payload would skip
whichever field it found inconvenient. Proved by mutation: raising the threshold
so the guard never fires fails two pgTAP assertions.

### Deploying this one is not like the others

**`0172` is not additive.** It replaces `create_promotion`, `update_promotion`
and `set_promotion_art` with new signatures. Code without the migration breaks
saving a promotion; the migration without the code calls a signature that no
longer exists. **Both orders break** — apply `0170`–`0172` immediately on merge,
not "soon after".

---

## 10. Block 18 — which programme the song is for

The music panel gained one step, and it comes **before** the search: a listener
says what they are asking for, then finds it. That is the order the owner
described, and it is the reason the step is not tacked onto the note screen.

**Choosing is optional** (D6), and three things follow from it that are easy to
get wrong in the other direction:

- The default option is **"Qualquer horário"**, not a blank. A select whose only
  meaning is "none chosen" is a question with no answer.
- A Station with **no programmes gets no step at all**, rather than a select
  holding one option.
- A programme list that **could not be read answers as empty**. A listener with a
  song to ask for is not stopped by a list they never asked to see.

**Every programme still on the air is offered, not only today's.** Somebody may
ask on a Tuesday for Saturday's programme. The ones airing right now are
*labelled* rather than filtered, through `shows_on_air`, which converts through
`companies.timezone` — the Station's own clock, never the server's.

### The two traps this step is built around

**The chosen id travels in a hidden input on the screen that submits.** It is
picked two screens before the send, and an input rendered only where it was
picked posts nothing. That is exactly the defect 17c's consent checkbox had; it
was found by re-reading rather than by a test, and this is the same shape.

**The id's ownership is decided by the database, not by the browser.** The schema
checks the *shape* only. `widget_record_music_request` resolves the id against
the Station and writes null for anything else, so a programme id copied from
another Station cannot reach `music_requests.show_id`.

`widget_shows(p_public_key, p_member_id)` exists because a visitor holds no
`music.view` and `shows` is readable only with it. It applies
`widget_listener_context`'s three refusals and returns every programme still on
air with an `on_air` flag.

---

## 11. Block 19a — a hashtag becomes a door

Before this block, a hashtag sent to a Station's WhatsApp number opened a
conversation inside WhatsApp itself. It no longer opens anything there.
Every match — a promotion's own hashtag, or one of a Station's two general
ones — is answered with exactly one message carrying a link into this same
widget page, and the visitor arrives already identified: no phone number
typed, no code to wait for. `ingest_whatsapp_event` never returns
`{outcome: 'conversation'}` any more; every hashtag match now returns
`{outcome: 'link', purpose, ...}`, and the worker's job is to turn that into
one message.

### `NEXT_PUBLIC_SITE_URL`, or every hashtag answers with silence

A hard prerequisite of this whole path, unlike `WIDGET_SESSION_SECRET` in §1:
`sendServiceLink` (`src/services/whatsapp-link.ts`) refuses to mint or send a
link without it, and `src/lib/env.ts` has required it in the strict
environment schema since Task 9's fix round 1 — a deployment missing it now
fails to boot rather than booting clean and deferring every matched hashtag
onto the retry ladder until it parks, silently, with nothing at startup
saying why. Set it to the address customers actually reach; the widget link
a listener receives is built directly from this value.

### Three hashtags, one order

A Station configures two of them itself, on **Templates → Messages**
(`/templates/messages`): the **music hashtag** and the **service hashtag**,
written together through `set_service_hashtags` and gated on
`templates.manage` — the same permission that screen's other card already
requires, on purpose, rather than a third permission for two text fields.
The third belongs to a promotion (`promotions.hashtag`, unchanged since
Block 4c).

An inbound message is matched against exactly one of the three, in exactly
this order, first match wins:

1. **A live promotion's own hashtag.** The INGEST matches it inside its own
   window — `starts_at <= <the message's own timestamp> < ends_at` — the
   same rule Block 4c has always judged a promotion hashtag by, judged
   against when the message arrived rather than against now(). A DIFFERENT,
   WRITE-TIME rule governs whether a Station may set a general hashtag equal
   to a promotion's own — `ends_at > now()` — and it is deliberately
   broader: an ended promotion no longer shadows a Station's word (Block
   4c's own trade, forbidding reuse forever is worse than the collision it
   prevents), but a promotion that has not started YET still clashes,
   because the day it opens it silently takes the word. See
   `set_service_hashtags`, two paragraphs below, for that second rule.
2. **The Station's music hashtag** — opens the music panel directly
   (`open=music`).
3. **The Station's service hashtag** — opens the plain menu (`open` absent;
   the visitor chooses from there).

The order is specific rather than incidental: a promotion's hashtag is the
narrow word printed on one flyer, and a Station's two are the general ones a
listener might type any day of the year. Reversing the order would silently
retire whichever promotion hashtag happened to collide with a general one.

`set_service_hashtags` refuses a Station hashtag equal to a promotion's own
(live now, or not started yet, at that same Station) at write time — the one
moment an operator is looking — with a readable sentence rather than a raw
constraint violation.

### Fifteen minutes, one use, and a two-minute window if you ask twice

The link is a single-use code (`mint_widget_link`, `consume_widget_link`),
not a signed token: single use is *state*, and there is nothing to burn in a
value nobody wrote down.

- **Fifteen minutes.** A code not opened inside that window is exactly as
  useless as one already used — `consume_widget_link` answers the identical
  "ask again" either way (see the failure table below).
- **Single use.** The code is consumed in the same UPDATE that reads it
  (`consumed_at is null` in the predicate), so two browsers racing to open
  one link have exactly one winner; the loser sees no row, never a stale
  one.
- **A two-minute window.** A listener who sends the same hashtag again
  inside two minutes of the first gets no second message. Only the SHA-256
  of the code is ever stored, so there is no raw value left to hand back a
  second time even in principle — the window therefore answers **null**,
  and the worker reads null as *say nothing*, which is the whole of the
  protection against five hashtags in a row producing five messages. The
  window is per **(listener, purpose, promotion)**: asking for a song and
  then, inside the same two minutes, asking for the menu still gets two
  messages, because those are two different things being asked for — and so
  does asking to enter two DIFFERENT promotions inside the same two minutes,
  because those are two different things too, even though both share the
  PROMOTION purpose.

### Free-form, because the listener spoke first

The link message is sent as ordinary, free-form text — never an approved
Meta template — and that is not an oversight, it is what the listener's own
message already bought. Sending the hashtag opens Meta's 24-hour customer
service window, and a reply inside that window needs no template at all;
only a message a business *starts* does. §4's `WEB_VERIFICATION` template is
a different door with a different constraint (17a's own code-based identify
flow, which can be asked for with no prior message from the listener at
all), and this one has none of that requirement.

### A promotion's hashtag needs rules text, or it answers nothing

A link into the widget is an invitation to accept a promotion's rules and
take part. A promotion with no rules text has nothing to show on that
screen, so its hashtag answers with **silence** rather than a broken link —
`ingest_whatsapp_event` finishes the event `no_rules` and the worker sends
nothing. `web_enabled` is deliberately **not** part of this check: sending
the hashtag already *is* asking to take part, whatever the widget's own
promotion list would otherwise have shown.

This is checked only once a message is confirmed able to enter at all — a
repeat, or a spent ceiling, is still recorded and answered exactly as it
always was (Block 4c/5a), because that is a fact about the message the
Station received and has nothing to do with whether rules text exists yet.

### The failure table — never a 404 for a WhatsApp-minted link

`/w/<publicKey>/enter?k=<code>` is the door every link points at. Whatever
goes wrong, the visitor lands on `/w/<publicKey>?link=expired`, which
renders one plain sentence above the identify form — never an error page,
and never the plain 404 an unknown or disabled installation gets on every
other path into this widget.

| what happened | `consume_widget_link` answers | visitor sees |
| --- | --- | --- |
| code never existed, already used, or its fifteen minutes ran out | `{ok: false, reason: 'unusable'}` | "ask again" |
| the Station was switched off, suspended or archived, or its Organization was blocked, after the link was minted | `{ok: false, reason: 'unavailable'}` | "ask again" |
| the code was minted for a *different* Station's public key | claims resolved, but the key does not match the one in the address | "ask again" |
| `enqueue_whatsapp_outbound` fails *after* `mint_widget_link` already spent D2's two-minute window, and the retried turn re-ingests inside it | never called — no code was ever sent | nothing; the event closes `already_answered`, indistinguishable on every screen from a listener who genuinely sent the hashtag twice |

**The fourth row is a different kind of failure from the first three, and
belongs in this table anyway.** The other three are about a visitor who
*has* a link and taps it; the fourth is about a listener who never receives
one — `consume_widget_link` is never even called, because no code reaches
WhatsApp's send queue. Spec §10 tracks it as a known risk rather than a fix:
`mint_widget_link` cannot be moved after the enqueue (the code has to exist
before there is anything to enqueue), so a failure in that one gap between
minting and sending is currently silent and unbounded. No code change in this
wave — the row exists so the gap is documented, not discovered.

**The dark-Station case is the whole reason the second row of this table
exists as a separate one from the first.** `page.tsx` 404s an unknown,
disabled or archived installation on every ordinary visit — probing a
public key must learn nothing an `<iframe src>` did not already say. A
WhatsApp-minted link is the one path where that would be the wrong answer:
the link was correct when it was sent, the Station simply went dark in
between, and a 404 reads as a broken link rather than as "try again". So
`page.tsx` carries one exception: when `?link=expired` is present, a
Station that resolves to "not found" still renders the identify form
instead of 404ing. Probing that parameter learns nothing new either way — an
unknown key and a real, dark Station render the identical sentence.

**`consume_widget_link` decides this itself** — it does not trust the
installation's `enabled` flag alone; it joins `companies` and
`organizations`, the identical join `installationExists` already makes
through `widget_frame_context` (0164). Both sides of the door have to agree
for the same reason: the first version of this fix carried the join into
`mint_widget_link` and `widget_link_send_context` (so a code is never
*minted* for a Station that is already dark) but missed `consume_widget_link`
itself, so a Station that went dark in the fifteen minutes *between* the
mint and the tap answered `ok: true` anyway — the route minted a session
and redirected without `link=expired`, and `page.tsx`, finding no
installation, gave the plain 404 this section exists to rule out. Both
doors now make the same check for the same reason.

### One session claim carries where the visitor came from

A session minted from a WhatsApp link carries `channel: 'WHATSAPP'` on its
signed claims (`WidgetClaims`, `src/lib/widget/session.ts`); one minted from
17a's own identify form on the Station's own site carries none. Nothing in
this block reads that claim — it exists for what comes after. The **door** a
request or an entry is submitted through is a separate fact from the
**channel** the visitor arrived by: a song request made from a
WhatsApp-minted session still lands in `music_requests` with `channel =
'WEB'`, because `channel` on that table has always meant which door
recorded it, not how the listener got there.

---

## 12. Block 19b — two presentations, one address

`/w/<publicKey>` decides how to draw itself from the request's `Sec-Fetch-Dest`:

- **`iframe`** — the embedded widget: a 28rem column with a transparent
  background, so a Station's own page shows through around it. This is every
  widget on every Station's website, and it is unchanged since Block 17a.
- **anything else, including the header being absent** — the application: full
  height, its own background, larger touch targets, and a header carrying the
  Station's picture and name. This is what a listener sees after tapping the
  link a WhatsApp reply carried.

The header's picture is **the Station's picture** — the "Foto da emissora" of
the console's Station record (`companies.thumb_url`). A Station that has not
uploaded one gets the header with its name alone. There is no separate logo
field and none is planned.

Every screen that ends an errand, and the menu, offers **"Sair"**: it clears the
session cookie and shows a farewell. From the WhatsApp door the farewell offers
a way back to the conversation, built from the Station's own
`integrations.display_phone_number`; a Station whose number is not recorded gets
the farewell without that button. From a Station's website it offers to identify
again.

**"Sair" is a redirect, not a state flip.** `signOutAction`
(`src/app/(widget)/w/[publicKey]/actions.ts`) clears the cookie and then
`redirect()`s to `/w/<publicKey>?left=1`; `page.tsx` renders the farewell for
that request, server-side, before it ever reaches the ordinary session check.
The first version held the farewell as client state inside the menu instead,
and a Server Action that mutates a cookie forces Next.js to refresh the very
route deciding which screen to draw from that same cookie — so that version's
farewell was replaced by the identify form roughly 30ms after it appeared,
before a listener could read it. Reloading `?left=1` now answers the farewell
again, every time; only a request carrying no `left` param at all sees what the
cookie's absence actually means.
