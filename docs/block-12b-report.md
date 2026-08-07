# Block 12b — Three Languages, and the Gear That Chooses Them — Verification Report

**Branched from:** `main` (`9f932a5`). **No migration.** PR base is `main`.

---

## 1. What shipped

**The gear**, beside the signed-in member's name in the sidebar. Click it, pick
one of three languages, and the interface is in that language from the next
paint. The choice is written to the cookie *and* to `profiles.locale`, so it
follows the person into a browser that has never seen them.

**Two catalogues.** `messages/pt.json` and `messages/es.json`, at exact parity
with English — 864 keys when the branch opened, **1038** by the end of the two
passes §6 and §6.5 describe.

**`AVAILABLE_LOCALES`** open to all three — the single line the gear needed to
appear, and the line that cannot move alone (§3).

---

## 2. The selector has no client JavaScript, and that is the design

`<details>` and one form per language. The menu opens because the browser opens
it; each language is a one-field POST to the Server Action. So it works before
hydration, works with JavaScript off, adds nothing to the bundle of a shell that
every screen renders, and needs no inline handler for the CSP nonce to bless.

It replaced a `<select>` plus a Save button — two clicks, and a state where
somebody had chosen but not saved.

---

## 3. What could not move on its own

`resolveLocale` filters on `AVAILABLE_LOCALES` and its answer becomes a filename
in `src/i18n/request.ts`. **A language named in that constant with no catalogue
beside it is a crashed render on every route, public ones included** — the defect
Block 12a shipped and this repository fixed hours earlier.

So both halves are pinned, in two different tests, against two different things:

- `resolve-locale.test.ts` pins the constant against the three names, and sweeps
  every combination of profile, cookie and header to prove no input can produce
  an answer outside it.
- `catalogue.test.ts` pins a **file on disk** for each name. The constant could
  otherwise open a language whose catalogue nobody wrote.

Adding a fourth language means both tests fail until its catalogue exists. That
is the intended cost.

---

## 4. Three sites where English grammar had leaked into the code

`{t('entr')}{count === 1 ? 'y' : 'ies'}` — a translated key with an English
plural suffix glued on in JSX. English pluralises by adding letters to the end
of a word; **nothing else here does**, and `inscriç` + `ies` is not a word in any
language. They are ICU plurals now, with the count inside the message so each
language decides for itself.

These three were fixed because they produce *gibberish*. They are not the same
problem as §6.

---

## 5. Two things that were true before and are now load-bearing

**`playwright.config.ts` pins `locale: 'en-US'`.** The resolution order ends at
`Accept-Language`, and Chromium sends whatever the *machine* is set to. From the
moment `pt.json` existed, a suite asserting roughly a hundred English strings
would have rendered in Portuguese on any developer machine set to pt-BR — a
failure that reproduces for one person and for nobody else. The language journey
overrides it where it needs to.

**`<details>` carries the implicit ARIA role `group`.** `audit.spec.ts` reached
for `getByRole('group').first()`, which meant "the audit row's disclosure" right
up until the shell above every screen grew one of its own. It now scopes to the
table, which is what it always meant. The suite caught it, not review.

---

## 6. The conditional text — done in a second pass

**117 sites in 58 files** held interface text inside a code expression rather
than as JSX text: every `pending ? 'Saving…' : 'Save'` on every form,
empty-state messages, confirmation titles, and the noun in every count label.
Block 12a's codemod externalised JSX *text*; text inside a ternary was invisible
to it, and 12a's own report records the loose-literal guard being left off "for
12b".

All of them are in the catalogue now — **864 keys became 995** — and the sweep
that found them returns one site, `'invitationId' : 'membershipId'`, which is a
form field name rather than anything a person reads.

**That last sentence was true of the sweep and false of the screen**, which is
the whole lesson of §6.5.

Three of them were not simply moved:

- **Count labels became ICU plurals.** `total === 1 ? 'role' : 'roles'` picks by
  a rule only English follows. `?? 0` on the count argument keeps the old answer
  for a withheld total, which read as plural before.
- **`music.yet` is gone.** The empty state was `No {title} {t('yet')}` plus a
  conditional tail — a key holding the word "yet" can only ever assemble a
  sentence in English word order. One whole message per branch now, with the
  noun interpolated.
- **The import answer warning** was a key, a conditional clause, and then bare
  JSX text continuing the same sentence. Also one whole message per branch.

---

## 6.5 The sweep matched one line, and Prettier writes two

The regex behind "returns one site" was `? '…' : '…'` **on a single line**. Any
ternary whose branches did not fit the line budget — which is every branch
longer than about forty characters, because Prettier breaks them onto their own
lines — never matched it. The pass that used that sweep therefore fixed
`pending ? 'Saving…' : 'Save'` everywhere and left the long sentences untouched,
and the sweep then reported the screen was clean.

**31 sites in 20 files survived it**, all of them text a person reads:

- **Every empty state that distinguishes "no matches" from "none yet"** —
  inventory, listeners, artists and songs. Four screens, eight sentences, and
  §6 above claims empty-state messages as done.
- **The "No such X, or you do not have permission to see this one." behind all
  five record dialogs** — the message a person gets when a record is refused.
- **The admin console's credential card**, which was *the same half-sentence
  defect §6 describes*: `t('theseAreEnvironment…')` with an English clause glued
  on by ternary, exactly like the import warning. Its `SecretLine` also printed
  `configured` / `not set` from a component with no `t` in scope.
- **Sign-in and the public contact form** — the expired-password and
  invalid-credentials errors, and both contact-form failures. The two screens a
  person meets before they have an interface language at all.
- **The withheld-listener tooltips** in music requests, one of which explains an
  erasure under the LGPD, and **the audience panel's distinct-listener caveat**.

Where a sibling in the *same expression* was still English, it came too — a
sentence half in one language is worse than either. `team-grid.tsx` was already
rendering `{t('invitationPending')}` beside a bare `'Active'`; the audience
tiles would have carried a translated caveat under an English label.

**995 keys became 1038.** Three more became ICU plurals for the same reason §4
gives — `${row.access.length} Station(s)` was English hedging its own plural,
and now each language answers for itself.

### What is still inline

**38 strings live in template literals** — `` `Actions for ${prize.name}` ``,
`` `No ${kindLabel} match “${state.search}”.` `` — across 27 files. Neither
sweep saw them. Alongside those: `mergeConfirmationText` and
`childCountLabel` in `merge-panel.tsx`, which are exported pure helpers with
their own unit tests, so translating them changes a signature and its callers;
and `table.tsx`, whose sort announcement (`, sorted descending`) and
`toLocaleString('en-GB')` are shared-primitive concerns that belong with D5's
date and number work rather than with this pass.

Three classes that are **not** conditional text, found by the line-oriented
sweep and left deliberately, because widening again is how a pass never ends:

- **13 `label:` constants** in the dashboards' module-level spec lists
  (`music`, `promotions`, `period-control`). The audience four moved only
  because the caveat above them did.
- **`SKIP_REASONS`** in `import-form.tsx` — four refusal reasons in a lookup
  map, and `movements/page.tsx`'s two `??` fallbacks for a picker whose row has
  gone.
- **`template-registry.tsx`'s three variable descriptions.**

Nothing above is conditional, and each renders coherently in English today.

---

## 7. The gate

| gate | result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm run test` | **909/909** in 71 files |
| `npm run db:test` | **1403/1403** in 29 files |
| `npm run test:isolation` | **288/288**, 29 of 29 files accounted for |
| `npx playwright test --workers=1` | **47/47** |

No migration in this block, and no SQL changed — the database gates are here
because a green branch says so, not because anything in them moved.

Every row was re-run after §6.5, on the tree being merged — not inherited from
the run that produced this table the first time.

**The local trap that cost the most, with its real signature.** Running
`npm run build` while a `next dev` server is alive is already recorded as
"the dev server 404s on chunks". It is narrower and nastier than that: the JS
chunks keep resolving, because dev rebuilds them on demand. **The stylesheet
does not.** `/_next/static/css/app/layout.css` returns 404 and the page renders
with no CSS at all.

That matters here because `app-shell.tsx` carries a second, mobile-only
`<header className="… md:hidden">` that links **every** nav item. With no CSS,
`md:hidden` hides nothing, the header joins the accessibility tree at every
viewport, and each sidebar link now exists twice — so `getByRole('link', …)`
raises a strict-mode violation on screens nobody touched. **23 of 47 journeys
failed that way**, with errors that read exactly like application defects. The
cure is `rm -rf .next` and a dev server started after it, and the tell is to
`curl` the `layout.css` href before believing any of it.

One journey — `dashboards.spec.ts`'s round trip — failed once more on the first
run after that cleanup, inside React's dev-only `buildFakeCallStack`
(`frame.join is not a function`), with no 5xx on the wire. It did not reproduce:
that spec passes 4/4 alone and the full suite is 47/47. Recorded rather than
explained.

**A second local-workflow trap.** Running `db:test` *after* the e2e suite
on the same stack fails `15_music_rpcs`: its fixture and
`music-catalogue.spec.ts` both use the song title *Águas de Março*, and the
pgTAP assertion reads it back with an unscoped `where title = …` subquery. After
two e2e runs there were three such rows and the subquery raised. CI never sees
it — each job starts its own container — and the numbers above are from a reset
stack. It is pre-existing and untouched by this block.

---

## 8. Vocabulary, which is the part worth arguing with

The translations follow the radio rather than the dictionary, and these are the
choices to overrule if the operation says otherwise:

| English | Portuguese | Spanish |
| --- | --- | --- |
| Station | Emissora | Emisora |
| Role | Cargo | Rol |
| Listener | Ouvinte | Oyente |
| Request | Pedido | Pedido |
| Pickup | Retirada | Retiro |
| Label | Gravadora | Sello |
| Report | Relatório | Informe |

Left untranslated on purpose: the sha256 recipe, permission ids like
`audit.view`, table names in the audit trail, `pt_BR` and `pickup_reminder`, and
the two WhatsApp button labels a **listener** reads — *Quero!* and *Agora não*
are the Station's voice, not the interface's.

---

## 9. What this block did not touch

Everything D1 put out of reach, and for the same reason: WhatsApp templates and
system messages, role names, Station, prize, promotion and listener names, notes,
reasons, quiz answers. Switching language never reads, rewrites or re-encodes a
stored value — the journey asserts it on a name typed as *Ana Gonçalves Ştefan*,
which survives two language changes byte for byte.

**Dates still follow `en-GB`** (12a's D5). Day/month is already correct for
pt-BR and es-ES, so nothing on screen is wrong; `formatInstant` is untouched and
still hardcodes its format.
