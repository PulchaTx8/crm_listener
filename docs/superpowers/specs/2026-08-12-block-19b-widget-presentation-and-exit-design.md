# Block 19b — The widget as an application, and a way out of it

**Status:** design agreed with the owner, 2026-08-12.
**Completes:** §11 of `2026-08-11-whatsapp-service-entry-design.md` — the second
of that block's two passes.
**Extends:** Blocks 17a–17c, whose panels this changes the frame around and adds
one button to.

---

## 1. What this is for

Two complaints, from the owner, about the screen Block 19a lands a listener on.

**The first is about arriving.** Somebody taps a link inside WhatsApp and the
browser opens a narrow, transparent column floating in an empty tab — a widget
built to sit in a sidebar of a radio station's website, shown with no website
around it. Nothing on it says which Station it belongs to. The owner's words
were *"a ideia é não causar grande impacto na mudança de ambiente"*: leaving the
chat should not feel like leaving the Station.

**The second is about finishing.** A listener asks for one song, is told the
request arrived, and the only button on the screen is "Voltar" — back to a menu
they did not want. There is no way to say *I am done*, and closing the tab
leaves a live session behind for up to thirty minutes.

Neither is a new capability. The first is a presentation the address already
has enough information to choose; the second is one button and one server
action.

---

## 2. Decisions

The owner's, taken 2026-08-12.

**D1 — The presentation is chosen per request, by the page, and never by an
operator.** `/w/<publicKey>` stays the only address. A request whose
`Sec-Fetch-Dest` is `iframe` is embedded, exactly as today; anything else is an
application. This is §6 of the Block 19 design, with one change decided here —
see D3.

**Shipped with one addition: a cookie carries the decision between requests.**
`Sec-Fetch-Dest` only answers this question on a genuine document request — a
Server Action POST, and the RSC fetch a `router.refresh()` issues, both report
`Sec-Fetch-Dest: empty`, regardless of whether the script making that call is
running inside an iframe, because that is what any script-initiated `fetch()`
reports everywhere. Reading the header directly on every render (the original
shape) meant the menu that replaces the identify form after a correct code —
and the farewell right after "Sair" — briefly rendered with the application's
header and chrome, inside the very iframe this decision exists to keep bare.
`middleware.ts` now reads the header once, on the one request in the round
trip that can answer it, and writes the answer into
`WIDGET_PRESENTATION_COOKIE`; `page.tsx` reads that cookie, falling back to a
direct header read only if it is somehow absent. The decision is still made
from `Sec-Fetch-Dest` and nothing else, once per browsing context — the cookie
is the mechanism that carries that one answer forward to the requests that
cannot ask the question themselves. §3 has the full picture.

**D2 — The Station's logo is the picture that already exists.** `companies.thumb_url`,
the "Foto da emissora" of the console's Station record, drawn as a round icon
beside the name — the shape of the top of a WhatsApp conversation, which is the
continuity the whole presentation exists to preserve. No new column, no new
upload field, and every Station that has already filled the picture in gets the
header without doing anything. A Station with no picture gets its name alone.

**D3 — Anything that is not framed is an application**, with or without a
session. The Block 19 design said *not framed AND a session whose channel is
`WHATSAPP`*, which leaves two screens orphaned: the expired-link screen, which
is the first thing a listener with a stale link sees and has no session by
definition, and the reload after D5's sign-out. Both would render as a 28rem
transparent column in a full tab. The embedded presentation only makes sense
inside a frame, so the condition is the frame and nothing else.

**D4 — "Sair" ends the session; "Voltar" does not.** It clears the cookie and
shows a farewell. The alternative — end the errand, keep the session alive for
the rest of its thirty minutes — was rejected for the widget on a Station's own
website, where the machine may be shared and the next visitor would inherit the
last one's identity. The cost is stated: a listener who changes their mind after
signing out identifies again, and from the WhatsApp door that means sending the
hashtag again, because the link burned on first use.

**Shipped as a redirect to `?left=1`, not as a client-side flip.** `signOutAction`
clears the cookie and then `redirect()`s to `/w/<publicKey>?left=1`; `page.tsx`
renders the farewell for that request, server-side, before it reaches the
ordinary session check. This replaced an earlier version that held the farewell
as state inside `WidgetMenu`, because a Server Action that mutates a cookie
forces Next.js to refresh the very route that decides which screen to draw from
that same cookie — and a farewell held as client state does not survive that
refresh.

**D5 — The farewell offers the way back that fits the door it came from.**
From WhatsApp, a button to the conversation (`wa.me`, built from the Station's
own number). From a Station's website, a button to identify again. A Station
whose WhatsApp number is not recorded gets the farewell without the first
button, never a dead one.

**D6 — "Sair" appears on the menu and on the three screens that end an
errand**, and nowhere else. The three are: a music request recorded, a promotion
entry recorded, and a promotion entry declined. It is deliberately absent from
the middle of a search or a half-filled promotion form, where a button that
discards what was typed sits next to the field being typed into.

---

## 3. How the presentation is chosen

```
        ┌────────────────────────────────────────┐
        │ Request to /w/<publicKey>              │
        └───────────────────┬────────────────────┘
                             │
              isDocumentRequest(method, accept)?
       (GET, Accept: text/html — a real navigation,
        not a Server Action POST or a router.refresh()
        fetch, both of which report Accept: text/x-component
        and Sec-Fetch-Dest: empty no matter what is on screen)
                    ┌────────┴────────┐
                   yes                no
                    │                  │
       Sec-Fetch-Dest == 'iframe' ?    │
        ┌───────────┴───────────┐     │
       yes                      no    │
        │                        │    │
        ▼                        ▼    ▼
  choosePresentation()     choosePresentation()   read WIDGET_PRESENTATION_COOKIE
  = 'embedded'              = 'app'                (written by the LAST yes-branch
        │                        │                  above; untouched by every no)
        └───────────┬────────────┘                          │
                     ▼                                       │
       WIDGET_PRESENTATION_COOKIE rewritten,◄─────────────────┘
       path=/w, SameSite=None, Partitioned,
       session cookie (no maxAge — §2's D1
       addendum has the reason)
                    │
                    ▼
       ┌────────────┴────────────┐
      'embedded'                'app'  (including a
       │                         missing/absent cookie,
       ▼                         which falls back to the
┌─────────────┐           header directly — see D1)
│  EMBEDDED   │           ┌──────────────┐
│             │           │ APPLICATION  │
│ max-w-md    │           │ min-h-dvh    │
│ p-4         │           │ solid bg     │
│ transparent │           │ header:      │
│ html/body   │           │  photo+name  │
│             │           │ larger taps  │
│ no identity │           │ identity read│
│ read at all │           │ once, server │
└─────────────┘           └──────────────┘
```

**Why the header and not the session claim.** The `channel` claim survives a
reload, which is why Block 19a put it in the token — but the cookie's `Path` is
`/w`, one path for every installation this deployment serves, so a browser that
arrived from WhatsApp and later loads the same Station's website carries a
`WHATSAPP` claim into a request that genuinely is an iframe. `Sec-Fetch-Dest`
answers the question actually being asked: is there a frame around me. The claim
is not read for this decision at all.

**The header absent is an application, not an embed.** Every browser this
product supports sends `Sec-Fetch-Dest`; the one that does not is far likelier
to be a script or a very old browser opening the address directly than a modern
site framing it. Failing to the application costs a framed widget a header it
should not have; failing to the embed costs a WhatsApp listener the whole point
of this block.

**`WIDGET_PRESENTATION_COOKIE` is ALSO scoped `path: '/w'`, one jar for every
installation, and that is not the same mistake the paragraph above just ruled
out for the session claim — worth saying once rather than trusting it follows
by analogy.** The claim rejected above names WHO the listener is: a fact about
one installation, which is exactly why `readSessionFor` refuses a session
minted at Station A when Station B's widget presents it — a shared jar there
is a cross-tenant leak. `WIDGET_PRESENTATION_COOKIE` names nothing about a
listener or a Station at all; it is a fact about the BROWSING CONTEXT — is
there a frame around THIS document — which is exactly as true or false for a
tab open on any installation this deployment serves. Reusing the value across
Stations in the same tab is not a leak, because there is nothing station-
specific in it to leak. `Partitioned` still matters here, for an unrelated
reason: without it, a listener with a WhatsApp-minted tab open in one tab and
a Station's own site framing the widget in another would share this one
cookie between two DIFFERENT browsing contexts, and whichever tab's request
landed most recently would silently decide the other tab's chrome too.
Partitioning keys the jar to the embedding site, so the two tabs never
collide — a second, independent reason for the same attribute, on top of the
CHIPS-deprecation one every cookie on this path already needs.

---

## 4. The data

Nothing is stored. `companies.thumb_url`, `companies.name` and
`whatsapp_integrations.display_phone_number` already exist and are already
written by the console; this block only opens a door to read them.

**What that door publishes, stated rather than assumed.** A caller holding a
public key learns a Station's name, its picture and its WhatsApp number. All
three are already on the Station's own website — the same website whose page
carries that public key in an `<iframe src>`. The key proves nothing it did not
already prove.

---

## 5. The door

`0185` adds one function, in the shape `0161` set and `0164` corrected:

```
widget_station_identity(p_public_key text) returns jsonb
  language sql stable security definer
  set search_path = pg_catalog, public
  granted to anon, service_role
```

Answers `{"found": true, "name": …, "thumb_url": …, "whatsapp_number": …}` for
a live installation, and `{"found": false, "name": null, "thumb_url": null,
"whatsapp_number": null}` for **five causes alike**: an unknown key, a disabled
installation, an archived one, a suspended Station (`companies.status`) and a
blocked Organization (`organizations.suspended_at`). One answer for five causes
is `0164`'s rule, and the reason is `0164`'s: a distinct refusal here would
publish a customer's billing status to anybody loading their home page.

`anon`, not `service_role` alone: the caller is `page.tsx`, serving an anonymous
visitor, and `installationExists` already reaches `widget_frame_context` with the
anon key for exactly this reason. Handing this request a service-role client to
ask a question the anon role can answer would be privilege with no use.

`whatsapp_number` is `integrations.display_phone_number` for that Station's row
with `provider = 'WHATSAPP'`, `enabled` and `deleted_at is null` — the same three
conditions every other reader of that table applies. It is null when there is no
such row, when the row is switched off, and when the operator never typed the
number in: a Station that cannot receive WhatsApp has no conversation to send
anybody back to, and one whose number nobody recorded has none we can name.

**The read costs nothing in the embedded case**, because it does not happen: the
page asks only when it has already decided to draw an application.

---

## 6. The screens

### The application frame

`(widget)/layout.tsx` stops deciding. Today it imposes `max-w-md p-4` and the
`html,body{background:transparent}` rule on every request; both belong to the
embedded presentation alone, so both move into the page's branch. The layout
becomes the pass-through its own header comment always described it as.

The application draws:

- a **header** — the round picture and the Station's name, above the panel, not
  scrolling with it;
- a **surface** — `min-h-dvh` with the application's own background, so the tab
  has a floor;
- **larger touch targets** — every `button`, `select`, `input` and `textarea`
  inside the surface gets a minimum height of `2.75rem` (44px, the floor both
  platform guidelines name) and `1rem` text, so a thumb on a telephone hits what
  it aimed at. Applied through a `<style href="widget-app-surface">` block
  scoped to `[data-widget-presentation='app']`, so no panel component is edited
  to get it.

The style block rather than `globals.css` is the mechanism `layout.tsx` already
uses and defends in writing: the widget's visual rules do not enter the file
every other screen shares. It is a second `href`, so React hoists and dedupes it
independently of the transparency rule it never appears alongside.

### The exit

Four screens gain a "Sair": the menu, a recorded music request, a recorded
promotion entry, and a declined one. On the three ending screens it sits beside
"Voltar"; on the menu it sits below the two errand buttons, separated from
them, because it is not a third thing to do. "Voltar" and the errands stay
ordinary buttons; "Sair" is `variant="ghost"` everywhere, because ending a
session is not what most people came for.

**Shipped as a redirect, not a replace-in-place.** The paragraph above
described the first version: "Sair" flipped a piece of client state inside
`WidgetMenu`, which swapped the panel for `<Farewell>` with no reload. That
version did not survive contact with the framework — a Server Action that
mutates a cookie forces Next.js to refresh the very route that decides
`<WidgetMenu>` vs `<IdentifyForm>` from that same cookie, and the refresh won
the race almost every time, replacing the farewell with the identify form
roughly 30ms after it appeared (D4's own addendum has the measurement).
`signOutAction` now clears the cookie and `redirect()`s to `?left=1`, and
`page.tsx` renders `<Farewell>` for THAT request, server-side, before it ever
reaches the cookie-driven branch — a real navigation the forced refresh
cannot outrun, because there is no "this same route, freshly rendered" left
for it to contribute. The farewell carries one button: `wa.me/<digits>` when
the door returned a number, otherwise "identify again" — a plain anchor to
`/w/<publicKey>`, no query string, which a server holding no cookie for this
visitor answers with 17a's form.

---

## 7. What the listener sees when something is wrong

| case | answer |
| --- | --- |
| Station has no picture | the header, with the name alone |
| Station has no WhatsApp number recorded | the farewell, without the button back to the conversation |
| identity door unreachable or refuses | the application frame with **no header** — the panels still work; a Station's name is not worth a screen nobody can use |
| listener reloads after signing out | the farewell again, in the presentation it was shown in — `?left=1` is a real address that `page.tsx` renders server-side, not client state a reload can lose |
| listener signs out from the site widget | the farewell, in the embedded frame, offering "identify again" (D5) rather than a WhatsApp button — this listener never came from WhatsApp, and the identity door is never read for a framed request. Tapping "identify again" is what reaches 17a's form; signing out by itself does not skip the farewell |

---

## 8. How it is proved

**pgTAP** (`supabase/tests/`):

- `widget_station_identity` returns name, picture and number for a live
  installation;
- it returns `found: false` for each of the five causes, in **five separate
  assertions** — a single "not found" test passes against a function that
  forgot four of the joins;
- `anon` may execute it and the grant is not wider than `anon, service_role`.

**Unit** (`vitest`):

- the presentation decision, over `Sec-Fetch-Dest` of `iframe`, `document`,
  `empty` and absent;
- the number reduced to digits for `wa.me`, including a number typed with
  punctuation and one that reduces to nothing;
- `signOutAction` clears the cookie with the same five attributes it was minted
  with, and does so whether or not the presented token is still valid.

**e2e** (`playwright`):

- a WhatsApp arrival shows the header with the Station's name; the same page
  framed does not;
- "Sair" reaches the farewell, and the frame lands on an address carrying
  `left=1`; the farewell stays visible rather than flickering back to the
  identify form (the D4 addendum's own defect, held across a full second, not
  merely checked once); a reload of that same address answers the farewell
  again; and only a request carrying no `left` param at all — the session
  cookie genuinely gone — shows the identify form.

The e2e assertions go through the screen, never around it — a test that sets the
cookie itself and skips `/enter` proves the frame and not the door, which is the
lesson Block 17a's spec records in writing.

---

## 9. What was considered and removed

**A separate `logo_url` column.** A second image on the Station record, wide and
transparent, distinct from the photo. Removed: it costs a migration, a console
field and a round of work for every Station, and until they do it the header
shows a name alone — which is what the photo they already uploaded was going to
avoid.

**A query parameter set by `/enter`.** Cheaper than reading a header, and gone
on the first reload.

**Deciding by the `channel` claim.** Wrong for the reason §3 gives: the cookie's
path is shared across every installation, so the claim outlives the arrival it
describes.

**"Sair" on every panel.** Rejected with the owner: a button that ends the
session, sitting beside a half-filled promotion form, is a way to lose work.

**Keeping the session alive after "Sair".** Rejected: on a shared machine the
next visitor inherits the last one's identity, and the widget on a Station's
website is exactly where shared machines are.

---

## 10. Risks, stated rather than discovered

**`Sec-Fetch-Dest` is a request header, and the middleware may cache.**
`frame-cache.ts` caches frame origins for sixty seconds per key; nothing in this
block may join that cache, because the answer varies per request in a way the
key does not capture. The identity read is per-request and uncached.

**The header is the first thing that renders and it blocks the panel.** The
identity read happens on the server before anything is sent. A slow or
unreachable database must not hold the panel: the read failing is a header that
does not appear (§7), not a page that does not.

**A Station's picture is served from Supabase Storage.** `img-src` already
allows that origin — the promotion pictures in `enter-promotion.tsx` come from
the same bucket — so no CSP change is needed. If one turns out to be, it belongs
in `csp.ts` with the reason written next to it, not in a `<meta>` tag.

**`display_phone_number` is typed by an operator, not validated.** It reaches
`wa.me` reduced to digits; anything that reduces to an empty string produces no
button rather than a broken link.

---

## 11. Delivery

One pass. The door, the presentation branch, the exit and its farewell, the
translations in three languages, and every test in §8. Migrations start at
`0185`; the repository is at `0184`.
