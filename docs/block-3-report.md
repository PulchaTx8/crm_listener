# Block 3 — Members — Verification Report

- **Date:** 2026-07-28
- **Branch:** `block-3`
- **Spec:** `docs/superpowers/specs/2026-07-28-block-3-members-design.md`
- **Plan:** `docs/superpowers/plans/2026-07-28-block-3-members.md`
- **Ledger:** `.superpowers/sdd/2026-07-28-block-3-members/progress.md`
- **Predecessor:** Block 1c (`docs/block-1c-report.md`), `main` @ `34940be`. Block 2
  (inventory/prizes) is a **sibling** branch, not a predecessor — it was merged into
  `block-3` mid-branch once its own PR landed (see §3), and its migrations
  (`0025`-`0030`) sit underneath this block's (`0031`-`0035`) for that reason, not
  because Block 2 finished first in any other sense.

---

## 1. Verification

All run on a clean `npx supabase db reset`, local Supabase stack already running.

| Command | Result |
|---|---|
| `npm run lint` | PASS — no ESLint warnings or errors |
| `npm run typecheck` | PASS — no output |
| `npm test` | PASS — 15 files, 161 tests |
| `npx supabase db reset && npx supabase test db` | PASS — 3 files, 205 assertions |
| `npm run test:isolation` | PASS — 9 files, 88 tests |
| `npm run build` | PASS |
| `npm run test:e2e` | **7/9 passed** — `inventory-flow` and `roles-flow` failed; `members-flow` (this block's own journey) passed. Known open gate, not closed here — see §1.2. |

Verbatim output:

```
> pulchatx@0.1.0 lint
> next lint --dir src --dir tests
✔ No ESLint warnings or errors

> pulchatx@0.1.0 typecheck
> tsc --noEmit
(no output)

> pulchatx@0.1.0 test
> vitest run
 ✓ tests/unit/supabase-config.test.ts (2 tests)
 ✓ tests/unit/errors.test.ts (3 tests)
 ✓ tests/unit/rate-limit.test.ts (4 tests)
 ✓ tests/unit/sanity.test.ts (1 test)
 ✓ tests/unit/roles-schema.test.ts (13 tests)
 ✓ tests/unit/inventory-schema.test.ts (41 tests)
 ✓ tests/unit/members-schema.test.ts (47 tests)
 ✓ tests/unit/env.test.ts (9 tests)
 ✓ tests/unit/logger.test.ts (5 tests)
 ✓ tests/unit/mailer.test.ts (1 test)
 ✓ tests/unit/member-cpf.test.ts (8 tests)
 ✓ tests/unit/member-search-filter.test.ts (16 tests)
 ✓ tests/unit/provisioning-password.test.ts (3 tests)
 ✓ tests/unit/contact-requests.test.ts (3 tests)
 ✓ tests/unit/invitation-token.test.ts (5 tests)
 Test Files  15 passed (15)
      Tests  161 passed (161)

Applying migration 0031_members.sql...
Applying migration 0032_member_lifecycle_tables.sql...
Applying migration 0033_member_dedup.sql...
Applying migration 0034_member_rpcs.sql...
Applying migration 0035_rls_members.sql...
Restarting containers...
Finished supabase db reset on branch block-3.

Connecting to local database...
/CRM - LISTENER/supabase/tests/00_smoke.test.sql ........ ok
/CRM - LISTENER/supabase/tests/01_identity.test.sql ..... ok
/CRM - LISTENER/supabase/tests/02_permissions.test.sql .. ok
All tests successful.
Files=3, Tests=205,  0 wallclock secs
Result: PASS

> pulchatx@0.1.0 test:isolation
> vitest run --config vitest.isolation.config.ts
 ✓ tests/isolation/members.test.ts (19 tests) 15133ms
 ✓ tests/isolation/inventory.test.ts (17 tests) 14947ms
 ✓ tests/isolation/roles.test.ts (17 tests) 11374ms
 ✓ tests/isolation/permissions.test.ts (11 tests) 5395ms
 ✓ tests/isolation/invitations.test.ts (7 tests) 4136ms
 ✓ tests/isolation/tenant.test.ts (9 tests) 3927ms
 ✓ tests/isolation/contact-requests.test.ts (3 tests) 66ms
 ✓ tests/isolation/provisional-password.test.ts (4 tests) 1197ms
 ✓ tests/isolation/signup-disabled.test.ts (1 test) 15ms
 Test Files  9 passed (9)
      Tests  88 passed (88)

> pulchatx@0.1.0 build
> next build
 ✓ Compiled successfully in 1307ms
   Linting and checking validity of types ...
 ✓ Generating static pages (10/10)
Route (app)                                 Size  First Load JS
├ ƒ /members                             4.39 kB         117 kB
├ ƒ /members/[memberId]                  4.12 kB         117 kB
...

> pulchatx@0.1.0 test:e2e
> playwright test
Running 9 tests using 6 workers
  ok 1 tests\e2e\home.spec.ts:3:5 › home shows the product and links to contact
  ok 7 tests\e2e\home.spec.ts:9:5 › contact page renders the form
  ok 8 tests\e2e\home.spec.ts:15:5 › login page renders the credentials form and offers a reset
  ok 9 tests\e2e\home.spec.ts:22:5 › an anonymous visitor is redirected away from the app
  ok 2 tests\e2e\invitation-flow.spec.ts:38:5 › an owner invites a colleague who joins with their own password (24.9s)
  ok 4 tests\e2e\provisioning-flow.spec.ts:46:5 › provision a customer, sign in, change the password, then suspend (25.7s)
  x  3 tests\e2e\inventory-flow.spec.ts:57:5 › a delegate holding a scoped Stock Keeper role runs the whole prize and stock journey (30.3s)
  x  6 tests\e2e\roles-flow.spec.ts:49:5 › an owner composes a role and assigns it per Station (30.4s)
  ok 5 tests\e2e\members-flow.spec.ts:86:5 › a delegate holding a scoped Audience Manager role runs the whole listener journey, and a delegate at another Station finds nothing (35.4s)

  1) inventory-flow.spec.ts — Test timeout of 30000ms exceeded.
  2) roles-flow.spec.ts — Test timeout of 30000ms exceeded.
     Expect "toBeVisible" with timeout 15000ms
     waiting for locator('[data-testid="member-row"]')...getByRole('button', { name: 'Remove' })

  2 failed
  7 passed (39.8s)
```

### 1.1 What pgTAP and isolation each prove, and a caveat that is now out of date

As in every prior block: pgTAP has no session harness for most of what it asserts,
so most of `supabase/tests/*.sql` proves a grant is present or absent, a constraint
fires, or a flag is set — not that a policy filters rows for a real signed-in user.
Session-dependent enforcement is proven by `tests/isolation/members.test.ts` under
real JWTs.

**One correction to a caveat repeated in three prior block reports.** Those reports
say nothing in `supabase/tests/*.sql` can prove a policy filters rows for a real
signed-in user — that is no longer entirely true for this repo, and Task 5's review
found it first. `02_permissions.test.sql` (lines 704-773) switches to `set local
role authenticated` with real `request.jwt.claims`, reads through five different
delegate/owner sessions, and asserts on what comes back — nine such assertions for
this block alone. `authenticated` is neither the table owner nor `BYPASSRLS`, so
RLS genuinely applies to those reads; this is real proof of row-level filtering,
inside a `.sql` file, not merely a grant check. What remains true of the old
caveat: it still applies to the other ~130 pgTAP assertions in this project that
never switch role, and pgTAP still cannot exercise a `SECURITY DEFINER` RPC's own
internal permission check the way a real client call can (a function body executes
under its owner regardless of `set local role`) — that half is what the isolation
suite alone still proves.

### 1.2 The e2e gate is open, and this run does not close it

`npm run test:e2e` at the repo's true default (no `--workers` override) produced
7/9 passed. The two failures, `inventory-flow.spec.ts` and `roles-flow.spec.ts`,
touch no file this block added or modified. `members-flow.spec.ts` — this block's
own end-to-end journey — passed cleanly at 35.4s, both in this run and in Task 10's
own prior run.

Task 10's last recorded full-suite run (ledger) was 6/9 passed, failing
`inventory-flow`, `provisioning-flow` and `roles-flow`. This run failed
`inventory-flow` and `roles-flow` but not `provisioning-flow` — **which spec fails
changes between runs**, which is itself evidence against a deterministic defect in
any one spec and consistent with the ledger's own theory: shared `next dev`
compile-under-load contention at this machine's 6 default workers, not a real
assertion failing. `roles-flow`'s failure in this run has the identical shape
Task 10 already recorded — `Test timeout of 30000ms exceeded` waiting 15s on a
locator, Playwright killing a still-pending `expect` rather than an assertion
evaluating false. Task 10's ledger also records that deleting `members-flow.spec.ts`
entirely reproduced the same three failures, which rules out this block's own spec
as the cause of the others' flakiness.

**This is reported as an open gate, not closed by this task.** Per the dispatch,
closing it or working around it was explicitly out of scope here. What one run (or
even the two runs now on record) can establish: `members-flow` itself is reliably
green, and the failures are not concentrated in code this block touches. What it
cannot establish: whether the suite is reliably green or reliably red at this
machine's worker count, or whether CI — 2 workers against a production build, a
materially different environment per Block 2's own §1.4 finding — would show the
same pattern. Only CI, which fires on `pull_request`, can arbitrate that.

### 1.3 The RLS grid: what 65 assertions prove, corrected against the ledger

`0035_rls_members.sql` secures five tables — `members`, `member_company_links`,
`member_consents`, `member_notes`, `member_blocks` — with RLS enabled, `revoke all
from anon, authenticated`, `select` granted to `authenticated` and `service_role`,
one policy per table, and `revoke truncate` from `service_role`. This is asserted
by 65 pgTAP checks in `02_permissions.test.sql` (lines 503-607).

The block's own ledger describes this grid's evidentiary weight inaccurately — its
count does not add up (5+10+5+10+6 = 36, stated as 35) and it double-counts a set
of 6 "behavioural" assertions as part of the 65 when they are a separate block
later in the file. Recounted directly against the migration and the project's own
established default-ACL finding (a freshly created `public` table grants the
Supabase roles only `Dxtm` — TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, never SELECT/
INSERT/UPDATE/DELETE — `0002_rate_limit.sql:15`, restated at `0035:173-192`):

| Category | Count | Genuinely bites an edit to `0035`? |
|---|---|---|
| RLS-enabled flags | 5 | Yes |
| `authenticated`/`service_role` SELECT grants | 10 | Yes |
| `anon` SELECT denied | 5 | No — never in the default ACL to begin with |
| Policy counts (one per table) | 5 | Yes |
| INSERT/UPDATE/DELETE denied (5 tables × 3 ops × 2 roles) | 30 | No — none of these was ever in the default ACL; the migration grants none of them, so nothing needs to revoke them |
| TRUNCATE denied (5 tables × 2 roles) | 10 | Yes — TRUNCATE **is** in the default ACL; the explicit revoke is what closes it |

**30 of the 65 genuinely bite; 35 guard a future grant against a baseline the
default ACL already provides for free.** Beyond the 65, **9** behavioural
assertions (not 6) prove real row-level filtering under session-switched real JWTs
— four on `members`, one on `member_notes`, two on `member_blocks`'s org-wide
branch (including the Important-2 negative case), two on the owner's view. pgTAP
alone carries no dedicated behavioural case for `member_consents` or
`member_company_links`; both are proven instead — more strongly — by
`tests/isolation/members.test.ts` (case 5, gap 5a) under real signed-in sessions.

---

## 2. Proof that the invariant tests still bite

Two mutations, each applied to the migrations on disk, each verified live against
`npx supabase db reset`, then reverted with `git diff --stat` confirmed empty
before the next step — never chained with `&&`, since a test runner exits non-zero
on exactly the failure a mutation is designed to cause, and `run && git checkout`
would silently skip the restore. Mutation 2 was not started until mutation 1's
revert was confirmed clean. Neither mutation is present in any commit.

### 2.1 `find_member_by_identifier`'s `elsewhere` branch, made to leak `member_id`

`supabase/migrations/0033_member_dedup.sql`'s `elsewhere` return was changed from
`jsonb_build_object('outcome', 'elsewhere')` to
`jsonb_build_object('outcome', 'elsewhere', 'member_id', v_id)`. After
`npx supabase db reset`, `tests/isolation/members.test.ts` was run:

```
 ❯ tests/isolation/members.test.ts (19 tests | 1 failed)
   × deduplication — find_member_by_identifier > case 2: returns elsewhere and
     nothing else — exactly one key — when the caller cannot reach it
     → expected { outcome: 'elsewhere', …(1) } to deeply equal { outcome: 'elsewhere' }

 AssertionError: expected { outcome: 'elsewhere', …(1) } to deeply equal { outcome: 'elsewhere' }
 - Expected
 + Received
   Object {
+    "member_id": "31172bd8-2f39-485b-8235-f48ad28eddc3",
     "outcome": "elsewhere",
   }

 Test Files  1 failed (1)
      Tests  1 failed | 18 passed (19)
```

Caught by `tests/isolation/members.test.ts:79` — the `toEqual({ outcome:
'elsewhere' })` assertion fails on the extra key before the file's own belt-and-
braces `toHaveLength(1)` key-count check (line 84) even runs. The mutation was
caught, not by luck of a secondary assertion but by the primary shape check the
brief named.

Reverted (`git checkout -- supabase/migrations/0033_member_dedup.sql`, then `;`,
never `&&`); `git diff --stat` on the file: empty.

### 2.2 `create_member`'s audit detail, made to carry `p_full_name`

`supabase/migrations/0034_member_rpcs.sql`'s `create_member` audit insert was
changed from `jsonb_build_object('member_id', v_id)` to `jsonb_build_object(
'member_id', v_id, 'name', p_full_name)`. After `npx supabase db reset`, the same
suite:

```
 ❯ tests/isolation/members.test.ts (19 tests | 1 failed)
   × case 8 (+ gaps 3 and 6, rule 1): after anonymisation, no audit_logs row for the
     Member contains any erased value, ...
     → expected '[{"detail":{"owner_user_id":"08df738c…' not to contain
       'Zzq Probe mem-audit-1785259631067'

 Test Files  1 failed (1)
      Tests  1 failed | 18 passed (19)
```

Caught by `tests/isolation/members.test.ts:700`, the needle-search loop over every
distinctive value across all nine `audit_logs` rows for the Member. The printed
haystack shows the leak concretely: `{"detail":{"name":"Zzq Probe mem-audit-
1785259631067","member_id":"4fcb46af-..."}}` on the `create_member` row.

Reverted (`git checkout -- supabase/migrations/0034_member_rpcs.sql`, then `;`);
`git diff --stat` on both mutated files: empty. `npx supabase db reset` re-run,
`npx supabase test db` (205/205, unchanged) and `tests/isolation/members.test.ts`
alone (19/19) re-confirmed clean on the restored tree.

**Both mutations were caught by the test named in the brief. Neither passed
vacuously.**

---

## 3. Deployment steps

Everything in `docs/block-1a-report.md` §1, `docs/block-1b-report.md` §3,
`docs/block-1c-report.md` §3 and `docs/block-2-report.md` §3 still applies.
Migrations `0031`-`0035` apply with `npx supabase db push --linked` (after
`0025`-`0030`, Block 2's, which this branch already contains — see the ledger's
"Branch maintenance" entry for how the numbering collision risk was resolved):

- `0031_members.sql` — `members` (Organization-scoped identity) and
  `member_company_links` (what RLS reads for per-Station visibility); four partial
  unique indexes (`organization_id` + normalised phone/email/CPF-hash/passport,
  each `where deleted_at is null`) that make a duplicate identifier
  unrepresentable independent of any RPC; the six `members.*` permission rows
  (`view`, `create`, `edit`, `block`, `archive`, `erase`); `normalize_phone`/
  `normalize_email`, extracted `immutable` functions shared by the generated
  columns and the dedup function so normalisation cannot drift between the two.
- `0032_member_lifecycle_tables.sql` — `member_consents`, `member_notes`,
  `member_blocks` (append-only in spirit, no `updated_at` on any of the three,
  matching the master spec's LGPD posture) and `is_member_blocked`, whose
  `starts_at`/`ends_at` comparison against `now()` is why a dated suspension
  expires with no job ever running.
- `0033_member_dedup.sql` — `member_reachable` (the shared any-link reachability
  test, admitting the owner and platform admin outside the per-link check so a
  Member whose only Station is suspended or archived is not a permanent dead end)
  and `find_member_by_identifier`, the block's most sensitive function — see §5.1.
- `0034_member_rpcs.sql` — the nine write RPCs (`create_member`, `update_member`,
  `link_member_to_company`, `archive_member`, `record_member_consent`,
  `add_member_note`, `block_member`, `lift_member_block`, `anonymize_member`) plus
  two internal helpers (`member_linked_to_company`, and the enum
  `member_erasure_reason` — owner's Ruling A, §5.2). Every audit entry these nine
  write carries `member_id` and no personal value; §2.2 above demonstrates this is
  genuinely enforced, not merely stated.
- `0035_rls_members.sql` — RLS on all five tables from `0031`/`0032`, `select`-only
  grants to `authenticated` and `service_role`, `revoke truncate`, and the
  reachability policies described in §1.3.

Fifteen functions ship across these five migrations: the twelve forming the
product-facing API surface (the nine write RPCs, `find_member_by_identifier`,
`is_member_blocked`, and `member_reachable` — the last directly callable and
covered by its own isolation case, gap 2), plus three pure internal helpers
(`normalize_phone`, `normalize_email`, `member_linked_to_company`) with no
independent grant of their own.

**Nothing here is destructive.** All five migrations were checked directly for
`DROP TABLE`, `DROP COLUMN`, `DROP FUNCTION`, `DROP POLICY` and `DELETE FROM` —
none appears in any of them. No table is dropped, no column is dropped, no
existing row anywhere in the schema is deleted or rewritten. This block adds five
new tables, three new enum types (`member_consent_type`, `member_block_kind`,
`member_erasure_reason`) and fifteen new functions, plus their RLS — nothing here
touches a table any earlier block shipped except to add six new rows to
`permissions`.

**The one property worth protecting going forward, matching Block 2's own §3
close:** no future migration should grant `INSERT`, `UPDATE` or `DELETE` on any of
the five Member tables to anything but the nine `SECURITY DEFINER` RPCs that
already own them (which need no grant of their own, since they run as the table
owner), and no future block should read or write these tables from outside RLS
without going through `find_member_by_identifier`, `member_reachable`, or a fresh
policy reviewed with the same scrutiny Task 3 and Task 5 gave this one.

---

## 4. Definition of done

Copied from the spec's §13, with evidence per row.

| Criterion | Status | Evidence |
|---|---|---|
| Deduplication prevents a duplicate across the Organization | ✅ | `tests/isolation/members.test.ts` cases 1-3; `0031`'s four partial unique indexes make it unrepresentable even without the function, per Task 1's own drop-the-index verification |
| It does so **without revealing** a Member from an unreachable Station | ✅ | case 2, "returns elsewhere and nothing else — exactly one key"; §2.1 above proves this by mutation |
| A Member is invisible to a user with no access to any of their Stations | ✅ | case 4, driven from permission resolution, not the access gate — the delegate holds a live membership at the Member's Station under a role granting nothing |
| "Stations they took part in" shows only reachable Stations | ✅ | case 5 |
| A dated suspension expires with no job running | ✅ | case 6 — three calls to `is_member_blocked` (past/future/indefinite org-wide), no job in between |
| Anonymisation leaves no personal data in the source table | ✅ | case 9 (generated columns clear, phone reusable); `anonymize_member`'s own comment records this was verified against a live database, not merely reasoned about (Task 4) |
| **Anonymisation leaves no personal data in the audit trail** | ✅ | case 8; §2.2 above proves this by mutation, and case 8's own fixture seeds the four categories (passport, address, birth date, discovery source) that had zero coverage before Task 7's fix round |
| The raw CPF is stored nowhere | ✅ | pgTAP: `hasnt_column('members', 'cpf', ...)` and the `cpf_hash` format CHECK (Task 1); isolation "bonus" case sends a raw eleven-digit CPF directly to `create_member` and gets a `23514` naming `members_cpf_hash_check`, proving the CHECK holds even if Node's hashing were bypassed |
| An archived Member's identifiers can be reused | ✅ | case 10 |
| Each of the six permissions gates its own operation | ✅ | case 7, one sub-case per permission code, refused-then-allowed |
| lint, typecheck, unit, pgTAP, isolation, e2e and `docker build` pass | ⚠️ | lint/typecheck/unit/pgTAP/isolation/build all PASS per §1 above; `docker build` was not part of this task's dispatched gate list and was not run; `test:e2e` is the known open gate documented in §1.2 — not a Block 3 regression, but not closed either |

---

## 5. What the plan and the implementation got wrong

Of ten reviewed tasks, only **Task 2** (the append-only lifecycle tables and the
date-driven block expiry) reviewed clean on the first pass with no Critical or
Important finding at all. Every other task needed at least one fix round — Tasks
6, 8, 9 and 10 needed two — and the heaviest concentration of Important findings
(5, 5 and 3 respectively, each a "Needs fixes" verdict) sits exactly where the
block's own two rules live: the dedup function that reads across the visibility
boundary (Task 3), the write RPCs and erasure (Task 4), and the RLS that seals the
five tables (Task 5). Task 1 carried two small fix-round items despite an
"Approved" verdict; Tasks 6, 7, 8 were each approved with one Important found and
fixed; Task 9's forms and Task 10's e2e journey each needed a second round to
close an Important the first round's own fix had introduced.

### 5.1 The dedup function leaks existence by design, and why that is the correct trade

`find_member_by_identifier` (`0033_member_dedup.sql`) is, in the project's own
words, "THE ONE PLACE IN THIS PROJECT THAT READS ACROSS THE VISIBILITY BOUNDARY BY
DESIGN." Its `elsewhere` branch tells a caller that *someone* in the Organization
holds the phone number, e-mail, CPF or passport they searched for, without telling
them who: no id, no name, no Station name, no count. That is a deliberate,
uncomfortable trade, not an oversight — **any system that prevents duplicates
across a visibility boundary leaks the existence of what is on the other side.**
The system cannot refuse a genuine duplicate without checking whether one exists,
and checking necessarily produces a yes/no answer the caller can observe. What the
function must never leak, and does not, is **who** — verified structurally (the
`elsewhere` branch is a bare `jsonb_build_object('outcome', 'elsewhere')` literal
with no interpolation) and now verified by mutation (§2.1 above): the moment the
function was changed to return `member_id` in that branch, the isolation suite's
case 2 caught it immediately and specifically.

Two things about this design were tightened during review rather than shipped as
first written. Task 3's review found that `limit 1` with no deterministic order
over four independently-unique identifiers could hand back an arbitrary Member
when two different Members held two different matching identifiers — fixed with a
`candidates` CTE ordered `reachable desc, id`, so the answer prefers a Member the
caller can actually reach and is stable across repeated calls. And the function's
own permission gate (`members.view` required, checked before any argument
validation) means a caller who lacks that permission cannot distinguish "you sent
bad arguments" from "you have no access" — no oracle from the error shape.

One thing was found and deliberately **not** fixed in this block: the function
writes no audit record of a cross-boundary probe, because it is `stable` (a design
choice enabling PostgREST to route it efficiently) and cannot write. Any org
member holding `members.view` at one Station can therefore enumerate identifiers
Organization-wide, untraced. This is one level down from the existence leak the
spec already requires — the spec accepts that a search reveals existence to the
searcher; what remains unaddressed is that the search itself leaves no record for
anyone else to see it happened. Recorded here rather than fixed, matching the
same trade-off already accepted at the design level.

### 5.2 Merging duplicate Members is deferred to Block 9, not solved partially here

The design spec (§4, lines 94-97) is explicit that merging two Members later found
to be the same person is out of scope for this block: it "needs participations and
deliveries to re-point, which do not exist yet, and doing it now would mean
inventing their contracts blind." Block 9's ETL is named as the first caller that
genuinely needs a merge operation. This block's partial unique indexes make a
*duplicate* unrepresentable at write time; they say nothing about *un-merging* two
records that predate the indexes, or about *merging* two that legitimately turned
out to be one person after both were created in different Stations before either
was linked to the other's. No code in this block attempts either.

### 5.3 Anonymising internal users remains unbuilt; this block is the model for it

Block 1c's report already established that an internal panel user cannot be
deleted once they have acted, because five foreign keys reach `auth.users` with no
`on delete` behaviour. The design spec (§7, lines 185-188) states plainly that
`anonymize_member`'s pattern — scrub the identifying columns, keep the row so
history still references something, set a sentinel timestamp, audit the event and
no personal value — "is the answer there too, and this block builds the pattern it
will follow. Doing it for internal users is not in scope here." Nothing in this
block touches `auth.users`, `company_memberships` or any internal-user table; the
pattern exists now as a worked example (a migration, an RPC shape, an isolation
test proving the audit trail stays clean) for whichever future block takes on
internal-user erasure, not as a partial implementation of it.

### 5.4 Four owner rulings, attributed correctly

**Fixed before implementation** (design spec §2, 2026-07-28): three consents —
rules, image/name use, sponsor communication — each recorded separately with date
and origin; and explicitly **no WhatsApp consent record**, on the owner's own
stated legal reasoning that a Member who messages the Station first has authorised
the reply, with the origin and date of first contact recorded as the evidence that
position rests on ("this is a legal judgement the owner made and it is recorded
here as theirs, not derived" — the spec's own words).

**During the block, three more rulings, each made by the owner in response to a
review finding, not by the plan or the controller:**

1. **The erasure reason becomes a bounded enum** (`member_erasure_reason`:
   `subject_request`, `court_order`, `internal_policy` — deliberately no `other`,
   because an escape hatch invites exactly the free text the rule exists to keep
   out). The finding: `anonymize_member`'s comment claimed "no erased value, ever"
   while the reason parameter was unbounded operator text, written verbatim into
   an immutable audit trail. Task 7's own audit-search test could never have
   caught this on its own, because the test controls what reason string it sends —
   the owner chose to make the rule checkable by the type system rather than
   dependent on an operator's discipline, the same reasoning that already kept the
   raw CPF out of the database.
2. **Anonymisation also scrubs the free text in the three lifecycle tables** —
   `member_notes.body`, `member_consents.origin`, `member_blocks.reason` and
   `lift_reason`. The review found these survive an erasure untouched by the
   original draft, so a note reading "this is the person we erased, their phone
   was X" could outlive the erasure it describes. `0032` declares these three
   tables append-only in spirit; the owner accepted that scrubbing them on
   erasure is a real, deliberate exception to that spirit, not a violation of it —
   the same pattern as `members` itself: the row survives so history references
   something, the person does not.
3. **The `member_blocks` org-wide read branch is narrowed to require
   reachability, not `has_org_permission` alone.** The original policy let anyone
   holding `members.view` at *any* Station in the Organization read every
   Organization-wide block, including the mandatory free-text `reason`, for a
   Member `members_select_reachable` itself hides from that same caller. The
   implementer's comment attributing this shape to `block_member`'s own write-side
   asymmetry was factually accurate (`0034:583-587` does gate the write on
   `has_org_permission` alone) — but the owner's ruling was that mirroring a write
   asymmetry onto a read is a different decision, because writing an org-wide
   block discloses nobody's data while reading one discloses the Member's own
   history. The fact that made narrowing free: `is_member_blocked` is `SECURITY
   DEFINER` and already answers "is this person barred" regardless of what this
   policy allows, so narrowing the read cost no operational capability.

### 5.5 The comment-defect class, and why it kept recurring in exactly this shape

Eight instances of the same defect — a comment describing a mechanism the code
does not actually have — have now shipped across this project; six of the eight
are in this block (Task 1, 3, 4, 5, 6, 9). The mechanism behind it is nameable, and
it is not carelessness about writing comments. The worst instances in this block
were comments **justifying a decision** — Task 5's false claim that calling
`member_reachable` from the `members` policy would cause RLS recursion (when the
inline alternative it defended did exactly the same re-entry, and the project's
own prior migrations, `0021` and `0024`, already document the real mechanism from
scars); Task 9's `station-access` comment claiming a helper was "generalised
rather than hand-copied a second time" when it had, in fact, been hand-copied and
silently dropped a `suspended` filter in the process; and Task 9's `BlockForm`
comment claiming an empty-Stations-but-`canBlock`-true state "can only happen for
an owner/platform-admin caller," which was false and papered over a real dead end
for an ordinary delegate.

Each of these was written from the reasoning that produced the decision, which
reads as a conclusion rather than a claim — so nobody re-checks it, and in three
cases the comment concealed the actual gap between what was intended and what was
built. **A comment describing what code does is checkable against the code; a
comment explaining why something is safe or impossible looks pre-checked, and
that is precisely why it is the more dangerous of the two to get wrong.** A
structurally identical variant surfaced three times in Task 10, one level removed
from a comment: claims that several test assertions were mutually independent,
which were really unexamined claims about the fixture data (every value in that
suite ends in the same timestamp, so a "the id never appears" check and a "the
name never appears" check were never actually independent of each other).

### 5.6 Smaller findings worth naming plainly

- **Task 3** (deferred): `find_member_by_identifier` writes no audit record of a
  cross-boundary probe (§5.1 above) — accepted as a consequence of the function
  being `stable`, not fixed.
- **Task 4** (deferred, disclosed asymmetry): `first_contact_at` survives
  `anonymize_member` while `first_contact_origin` is erased, though the
  function's own comment describes the pair as one piece of evidence. Follows the
  brief's shipped body exactly; the asymmetry is real and is named here rather
  than left implicit.
- **Task 4** (deferred, project-wide question, confirmed at this task):
  `authenticated`'s `EXECUTE` on every RPC in `0033`/`0034` survives `revoke ...
  from public`, the same pattern inherited from `apply_inventory_movement`
  (`0027:133`). Confirmed directly against the live database in this task
  (`has_function_privilege('public', 'create_member(...)', 'EXECUTE')` → `f`,
  `has_function_privilege('authenticated', ..., 'EXECUTE')` → `t`) — standard
  Postgres ACL behaviour: revoking from `PUBLIC` removes only the implicit
  blanket grant, never a role's own separately granted privilege.
- **Task 8** (deferred, disclosed): `formatDate`/`formatDateTime`
  (`src/app/(app)/members/format.ts`) carry no explicit `timeZone` for the
  `timestamptz` fields they render — consent granted-at, block created-at, note
  and link timestamps. Same shape as `inventory/format.ts`, so a project-wide
  convention rather than a regression, but these are the product's first
  person-facing **legal** timestamps rather than an internal operational log —
  worth a deliberate decision at the next touch of this screen rather than a
  silent carry-forward.
- **Task 8** (fixed in review): `birth_date`, a Postgres `date` column with no
  time component, was rendered with `toLocaleDateString`, which parses the
  date-only ISO string as UTC midnight and then renders in the runtime's own
  zone — a São Paulo server would have shown 9 May for a 10 May birth date. Fixed
  with a dedicated `formatCalendarDate` pinning both the parse and the render to
  UTC, reproduced by the reviewer under both `TZ=America/Sao_Paulo` and
  `TZ=UTC` before being accepted.
- **Task 9** (fixed in review, the block's highest-stakes screen): the erasure
  confirmation copy told the operator that consents keep "their dates, types and
  who recorded them," while `anonymize_member` (per Ruling B above) also nulls
  `member_consents.origin` — an operator was told evidence survives when it does
  not, on the one screen built specifically to state the erasure promise
  accurately. Fixed to name `origin` among what is destroyed.

---

## 6. Open items

1. **`npm run test:e2e` is an open gate, not closed by this task.** §1.2 above.
   `members-flow.spec.ts` itself is reliably green across both runs on record;
   `inventory-flow` and `roles-flow` fail inconsistently between runs at this
   machine's 6-worker default, in a shape (30s test timeout waiting on a 15s
   locator) consistent with `next dev` compile contention rather than a real
   assertion failing. Only a CI run, at 2 workers against a production build, can
   arbitrate whether this recurs under different resource constraints.

2. **`find_member_by_identifier` writes no audit trail of a cross-boundary
   existence probe.** Any org member holding `members.view` at one Station can
   enumerate identifiers Organization-wide, untraced, because the function is
   `stable` and cannot write. Accepted as a consequence of the design in §5.1
   above, not fixed here.

3. **The two disclosed, deferred asymmetries in §5.6**: `first_contact_at`
   surviving erasure while `first_contact_origin` does not, and the members
   screens' `timestamptz` fields carrying no explicit rendering zone on the
   product's first legal timestamps. Neither is a defect against this block's own
   brief; both are worth a deliberate decision at the next relevant touch rather
   than silent carry-forward.

4. **`docker build` was not run as part of this task.** It was not in this task's
   dispatched gate list (unlike Block 2's report, which included it); lint,
   typecheck, unit, pgTAP, isolation and `next build` all passed. If a container
   build is part of this project's actual deployment path, it should be run
   before merge as a separate check.

5. **The remaining ~27 deferred minors recorded in the block's ledger** (full
   detail: `.superpowers/sdd/2026-07-28-block-3-members/progress.md` and the
   per-task reports in the same directory) are, on review, either already closed
   by a later task without the ledger being updated to say so (Task 2's
   `is_member_blocked` org-wide branch, Task 3's unprobed platform-admin arm, and
   Task 4's "5 of 9 RPCs" and "no post-refactor probe" gaps — all four closed by
   Task 7's cases 6, 8, and gap 2, confirmed present and passing in this run),
   deliberate and already-reasoned scope or trade-off decisions (the
   eight-consecutive-text-parameter ergonomic risk, mitigated in practice by the
   service layer's named-object RPC calls; the missing `SET search_path` on
   `normalize_phone`/`normalize_email`, left to avoid blocking inlining on
   IMMUTABLE functions used in index expressions), or low-blast-radius cosmetic
   and evidentiary gaps (stale doc cross-references, a latent unreachable
   UTC-offset edge case in `toDateOnly`, the anonymised-member rendering
   remaining untested live because Task 10's e2e role deliberately excludes
   `members.erase` by design). None blocks a merge on its own.

6. **Items 1, 2, 5, 8 and 9 of `docs/block-1c-report.md` §5 remain open and are
   unrelated to this block's scope** (non-cascading FKs on internal-user
   deletion — the same defect this block's `anonymize_member` pattern is offered
   as the eventual answer to, §5.3 above, not yet applied there; `RAISE LOG`-only
   denial paths; the `roles.manage` self-escalation property; the table-wide
   `profiles` `SELECT` grant; the four-screens-three-behaviours read-failure
   inconsistency).

7. **The isolation suite's account-cleanup leak, first recorded in Block 1c and
   carried in `docs/block-2-report.md` §6 item 3, deepens further with this
   block.** `members.created_by` (`0031_members.sql:86`) is a genuinely new
   `uuid references auth.users(id)` with no `ON DELETE` behaviour — one more
   non-cascading foreign key on top of the ones Block 1c and Block 2 already
   named. `audit_logs.actor_id` (`0004_audit_and_contact.sql`, pre-existing) is
   not a new foreign key, but this block's nine write RPCs are nine new call
   sites populating it, widening the set of accounts `cleanupUsers` cannot
   remove. This run's own isolation suite left 55-64 accounts behind per file,
   consistent with the existing, already-disclosed pattern rather than a new
   regression.
