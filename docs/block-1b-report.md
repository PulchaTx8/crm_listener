# Block 1b — Permissions & Invitations — Verification Report

- **Date:** 2026-07-26
- **Branch:** `block-1b`
- **Spec:** `docs/superpowers/specs/2026-07-26-block-1b-permissions-invitations-design.md`
- **Plan:** `docs/superpowers/plans/2026-07-26-block-1b-permissions-invitations.md`
- **Predecessor:** Block 1a (`docs/block-1a-report.md`)

---

## 1. Verification

All run on a clean `npm run db:reset`.

| Command | Result |
|---|---|
| `npm run lint` | PASS — no ESLint warnings or errors |
| `npm run typecheck` | PASS — no output |
| `npm run test` | PASS — 10 files, 36 tests |
| `npm run db:test` | PASS — 3 files, 44 assertions |
| `npm run test:isolation` | PASS — 6 files, 34 tests |
| `npm run test:e2e` | PASS — 6 tests |
| `npm run build` | PASS — compiled |
| `docker build -t pulchatx:dev .` | PASS — image 313 MB |

### 1.1 The fail-closed guard is not vacuous

Removing the permission-existence term from `has_permission` and re-running the
isolation suite fails exactly one test:

```
× permission helpers > returns false for an unknown permission code, even for a platform admin
Tests  1 failed | 24 passed (25)
```

Restored, all pass. The guard is doing work rather than agreeing with whatever
the function happens to return.

### 1.2 The generated types still engage

`(await createUserClient()).from('no_such_table_1b')` produced two compile
errors naming the table; deleting the probe restored a clean typecheck. Re-run
this after any Supabase package bump — Block 1a shipped a version skew that
silently disabled it once already.

---

## 2. What the plan got wrong

Three defects surfaced only by executing it. All three are recorded here because
each was invisible on the page.

### 2.1 The last-owner trigger refused legal demotions — **the serious one**

The trigger is `DEFERRABLE INITIALLY DEFERRED`, so it fires at **COMMIT** — after
`change_member_role`'s own `SECURITY DEFINER` context has been popped and the
session is back to `authenticated`. The owner count therefore ran under the
caller's RLS, which shows only the rows they may read. An owner demoting
themselves can no longer see the other owners, counts zero, and is refused an
operation that is perfectly legal.

`enforce_last_owner` is now `SECURITY DEFINER` so it counts with full visibility.

**The plan's own tests would not have caught this.** They asserted only that the
trigger *blocks* — remove the last owner, demote the last owner — which a trigger
that refuses everything passes. The case that failed was one added beyond the
plan: *allows demoting an owner once a second owner exists*. A guard needs a test
that it permits, not only that it forbids.

### 2.2 Seeding a second member could not use the service client

The plan's test helper inserted membership rows with `service_role`. Block 1a
deliberately leaves the tenant tables read-only for that role, so a mistake in
server code cannot create or move a tenant behind the audited RPCs' back — and
that applies to tests too. `addMemberByInvitation` in the harness now goes
through the real invitation flow, which makes the seeding path the production
path.

### 2.3 A test could not age an invitation row

Same root cause: `service_role` holds no write grant on `invitations`. The expiry
test now creates the invitation already expired (`p_ttl_days: -1`) through
`create_invitation`, which is both the only way in and the more honest one.

### 2.4 `docker build` broke on a test-only import

`playwright.config.ts` sits at the repository root and imports
`tests/local-supabase`, which `.dockerignore` excludes. `next build` inside the
container typechecks the config and cannot resolve the module. The test runner
configs are now excluded from the image, where they were never needed.

---

## 3. Deployment steps

Everything in `docs/block-1a-report.md` §1 still applies. This block adds one
change of status:

### Custom SMTP is now required, not recommended

Block 1a listed it as needed for password reset. With invitations it becomes the
main path by which a customer's colleagues get in. Without it, invitations do not
arrive at all and the Owner's only recourse is to copy the on-screen link and
relay it by hand.

Dashboard → **Project Settings → Authentication → SMTP Settings**, and set
`NEXT_PUBLIC_SITE_URL` to the address customers actually reach — it is what the
invitation link is built from. Getting it wrong produces links that point
nowhere, and the token cannot be re-shown afterwards.

Migrations `0010`–`0014` apply with `npx supabase db push --linked`.

---

## 4. Definition of done

| Criterion | Status | Evidence |
|---|---|---|
| An Owner invites a colleague who opens the link, chooses a password, and reaches the app at the invited role | ✅ | `invitation-flow.spec.ts` |
| An operator calling the invitation or member-management RPCs is rejected under a real JWT | ✅ | `permissions.test.ts`, `invitations.test.ts` |
| A revoked and an expired invitation both refuse acceptance, with the same message as an invalid one | ✅ | `invitations.test.ts`; the page renders one message for all three |
| The same invitation cannot be accepted twice | ✅ | `invitations.test.ts`, and the e2e reopens the link |
| An Organization cannot be left without an owner, by removal or demotion | ✅ | `permissions.test.ts` — both directions, plus the permitting case |
| A removed member loses access on their next request | ✅ | `permissions.test.ts`, same JWT, no re-auth |
| A suspended Company grants no permissions, even to its Owner | ✅ | `permissions.test.ts` |
| `has_permission` returns false for an unknown code even for a platform admin, and true for a real one | ✅ | `permissions.test.ts`, both directions |
| An Owner can read their own Organization's audit trail, and no other | ✅ | `permissions.test.ts` — an Owner sees only their org, an operator sees nothing |
| Breaking the fail-closed term makes the suite fail | ✅ | §1.1 |
| lint, typecheck, unit, pgTAP, isolation, e2e, `docker build` all pass | ✅ | §1 |

---

## 5. Open items

1. **The "already has an account" message on the team screen is untested.** The
   database refuses correctly and an isolation test proves it, but the mapping
   from that error to the friendly sentence in `actions.ts` is reasoned, not
   exercised. A wrong regex there degrades a clear message to a generic one.
2. **Denied direct PostgREST calls are still not in `audit_logs`** — carried over
   from Block 1a §3.2, and now also true of the invitation and member RPCs.
3. **`operator` and `viewer` hold no permissions**, so the model stays lightly
   exercised until Block 2 brings a real domain.
4. Items 2–5 of `docs/block-1a-report.md` §5 remain open.
