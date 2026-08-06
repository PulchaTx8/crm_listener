# Block 10a — The Trail Nobody Could Read, and the Integration Nobody Could Configure — Verification Report

**Date:** 2026-08-05
**Branch:** `block-10a` (cut from `block-8b`, **not** from `main` — the migrations continue at `0129` and require `0121`–`0128`)
**Spec:** `docs/superpowers/specs/2026-08-05-block-10a-audit-and-integration-design.md`
**Plan:** `docs/superpowers/plans/2026-08-05-block-10a-audit-and-integration.md`
**Migrations:** `0129`–`0130`

Two things in this system had been written and never read. `audit_logs` had
collected rows since Block 1b — nine blocks of edits, movements, deliveries,
erasures, and since Block 8b every report export — and nothing in the product
could display one. `integrations` had RLS with **no policies**, so connecting a
radio to WhatsApp meant issuing SQL by hand against production.

---

## 1. The gate

| gate | result |
| --- | --- |
| `npm run lint` (cache cleared) | clean |
| `npm run typecheck` | clean |
| `npm test` | **839/839** across 62 files (831 before, 8 new) |
| `npm run db:test` | **1358/1358** across 25 files (1336 before, 22 new) |
| `npm run test:isolation` | **276/276** across 26 files, all required by name (269 before, 7 new) |
| `npm run build` | clean; `/audit` 828 B, `/admin/integrations` 2.62 kB |
| `npx playwright test --workers=1` | **36/36** |

**The isolation suite's first full run failed its own guard** — 26 files
collected, 24 reported. That is the worker death `verify-isolation-suite.mjs`'s
header documents at about two runs in five, on a different file each time and
with no cause found across fifteen measured runs. The re-run was 26/26 with 276
cases. Recorded rather than silently re-run, because the guard exists precisely
so that this cannot be mistaken for a green run — and because a reader should
know that the number above was reached on a second attempt.

---

## 2. What was found before the block was scoped

Half of §11's Block 10 was already built, and saying so is what made this block
small enough to review in one sitting: `/team` and `/roles` shipped in Blocks
1b/1c, and provisioning and suspension in the admin console. What remained was
four independent things, and the owner took the two with real accumulated debt.

**`entitlements` and the Company `pending` lifecycle are deferred**, and the
second may turn out to be unnecessary rather than missing: `company_status` is
`('active','suspended')` and `provision_customer` creates an active Company,
because an administrator provisions every customer by hand — so the Company is
enabled by an admin action at birth, and a separate pending state would only
earn its keep if customers could self-register.

---

## 3. The decision the block rests on

**`list_audit_logs` is `SECURITY INVOKER`, alone among this codebase's list
RPCs**, and the attribute itself is asserted rather than any behaviour that
follows from it.

Every other list function here is `DEFINER` for a reason: it must be *narrower*
than RLS (an archived promotion's entries), or it needs a column RLS cannot
express per row (a listener's name behind `members.view`). This one needs
neither. `audit_logs` already carries the rule in two policies, and this is the
one table in the schema where restating them wrong would be **invisible** — the
screen would still render, still paginate, and still look like an audit trail.
There is no user-visible difference between "the audit viewer" and "the audit
viewer, showing slightly too much", and no behavioural test catches a `DEFINER`
version either: it passes everything on the day it is written and only drifts
later.

So pgTAP asserts `prosecdef` is false and that the body names no permission
helper, and the isolation suite proves the term such a rewrite would drop first:
**a row with a null `organization_id` reaches the platform admin and nobody
else.** Nothing in the product writes such a row today; the test plants one,
because the term has to hold anyway — something will.

---

## 4. What the tests found

**`audit.view` had guarded nothing since Block 1b**, and the isolation suite is
the first thing in the repository to exercise it. A member without it now
provably gets an **empty page and not a refusal**, which is the correct answer
and what the screen says in words.

**The integration form identified no Station.** The e2e's first version filtered
forms by their text and matched none — the Station's name lives in the card
header, outside the form. That is a defect in the markup rather than a test
convenience: anyone reading the DOM during an incident had the same problem. The
form now carries a `data-testid` keyed by Station id.

**The filter bar's "Clear" was a second submit button**, which would have posted
the fields currently filled in — the opposite of clearing them. It is a link to
the bare path now, because every filter lives in the URL and nowhere else.

---

## 5. Two things this block deliberately does not do

**No secret enters the database.** The three WhatsApp credentials are
installation-wide environment variables, so one Meta app serves every Station.
The screen writes identifiers only and has no field for a token — one would be
the first step of a secrets subsystem needing encryption, rotation and an answer
to "who may read it". What it *does* show is whether each secret is configured,
as a boolean: the question somebody brings to that screen is "why does this
radio receive no messages", and "the access token is not set" is half the
answers.

**No export.** Block 8b built the engine and its spec excluded the audit trail;
adding `AUDIT` as a sixth listing type would be cheap now. It is deferred anyway,
because **exporting an audit trail is itself an audited event**, and the
recursion is a decision rather than a detail. That belongs with Block 11's
retention work, where how long the trail lives is already an open question.

---

## 6. What the next block inherits

`0057`'s two unique indexes are now load-bearing in a screen as well as in the
schema, and the service layer tells them apart by constraint name.
`integrations_number_live` is a **correctness** constraint, not hygiene: the
webhook routes an inbound message by `phone_number_id`, so a number claimed
twice would silently deliver a listener's message to the wrong radio.

Block 11 inherits two open questions this block named and did not answer: audit
retention, and whether the trail may be exported.

---

## 7. Deploy

Ordinary. Nothing here rewrites a shared function — unlike Block 8b's `0121` —
so the risk is the usual one: a frontend ahead of `0129`/`0130` renders both
screens and fails with `PGRST202` behind them. Database first.

`docs/block-10a-runbook.md` carries the operational half: `/admin/integrations`
is now the only supported way to connect a Station, and the three secrets remain
environment variables.
