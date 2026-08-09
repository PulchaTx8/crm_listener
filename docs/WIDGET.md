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
the **Templates** screen that already exists (`/templates/whatsapp`) — there
is no second screen for it.

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

**An unknown key, a disabled installation, or an archived one all get a plain
404** — one answer for three causes, deliberately, so probing a public key
learns nothing an `<iframe src>` did not already say.

**An installation with no origins configured is a different case, and it
does not 404.** `widget_frame_context` (`0161`) decides whether an
installation is `found` by matching the key, `enabled`, and `deleted_at is
null` — it never looks at `allowed_origins`. So the page exists, is enabled,
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

1. The visitor types a phone number (and a name, if the number is new to this
   Organization) and asks for a code.
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
