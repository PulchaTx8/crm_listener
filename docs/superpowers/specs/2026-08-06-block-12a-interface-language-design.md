# Block 12a — The Interface Speaks, the Content Does Not — Design Spec

**Date:** 2026-08-06
**Status:** approved by the owner
**Splits:** the interface-language work in two. **12a takes every user-facing
sentence out of the code and builds the machinery that chooses a language;
12b brings Portuguese and Spanish.** After 12a the screens look exactly as they
do today — English, unchanged — which is the point: nobody ever sees half a
screen in one language and half in another
**Depends on:** Block 0 (`middleware.ts`, `profiles`), and every block after it,
because the text being moved is theirs
**Branches from:** `main`. **Migration `0135`.**

---

## 1. What this block is for

The product speaks English to everybody. Its customers are Brazilian radio
stations, and the ones it is being sold to next are not all Brazilian.

Three languages are wanted — **English, Português, Español** — chosen by the
person reading, remembered for them, and applied to **what they read and nothing
else**.

The size of the job is why it is two blocks: **31 screens, 124 components, 18
Server Action files**, and not one sentence of it lives anywhere but inside the
component that renders it.

---

## 2. Decisions

### D1 — Language is a display choice, never a data transformation

**The owner's rule, in the owner's words: the test is not where the text lives,
it is whose responsibility it is.** If the user can edit it inside the product,
it is theirs and nothing touches it. If only we can change it — by shipping code
or a migration — it is ours, and it is translated.

Switching language **never** reads, rewrites or re-encodes a stored value. A
Japanese operator sets the interface to English, types Japanese into the fields,
switches to Spanish halfway through, and every byte they entered is exactly where
they left it.

| theirs — never translated | ours — translated |
| --- | --- |
| Station, prize, promotion and listener names | labels, captions, headings, buttons |
| notes, reasons, quiz answers | validation and error messages written in TypeScript |
| role names they composed ("Gerente") | situation and audit-action labels |
| **WhatsApp templates and system messages** — they edit these on the Templates screen, and the reader is the *listener*, in the Station's own voice | the permission catalogue's human text (D6) |
| | subject and body of the e-mails the system sends |

Consequences worth stating, because they are what stops somebody "improving"
this later:

- **The schema gains no language columns.** No `name_pt`, no `name_es`.
- **Ordering does not change.** Lists are ordered in the database — that is how
  keyset pagination has worked since Block 3b — so switching language does not
  reshuffle a list of names.
- **Search and deduplication do not change.** `phone_normalized` and
  `email_normalized` are data normalisation, not language.

### D2 — Profile, then cookie, then the browser, then English

Resolution order, in full:

1. `profiles.locale` — the signed-in person's own choice, which follows them to
   any browser.
2. A `locale` cookie — what this browser remembers, and the only thing anyone has
   before signing in (the landing page, `/contato`, `/login`).
3. `Accept-Language`, if it asks for one of the three.
4. **English.**

**The middleware is what makes this cheap.** It already loads `profiles` on every
request to check `must_change_password`; it now reads `locale` in the same query
and, when the cookie disagrees with the profile, rewrites the cookie. Rendering
then reads **only the cookie** — no extra round trip anywhere, and the profile
stays the truth that travels with the person.

Changing the language is a Server Action that writes both.

**No locale segment in the URL.** Routes are untouched, by the owner's
requirement and because a `/pt/` prefix would rewrite every link, every
`redirect()` and every test in the repository to buy nothing this installation
needs.

### D3 — `next-intl`, and the specific thing it is bought for

One new dependency, in a repository with nineteen.

It is not bought for message files — those are trivial — nor for plurals, which
`Intl.PluralRules` gives away. **It is bought for keeping the locale bound to the
request inside Server Components.** The classic way a hand-rolled implementation
fails is a locale cached in module scope: under load, one user is served another
user's language. That defect does not appear in development, does not appear in
tests, and appears in production as a report nobody can reproduce.

It also brings ICU messages, which is what the **eighteen** places currently
writing `unit(s)` need — a dodge that reads badly in English and worse in
Portuguese.

### D4 — 12a changes no pixel, and the selector is gated by a constant

Every sentence moves out of the components into `messages/en.json`, and the
screens render exactly what they render today.

The selector exists from 12a but is driven by `AVAILABLE_LOCALES`. In 12a that
constant holds `['en']` and the control does not render. In 12b it holds all
three and the control appears.

**There is therefore no moment at which somebody chooses "Português" and receives
English**, which is the whole reason the work is split this way.

### D5 — Dates and numbers follow the language; the timezone does not — **and this lands in 12b**

`formatInstant` currently calls `Intl.DateTimeFormat('en-GB', { …, timeZone })`
— the format hardcoded, the zone the Station's. It starts taking the reader's
language instead.

**The zone stays the Station's, in every language.** That is a correctness
property Block 6a paid for: an operator in another state must not read a draw as
having happened an hour from when the Station ran it.

The owner was shown the cost and accepted it: `en-US` writes month/day, so an
English reader and a Portuguese reader looking at the same deadline see
`08/06/2026` and `06/08/2026`. The instant is identical; the risk is two people
comparing dates out loud.

**It ships in 12b, not here, and the reason is D4.** Today's format is `en-GB`,
which writes day/month; the English locale writes month/day. Making this change
in 12a would flip every date in the product into American order while the block's
whole promise is that nothing on screen moves — and it would do it for the only
audience that exists at that moment, which is everybody. In 12b it arrives
alongside the languages that make it mean something.

`formatInstant` still gains its language parameter in 12a, so the plumbing is in
place and asserted; in 12a the only caller passes the value that reproduces
today's output exactly.

**Nothing about storage changes.** The columns are `timestamptz` — an absolute
instant, with no format in them at all.

### D6 — The permission catalogue is translated by its code, not by editing the table

`public.permissions` holds human text (`description`) that the roles screen
renders. It is **ours** by D1's test — nobody can edit it in the product — but it
lives in a table.

It is translated in the message catalogue, keyed by the permission `code`, which
is stable and already the primary key. **The table is not given language
columns and its English text stays** as the source and the fallback for a code
the catalogue has not learned yet.

### D7 — The sentences that come from the database are measured here and decided in 12b

Some text the user reads is not in TypeScript. The error mappers do this:

```ts
if (cause instanceof ConflictError) return cause.message;
if (cause instanceof BusinessRuleError) return cause.message;
```

and `cause.message` is the sentence a `raise exception` wrote — there are 490 in
the schema. The SQLSTATE codes the services map (`22023`, `23514`, `23505`,
`P0002`, `42501`) say what *kind* of failure it is, never *which rule* was
broken. Only the English sentence distinguishes them.

**12a does not fix this and does not pretend to.** It measures it: how many of
those sentences actually reach a user, and which. The count and the list go in
the block report, and the owner decides in 12b between giving each rule a stable
code (which touches the schema and the pgTAP assertions that read those
sentences) and leaving them in English.

Naming it here so that "the interface is translated" is never read as "everything
the user reads is translated".

### D8 — Two guards, because externalisation rots without them

1. **Key parity** — a test that fails when the catalogues do not hold exactly the
   same set of keys. It guards one catalogue in 12a and is what makes a forgotten
   translation impossible in 12b.
2. **No loose literals** — a check that fails when user-facing text is written
   inside a component again. Without it the next pull request quietly starts
   putting sentences back, and the second language silently stops being complete.

---

## 3. Migrations

| # | what |
| --- | --- |
| `0135` | `profiles.locale text` — `'en' \| 'pt' \| 'es'`, null meaning "never chose", checked by a constraint |

---

## 4. Verification

The house gate: lint, typecheck, build, unit, pgTAP, isolation, e2e in series.

Specific to this block:

- **The screens are unchanged.** The existing 44 Playwright journeys assert
  captions, headings and button names all over the product; they are the
  regression test for an externalisation that dropped or altered a word, and they
  must pass **without being edited**. An edit to a selector in this block is a
  finding, not a fix.

  This is a real gate rather than a hope: those journeys name roughly a hundred
  visible strings between them, and none of them asserts a formatted date — which
  is exactly why D5 can wait for 12b without leaving a hole here.
- The key-parity test and the loose-literal guard of D8.
- pgTAP for `profiles.locale`: the constraint accepts the three and refuses a
  fourth.
- An isolation case: a signed-in caller may write their own `locale` and may not
  write anybody else's.
- A unit test of the resolution order — profile beats cookie, cookie beats
  `Accept-Language`, and nothing at all yields English.

---

## 5. Out of scope

**Portuguese and Spanish.** They are 12b, along with the selector becoming
visible, the date format following the language (D5), a journey that switches
language and asserts that a caption changed while a name the user typed did not,
and the D7 decision.

**WhatsApp templates and system messages**, in any block: the Station writes
them and the listener reads them.

**A locale segment in the URL**, in any block (D2).
