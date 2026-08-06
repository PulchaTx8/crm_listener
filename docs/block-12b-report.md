# Block 12b — Three Languages, and the Gear That Chooses Them — Verification Report

**Branched from:** `main` (`9f932a5`). **No migration.** PR base is `main`.

---

## 1. What shipped

**The gear**, beside the signed-in member's name in the sidebar. Click it, pick
one of three languages, and the interface is in that language from the next
paint. The choice is written to the cookie *and* to `profiles.locale`, so it
follows the person into a browser that has never seen them.

**Two catalogues.** `messages/pt.json` and `messages/es.json`, 864 keys each, at
exact parity with English.

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

## 6. What is still in English, and why it is a separate pass

**117 sites in 58 files** hold interface text inside a code expression rather
than as JSX text — every `pending ? 'Saving…' : 'Save'` on every form, empty-state
messages, confirmation titles. Block 12a's codemod externalised JSX *text*; text
inside a ternary was invisible to it, and 12a's own report records the
loose-literal guard being left off "for 12b".

They render in English in all three languages. Nothing is broken and nothing is
gibberish — it is simply not translated yet. Finishing them, and then turning on
the guard that stops them coming back, is the next pass.

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

**A local-workflow trap worth knowing.** Running `db:test` *after* the e2e suite
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
