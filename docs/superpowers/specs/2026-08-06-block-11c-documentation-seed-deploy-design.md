# Block 11c — The Documents, the Seed, the Journey and the Proof — Design Spec

**Date:** 2026-08-06
**Status:** approved by the owner
**Splits:** master spec §11 Block 11 — 11a shipped the headers and the retention sweep, 11b the CSP, the routine alerting and the upload review. **This is the last block of the project**: the five documents, the controlled seed, the reproducible deploy, documented backup/PITR, and the §35 acceptance journey the master spec names as the definition of done
**Depends on:** every block, which is the point — this one describes and proves what the other nineteen built
**Branches from:** `block-11b`. Its PR (#31) will have merged by the time this opens, so **the PR base is `main`** — this project's PRs merge while the next block is in flight. **No migrations.**

---

## 1. What this block is for

Master spec §11 says the block is done when "the §35 E2E flows pass end to end;
documentation is delivered; the deploy is reproducible." None of the three is
true yet.

**There is no documentation of the system, only of its construction.** Forty-two
documents in `docs/` are per-block reports and runbooks — they record *why a
decision was taken in the week it was taken*, which is a different question from
*how does this work today*. Somebody joining has to read twenty blocks in order
to learn that RLS is the primary mechanism. The `README` is three lines.

**There is no seed.** Every `db reset` prints `no files matched pattern:
supabase/seed.sql`, and a developer who wants to see a full screen builds one by
hand through twenty minutes of clicking.

**The deploy is documented in five places and proved in none.** `Dockerfile`,
`.env.example`, `deploy-readiness-report.md`, `bloco-0-handoff.md` and five block
runbooks each hold a piece.

**Backup is a belief.** Nobody has looked at what the hosted project's plan
actually retains, and nobody has restored anything.

**And §35's journey has never been run as a journey.** Every one of its steps is
covered by one of forty-three Playwright tests; the seam between them is covered
by nothing.

---

## 2. Decisions

### D1 — Five documents that explain the model and point at the living source

`docs/ARCHITECTURE.md`, `SECURITY.md`, `DATABASE.md`, `PERMISSIONS.md`,
`DEPLOYMENT.md`. Each explains **how a thing works and why**, and where the list
is long it names the query rather than copying it.

That is the whole rule, and it exists because the alternative rots. A
`PERMISSIONS.md` listing a hundred permission keys is wrong the first time
somebody adds one and forgets to edit the markdown — and it is wrong *silently*,
which is worse than absent. So the document explains the model — roles composed
per Company, the owner outside the link table, delegation as a permission like
any other, `has_permission` and its `_for` siblings — and says the catalogue is
`select key from public.permissions order by key`.

Same for `DATABASE.md`: the numbering, the never-edit-after-push rule, the Block
0 GRANT convention, `digest()` living in `extensions`, procedure-versus-function
and the `commit` rule that Block 11a paid for. Not a list of 134 migrations.

- **ARCHITECTURE** — the layers (Server Component → action → service → RPC), why
  the `service_role` client is isolated, the outbox and the worker tick, where
  each boundary is. The document that answers "where do I change X".
- **SECURITY** — RLS as the primary mechanism, `SECURITY DEFINER` functions that
  re-authorise, the headers and the CSP, the shared secret on the machine
  routes, and the LGPD story: pseudonymised audit, `anonymize_member`, the
  retention sweep. It points at the isolation suite as the living proof.
- **DEPLOYMENT** — the reproducible path end to end: build args versus runtime,
  binding to `0.0.0.0`, the health check, `SKIP_ENV_VALIDATION`, the three
  `app.*` database settings, migrations before the frontend, and backup/PITR
  (D4).

**The forty-two block documents stay exactly where they are.** They are the
history — why it was decided this way — and the five are the state. Each of the
five points into them for the reasoning rather than restating it.

### D2 — The seed is a script, deliberately outside `db:reset`

`npm run seed:demo`, a Node script using the service key.

**Not `supabase/seed.sql`**, and that is the decision rather than an oversight:
that file runs on every `db reset`, which is what CI's database job and every
local pgTAP run start from. Putting rows in front of 1397 assertions and 44
journeys that currently begin on an empty database is a way to turn a demo
convenience into a week of red suites, and the failures would look like
regressions in whatever block owns the counting.

It creates one demo Station with the whole cycle already visible: a prize
catalogue with stock, a promotion with prizes linked, listeners, participations,
a draw that has run, one winner delivered with a receipt and one with a deadline
still running.

**Idempotent by the Company name** — running it twice does not duplicate — and
**it refuses to run against anything but a local Supabase URL**, with a message
that says why. A demo Station inside a customer's database is damage nobody
undoes.

### D3 — One acceptance journey, through the screens, for §35

`tests/e2e/acceptance.spec.ts`: a single test walking the master spec's §35 from
end to end, with a generous `test.setTimeout` because it is long.

Provision a customer in `/admin/customers` → the owner signs in and changes the
provisional password → register listeners → invite a colleague restricted to one
Station and prove they cannot reach the other → prize, stock, reservation →
promotion, prizes linked → participation → draw → deadline → delivery with a
private receipt → the uncollected prize returning to stock → a report exported →
the audit entry.

**No RPC shortcut on any step that has a screen.** Its whole value is the seam
between blocks, which forty-three isolated journeys never exercise. It duplicates
coverage on purpose.

### D4 — There is no screen for a second Station, and the block records that rather than building one

§35 asks for two Companies. **The product has no path to a second one**:
`provision_customer` creates an Organization and one Station, and the five specs
that need another insert it with the service key. The acceptance journey does the
same, and `ARCHITECTURE.md` records the gap in a line: adding a Station to an
existing Organization is a manual insert today, because the decision was never
taken.

Building that screen would be new product — permission, audit, tests — in the
block whose job is to describe and prove what exists. The owner ruled it out.

### D5 — Backup is proved, not asserted

`DEPLOYMENT.md` gets three things:

1. **What the hosted project actually has** — plan, daily-backup retention, and
   whether PITR is enabled or is a paid add-on. Read from the dashboard, not
   assumed.
2. **The restore procedure**, step by step.
3. **The proof**: `supabase db dump` from the hosted project, restored into a
   throwaway local database, with row counts compared table by table. It
   demonstrates the data is recoverable **without touching production**, and the
   document records the date it was done.

An untested backup is a rumour, and the day you find out is chosen for you.

### D6 — The deploy is proved by building it

`docker build` of the image locally, from scratch, with no cache. It is the
cheapest possible answer to "is the deploy reproducible" and it fails loudly if
a dependency, a Node version or a build arg has drifted since Block 0.

### D7 — The README becomes the front door

Three lines today. It gets: what the product is, how to bring a local
environment up in five commands, and links to the five documents. Nothing else —
a README that repeats the documents is a sixth document that disagrees with them.

---

## 3. Out of scope

**No migrations, and no new product behaviour.** Not the second-Station screen
(D4), not a `job_health` screen, not external uptime monitoring or error
tracking.

**Block 9 (the legacy ETL) stays deferred** — the owner has neither the SQL
Server, nor a dump, nor a schema. **Block 10b (`entitlements` and the `pending`
state) stays deferred and questioned** — nothing in the product asks whether a
feature is on, and the admin provisions each customer by hand, so a Company is
born enabled.

---

## 4. Verification

The house gate: lint, typecheck, build, unit, pgTAP, isolation, e2e in series —
with **44** Playwright tests, the acceptance journey being the new one.

Two proofs that are not automated tests and are recorded with their dates in the
block report: **the dump restored** into a local database with row counts
compared, and **the image built** from a cold cache.

`npm run db:test` still needs a freshly reset database, and `db reset` still
leaves Kong blind until `docker restart supabase_kong_<project>`.
