# Block 8b — The Report Engine, and the Identity the Worker Does Not Have — Verification Report

**Date:** 2026-08-05
**Branch:** `block-8b` (cut from `main` at `1b1241d` — merge of PR #27, `block-8a`)
**Spec:** `docs/superpowers/specs/2026-08-05-block-8b-report-engine-design.md`
**Plan:** `docs/superpowers/plans/2026-08-05-block-8b-report-engine.md`
**Migrations:** `0121`–`0128`
**Commits:** `44e8844..52a1558` (12 commits; this report and the runbook are the
last task, committed separately)

Block 8a made the system answer questions on a screen and could not hand
anybody a file. This block does: five operational listings and three panel
snapshots, generated asynchronously by the worker, scoped to exactly what the
person who asked was entitled to read.

---

## 1. The gate

Measured on this branch, against a freshly reset local stack:

| gate | result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` | **831/831** across 61 files (787 before this block, 44 new) |
| `npm run db:test` | **1336/1336** across 24 files (1263 before, 73 new) |
| `npm run test:isolation` | **269/269** across 25 files, all required by name (261 before, 8 new) |
| `npm run build` | clean; `/reports` at 3.52 kB |
| `npx playwright test --workers=1` | **35/35** |

**The e2e suite passes in series and is run in series here.** Parallel has
failed on this machine for sign-in contention against the local Supabase since
Block 7b; CI is the arbitration, as it has been for every block since.

### CI

**All three jobs green** on `acb8543` (run `31051347107`): `build`, `db`, `e2e`.

Two things happened on the way there, both worth recording.

**CI's lint caught what the local one did not.** `next lint` caches by file, and
`organizationId` in the e2e spec stopped being used partway through the branch —
when `requestReportAction` began deriving the Organization from the Station ids
instead of accepting it from the form. The local cache kept returning a clean
verdict from before that change. Clearing `.next/cache/eslint` reproduces it.

**The first `e2e` run failed on `promotions-flow.spec.ts`, not on this block.**
Block 4's fixture setup got `An invalid response was received from the upstream
server` — a 502 from the local Supabase gateway — during `create_promotion`.
`reports.spec.ts` passed in the same run. A re-run of the failed job was green.
Recorded rather than quietly re-run: CI runs e2e with **two workers**, and this
is the shape of the contention every block since 7b has met on this machine in
parallel. It is not evidence about this block's code, and it is not evidence
that the suite is stable in parallel either.

**`npm run db:test` requires a freshly reset database**, and this cost time
during verification. After the e2e or isolation suites have run,
`15_music_rpcs.test.sql` — Block 7a's, untouched by this block — fails with
"more than one row returned by a subquery used as an expression", because its
fixtures assume music rows they did not create do not exist. This is a
pre-existing property of that file, recorded here and in the runbook rather
than fixed, because fixing it belongs to whoever owns that suite's isolation.

---

## 2. The constraint the whole block is shaped by

**The worker has no identity, and nothing that existed before this block runs
inside it.**

The tick holds a `service_role` client, where `auth.uid()` is null — a
`service_role` JWT carries no `sub` claim. So `has_permission` is false for
every code and every Station. Worse, the three 8a aggregates are `SECURITY
INVOKER` and granted **to `authenticated` only**: the worker cannot execute
them at all. The four list RPCs are the same.

So the thing that generates a file is not the thing entitled to the data. Two
answers, because there are two kinds of report:

**A panel's numbers are captured at request time**, by the same call the screen
makes, as the same user, and stored on the run row; the worker only renders
them into a PDF. This is what 8a told its successor to do — *"8b should reuse
these functions rather than write a fourth way to count the same rows"* — and
it closes the revocation window for panels at no cost.

**A listing's authorization travels as an explicit user id.** `has_permission`
became a one-line wrapper over `has_permission_for(user_id, …)` — one body, two
doors — and the page function re-checks the requester's permission **on every
page**. A role changed mid-file closes the door mid-file.

Two alternatives were considered and are named in the spec so the rejections
are visible: freezing the authorized plan into the run row (misses revocation,
and rewrites the predicates by hand — the loss `0095`'s header records), and
minting a JWT so the worker can impersonate the requester (removes all
duplication and grants the worker every user's rights).

---

## 3. What the tests found that review would not have

**A fifth helper was missing, and the failure would have been invisible.**
`0044` introduced `is_owner_of_company` so a policy could admit the
Organization's owner to archived promotions, and `0090` restates that rule by
hand. Restating it in the worker would have asked about `auth.uid()`, got null,
and quietly answered "not the owner" — **fail-closed, so no leak, and worse
than a leak in one specific way**: an owner's export would have been missing
exactly the rows his screen was showing him, with nothing anywhere saying why.
Found while writing `0124`, fixed in `0121`.

**`COMMENT ON POLICY` requires ownership of the relation; `CREATE POLICY` does
not.** `0123` failed to apply with `must be owner of relation objects`, and the
policy was not the problem — the comment was. `0086` omits comments on its two
receipt policies for the same reason, which was not obvious until this one
failed. The reasoning moved into the file header.

**`columns.test.ts` reported `name` and `phone` as unbuilt in three reports.**
The SQL builds them; the test's extraction missed the conditional
`jsonb_build_object` inside `case when v_names`. It balances parentheses now,
and the false positive is recorded in the file so nobody "fixes" it by deleting
the assertion. The test itself is the one that matters: nothing else in the
repository can catch a declared column the SQL does not produce — the SQL
compiles, the TypeScript compiles, the export succeeds, and the file has a
column of blanks.

**The isolation suite's consolidated test was wrong on its first run.** It cast
the owner as the caller who lacks `reports.consolidated`; `has_permission_for`
admits the Organization's owner to every code before it ever looks at a role,
so he holds it by construction. `20_dashboards.test.sql` needed a third caller
for exactly this reason and its comment says so — the rule did not change, the
test's assumption about it did.

**The e2e's first assertion was worse than useless.**
`expect(tick.reports).toBeTruthy()` passes on `{ error }`, so a tick that
generated nothing satisfied it. And the queue is **global to the
installation** — `claim_report_run` takes the oldest QUEUED run in the whole
database, so runs left by the isolation suite were claimed instead, and the
tick truthfully reported `claimed: 1, ready: 1` about somebody else's row.

---

## 4. Decisions the owner made

Five, in the conversation that preceded the spec:

- **Both kinds of report**, not just panel exports: the five operational
  listings are what makes the asynchronous engine necessary at all.
- **`saved_reports` means generation history**, not saved filter definitions.
  The table is called `report_runs`, a deliberate departure from §11's name,
  because a table called "saved reports" holding a work queue misleads every
  reader who comes after.
- **Everything goes through the queue.** One path, one set of defects. The cost
  is stated plainly: up to ten seconds even for a thirty-row CSV.
- **PDF for panels, XLSX and CSV for listings.**
- **Files expire in seven days**, through Block 6b's erasure queue.

---

## 5. Two things the product cannot do

**No export carries a full CPF.** `0031` stores a SHA-256 and three digits and
says the raw number "is stored nowhere and appears in no query log". This is an
impossibility, not a cut scope.

**A withheld column is absent, never blank**, and the file names it. On a
screen an omitted figure is a blank the page explains; in a spreadsheet a
missing column is indistinguishable from one nobody asked for, and an empty one
reads as data. When nothing was withheld the file says so explicitly, because
silence and "quietly dropped a column" look identical.

---

## 6. What Block 9 and beyond inherit

`has_permission_for` and its three siblings are now available to any background
job that needs to act on a named person's behalf. Block 9's ETL runs outside
the app with `service_role` and does not need them; Block 10's administration
console might.

`report_runs` is the audit surface for data leaving the installation. Block 11's
security review should read it as such.

**Not in this block, and deliberately:** saved filter definitions with names,
scheduled reports, e-mailed reports, and reports over the audit trail itself
(Block 10 owns the audit viewer).

---

## 7. Deploy

`docs/block-8b-runbook.md` opens with the order and why it is not negotiable
here specifically: `0121` rewrites five functions every RLS policy depends on.
Database first, `db:test` and `test:isolation` green, then the frontend.

**Migrations go up only after this PR merges.** They were edited in place on
the branch — `0121` gained a fifth helper, `0126` gained parameter defaults,
`0127` gained two casts — and Supabase records a migration by version number,
so pushing early and editing afterwards means the edit never lands while
`migration list` shows everything applied.
