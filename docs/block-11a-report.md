# Block 11a — The Headers That Were Never Sent, and the Data That Was Never Let Go — Verification Report

**Date:** 2026-08-06
**Branch:** `block-11a` (cut from `block-10a` — the migration continues at `0131`)
**Spec:** `docs/superpowers/specs/2026-08-05-block-11a-headers-and-retention-design.md`
**Plan:** none — the block is two deliverables and the spec carried the task list
**Migrations:** `0131`

Two absences, eighteen blocks old. This application sent **no security header at
all**, and had **never deleted anything for age** — the raw Meta payload of every
WhatsApp message ever received was still in `webhook_events`, with the listener's
phone number and message text.

---

## 1. What shipped, and what did not

**Shipped:** five security headers on every route, and the N7 retention sweep.

**Not shipped, after being implemented and tested: the Content-Security-Policy.**
Design D2 is struck through in the spec rather than quietly dropped. This is the
block's most important outcome and §2 is about it.

---

## 2. The CSP was withdrawn by the test that was supposed to bless it

D2 argued that this codebase's Playwright suite — thirty-eight journeys across
every screen — is a better CSP test than a week of report-only telemetry nobody
reads, and that **if the suite passes, the policy does not break the product.**

The suite is what withdrew it:

    11 passed, 23 failed

and **not one CSP error anywhere in the output.** The symptom was journeys timing
out on clicks that did nothing, because no client component had hydrated. Three
fixes, each plausible, each measured, none of which changed the result:

1. Forwarding the nonce properly — `NextResponse.next({ request: { headers } })`
   rather than mutating `request.headers`, which does not propagate.
2. Dropping `'strict-dynamic'`, which makes a browser ignore `'self'` and so puts
   every Next chunk at the mercy of the framework having stamped the nonce.
3. Rebuilding the forwarded headers *after* the Supabase cookie write, since the
   snapshot taken before it carries no refreshed session.

Next's App Router emits **inline** bootstrap scripts, and a `script-src` carrying
a nonce blocks every inline script that does not have it. The nonce is not
reaching the renderer here, and finding out why is a change whose whole subject
is that.

**A CSP that breaks the product is worse than no CSP**, because it gets deleted
in an incident by whoever is on call, along with whatever else looks suspicious.
`X-Frame-Options: DENY` covers the framing half meanwhile. Block 11b owns the
policy, with D2 as its brief — and with the instruction that the *pass count*, not
the console, is what to read: this failure produced no error message at all.

---

## 3. The retention sweep shipped broken, and the suite that caught it did not exist yet

The first version wrapped each table's delete in `begin … exception when others
… end`. **A PL/pgSQL block with an exception clause opens a subtransaction, and a
COMMIT inside one raises `cannot commit while a subtransaction is active`.**

Every table failed. Zero rows deleted. Every night, at 04:11, logging warnings
into a Postgres log nobody reads — which is precisely the failure mode this
block's own runbook warns about.

**`24_retention.test.sql` was green throughout**, because it asserts the
procedure's *source* and cannot execute it: the sweep commits, and pgTAP wraps
every file in a transaction it rolls back.

It was found by **calling the thing** — one manual `call public.sweep_retention()`
against a seeded row. Two changes came out of it:

- `tests/isolation/retention.test.ts`, the only place in this repository that
  calls the sweep. It seeds a row past its period and one inside it, calls,
  asserts the first is gone and the second is not, and calls **again** to prove
  idempotence — a sweep that only works on a database with something to delete
  fails on the first quiet night. It calls through a **direct Postgres
  connection**, not PostgREST: `sweep_retention` is a *procedure*, and
  `supabase.rpc()` answers `PGRST202`. `pg_cron` issues `CALL` over a plain
  connection, so the test walks the same path production does.
- A pgTAP assertion that the body carries **no exception handler**, so it cannot
  come back.

The cost of dropping the handlers is stated in the migration: a table that
cannot be swept aborts the procedure and the ones after it wait until tomorrow.
That is strictly better than what it replaced, which was all seven waiting for
ever.

---

## 4. The gate

| gate | result |
| --- | --- |
| `npm run lint` (cache cleared) · `typecheck` · `build` | clean |
| `npm test` | **849/849** across 63 files (839 before, 10 new) |
| `npm run db:test` | **1375/1375** across 26 files (1358 before, 17 new) |
| `npm run test:isolation` | **279/279** across 27 files, all required by name (276 before, 3 new) |
| `npx playwright test --workers=1` | **38/38** |

Two red runs on the way here, both recorded because a reader comparing
timestamps in the log would otherwise find them unexplained, and neither was the
code.

**An e2e run came back 26 passed / 10 failed, and the cause was mine**: I ran
`supabase db reset` to fix the retention procedure while the suite was running in
the background.

**The isolation suite's first clean run came back 279 passed across 26 of 27
files** — a worker died without its file reporting, which
`verify-isolation-suite.mjs`'s own header documents at about two runs in five,
on a different file each time, with no cause found across fifteen measured runs.
Its guard is what caught it rather than the exit code. The re-run was 27/27.

---

## 5. What Block 11b inherits

- **The CSP**, with §2 as its brief and the nonce plumbing as its first task.
- **An alert on the sweep's counters.** Today they go to the Postgres log and
  nowhere else, so a sweep failing for a month looks exactly like one that has
  been working. D7 named this; 11b builds it.
- The five documents, the controlled seed, the deploy and backup/PITR runbook,
  and the upload/MIME review of the one upload path (delivery receipts).

---

## 6. Two lists the sweep will never grow, and why they are asserted on its source

**`audit_logs` is kept for ever.** It is pseudonymised by construction — ids, not
names — and it is the proof that erasures happened. Deleting the record of a
deletion is the worst available outcome in an audit. Block 10a's runbook flagged
this as open; it is closed this way.

**No business record is ever swept**: participations, winners, draws, promotions,
members, prizes, inventory movements. They are what a radio must be able to prove
afterwards. Personal data inside them is removed by `anonymize_member`, which is
driven by a person asking rather than by a clock.

Both lists are asserted against the procedure's own source, because a sweep that
quietly gained one of these tables would otherwise be discovered by its damage —
and for these tables, the damage is "the thing you needed to prove is gone".
