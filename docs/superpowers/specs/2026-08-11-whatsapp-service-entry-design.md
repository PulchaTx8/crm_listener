# Block 19 — WhatsApp becomes a door into the widget, not a second product

**Status:** design agreed with the owner, 2026-08-11.
**Supersedes, in part:** the conversational participation flow of Blocks 5a and 5b.

---

## 1. What this is for

A listener sends a hashtag to the Station's WhatsApp number and is served. Today
that means a conversation: the bot asks for a name, a city, a CPF, one message at
a time, and the answers become a participation. After this block it means a
**link**: the bot answers once, with a URL that already knows who the listener
is, and the whole of the service happens on the screen Blocks 17a–17c built.

The owner's requirement, in their words, is that WhatsApp and the widget be *"apenas
diferentes canais de entrada para o mesmo mecanismo de atendimento"*. This design
takes that literally. WhatsApp does exactly one thing — recognise a hashtag and
hand back an addressed door — and owns no step of the service at all.

**What that buys, and it is the whole argument for the shape:** there is no second
implementation of asking for a song, no second implementation of entering a
promotion, no second set of limits, refusals or consent rules to keep in step
with the first. A change to the music panel is a change to both channels because
there is only one panel.

---

## 2. Decisions

The owner's, taken 2026-08-11.

**D1 — The service happens in the browser, never in the chat.** The hashtag is
answered with a link. Nothing about a song, a promotion or a listener's data is
collected over WhatsApp messages after this block.

**D2 — The link arrives already authenticated, is good for 15 minutes, and burns
on first use.** Somebody who wrote to the Station from their own number has
already proved that number; asking them for a verification code afterwards is
the step most of them abandon at. The cost is stated rather than hidden: whoever
holds that URL within its 15 minutes acts as that listener. It is bounded by the
short life, by the single use, and by the fact that it was delivered to that
listener's own WhatsApp.

**The same hashtag sent again within two minutes returns the link already
minted**, rather than a second one. That is what an impatient listener sending
three messages gets — one answer, one working link — and it is why minting is a
door with state rather than a signed string. After two minutes the next message
mints a fresh code and the previous one is finished.

**D3 — Three hashtags, one order.** A message is matched against the Station's
live promotions first, then the Station's music hashtag, then its service
hashtag. First match wins; no match is silence, as it is today.

**D4 — A promotion's hashtag opens THAT promotion**, even when `web_enabled` is
off. Sending the hashtag *is* asking to take part in it, and the flag continues
to mean only "appears in the widget's list for somebody who arrived without a
hashtag". **Rules stay mandatory**: they are the text the listener accepts, and
17c writes that consent — a promotion with no rules answers that it is
unavailable rather than entering somebody into something unwritten.

**D5 — One screen, two presentations.** `/w/<publicKey>` stays the only address.
Framed, it is the 28rem transparent column it is today; opened from a WhatsApp
link it is a full-height application with the Station's name and logo. The
decision belongs to the page, which knows how the request arrived, and never to
the operator, who would have to be asked a question they have no way to answer.

**D6 — The two Station hashtags are edited on `/templates/messages`** and stored
on `widget_installations`. Blank means the door is closed, which is the state
every Station starts in.

**D7 — Conversations already open are allowed to finish.** No hashtag starts a
new one. The engine keeps answering whoever is mid-flow until they finish or
their state expires; a later block removes the machinery once nothing is using
it. Nobody loses what they already typed.

**D8 — The reply's wording is a system message**, per Station, with a default in
code — the mechanism `/templates/messages` already edits. The link is appended on
its own line rather than interpolated into a placeholder, because a placeholder
an operator can delete is a message that arrives without its link.

---

## 3. The path of one message

Everything not marked NEW is already in production.

1. Meta → `POST /api/webhooks/whatsapp`. Signature over the raw bytes, then one
   row per message in `webhook_events`, idempotent on `sha256(wamid)`, then a
   tick is fired. The route decides nothing.
2. The worker takes an event `FOR UPDATE SKIP LOCKED`, resolves the Station from
   `phone_number_id` and the listener from the sender's phone — both as today.
   **NEW:** instead of entering the listener into a promotion, it matches D3's
   three hashtags, mints a single-use code and queues one outbound message
   carrying the link. **The ingest transaction makes no external call**: it
   writes to `outbox_messages`, and a separate sender talks to Meta. Neither
   Meta nor Deezer can slow the intake of the next message.
3. **NEW:** the listener opens `GET /w/<publicKey>/enter?k=<code>`. The handler
   consumes the code atomically, mints the widget session with `channel:
   'WHATSAPP'`, and redirects — `?open=music`, `?open=promotion&id=<uuid>`, or
   the menu. The code leaves the address bar with that redirect.
4. From there it is the widget: the same server actions, the same doors, the
   same limits, the same refusals.

---

## 4. The data

**Two columns on `widget_installations`:**

```
music_hashtag   text  -- null means this door is closed
service_hashtag text  -- null means this door is closed
```

Shaped by the same rule promotions use (`#` then letters and digits), and
**refused when they collide**, case-insensitively, with each other or with a
live promotion's hashtag at that Station. The collision matters because D3
matches promotions first: a Station hashtag equal to a promotion's would simply
never answer, and no screen would say why.

**A table, `widget_link_tokens`:**

```
id, organization_id, company_id, member_id, public_key,
purpose        -- 'MUSIC' | 'MENU' | 'PROMOTION'
promotion_id   -- present only for PROMOTION
token_hash     -- sha256 of the code; the raw value exists only in the URL
expires_at, consumed_at, created_at
```

RLS on, no policy, ACL revoked: it is reachable only from inside `SECURITY
DEFINER` bodies, like every other table holding a listener's identity.

**Why a table and not a signed token like the session.** Single use is state —
there is no way to *burn* a token that is not written down — and D2's two-minute
resend window needs the same state. A signed token can be verified but never
revoked, and the widget session (which is signed, and stateless, and 30 minutes
long) is what it is precisely because it does not need either.

**Three keys on `system_message_key`**, with defaults in `engine.ts` beside the
existing copy: the text that accompanies the music link, the promotion link and
the menu link.

---

## 5. The doors

| function | does |
| --- | --- |
| `set_service_hashtags(company, music, service)` | writes D6's two columns, checking `templates.manage`, refusing the collisions of §4 |
| `mint_widget_link(company, member, purpose, promotion)` | returns a live code, or **the code already minted for that listener, that purpose and that promotion in the last two minutes**; a different purpose is a different question and gets its own |
| `consume_widget_link(code_hash)` | marks it used and returns the claims, or refuses; the update is `where consumed_at is null` and returns the row, so two simultaneous opens have exactly one winner |
| `widget_station_identity(public_key)` | the Station's name and `thumb_url`, for the application header |

`ingest_whatsapp_event` (0062) is rewritten around D3 and D7: match, mint, queue,
finish — and leave an open conversation's answers on the old path.

### The permission seam, stated rather than discovered

`templates.manage` will write two columns on `widget_installations`, a row the
console otherwise owns. That is a deliberate mismatch: the owner chose the screen,
and the alternative — a third permission for two text fields — is the mistake
Block 18 already documented at length in `docs/PERMISSIONS.md`. The door is the
boundary, and it checks the permission the screen is gated on.

A Station with no installation gets the two fields **disabled with the reason**.
Creating an installation stays a console act; 0159's own comment explains why it
is an intention somebody declares rather than a row that appears.

---

## 6. The screens

**`/templates/messages`** gains a settings block above the message list: the two
hashtags, saved through §5's door, with the collision refused in words an
operator can act on.

**`/w/<publicKey>`** gains a second presentation, chosen per request:

- `Sec-Fetch-Dest: iframe` → embedded, exactly as today;
- otherwise, with a session whose channel is `WHATSAPP` → application: full
  height, its own background, larger touch targets, the Station's name and logo
  at the top.

The 28rem cap and the transparent background move out of the route group's
layout and into that decision. Reloading keeps the presentation, because the
channel is a claim in the signed session rather than a query parameter.

---

## 7. What the listener sees when something is wrong

| case | answer |
| --- | --- |
| link expired or already used | a screen saying so, and to send the hashtag again — never a 404, which reads as broken |
| promotion ended between the link and the tap | the refusal the widget already has |
| Station has no installation, or it is switched off | silence on WhatsApp; the reason is recorded on the event for the operator |
| listener anonymised (LGPD) | no link, by the same door that already refuses |
| Meta unreachable when the reply is sent | the outbox retries; the code is already valid and waiting |

The reply is **free-form text within the 24-hour window** the listener's own
message opened, so it needs no approved template — and therefore does not meet
the language-label refusal that has bitten this project before.

---

## 8. How it is proved

**pgTAP.** The three hashtags and their order; a collision refused; a code
consumed exactly once when two callers race; the two-minute window returning the
same code; an expired code refused; a reprocessed event producing neither a
second code nor a second message.

**Unit.** Hashtag validation; the presentation choice (framed versus
application); the composition of the outbound message and its appended link.

**e2e.** The whole journey: a signed webhook delivery, a tick, the link in the
outbox, the link opening the screen already identified in application mode, a
song request recorded, and the same link refused on a second tap.

**Load, because "hundreds at once" is the requirement and cannot be taken on
faith.** ~200 events from ~200 listeners injected at once; every one gets exactly
one link, with the right listener and the right Station. Nothing mixed, nothing
lost. If anybody later derives a code from shared state, this is the test that
falls over.

---

## 9. What was considered and removed

- **A conversational music request over WhatsApp** — searching Deezer by text
  and choosing by number. It is a worse search than the screen's, and it would be
  a second implementation of the one thing this block exists to stop duplicating.
- **A separate route for the WhatsApp channel.** Two addresses means two sets of
  headers, two session paths and two places a defect can hide.
- **A per-Station switch between conversation and link.** It is the "two
  independent flows" the owner asked to avoid, and it doubles what must be tested
  forever.
- **A stateless signed link.** Cannot be single-use, cannot be revoked, cannot
  support the resend window.
- **A web app manifest and `theme-color`.** Would make "add to home screen"
  produce a real icon. Nothing in the flow needs it; it is a later block's line.

---

## 10. Risks, stated rather than discovered

**A link is a bearer credential.** D2 accepts this consciously. Fifteen minutes,
one use, hashed at rest, and delivered only to the number that wrote in.

**Promotions that were WhatsApp-only now require rules.** Anything with a hashtag
and no rules text answers "unavailable" instead of entering somebody. Operators
must be told before this ships, and the promotions screen should say so where the
hashtag is typed.

**The conversational engine becomes dead weight** the moment the last open
conversation closes. D7 keeps it alive on purpose; leaving it there forever is
how a codebase acquires a second way to do everything. Removing it belongs in the
next block, not this one.

**A late `enqueue_whatsapp_outbound` failure can spend D2's window for nothing,
and look identical to a healthy suppressed repeat.** Fix round 1 moved the
context read (`widget_link_send_context`) ahead of `mint_widget_link` so a
Station gone dark refuses before any code is minted -- but the mint itself
cannot be moved: the code has to exist before there is anything to enqueue.
`mint_widget_link` answers a code and burns the two-minute window in the same
statement, before the one message carrying that code is ever sent. If
`enqueue_whatsapp_outbound` then fails -- a lock, a dropped connection, the
outbox table momentarily unreachable -- `sendServiceLink` rethrows, the caller
defers the event, and the retry re-ingests *inside* the two-minute window:
`mint_widget_link` finds the unconsumed token it just minted, answers null (its
contract for "this listener already has a working link"), and the turn closes
`already_answered` having sent nothing at all. On every screen an operator can
read -- the event's outcome, the worker's tick counters -- this is
indistinguishable from the ordinary case the window exists to produce: a
listener who genuinely sent the hashtag twice. There is no code fix in this
wave; it is written down here so the gap is a decision, not a surprise found
later. Candidates for the next round: make the mint and the enqueue one
transaction (the two are on different systems -- Postgres and the outbox table
are the same database, so this may be simpler than it sounds, but the outbox
row still only becomes a real WhatsApp send on a LATER worker tick, and that
send is what actually has to happen before the window's cost is real); or
shorten the window enough that the operator-visible blast radius -- one silent
turn, once, per failure of this kind -- is bounded and named as an accepted
cost rather than an invisible one.

---

## 11. Delivery, in two passes

This is more than one sitting's work, and the seam is natural.

**19a — the door.** The two columns and their screen fields, `widget_link_tokens`,
the three doors, the rewritten `ingest_whatsapp_event`, the `/enter` route
handler, the `channel` claim, the three message defaults, and every test in §8
including the load one. At the end of 19a the flow works end to end and the
screen it lands on is the widget exactly as it looks today.

**19b — the presentation.** `widget_station_identity`, the application shell, the
move of the 28rem cap and transparent background out of the route group's layout,
and the `Sec-Fetch-Dest` decision.

Migrations start at `0177`; the repository is at `0176`.
