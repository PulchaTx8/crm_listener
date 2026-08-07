# Block 12c — The Rest of the Interface — Verification Report

**Branched from:** `main` (`8ba9abd`). **No migration.** PR base is `main`.

---

## 1. What shipped

**The catalogue went from 1,038 keys to 1,489**, at exact parity in English,
Portuguese and Spanish. 126 files changed; 9 commits.

Every screen this app has now renders in the reader's language: the page
descriptions, the field labels, the empty states, the confirmations, the
aria-labels a screen reader announces, and — the largest single piece — **every
error message a person can be shown**.

**`Arte/` is named in `.gitignore`.** Three source documents the owner keeps
beside the code, previously untracked, which is one `git add -A` away from
being committed. The files stay on disk; the repository stays out of them.

---

## 2. Block 12b's own report said 38 strings were left. It was 451

§6.5 of `block-12b-report.md` lists what was still inline: 38 template
literals, two exported helpers, thirteen `label:` constants, `SKIP_REASONS`,
three variable descriptions. That list is accurate about **what its sweeps
looked for** and silent about what they never looked at.

Three passes had run by then. 12a's codemod took JSX **text**. 12b's first pass
took text inside a **ternary**. 12b's second took the ternaries Prettier had
broken across two lines. Between them they never once looked at a **string
literal in a JSX prop**:

```tsx
description="Who is listening, how many are new, and who is barred — one Station or several, side by side."
label="Find a Station"
aria-label={`Edit ${prize.name}`}
```

Nor at the module-level `Record`s that hold this app's whole vocabulary — every
bucket name in the inventory ledger, every movement type, every participation
status, every consent type — nor at the nine `describe*Error` functions, which
between them are every sentence this product says when something goes wrong.

**A sweep that defines its own criterion of done reports done.** §6.5 says this
about itself, one paragraph before making the same mistake at a different
altitude.

---

## 3. The rule that decided every case

**A module body has no request behind it, so it has no language either.**

`const BUCKET_LABELS = { available: 'Available', … }` is evaluated once, when
the module loads, with no locale in scope and no way to acquire one. Every such
Record now holds **catalogue keys**, and the component that renders it resolves
them with the `t` it already had:

| Was | Is |
| --- | --- |
| `BUCKET_LABELS`, `MOVEMENT_TYPE_LABELS` | `*_LABEL_KEYS` + `formatBucket(bucket, t)` |
| `STATUS_LABELS` ×2, `BLOCK_KIND_LABELS`, `CONSENT_TYPE_LABELS`, `NATIONALITY_LABELS`, `VOCAL_LABELS`, `SOURCE_LABELS` | `vocab` namespace (§4) |
| `CARD_SPECS` ×2, `PRESETS`, `TAB_COPY`, `TAB_LABELS` ×3, `REASON_LABELS`, `LABELS`, `MESSAGE_LABELS`, `PURPOSE_DETAILS`, `MESSAGES` ×2 | a function taking `t`, or a key Record |

The shape is not new. `dashboards/audience/page.tsx` already had
`cardSpecs(consolidated, t)` and a comment explaining why. This pass applied
that reasoning everywhere it was already true.

---

## 4. One vocabulary, one namespace — `vocab`

`slice-labels.ts` argues at length that the four Records naming Postgres enums
must not be duplicated per screen: "Came back too soon" appears on the
participations grid **and** on the promotions dashboard, from one string, and a
dashboard that invented its own wording would be the second place to change.

That argument survives translation only if the **catalogue** does not duplicate
them either. So the six enum vocabularies live in a new top-level `vocab`
namespace, and each reader binds `tv` beside its own `t`. `withOperatorLabels`
— the one function that turns a chart's raw enum key into a word, and which was
handing back English on three dashboards — takes the translator now.

---

## 5. The error layer, which had none of this

Nine `describe*Error` functions, 76 call sites, not one sentence in the
catalogue. Two decisions:

**`t` is a parameter, not something they read.** Reading it means
`getTranslations`, which is async, and `inventory/errors.ts`'s own header
explains at length why these are synchronous. Every caller already holds a
translator for the right namespace at the point it catches, or is an async
Server Action that can acquire one on the error path.

**The `action` and `what` a caller passes are catalogue KEYS.** They used to be
English phrases spliced into a sentence stem:

```ts
describeInventoryWriteError(cause, 'add stock')
// → `You do not have permission to ${action} in this Station.`
```

A call site cannot pass a Portuguese verb it never had. Fifty-one phrases moved
into the catalogue, where their three translations live.

---

## 6. Four places English grammar was still written into the code

§4 of the 12b report found three. These are four more, and they are the same
defect: **a rule only English follows, expressed as string arithmetic.**

- **`childCountLabel`** built "412 requests" as `count === 1 ? noun.slice(0, -1) : noun` — a plural made by *removing a letter* — with `toLocaleString('en-GB')` hardcoded. ICU plurals, one per child noun.
- **`roughDuration`** built "3 days" as `` `${days} day${days === 1 ? '' : 's'}` ``. Four ICU messages.
- **`formatQuestionCount`** returned `'No quiz'`, `'1 question'` or `` `${count} questions` ``. One message with a `=0` case.
- **`music/catalog/actions.ts`** assembled `` `register ${NOUN[kind]}s` `` and `` `save this ${NOUN[kind]}` ``. English puts one "this" in front of every noun; Portuguese agrees with the noun's gender — *salvar **esta** gravadora*, *salvar **este** gênero*. No stem plus noun can assemble both. Twelve whole phrases, one per kind and per verb.

The catalogue-tab strip had the same shape: a `noun` spliced into "New {noun}",
"Add {noun}", "Archive this {noun}?". The noun survives only as a `data-testid`.

---

## 7. A real defect the translation exposed

`pickups-grid.tsx` decided whether to paint a deadline red like this:

```tsx
const clock = describeDeadline(deadlineAt, status);
const overdue = clock.startsWith('overdue');
```

An **English question about a sentence**. The moment `describeDeadline` answers
in three languages, `overdue` is false for every Portuguese and Spanish reader,
the red never appears, and **no test fails** — the suite pins `locale: 'en-US'`
(12b §5), so it only ever asks the question in the language where it works.

It reads the date now. This is the argument for translating error and status
text rather than leaving it: English text becomes load-bearing for logic, and
nothing marks the moment it does.

---

## 8. Two half-sentences, in fifteen screens and in two more places

`noStationYouCanReachMatches` held `No Station you can reach matches “` — an
opening quote and nothing to close it — and every one of **fifteen** screens
wrote the rest as bare JSX:

```tsx
{t('noStationYouCanReachMatches')}{search}”.
```

The key owns the whole sentence and its `{search}` now. The dashboards' station
scope note was worse still: a translated stem, a conditional English clause,
and then two complete English sentences continuing it. One whole message per
branch, which is the rule §6 of the 12b report already set for the import
warning. Two more of the same shape are fixed: the audience archive dialog's
"— not by you, not by support…" and the import's "Its header row reads:".

---

## 9. The gate

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm test` | **909 passed**, 71 files |
| `npm run build` | clean, from a removed `.next` |
| Catalogue parity | en 1,489 · pt 1,489 · es 1,489, **no gaps in either direction** |
| Every literal `t('key')` resolves | **1,503 checked, 0 missing** |
| Every threaded `t('key')` resolves | **309 checked, 0 missing** |
| Every message formats, all three languages | **4,467 formatted, 0 failures** |
| Every removed English literal still in `en.json` | 246 checked, 2 expected absences (`"No quiz"` is inside an ICU `=0` branch; `"Enums"` was a type index) |
| Each replaced literal vs. its new key's value | **105 pairs, 0 drifted** |

**`npm run test:e2e` did not run here.** It needs the local Supabase stack and
Docker is not running on this machine; CI runs it on this PR. That matters more
than usual for this branch — the suite asserts roughly a hundred English
strings and this pass moved most of them out of the code — so **a red e2e job
is the expected way to find anything above that is wrong.**

### The check that earned its place

Four of the six checks above pass on a defect I actually shipped and caught two
commits later. The catalogue tabs became `kindGenres` / `kindShows` /
`catalogueLists` — keys that **exist**, and hold the lower-case plural the merge
screen puts inside a sentence, and a Portuguese sentence stem. The tabs would
have read "Catalogue lists", "genres", "shows".

Key resolution passed. Message formatting passed. Parity passed. The
removed-literal sweep passed, **because "Genres" and "Shows" are still in
`en.json` — somewhere else.**

What found it was comparing each replacement **pair**: the literal that left the
code against the value of the key that replaced it. Across 105 such pairs it was
the only drift. A check that asks "does this key exist" cannot see a key that
exists and says something else.

---

## 10. What this block did not touch

**Zod validation messages** (`src/schemas/*.ts`, ~97 strings), the **audit trail
labels** (`src/lib/audit/labels.ts`, 31), and the **report type labels**
(`src/lib/reports/types.ts`). Scoped out by the owner when the size of the real
remainder was measured, and left whole rather than half-done: a form that
refuses in English beside a screen that answers in Portuguese is a worse state
than one that is consistently one or the other, and Zod schemas are
module-level constants, which §3 is about.

**`InternalError` messages in `src/services/*.ts`.** Never rendered — every
`describe*Error` replaces them with a generic sentence, on purpose, because
they may carry raw database text.

**Dates and numbers still follow `en-GB`** — 12a's D5, untouched, exactly as
§9 of the 12b report records. Day/month is already correct for pt-BR and es-ES.
The one number format that moved did so as a side effect: `childCountLabel`'s
hardcoded `toLocaleString('en-GB')` is now the reader's grouping, because ICU's
`#` formats per locale.

**The 22 catalogue values identical in English and Portuguese** are the ones §8
of the 12b report says should be: product names, permission ids like
`audit.view`, table names in the audit trail, `pt_BR`, `pickup_reminder`, and
the two WhatsApp buttons a **listener** reads.
