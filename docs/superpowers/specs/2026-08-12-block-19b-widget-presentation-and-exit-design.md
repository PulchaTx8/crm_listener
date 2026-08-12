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
                    ┌─────────────────────────┐
                    │ GET /w/<publicKey>      │
                    └───────────┬─────────────┘
                                │
                   Sec-Fetch-Dest == 'iframe' ?
                    ┌───────────┴───────────┐
                   yes                      no  (including the header absent)
                    │                        │
             ┌──────┴──────┐          ┌──────┴───────┐
             │  EMBEDDED   │          │ APPLICATION  │
             │             │          │              │
             │ max-w-md    │          │ min-h-dvh    │
             │ p-4         │          │ solid bg     │
             │ transparent │          │ header:      │
             │ html/body   │          │  photo+name  │
             │             │          │ larger taps  │
             │ no identity │          │ identity read│
             │ read at all │          │ once, server │
             └─────────────┘          └──────────────┘
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

The farewell replaces the panel in place — no reload — and carries one button:
`wa.me/<digits>` when the door returned a number, otherwise "identify again",
which refreshes the page and gets 17a's form back from a server that no longer
sees a cookie.

---

## 7. What the listener sees when something is wrong

| case | answer |
| --- | --- |
| Station has no picture | the header, with the name alone |
| Station has no WhatsApp number recorded | the farewell, without the button back to the conversation |
| identity door unreachable or refuses | the application frame with **no header** — the panels still work; a Station's name is not worth a screen nobody can use |
| listener reloads after signing out | the farewell again, in the presentation it was shown in — `?left=1` is a real address that `page.tsx` renders server-side, not client state a reload can lose |
| listener signs out from the site widget | 17a's identify form, in the embedded frame, as an expired session already does today |

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
- "Sair" on the recorded-request screen reaches the farewell, and a reload after
  it lands on the identify form.

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
