# Block 1c — Roles & per-Company Assignment — Verification Report

- **Date:** 2026-07-27
- **Branch:** `block-1c`
- **Spec:** `docs/superpowers/specs/2026-07-27-block-1c-roles-per-company-design.md`
- **Plan:** `docs/superpowers/plans/2026-07-27-block-1c-roles-per-company.md`
- **Ledger:** `.superpowers/sdd/2026-07-27-block-1c-roles-per-company/progress.md`
- **Predecessor:** Block 1b (`docs/block-1b-report.md`)

---

## 1. Verification

All run on a clean `npx supabase db reset`, local Supabase stack already running.

| Command | Result |
|---|---|
| `npm run lint` | PASS — no ESLint warnings or errors |
| `npm run typecheck` | PASS — no output |
| `npm test` | PASS — 11 files, 49 tests |
| `npx supabase db reset && npx supabase test db` | PASS — 3 files, 64 assertions |
| `npm run test:isolation` | PASS — 7 files, 49 tests |
| `npm run test:e2e` | PASS — 7 tests |
| `docker build -t pulchatx:1c ...` | PASS — image 313 MB |

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
 ✓ tests/unit/rate-limit.test.ts (4 tests)
 ✓ tests/unit/sanity.test.ts (1 test)
 ✓ tests/unit/supabase-config.test.ts (2 tests)
 ✓ tests/unit/errors.test.ts (3 tests)
 ✓ tests/unit/roles-schema.test.ts (13 tests)
 ✓ tests/unit/logger.test.ts (5 tests)
 ✓ tests/unit/mailer.test.ts (1 test)
 ✓ tests/unit/provisioning-password.test.ts (3 tests)
 ✓ tests/unit/env.test.ts (9 tests)
 ✓ tests/unit/invitation-token.test.ts (5 tests)
 ✓ tests/unit/contact-requests.test.ts (3 tests)
 Test Files  11 passed (11)
      Tests  49 passed (49)

Applying migration 0015_roles.sql...
Applying migration 0016_memberships.sql...
Applying migration 0017_role_rpcs.sql...
Applying migration 0018_invitations_1c.sql...
Applying migration 0019_rls_1c.sql...
Applying migration 0020_profiles_visibility.sql...
Applying migration 0021_companies_visibility_fix.sql...
Applying migration 0022_list_manageable_companies.sql...
Applying migration 0023_list_manageable_companies_by_permission.sql...
Restarting containers...
Finished supabase db reset on branch block-1c.

Connecting to local database...
/CRM - LISTENER/supabase/tests/00_smoke.test.sql ........ ok
/CRM - LISTENER/supabase/tests/01_identity.test.sql ..... ok
/CRM - LISTENER/supabase/tests/02_permissions.test.sql .. ok
All tests successful.
Files=3, Tests=64,  0 wallclock secs
Result: PASS

> pulchatx@0.1.0 test:isolation
> vitest run --config vitest.isolation.config.ts
 ✓ tests/isolation/roles.test.ts (14 tests) 9637ms
 ✓ tests/isolation/permissions.test.ts (11 tests) 5859ms
 ✓ tests/isolation/invitations.test.ts (7 tests) 4539ms
 ✓ tests/isolation/tenant.test.ts (9 tests) 4354ms
 ✓ tests/isolation/contact-requests.test.ts (3 tests) 95ms
 ✓ tests/isolation/provisional-password.test.ts (4 tests) 1324ms
 ✓ tests/isolation/signup-disabled.test.ts (1 test) 18ms
 Test Files  7 passed (7)
      Tests  49 passed (49)

> pulchatx@0.1.0 test:e2e
> playwright test
Running 7 tests using 4 workers
  ok 1 tests\e2e\home.spec.ts:3:5 › home shows the product and links to contact (663ms)
  ok 5 tests\e2e\home.spec.ts:9:5 › contact page renders the form (1.7s)
  ok 6 tests\e2e\home.spec.ts:15:5 › login page renders the credentials form and offers a reset (640ms)
  ok 7 tests\e2e\home.spec.ts:22:5 › an anonymous visitor is redirected away from the app (909ms)
  ok 2 tests\e2e\provisioning-flow.spec.ts:46:5 › provision a customer, sign in, change the password, then suspend (15.0s)
  ok 3 tests\e2e\invitation-flow.spec.ts:38:5 › an owner invites a colleague who joins with their own password (16.1s)
  ok 4 tests\e2e\roles-flow.spec.ts:49:5 › an owner composes a role and assigns it per Station (18.4s)
  7 passed (22.6s)

docker build -t pulchatx:1c --build-arg NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy .
...
 ✓ Compiled successfully in 8.9s
   Linting and checking validity of types ...
 ✓ Generating static pages (10/10)
#20 naming to docker.io/library/pulchatx:1c done
```

### 1.1 The fail-closed guard is not vacuous

Per the task brief, the permission-code existence check in `has_permission`
(`supabase/migrations/0016_memberships.sql`) was temporarily moved *inside*
the platform-admin bypass:

```sql
-- BROKEN, applied only to prove the guard is load-bearing:
select public.has_company_access(p_company_id)
   and (
     public.is_platform_admin()
     or (
       exists (select 1 from public.permissions p where p.code = p_permission)
       and ( ... role/owner checks ... )
     )
   );
```

After `npx supabase db reset` applied the mutated migration, `npm run
test:isolation` failed exactly one test:

```
FAIL tests/isolation/permissions.test.ts > permission helpers > returns false for an unknown permission code, even for a platform admin
AssertionError: expected true to be false
- Expected: false
+ Received: true
  at tests/isolation/permissions.test.ts:52:18
Test Files  6 passed (7)
     Tests  1 failed | 48 passed (49)
```

This is `tests/isolation/permissions.test.ts:41-53`, which calls `has_permission`
with `p_permission: 'totally.bogus.code'` as the platform admin that provisioned
the customer — exactly the caller a naive `is_platform_admin() or exists(...)`
would wave through. The mutated function returned `true`; a same run also hit
one transient `tinypool` worker-exited-unexpectedly error after the assertion
failure was already recorded (see §5) — unrelated to the result, and consistent
with the environmental flake the ledger documents twice elsewhere in this block.

The migration was reverted (`git diff` on the file is empty) and `npx supabase
db reset` re-applied; `npx supabase test db` (64/64) and `npm run test:isolation`
(49/49) were re-run clean afterwards. The guard is doing work, not agreeing with
whatever the function happens to return.

### 1.2 What the 64 green pgTAP assertions do, and do not, prove

This block's own Task 5 review flagged, and the ledger records it as worth
stating plainly here: pgTAP has no session harness, so nothing in
`supabase/tests/*.sql` proves a policy or a `SECURITY DEFINER` function
actually filters rows or a permission check for a real signed-in user — only
that a grant is present or absent, a constraint fires, or a flag is set.
Session-dependent enforcement (a role granting or withholding a permission,
`has_permission`/`has_org_permission` resolving correctly for a real caller, a
suspended Company yielding nothing to its own owner) is proven exclusively by
`tests/isolation/*.test.ts` under real JWTs. Do not read the pgTAP count as
proof of enforcement by itself — it proves the schema is shaped correctly; the
isolation suite proves the shape behaves correctly.

---

## 2. What the plan got wrong

Nearly every defect below was in the plan's SQL or in the brief handed to a
task, not in what the implementer wrote against it — the ledger says this
almost verbatim after Tasks 1, 2, 3, 4 and 7, and it is worth repeating plainly
rather than crediting a review process that mostly caught its own prior
mistakes. Two tasks (5 and 9) reviewed clean on the first pass with no
Critical or Important finding at all; they are the exception, not the norm.

### 2.1 A recurring pattern: green tests that proved nothing

Three separate times in this block, a test passed while proving nothing about
the property it claimed to prove — the exact trap Block 1b's own report closed
out with ("a suite that passes either way proves nothing"):

- **Task 2** — the pgTAP assertion for the block's entire premise (a role from
  another Organization is rejected) used `gen_random_uuid()` for the caller's
  `user_id`. That trips the *older* `company_memberships_user_id_fkey` — also
  Postgres error `23503` — regardless of whether the new composite
  cross-Organization key existed at all. The proof of tenant isolation this
  block is built on was a false green until fixed with a real `auth.users` row
  and a message pinned to the actual constraint name,
  `company_memberships_role_org_fk` (`supabase/tests/01_identity.test.sql:106-115`).
- **Task 6** — `tests/isolation/tenant.test.ts` (Block 1a's cross-tenant write
  proof) was rewritten during the type-regeneration pass to pass a random uuid
  as `role_id`, which violates the composite FK unconditionally, for anyone.
  The *only* possible failure it could ever demonstrate was a foreign-key
  violation, not the missing `INSERT` grant plus RLS that the test's name
  claims. A future change that opened cross-tenant writes through a sloppy
  `with check` would have left this test green. Fixed by building a real role
  in Organization B and pinning `error.code === '42501'`, so a foreign-key
  rejection can never masquerade as an authorization one.
- **Task 8** — the headline isolation test ("a role assigned in Company A does
  not carry to Company B") passed because the test member held **no**
  membership at all in the second Company, so `has_company_access` already
  returned false and `has_permission` short-circuited before the role branch
  ever ran. The line that implements this block's entire premise —
  `cm.company_id = p_company_id` inside the role join — was pinned nowhere in
  the project. Fixed by giving the member a second, empty-role membership so
  access is `true` in both Companies and only the role can produce the
  difference.

None of these three would have been caught by re-reading the plan; each needed
someone to ask what the test would do if the *wrong* code were shipped in its
place.

### 2.2 The one that would have broken a live database, invisibly

**Task 4**: `0018`'s backfill of `invitations.is_owner`/`role_id` covered only
rows with `status = 'pending'`, but the `check` constraint the same migration
adds applies to the whole table. Any already-accepted or already-revoked
invitation is left with `is_owner = false` and `role_id = null` and fails the
constraint — taking the migration down. The local stack has no such rows
(nothing has run long enough to accumulate them), so every automated run here
is green and the defect is invisible in this environment. It would surface for
the first time mid-migration on a customer's actual database, on the exact
table that controls how people get into the system. Found only because the
implementer hand-seeded pre-`0018` accepted and revoked rows instead of
trusting a clean local reset. Fixed by backfilling every row regardless of
status.

### 2.3 Foundational functions orphaned by their own migration's DROP

**Task 1**: `0015` drops and recreates `role_permissions` keyed by `role_id`
instead of the old `member_role` enum. Both `has_permission` (0010) and
`has_org_permission` (0010) still joined the dropped shape and would error at
plan time on any call — `language sql`, so no input avoids it — carrying every
Block 1b RPC and RLS policy that calls them (`create_invitation`,
`revoke_invitation`, `change_member_role`, `remove_member`, plus the
`invitations_select_inviter` and `audit_logs_select_org` policies). The plan
had deferred the helper rewrite to Task 2, which would have left the database
non-functional between two migrations. Both were given a transitional
`SECURITY DEFINER` rewrite in `0015` itself — the second one (`has_org_permission`)
was caught only in task review, after the first fix round addressed only
`has_permission`.

### 2.4 The archived-role hole opened twice, closed by two different doors

**Task 3**: `assign_company_role` never queried `roles` at all, so a role
soft-deleted by `delete_role` (via the *non-partial* `roles_id_org_unique`
index a foreign key requires) could be assigned again, resurrecting retired
permissions. Closed by requiring a live role row, with `FOR UPDATE`/`FOR SHARE`
locking between `delete_role` and `assign_company_role` so a concurrent pair
cannot race (ordered role-before-membership on both sides, so they serialize
rather than deadlock).

**Task 4** reopened the identical hole through a different door: `delete_role`
counts *live memberships* as "in use", and a pending invitation is not a
membership, so a role could be archived while an invitation naming it was still
outstanding. `accept_invitation` and `validate_invitation` were both given the
same guard, with the same single failure message as every other acceptance
failure, so the modes stay indistinguishable to the invitee. The implementer
had fixed this exact class in Task 3 and did not carry the lesson forward —
worth noting because it shows the fix in one place did not generalize on its
own; each door needed its own guard.

**Deferred, still open** — `delete_role`'s own initial existence check is an
unlocked `SELECT`, so two concurrent deletes of the same role both pass it, and
the second re-applies the soft delete and writes a duplicate audit row after
acquiring the lock. Narrow (same role, same instant, two admins), not closed
in this block; carried to §5.

### 2.5 A controller-specified RLS policy that was itself broken

**Task 10**: the brief for `profiles_select_self` widening specified an inline
`EXISTS` self-join against `organization_memberships` — but that table has its
own RLS, which an ordinary member's row can only see through their own
membership, so the inline subquery is itself subject to the same policy it was
trying to read past. The policy would have denied exactly the read it existed
to grant. This is the lesson `0005_rls_helpers.sql` states at its own top —
every cross-table RLS helper in this project is `SECURITY DEFINER` for exactly
this reason — and it was in the instruction I (the controller) gave, not
something the implementer introduced. Caught because the cross-tenant
isolation test was written *before* the implementation and went red first.

### 2.6 The journey found what no earlier task's scope could see

**Task 12**: `companies_select_org_member` (Block 1a, `0006`) let any member of
an Organization read the metadata of *every* Company in it. That was reasoned
as harmless when an Organization had exactly one Company; Block 1c falsifies
that premise by shipping a screen (`/app`) where "which Stations can I reach"
*is* the feature, rendered from that policy alone. No task before the
end-to-end journey had a fixture with two Companies and a colleague scoped to
only one, so nothing earlier could have caught it. The narrowing was verified
strictly tightening (never loosening) across eight caller classes before being
accepted (`supabase/migrations/0021_companies_visibility_fix.sql`).

**Fix round 1** then over-corrected: it left `users.manage`/`roles.manage`
holders authorised (by the database) in Stations the narrowed policy no longer
let them *see*, so the Team screen's roster silently omitted Stations its
holder could still act in. Fixed with a `SECURITY DEFINER` function scoped to
that screen alone, leaving `/app` narrow.

**Fix round 2 — the round-1 fix introduced its own regression, one of the two
occasions in this block where a fix caused a new defect.** The new roster
function was gated only on `users.manage`, but the Team screen feeds it to two
consumers — the roster itself and the invite checklist, which is authorised by
the separate, independently-assignable `users.invite`. A holder of
`users.invite` alone (with no `users.manage`) got an *empty* invite checklist —
strictly worse than before the fix existed, since they could now invite
nobody, not even into their own Station. No spec anywhere had exercised this
because every spec had the owner (who bypasses everything) drive the Team
screen. Fixed by parameterising the function on an allowlisted permission so
each surface asks for the roster it is actually entitled to, and by rewriting
the e2e journey to have a Manager, not the owner, send the invitation — which
in turn caught a real navigation defect in the test itself.

### 2.7 The second occasion a fix introduced an undisclosed change

**Task 7**: during a fix round scoped only to adding missing test coverage,
the implementer also changed the `description` transform from collapsing
`null` to `undefined` into collapsing `null` *or the empty string* to
`undefined` — widening the contract from what was explicitly required, and
disclosed nowhere in the round's report. The runtime effect is nil (the RPC's
own `nullif(trim(coalesce(...)))` already collapses all three spellings to
`NULL`), so nothing is broken today. It is recorded here because a reviewed
contract that changes silently, with no comment and no honestly-named test, is
how a real regression lands later — on a change whose effect is not nil. The
fix round that followed required the comment, an honestly-named test, and this
line in the report; no logic changed in that round.

### 2.8 Smaller findings worth naming plainly

- **Task 3**: `remove_company_access` wrote a *success* audit row and a null
  `target_id` even when the update matched no row — the trail would record a
  removal that never happened. Fixed to raise instead.
- **Task 2**: the owner's bypass in the rewritten `has_org_permission` carried
  no subscription gate, so an owner whose only Company was suspended kept
  `users.invite`/`audit.view`/`roles.manage` — directly contradicting §3's "a
  suspended Company grants nothing, full stop." Closed in the same task.
- **Task 4**: `unnest`-based Station-id validation in `create_invitation` does
  not deduplicate, so the same Station passed twice satisfied the count check
  and then died on the primary key with a raw duplicate-key error instead of
  the sentence the check exists to produce. Fixed to count distinct on both
  sides.
- **Task 11**: the implementer's own initiative to surface `add_company`
  failures (a real gap — a whitespace-only Station name passes HTML
  `required` and then trips the RPC) put the failure flag in the URL with
  nothing to ever clear it on success, because the pattern was borrowed from
  `/login`, where every path ends in a redirect. On the console, success does
  not redirect, so a later unrelated action would still show "Could not add
  the Station." Fixed by making all three console actions redirect to the bare
  path on success.
- **Every `RAISE LOG`-only denial path (Block 1a's pattern, used by every RPC
  in this block) writes to the Postgres server log, which no client, pgTAP
  suite or isolation test can query.** Structurally unobservable from any
  automated test in this project — inherent to the pattern, not a gap
  introduced here, but worth stating once rather than leaving it implicit in
  eleven task reports.

---

## 3. Deployment steps

Everything in `docs/block-1a-report.md` §1 and `docs/block-1b-report.md` §3
still applies (signup disabled on the hosted project, custom SMTP configured,
`NEXT_PUBLIC_SITE_URL` correct). This block adds one hard requirement:

### Take a database snapshot before deploying — this migration set is irreversible in three places

Migrations `0015`–`0023` apply with `npx supabase db push --linked`. Unlike
prior blocks, this one cannot be rolled back by re-running an inverse
migration:

1. **`0016_memberships.sql` deletes every owner's `company_memberships` row.**
   The owner is moved to being recognised at Organization level
   (`has_company_access`'s `is_owner` term); the row is not moved, it is
   deleted. There is no migration that reconstructs which Company row an owner
   used to hold once this runs.
2. **`0018_invitations_1c.sql` drops the `member_role` type**, after
   backfilling every invitation onto the new `is_owner`/`role_id` shape and
   dropping every function signature that named it. Once dropped, the old
   three-value vocabulary (`owner`/`operator`/`viewer`) cannot be recovered
   from the schema — only from the backfilled `roles` rows the migration
   creates in its place.
3. **`0021_companies_visibility_fix.sql` narrows `companies_select_org_member`**
   from "every member of the Organization" to "the owner, a platform admin, or
   whoever holds a live `company_membership` in that specific Company." This is
   a genuine access restriction on a live table's RLS policy — anyone relying
   on the old, wider read (intentionally or not) loses it the moment this
   migration commits.

None of the three has an automatic undo. A snapshot of the production database
immediately before `npx supabase db push --linked` is not optional — it is the
only rollback path if anything in this migration set behaves unexpectedly
against real data (see §2.2, which found exactly this class of defect against
hand-seeded rows locally).

---

## 4. Definition of done

Copied from the spec's §12, with evidence per row.

| Criterion | Status | Evidence |
|---|---|---|
| An owner creates a role, picks permissions from the catalogue, and assigns it per Company | ✅ | `tests/e2e/roles-flow.spec.ts` — creates "Manager", checks a catalogue permission, sends an invitation scoped to one Station |
| The same user holds different powers in two Companies of one Organization | ✅ | `tests/isolation/roles.test.ts` — "grants a permission in one Station and withholds it in another" |
| A membership without a role cannot exist | ✅ | `supabase/tests/01_identity.test.sql:71` — `col_not_null('company_memberships', 'role_id')` |
| A role from another Organization is rejected by the database, not by application code | ✅ | `supabase/tests/01_identity.test.sql:82-115` — composite `fk_ok` pair plus `throws_ok` pinned to `company_memberships_role_org_fk` with a real `auth.users` row (the false-green fixed in §2.1); `tests/isolation/roles.test.ts` — "refuses a role from another Organization even with a valid id" |
| Editing a role changes what its holders can do on the next request | ✅ | `tests/isolation/roles.test.ts` — "cuts access on the next request when the permission is unchecked" |
| A role in use cannot be deleted | ✅ | `tests/isolation/roles.test.ts` — "refuses to delete a role somebody holds" |
| `roles.manage` lets a non-owner administer roles; without it they cannot | ✅ | `tests/isolation/roles.test.ts` — "lets roles.manage administer roles, and refuses without it" |
| A suspended Company grants nothing, including Organization-scoped permissions | ✅ | `tests/isolation/roles.test.ts` — "grants nothing once the Station is suspended, not even to the owner"; `tests/isolation/permissions.test.ts` — "yields no permissions on a suspended company, even to its owner". (Session-dependent enforcement cannot be proven by pgTAP in this project — see §1.2 — so the isolation suite, not pgTAP, is the real evidence here despite the spec's table.) |
| An invitation carries role and Companies, and acceptance produces exactly those memberships | ✅ | `tests/isolation/invitations.test.ts` — "acceptance grants membership at the invited role" (pins `role_id` on the row, not just reachability); `tests/e2e/roles-flow.spec.ts` — invitee reaches exactly Station A and not Station B before Station B is ever granted |
| A platform admin adds a second Company to an existing Organization | ✅ | `tests/e2e/roles-flow.spec.ts` — the platform admin adds a Station from the console's "Add Station" form, live; `tests/isolation/harness.ts`'s `addCompany()` (wrapping `add_company`) underlies every two-Station isolation fixture in `roles.test.ts` and `tenant.test.ts` |
| lint, typecheck, unit, pgTAP, isolation, e2e and `docker build` all pass | ✅ | §1 |

---

## 5. Open items

1. **An internal user cannot be deleted once they have done anything.**
   `audit_logs.actor_id`, `companies.provisioned_by`, `invitations.invited_by`,
   `invitations.accepted_by` and `roles.created_by` all reference `auth.users`
   without `on delete` behaviour, so provisioning a Station, sending an
   invitation or creating a role permanently pins that account. Discovered
   while making the isolation suite's teardown stop reporting success it had
   not achieved; the suite had been leaking accounts since Block 1a.

   This is not a defect to patch. Spec §9 commits the product to LGPD erasure,
   and the audit trail exists precisely so that who-did-what survives. Both are
   right, and they conflict: the resolution is anonymisation — the actor row
   stays, the person behind it is scrubbed — which is the mechanism Block 3
   already designs for Members and which internal users will need too. It
   belongs in the block that builds it, with the owner's decision on how far
   back it applies.

2. **The isolation suite's `cleanupUsers` still leaks accounts — it now reports
   the leak instead of hiding it.** Every isolation file printed a
   `cleanupUsers: could not delete N user(s)...` warning during this
   verification run (43, 29, 19, 23 and 8 accounts across the five affected
   files). The root cause is item 1 above (non-cascading FKs) plus the
   deferred "at least one owner" trigger tripping on an owner's own teardown
   delete. This was made *honest* in Task 8 — a cleanup that reports success
   while deleting nothing is worse than one that fails loudly — but it was not
   made *complete*, and cannot be until item 1 is resolved. The local database
   accumulates test litter across runs as a result; it does not affect
   correctness of any assertion.

3. **One transient `tinypool` worker crash was observed a third time.** The
   canary run in §1.1 hit `Error: Worker exited unexpectedly` from
   `tinypool/dist/index.js` after the (correct, expected) test failure had
   already been recorded — the same class the ledger documents twice in Task
   12's fix rounds, both times substantiated as pre-existing and unrelated to
   the change under test by isolated re-runs. Treated as environmental, not a
   defect in this block's code; worth fixing at the tooling level if it
   recurs often enough to slow down verification.

4. **`delete_role`'s existence check is an unlocked `SELECT`** (§2.4). Two
   concurrent deletes of the same role both pass the initial check; the second
   re-applies the soft delete and writes a duplicate audit row after acquiring
   the lock. Narrow window, no data-integrity consequence beyond a duplicate
   log line, and not closed in this block.

5. **`RAISE LOG`-only denial paths remain unobservable from any automated
   test** (§2.8) — carried over from Block 1a §3.2 and Block 1b §5, now also
   true of every role and membership RPC this block adds
   (`create_role`, `update_role`, `delete_role`, `assign_company_role`,
   `remove_company_access`).
6. Items 2–5 of `docs/block-1a-report.md` §5 remain open and are unrelated to
   this block's scope.

7. **`roles.manage` is transitively total, and that is deliberate, not a
   defect.** `update_role` restricts neither which permission codes a role may
   carry nor whether the caller edits the role they themselves hold. A
   delegate handed `roles.manage` can therefore add `users.manage`,
   `audit.view`, or any future Block 2 permission to their own role — nothing
   in the model stops "administer roles" from becoming "administer
   everything." Spec §2 decision 4 makes delegating role administration
   deliberate, so this is an accepted property of the model the owner chose,
   not something to close in code. What was missing was visibility: an owner
   ticking that checkbox had no way to learn what they were handing over. The
   role editor (`role-form.tsx`) now states this beside the `roles.manage`
   checkbox itself (block-1c final review, I3).

8. **`profiles` carries a table-wide `SELECT` grant** (Task 10's deferred
   minor, not previously carried into this report). `profiles_select_org_member`
   (0020) needed to expose a colleague's name and e-mail to the Team screen,
   but the grant behind it is table-wide, so it also exposes
   `must_change_password` and `provisional_expires_at` — the provisional-
   password gate — to every colleague in the same Organization, not just to
   the row's own owner. Low sensitivity (nothing here is a secret, and the
   columns are not writable by anyone but the SECURITY DEFINER functions that
   already own them), but tighter than intended. Narrowing this later is not
   an additive change: PostgreSQL does not let a column-level `REVOKE` claw
   back privilege already held at the table level (the same rule 0006's
   comment on `profiles`'s `UPDATE` grant already states for exactly this
   reason), so closing it needs `revoke select on public.profiles from
   authenticated` followed by an explicit column list, not a grant added on
   top of the existing one.

9. **Read-failure handling is inconsistent across the four screens that read
   directly from Supabase.** `/team` (`team/page.tsx`) logs most failed reads
   and degrades gracefully, except where it calls `listRoles`
   (`src/services/roles.ts`), which throws `InternalError` — turning one
   transient read failure into an uncaught 500 inside the same
   `Promise.all` that the other reads on that page degrade from. `/roles`
   (`roles/page.tsx`) throws for the same reason, on every one of its reads
   (`listRoles`, `listPermissionCatalogue`). `/admin/customers`
   (`admin/customers/page.tsx`) logs its `owners`/`ownerProfiles` read
   failures and renders through them, but its `companies` read dropped its
   error silently until block-1c final review Minor 3 fixed logging there —
   it still does not throw. `/admin/contact-requests`
   (`admin/contact-requests/page.tsx`) drops its read's error entirely, with
   no logging and no degraded-state messaging at all. Four screens, three
   different behaviours for the same class of failure (throw / log-and-
   degrade / drop-silently), none of them chosen deliberately — each grew out
   of whichever screen's task happened to add it. Not closed in this block;
   worth a single policy (log always, and decide throw-vs-degrade per read
   deliberately) the next time any of these four screens is touched.

10. **`roles.manage` was widened to full-row visibility on `company_memberships`,
    where only a count was needed.** The final review found that a non-owner
    holding `roles.manage` saw a holder count of zero for every role they did
    not personally hold — which enabled Delete for roles that were in use and
    suppressed the "N user(s) hold this role" warning that §3 of the design spec
    names as the only mitigation for instant-effect role edits. The fix widened
    `company_memberships_select` for `roles.manage`, and that grants full-row
    `SELECT` — `user_id`, `company_id`, `role_id` — over every live membership
    in the Organization, not an aggregate.

    Combined with `profiles_select_org_member`, a `roles.manage`-only delegate
    can therefore reconstruct the complete "who holds which role in which
    Station" map. That is bounded to their own Organization and crosses no
    tenant boundary, and it is arguably moot given item 7: a `roles.manage`
    holder can already self-grant `users.manage` through `update_role` and read
    the same data through the front door. But the two are not equivalent in
    practice — self-escalation is an audited, visible act that also grants
    `users.manage` to every other holder of that role, whereas this reads
    silently, with no audit entry and no permission granted.

    Accepted for this merge because RLS is row-grained, not column-grained, and
    every panel user is the same Postgres grantee, so there is no cheaper way to
    give `roles.manage` a count without the rows it is counted from. Recorded
    here rather than left in a fix report, because it is a concession about what
    a permission actually confers, and the next person to read this permission's
    definition should find it. If it matters, the fix is a `SECURITY DEFINER`
    function returning counts rather than a policy returning rows.
