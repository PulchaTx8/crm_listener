# Block 11c — The Documents, the Seed, the Journey and the Proof — Verification Report

**Branched from `block-11b`.** Its PR (#31) is open with CI green; **this PR's
base is `main`**, because this project's PRs merge while the next block is in
flight and a base on a merged branch fails with a 404.

**Spec:** `docs/superpowers/specs/2026-08-06-block-11c-documentation-seed-deploy-design.md`
**Plan:** `docs/superpowers/plans/2026-08-06-block-11c-documentation-seed-deploy.md`
**Migrations:** none. **New product behaviour:** none.

**This is the last block.**

---

## 1. What shipped

**Five documents** — ARCHITECTURE, SECURITY, DATABASE, PERMISSIONS, DEPLOYMENT —
each explaining the model and pointing at the living source where the list is
long. The permission catalogue is a query, not a markdown table; the schema is
`supabase/migrations/` in order, not a copy that goes stale in silence. The
forty-odd block reports stay where they are as the history: they answer "why was
this decided", these answer "how does it work".

**A demo seed** (`npm run seed:demo`) — a script, deliberately not
`supabase/seed.sql`, because that file runs on every `db reset` and would put
rows in front of 1397 pgTAP assertions and 44 journeys that start from an empty
database.

**The §35 acceptance journey** (`tests/e2e/acceptance.spec.ts`) — fifteen stages
through the screens, from an empty database to an audited delivery.

**A README** that is a front door rather than a title.

**Two proofs that are not automated tests**, both dated in `docs/DEPLOYMENT.md`.

---

## 2. A correction the plan turned up

The spec's D4 originally said the product had no screen for a second Station, and
that the acceptance journey would insert one with the service key. **That was
wrong.** `AddStationForm` lives in the customer record dialog at
`/admin/customers` over the `add_company` RPC, platform-admin only. The first
search for it looked for `create_company` and found nothing.

D4 was rewritten before any code was written, and the journey creates both
Stations through the console like a real operator does. There was no gap to
record.

---

## 3. What the seed and the journey taught, which is most of their value

**The seed:**

- **"The Organization exists" is not "the seed finished".** The first run failed
  part-way, and the next run then reported success over an Organization with
  nothing in it. It now checks the *last* thing a run writes, and tells the
  operator to `db:reset` rather than pretending.
- **A Member has no `company_id`** — the link is `member_company_links`, because
  a listener belongs to the Organization and is linked to Stations. The first
  summary filtered a column that does not exist and, with the error unchecked,
  reported "0 listener(s)" over ten rows that were sitting right there.
- The guard matches on the **parsed hostname**, so `localhost.evil.example` does
  not pass, and it is caught at module scope so a refusal prints one sentence
  rather than a stack trace.

**The journey:**

- **The invitation limiter is keyed by the caller's IP, and every local test
  shares `127.0.0.1`.** Ten accepted invitations per window across the whole
  suite. Iterating on this file exhausted it, and a control working exactly as
  designed looked like a broken journey. The counter is reset in `beforeAll`,
  with the limiter still proved by its own unit and isolation tests.
- **Every Station-scoped screen defaults to the first Station the caller can
  reach**, so the two Stations are named in order. A promotion created at the
  other one refuses the listener's entry with a correct sentence about linking —
  and a very confusing test failure.
- **The report drain claims one run per tick**, so a database carrying queued
  runs from an earlier iteration hands the journey somebody else's work and
  leaves its own report Queued. A single tick passed its own assertions and still
  left the screen empty.
- **An unasserted submit surfaces three stages later.** The participation stage
  originally asserted nothing; the failure arrived at the draw as "no winners".
  It now asserts the outcome where it happens.

---

## 4. The two proofs

**The backup was restored, on 2026-08-06.** Schema and data dumps from
`djbkdyesubkedxjwcohq`, restored into a throwaway local database — production
untouched. Row counts matched exactly: `audit_logs` 12/12, `permissions` 40/40,
`promotions` 1/1, `companies` 1/1, `members` 0/0, `winners` 0/0. Eight statements
failed, every one against `auth.*` or `storage.buckets`, which belong to GoTrue
and Storage and do not exist in a bare Postgres; a real restore targets a
Supabase project, where they do. The dumps were deleted afterwards.

**The image builds from cold, on 2026-08-06.** `docker build --no-cache`
succeeded, 330 MB.

**One thing DEPLOYMENT deliberately does not state:** the hosted project's plan,
its backup retention window, and whether PITR is enabled. Those are read from the
dashboard, and a number written here that nobody re-checks is worse than a
pointer to where the truth is.

---

## 5. The gate

| gate | result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | clean; `/_not-found` the only prerendered route |
| `npm run test` | **882/882** in 67 files |
| `npm run db:test` | **1397/1397** in 28 files |
| `npm run test:isolation` | **285/285**, 28 of 28 files accounted for |
| `npx playwright test --workers=1` | **44/44** |

Two notes on the runs themselves, because both are the kind of thing that gets
misread later:

**The isolation runner dropped a worker once** — 285/285 cases passing, 27 of 28
files reported. That is Block 4b's flake: local, Windows, mechanism unknown,
about two runs in five. It was re-run until it came back complete rather than
interpreted, which is what that block's guard exists to force.

**A full Playwright run failed three specs, and two were flakes.** `dashboards`
and `templates` both passed on their own and in the clean re-run. The third was
real: the acceptance journey clicked through to the draws screen before the
prizes tab had finished rendering, went nowhere, and left no error to read. It
now waits for the control rather than for the click. The final run — freshly
reset database, `--workers=1` — is 44/44.

---

## 6. What remains of the project

**Nothing in the block plan.** Blocks 0 through 11 are delivered.

**Deferred, and each for a stated reason:**

- **Block 9 (the legacy ETL).** The owner has neither the SQL Server, nor a dump,
  nor a schema. It cannot be built against something nobody can see.
- **Block 10b (`entitlements` and the `pending` state).** Nothing in the product
  asks whether a feature is on, and the admin provisions each customer by hand,
  so a Company is born enabled. Building flags nobody reads is what `audit.view`
  did for nine blocks.

**Deliberately not built:** a screen for `job_health`, external uptime
monitoring, and an error-tracking service. The first shows five rows that an
e-mail already pushes to the person who can act on them; the other two are not
repository code.

**After the merge:** nothing new. `0132`–`0134` from Block 11b still need
`supabase db push` to the hosted project, along with `app.health_alert_url` and
`ALERT_EMAIL`, or the hourly health check runs and posts nowhere.
