# Block 20b — The sidebar becomes a tree, and four things move

**Status:** design agreed with the owner, 2026-08-12.
**Second of three:** the owner's list of 2026-08-12 carries nine items. Block
20a took items 1 and 2 (the two widget defects, PR #65). This block takes items
3, 4, 8 and 9 — the navigation — plus the navigation half of item 5. Block 20c
takes what is left of 5, and 6 and 7: the three catalogue screens and the album
thumbnail.

---

## 1. What this is for

The sidebar has grown for twenty blocks by appending. It now carries eleven
sections and twenty-six links, all open at once, in an order nobody chose — the
order they were built in. Four complaints, all the owner's, all about the same
thing: the list no longer describes the product.

- **Pedidos sits under Música.** It is a listener asking for something, not a
  record in the catalogue, and everything else a listener does is under
  Audiência.
- **The section is called Música but holds a catalogue** — songs, artists,
  labels, genres, albums.
- **Relatórios and Administração sit third and fourth**, between Painéis and
  Estoque, cutting the operational sections in half with two administrative
  ones.
- **Everything is open, always.** Twenty-six links is a wall, and the shape of
  the product is invisible inside it.

None of this is new capability. Three items are the order and wording of one
array in `src/lib/auth/shell.ts`. The fourth is one component.

---

## 2. Decisions

The owner's, taken 2026-08-12.

**D1 — Pedidos moves to Audiência.** `/music/requests` leaves the catalogue
section and joins Ouvintes, Participações and Programas. Same reasoning Block
6c used to move Participações out of Promotions, applied again: this is the
listing of PEOPLE asking, and it belongs beside the audience rather than beside
the recordings it happens to reference. The href does not change.

**D2 — Música becomes Catálogo, and the "Catálogo" item becomes three.**
Renaming the section alone would produce a section named Catálogo containing an
item named Catálogo — the "one link rendered twice" this codebase warns against
in three separate comments in the file being edited. Rather than ship that for
one block and delete it in the next, **the item is replaced now** by Gravadoras,
Gêneros and Álbuns, pointing at `/music/catalog?tab=labels`, `?tab=genres` and
`?tab=albums`. Those three addresses work today: `parseCatalogTab` in
`music/catalog/page.tsx` already reads exactly that vocabulary.

The consequence, and it is the point: **the navigation is final when this block
ships.** Block 20c changes what those three addresses render, not where they sit
in the sidebar.

**AMENDED 2026-08-13, on the owner's ruling: the `?tab=` addresses are an
interim, and Block 20c replaces them with real routes** — `/catalog/labels`,
`/catalog/genres`, `/catalog/albums`. `/music/catalog` goes away with them.

The owner's words: *"o grande erro cometido é não ter eliminado a tab"*. They
are right, and the shortcut cost more than it saved. Item 5 asked for the tabs
to STOP EXISTING, not to be linked to from three places; pointing the sidebar at
`?tab=` kept them alive under a new name. It also caused a defect that a real
route could not have: the sidebar's active-link test compares a pathname against
an href, and these three hrefs carry a query string that a pathname never does.
Fixing that meant reading `useSearchParams()`, which then failed to observe the
client-side canonicalisation the catalogue screen performs on a bare
`/music/catalog` — so on that arrival no catalogue item highlights at all.

**That defect is deliberately NOT patched here.** It is a property of the
interim addresses, and it disappears with them. Patching a query-matching rule
scheduled for deletion is polish on something already condemned.

The sidebar's ITEMS and their order are still final. Only their `href`s change
in 20c, and they change once.

**D3 — Relatórios and Administração move to the end, after Organização.** Not
"before Modelos", which is what the owner's item 8 says and which is already
true — they sit third and fourth today and Modelos is ninth. The owner's intent,
settled on 2026-08-12, is the opposite direction: everything administrative
gathers at the foot of the list, below the operational sections and below
Modelos and Organização. Plataforma stays last of all, because it is appended
after the array for platform admins only.

**D4 — The sidebar becomes a tree, collapsed by default.** Every section is a
disclosure. Nothing is expanded on a first visit except the section holding the
page the caller is on, which is always expanded. What a caller opens is
remembered between visits.

**D5 — The remembered state is a cookie, read on the server.** The shell already
renders on the server; a cookie read there means the sidebar arrives in the
right state rather than expanding and then collapsing after hydration. This
project already carries two precedents for a cookie deciding presentation: the
locale cookie, and `WIDGET_PRESENTATION_COOKIE` from Block 19b.

**D6 — WITHDRAWN. The home stays `/app`.** This decision was taken on
2026-08-12 and withdrawn by the owner on 2026-08-13, once implementing it made
the cost visible. It is left here rather than deleted because the reasoning is
worth keeping for whoever proposes it again.

It was never one of the owner's nine numbered items: it came from
disambiguating *"tudo recolhido e a /dashboards/audience aberta"*, and both
readings were chosen before anyone knew what the second one cost.

What it costs: `/dashboards/audience` redirects to `/app` for a caller who can
reach no Station with the permission it needs, so **the landing stops being the
same screen for every member**. Forty-odd assertions across twenty e2e specs
assert a fixed home after signing in; some break outright, and — worse — which
home a member gets depends on the Stations left behind by whichever spec ran
first, so the suite's result would depend on its execution order.

If the audience dashboard should be the front door, it is its own item with its
own spec, and the honest version of it decides what a member with no audience
permission sees rather than bouncing them somewhere else.

---

## 3. The order after this block

```
VISÃO GERAL      Minhas emissoras
PAINÉIS          Visão geral da audiência · … da música · … das promoções
ESTOQUE          Estoque · Movimentações
AUDIÊNCIA        Ouvintes · Participações · Programas · Pedidos          ← D1
PROMOÇÕES        Promoções · Retiradas
CATÁLOGO         Músicas · Artistas · Gravadoras · Gêneros · Álbuns ·
                 Manutenção                                              ← D2
MODELOS          Mensagens · WhatsApp
ORGANIZAÇÃO      Equipe · Cargos
RELATÓRIOS       Meus relatórios                                         ← D3
ADMINISTRAÇÃO    Trilha de auditoria                                     ← D3
PLATAFORMA       Organizações · Emissoras · Pedidos de contato   (admin only)
```

Manutenção stays last inside Catálogo, for the reason its own comment already
gives: it is the destructive one, and a sidebar is read top to bottom.

---

## 4. The tree

### 4.1 Sections need a stable key

`NavSection` today is `{ label, items }`, and `label` is the output of
`t('audience')` — a translated string. A cookie keyed on it would forget every
expansion the moment somebody switched language, and would key Portuguese and
English installations differently for no reason.

So `NavSection` gains `key: string` — `'overview'`, `'dashboards'`,
`'inventory'`, `'audience'`, `'promotions'`, `'catalog'`, `'templates'`,
`'organization'`, `'reports'`, `'administration'`, `'platform'`. The message
key and the section key are deliberately the same word, but they are not the
same thing and neither is derived from the other: renaming a section's copy
must never silently reset everybody's sidebar.

### 4.2 What decides whether a section is open

Two inputs, combined in `SidebarNav`:

1. **The cookie**, a comma-separated list of the section keys this caller has
   expanded. Absent means none — which is D4's default, expressed as the
   absence of state rather than as a list of every section.
2. **The active section** — the one containing an item matching the current
   path, by the same `pathname === href || pathname.startsWith(href + '/')`
   rule the component already uses to mark the active link.

A section renders open when it is in the cookie **or** it is the active one.
The active section is never written to the cookie: it is open because of where
the caller is, and it must go back to whatever they chose once they leave.

`usePathname()` is available while a client component renders on the server in
the App Router, and `SidebarNav` already depends on that today for its active
link. So both inputs are known at first render and there is no hydration
mismatch and no flash.

A caller may still collapse the active section by hand; it re-opens on the next
navigation. That is what "always opens the section you are on" means, and it is
what the owner asked for.

### 4.3 The cookie itself

`pulchatx_nav_open`, path `/`, `SameSite=Lax`, a year's `Max-Age`, **not**
`HttpOnly` — the client toggles it directly with `document.cookie`, which is
the whole reason it is not a Server Action: expanding a section must not cost a
round trip, and this value guards nothing. It carries no identity, no
permission and no secret; the worst a forged value can do is open a section the
caller could already open by clicking.

An unreadable or unknown value is treated as absent. A key in the cookie that
names no section is ignored rather than erroring — sections come and go between
blocks, and a stale key from an older deployment must not break the sidebar.

### 4.4 The section heading becomes a control

Today the heading is a `<p>` that nothing can focus. It becomes a `<button>`
carrying `aria-expanded`, `aria-controls` and a chevron that rotates — the
disclosure pattern, so a screen reader announces both what the section is and
whether it is open.

`tests/e2e/dashboards.spec.ts` carries a comment stating that the heading is a
plain `<p>` and that its selector was therefore never ambiguous. That comment
becomes false with this change and is rewritten with it. The selector it
describes is on a **link**, not the heading, so it keeps working — but a
comment that explains why something is safe, describing a structure that no
longer exists, is exactly the kind of lie this project has been bitten by.

---

## 5. The home — not changed by this block

`/app` appears in three places: `MEMBER_HOME` in `src/middleware.ts`, the
sign-in redirect in `src/app/(auth)/login/page.tsx`, and the redirect after a
forced password change in `src/app/(auth)/change-password/page.tsx`. All three
mean "where a member lands", and they are three copies of one fact.

**They stay as they are.** D6 above records what was going to happen here, why
it was withdrawn, and what a future block would have to settle first. The
one-constant tidy-up existed only to serve the value change and went back with
it; collapsing three copies into one is worth doing on the day something
actually needs them to agree.

The fact that made the change expensive is worth keeping in view regardless:
`/dashboards/audience` redirects to `/app` for a caller who can reach no Station
with the permission it needs (`page.tsx:104`, `if (!first) redirect('/app')`).
That is correct behaviour for a dashboard and the wrong behaviour for a front
door.

---

## 6. What this costs

**Eighteen e2e call sites reach screens by clicking sidebar links, not
thirteen** — the count below was wrong when first written, and five more files
broke identically once sections collapsed: acceptance, deadline, deezer,
filtered-draw, inventory-flow, invitation-flow, members-flow, music-catalogue,
music-requests, record-dialog, roles-flow, shows, templates, **audit,
dashboards, nav-content and provisioning-flow** — plus the shared
`tests/e2e/provision.ts`, the one worth naming separately: fixing its single
call site covers roughly fourteen of the eighteen at the source, rather than
fourteen individual edits. With sections collapsed, those links are not in the
DOM until the section is opened.

This is paid **once**, with one helper — `openNavSection(page, name)` in the e2e
helpers — used by all eighteen call sites, not with eighteen separate edits. A
helper is also what keeps the next nav change from costing eighteen edits
again.

**Four items need an icon that does not collide.** The house rule, written into
`ICONS` and into `shell.ts` in four comments, is that two adjacent rows of the
same section must not share a glyph; reuse across distant sections is fine and
already happens.

- **Pedidos** currently uses `ticket` — which is Participações, and moving it
  into Audiência would put `ticket` on two rows of one section. It takes
  `music` instead: unused in Audiência, and a song request is the one thing
  there that is about a recording.
- **Gravadoras** takes `building`. A label is a company, and `building`'s only
  other use is Plataforma > Organizações, a different section.
- **Gêneros** and **Álbuns** need new paths. `music` is Músicas in the same
  section and `box` reads as a package rather than a record. Two new glyphs,
  each with the comment `ICONS` requires explaining why nothing already declared
  meant it.

**Four message keys are new, and three of them do not exist anywhere yet.**
`nav.labels`, `nav.genres` and `nav.albums` are absent from all three
catalogues; only `music.albums` exists, and it belongs to the catalogue screen's
own namespace rather than to the sidebar's. `nav.catalog` survives the rename —
it currently labels the item being removed and becomes the SECTION's label,
which is the one place its wording was always right. `nav.music` is retired.
Portuguese: "Gravadoras", "Gêneros", "Álbuns". Each key is spelled as a
single-quoted literal at the call site, never composed, for the reason
`tests/unit/i18n/usage.test.ts` exists.

---

## 7. What this block does not touch

- **What the three catalogue addresses render.** `/music/catalog?tab=…` keeps
  its tabbed screen; Block 20c replaces it with three screens. This block only
  decides where those addresses sit in the sidebar.
- **The routes.** No href moves. Pedidos keeps `/music/requests`, and the three
  new items point at an address that already answers.
- **Permissions.** No section's visibility changes. The courtesy every section
  already extends — visible to every member, with the boundary in the database —
  is unchanged, and no permission gate is added or removed.
- **The mobile/narrow presentation**, which the shell does not have today and
  which this block does not invent.

---

## 8. Verification

`tests/unit/i18n/catalogue.test.ts` and `usage.test.ts` cover the copy changes.
The tree's own logic — which sections are open, given a cookie and a path — is
a pure function and is unit-tested as one, rather than only through a browser:
the same split `promotion-mapping.ts` exists for.

One e2e journey covers the disclosure end to end: land signed-in, find every
section collapsed except the one holding the current page, expand another,
navigate, and find it still expanded after the reload. That last step is the
only thing that proves the cookie, and a test that stops before it would pass
without persistence working at all.

The eight gates in the order `portoes-e-banco-local-sujo` records: typecheck,
lint, unit, `db:reset`, `db:test`, `seed:branding`, e2e, isolation. Nothing here
changes the database, so `db:test` is a regression check.

---

## 9. What Block 20c inherits

The sidebar as it will ship: Gravadoras, Gêneros and Álbuns as three items
pointing at `?tab=` addresses **that 20c must retire** (see D2's amendment).

**20c's first task is the routes, not the screens.** `/catalog/labels`,
`/catalog/genres` and `/catalog/albums` become real routes; the three sidebar
`href`s move to them; `/music/catalog` disappears, and whatever should happen to
anyone holding a link to it is 20c's to decide. Doing this first means the
screens are built where they will live, rather than built under `?tab=` and
moved afterwards — and it deletes the highlight defect D2's amendment records
rather than working around it.

Only then the screens themselves: a filtered list and a Cadastrar button opening
a popup, following the Músicas screen, plus a thumbnail on the album record.

Songs, Artists and Manutenção are NOT part of that move. The owner named three
addresses; the other three work today and nothing about them is broken. `albums` already carries `cover_md5`,
`deezer_album_id`, `upc` and `release_date` (0136/0137), so anything registered
from Deezer has a picture; where the picture comes from for an album typed in by
hand is 20c's open question, with Block 14's promotion and prize images as the
precedent to weigh.
