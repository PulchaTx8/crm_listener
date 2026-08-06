# Block 12a — The Interface Speaks, the Content Does Not — Verification Report

**Spec:** `docs/superpowers/specs/2026-08-06-block-12a-interface-language-design.md`
**Plan:** `docs/superpowers/plans/2026-08-06-block-12a-interface-language.md`
**Branched from:** `main`. **Migration `0135`.** PR base is `main`.

---

## 1. What shipped

**The machinery.** `profiles.locale`, the resolution order (profile → cookie →
`Accept-Language` → English), `next-intl` wired to a per-request cookie, the
middleware keeping that cookie in step with the profile on the query it already
made, and a Server Action that records a choice in both places.

**Every screen's text.** **1038 sentences across sixteen areas** now live in
`messages/en.json` — 866 keys, since the same sentence written twice is one key.
The screens render exactly what they rendered before: the 44 Playwright journeys
assert roughly a hundred visible strings between them and **all 44 pass
unedited**, which is the only claim worth making about an externalisation.

**The selector**, gated by `AVAILABLE_LOCALES`. It holds `['en']` and renders
nothing. Block 12b opens it by one constant.

**Two guards:** key parity across catalogues, and the D7 measurement.

---

## 2. The measurement Block 12b needs

**489 `raise exception` sites in the schema. 122 distinct sentences can reach a
user.**

The other 367 are guards whose message every mapper replaces with a sentence of
its own — `42501` becomes "You do not have permission to…", `P0002` becomes
"That could not be found." — so their SQL text never leaves the server. What
reaches a screen is the `22023` / `23514` / `23505` family, where the English
sentence is the only thing that distinguishes one broken rule from another.

`node scripts/measure-db-messages.mjs` prints the list. **The decision is the
owner's, in 12b:** give each of those 122 a stable code and translate them, or
leave them in English and say so.

---

## 3. Four things the journeys caught that the compiler could not

The externalisation was done by a codemod over the TypeScript AST. It was
written three times, and each rewrite came from a test failing rather than from
foresight. They are recorded because anybody doing this to another codebase will
meet all four.

**A regex cannot find the function a string belongs to.** The first version
counted braces and could not tell an arrow-function body from an object literal;
it put hooks inside the second and produced twenty-four syntax errors. The
parser knows. It also knows that a string inside a `.map()` callback belongs to
the **component around** the callback, which is where a hook may actually be
called.

**JSX collapses whitespace and decodes entities; a catalogue string does
neither.** A value copied verbatim rendered as `listener&apos;s` spread across
three lines of indentation.

**Whitespace *without* a newline is significant.** `held by {n} user(s)` is one
text node ending in a space. Trimming it renders `held by0 user(s)` — caught by
a journey asserting that caption, and by nothing else.

**`'use client'` marks a boundary, not a file.** Everything a client module
imports is client code too, directive or not, and `getTranslations` throws there
at runtime — `is not supported in Client Components` — while typecheck stays
perfectly clean. The tool now walks the import graph.

A fifth, smaller: `station-period-note.tsx` became an async Server Component, so
its unit test awaits it instead of rendering it synchronously. The mock resolves
against the real `messages/en.json` rather than echoing keys, because the
assertions are about the words a reader sees.

---

## 4. The gate

| gate | result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm run test` | **910/910** in 71 files |
| `npm run db:test` | **1403/1403** in 29 files |
| `npm run test:isolation` | **288/288**, 29 of 29 files accounted for |
| `npx playwright test --workers=1` | **44/44, no journey edited** |

The isolation runner dropped a worker on one run — Block 4b's flake, local and
Windows, mechanism unknown. It was re-run until complete rather than
interpreted.

`25_job_health` fails two subtests on a local stack that has been up for hours:
its first case is named "nothing is unhealthy on a **freshly seeded** database",
and `whatsapp-worker-tick` genuinely has gone quiet when nothing has ticked it
since morning. CI starts a new container, which is why the number above is the
one CI reports.

---

## 5. Three defects the review found after the gate was green

Every gate above passed on the first commit of this branch, and the branch still
carried a crash. They are recorded because each one is a class of failure the
gate is structurally unable to see.

**A language with no catalogue.** `resolveLocale` filtered on
`SUPPORTED_LOCALES` — every language the product will ever offer — and its
answer becomes a filename. `Accept-Language: pt-BR`, the default header of
essentially every browser in this product's market, resolved to `pt` and named
`messages/pt.json`, which this block does not write. A crashed render on every
route, public ones included, for a visitor who chose nothing. The filter is now
`AVAILABLE_LOCALES`, through a predicate named for the question it answers:
`isAvailable`, "is there a catalogue for this TODAY".

*Why nothing caught it.* `resolve-locale.test.ts` asserted that `pt` was the
correct answer for a Brazilian browser and never exercised the import — the one
test covering the line proved the bug correct. The journeys run under an English
`Accept-Language`, so no journey ever asked the question. **A unit test of a pure
function cannot see what its caller does with the value.**

**A cookie that never left.** `redirectWithCsp` builds a fresh
`NextResponse.redirect`, which starts with no cookies, and copied only the CSP
header across. Every cookie written above it — the refreshed Supabase session,
the locale sync — was dropped on all three redirect branches. The sync had been
placed before those branches deliberately, so that "somebody being sent to
/change-password should arrive there in their own language", and the delivery
was thrown away three lines later. **Placement is not delivery.**

**A comment describing a defence that was not there.** "The row is read back
rather than trusted" — there was no `.select()`. The code now does what the
comment always claimed. The `0135` and pgTAP comments were wrong in the opposite
direction: a column-scoped grant that misses `locale` raises 42501, loudly, and
the isolation test in this very block asserts exactly that. It is RLS that
refuses in silence. **In a repository where comments are the design record, one
asserting a guarantee that is absent is worse than no comment.**

---

## 6. What Block 12b inherits

- **The two catalogues**, `pt.json` and `es.json`, at which point the key-parity
  guard stops being ceremony.
- **`AVAILABLE_LOCALES`**, opened to all three, which makes the selector appear.
  It is now also the constant the resolution filters on, so opening it without
  writing the catalogue beside it is the crash of §5 again. `catalogue.test.ts`
  is what stops that: it pins a file on disk for every entry.
- **The date format following the language** (D5). It was deliberately held back:
  today's format is `en-GB`, which writes day/month, and the English locale
  writes month/day — so shipping it here would have flipped every date in the
  product into American order in a block whose promise was that nothing on
  screen moves. `formatInstant` is untouched and still hardcodes its format.
- **The 122 sentences** of §2, and the decision about them.
- **The loose-literal guard.** `react/jsx-no-literals` is not enabled yet: it
  belongs with 12b, once the catalogue is the only place text lives and the rule
  can be turned on against a clean tree.

---

## 7. What this block deliberately did not touch

Anything the user is responsible for. WhatsApp templates and system messages —
they edit those on the Templates screen, and the reader is the listener, in the
Station's own voice. Role names they composed. Station, prize, promotion and
listener names. Notes, reasons, quiz answers.

**No language columns anywhere.** Switching language never reads, rewrites or
re-encodes a stored value: a Japanese operator can set the interface to English,
type Japanese into the fields, switch to Spanish, and every byte they entered is
where they left it.
