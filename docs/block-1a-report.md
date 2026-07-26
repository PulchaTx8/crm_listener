# Block 1a — Auth & Tenant Foundation — Verification Report

- **Date:** 2026-07-26
- **Branch:** `block-1a-spec`
- **Spec:** `docs/superpowers/specs/2026-07-26-block-1a-auth-tenant-design.md`
- **Plan:** `docs/superpowers/plans/2026-07-26-block-1a-auth-tenant.md`

---

## 1. Deployment steps that code cannot do

These are manual and the block is not deployable without them.

### 1.1 Disable signup on the hosted project — **mandatory**

Supabase dashboard → **Authentication → Providers → Email → "Allow new users to sign up" → off.**

`supabase/config.toml` governs the local stack only; it does not propagate. Until this is
done, anyone can `POST /auth/v1/signup` against the hosted project from any origin and the
subscription model is decoration. `tests/isolation/signup-disabled.test.ts` asserts the
behaviour, so pointing it at the hosted project verifies the change:

```bash
SUPABASE_TEST_URL=https://<ref>.supabase.co \
SUPABASE_TEST_ANON_KEY=<hosted anon key> \
ALLOW_REMOTE_ISOLATION_TESTS=1 \
npx vitest run --config vitest.isolation.config.ts tests/isolation/signup-disabled.test.ts
```

Run **only that file**. The rest of the isolation suite creates and deletes real users, which
is why the config refuses a non-loopback target unless `ALLOW_REMOTE_ISOLATION_TESTS=1` is set.

Leave **Authentication → Providers → Email** itself *enabled*. That switch gates sign-**in**
as well as sign-up; disabling it refuses every login with "Email logins are disabled".

### 1.2 Raise the hosted minimum password length

Dashboard → **Authentication → Policies → Minimum password length → 10**, matching
`config.toml` and the client-side check on the change-password screen.

### 1.3 Configure custom SMTP — required for password reset

Dashboard → **Project Settings → Authentication → SMTP Settings.** The built-in sender is
rate limited to a handful of messages an hour and is not intended for production; without a
custom sender, password reset silently fails to deliver. The same configuration serves
Block 1b's invitations.

Set `NEXT_PUBLIC_SITE_URL` to the address customers actually reach, and add that origin under
**Authentication → URL Configuration → Redirect URLs**, or the reset link will be rejected.

### 1.4 Seed the first platform admin

There is no UI for this by design — it is the bootstrap of the privilege that grants every
other privilege. After creating the user (dashboard → Authentication → Add user, or the
Admin API), run in the SQL editor:

```sql
-- 1. The application-level profile row. Provisioning creates this for customers;
--    the first admin has no one to provision them.
insert into public.profiles (id, email)
select id, email from auth.users where email = 'owner@yourdomain.com'
on conflict (id) do nothing;

-- 2. The privilege itself.
insert into public.platform_admins (user_id)
select id from auth.users where email = 'owner@yourdomain.com'
on conflict (user_id) do nothing;

-- 3. Confirm exactly one row, and that it is the intended account.
select pa.user_id, u.email from public.platform_admins pa
join auth.users u on u.id = pa.user_id;
```

A platform admin can read every Company's metadata and provision and suspend at will. Keep
the list to the people who genuinely need it, and re-run step 3 after any change.

### 1.5 Apply the migrations

```bash
npx supabase db push --linked   # 0003 … 0009
```

---

## 2. Verification — commands and results

All run on 2026-07-26 against the local stack, from a clean `npm run db:reset`.

| Command | Result |
|---|---|
| `npm run lint` | PASS — no ESLint warnings or errors |
| `npm run typecheck` | PASS — no output |
| `npm run test` | PASS — 9 files, 31 tests |
| `npm run db:reset` | PASS — migrations 0001–0009 applied |
| `npm run db:test` | PASS — 2 files, 28 assertions |
| `npm run test:isolation` | PASS — 4 files, 16 tests |
| `npm run test:e2e` | PASS — 5 tests |
| `npm run build` | PASS — compiled, `ƒ Middleware 105 kB` |
| `docker build -t pulchatx:dev .` | PASS — image 313 MB |

Verbatim output is in the commit history of this branch and reproducible with the commands above.

### 2.1 The isolation suite is not vacuous

Per the plan, `companies_select_org_member` was temporarily forced to `using (true)` and the
suite re-run:

```
× tenant isolation > a user reads only their own company
✓ (the other seven)
Tests  1 failed | 8 passed (9)
```

The policy was restored and all pass. The harness detects a real leak rather than agreeing
with whatever the schema happens to say.

### 2.2 The generated types are not vacuous

`(await createUserClient()).from('no_such_table')` must fail to compile. On the first attempt
it compiled — see §3.3. After the fix, both clients reject an unknown table name with the
real table list.

---

## 3. Departures from the plan

Everything here was found by executing the plan, not by reading it. Each is a defect the plan
would have shipped.

### 3.1 The password gate was bypassable — **security**

The plan granted table-level `UPDATE` on `profiles` to `authenticated` and intended to claw
back the two gate columns in 0008 with `revoke update (must_change_password, ...)`.

PostgreSQL ignores a column-level `REVOKE` when the role already holds the table-level
privilege. Verified against the local database:

```
 table_update | col_b_update | col_a_update
 t            | t            | t            <- still granted after the REVOKE
```

Any signed-in user could have cleared `must_change_password` with one PostgREST `PATCH` and
walked past the forced password change. Fixed at the source in 0006 with a column-level
`GRANT UPDATE (full_name)`. Pinned by four pgTAP assertions — including that no table-wide
`UPDATE` grant exists, since that alone would silently reopen it — and by two isolation tests
covering both directions (the gate cannot be cleared; the display name still can be edited).

### 3.2 Denied privileged calls were never audited

The plan wrote an `audit_logs` row on each denied branch and then raised. The raise aborts the
transaction and takes the row with it, so no denial could ever have been recorded — contrary
to spec §5. **Decision taken: `RAISE LOG` plus an application-layer row.** The RPCs log the
refusal to the Postgres log, which survives the rollback, and `services/provisioning.ts`
writes the `audit_logs` row from outside the failed transaction.

**Known limit:** a refusal on a call made straight to PostgREST, bypassing the app, appears in
the Postgres log only. Closing that needs an autonomous transaction (`dblink`) and is deferred.

### 3.3 The generated types silently did nothing on the user client

`@supabase/ssr` 0.5 passes its generics into the 3-parameter `SupabaseClient` it was built
against; `@supabase/supabase-js` 2.110 takes four. `Database` landed in the wrong slot and
`.from()` degraded to accepting any string — on the client every RLS-respecting query uses.
The service client was fine, which is what made it look like it worked. Upgraded to
`@supabase/ssr` 0.12.3. **Re-run the probe after any Supabase package bump.**

### 3.4 The isolation tests had no database, and would have aimed at production

Vitest does not copy `.env` into `process.env`, so `NEXT_PUBLIC_SUPABASE_URL` was `undefined`
and the suite could not have passed as the plan predicted. Had it loaded `.env`, that file
names the **hosted** project — the harness would have created and deleted real users there.

`vitest.isolation.config.ts` now pins the local stack and refuses any non-loopback target
unless `ALLOW_REMOTE_ISOLATION_TESTS=1`. `playwright.config.ts` does the same for the dev
server it drives. Shared constants live in `tests/local-supabase.ts`.

### 3.5 A successful provisioning would have reported failure and lost the password

The plan's success `redirect()` sat inside the `try`. `redirect()` signals by throwing, so the
`catch` would have swallowed it and rendered `?error=failed` — after the customer was created
and with the password gone. Every server action now keeps `redirect()` outside its catch.

### 3.6 The provisional password travelled in a URL

The plan passed it as a redirect query parameter, with a comment claiming it "never reaches a
log". A query string reaches browser history and the access log of every proxy in front of the
app. It is now returned through the Server Action result and rendered once
(`credential-forms.tsx`); the e2e test asserts it never appears in the URL.

### 3.7 Provisional expiry was written and never read

`provisional_expires_at` was set at provisioning and read by nothing, so an expired password
worked indefinitely — against spec §6 and the plan's own Definition of Done. Enforced in the
middleware rather than only at sign-in, so an already-open session loses access too. Added
`reset_provisional_password` and a one-click reissue per Company, without which expiry would
simply strand the customer.

### 3.8 Ordinary customers had nowhere to land

The plan sent everyone to `/admin/customers` after the gate cleared, which the admin layout
bounces for non-admins — a dead end failing the "reaches the application" criterion.
**Decision taken: a Company status page** at `/app`, listing each Company with its status
badge and, when suspended, the reason. This directly exercises spec §4: metadata stays visible
while suspended so the customer sees *why* access stopped.

### 3.9 `service_role` had no grants on any table in this block

The `public` schema's default ACL hands the Supabase roles only `Dxtm`, and `BYPASSRLS` is not
a substitute for a missing `GRANT` — the trap Block 0 documented on `rate_limit_counters` and
the plan did not carry forward. Every server-side insert in Tasks 9, 11, 12 and 16 failed at
runtime. 0006 now grants explicitly, and deliberately keeps the tenant tables **read-only** for
`service_role`: organizations, companies and both membership tables are written only by the
`SECURITY DEFINER` RPCs, which carry the audit entry, so a server-side mistake cannot create or
move a tenant behind the audit trail's back.

### 3.10 Smaller fixes

- **`[auth.email].enable_signup` must stay `true`.** I turned it off for thoroughness; the CLI
  maps it to `GOTRUE_EXTERNAL_EMAIL_ENABLED`, which gates sign-**in** too, and every login
  broke. `[auth].enable_signup` alone closes public signup.
- **`tailwind.config.ts` used `require()`.** Tailwind's loader reads the file through
  `loadESMFromCJS`, where `require` is undefined; the dev server died on the first CSS compile
  of any page beyond the cached one. Pre-existing, invisible with only one page.
- **`docker build` was broken by empty build args.** The Dockerfile exports `NEXT_PUBLIC_*`
  unconditionally, so an image built without them arrives with empty strings. `env.ts` treated
  those as garbage rather than absence. Now normalised, with tests.
- **Session-dependent pages are explicitly `force-dynamic`.** They were dynamic only by
  accident — locally `.env` existed, so `cookies()` was reached; in the container the Supabase
  client threw first and Next treated it as a prerender error.
- **`server-only` stub for Vitest.** The plan unit-tests `generateProvisionalPassword` from a
  module that imports `server-only`, which throws outside a Server Components bundle. Aliased
  in the test configs; Next still enforces the real guard at build time.
- **Login picks its own destination.** A middleware redirect issued during a Server Action's
  RSC navigation leaves the address bar stale — the customer saw `/change-password` while
  looking at `/app`. The middleware still enforces both rules for every other request.

---

## 4. Definition of done

| Criterion | Status | Evidence |
|---|---|---|
| Provisioning creates user, organization, company and both memberships, or fails cleanly with no orphaned auth user | ✅ | `provision_customer` + compensating delete; `provisioning-flow.spec.ts` |
| Customer signs in with the provisional password, is forced to change it, reaches the app | ✅ | `provisioning-flow.spec.ts` |
| Cross-tenant read **and** write both fail under a real JWT | ✅ | `tenant.test.ts` |
| Public `signUp` is refused, proven by a test | ✅ | `signup-disabled.test.ts` (hosted: §1.1) |
| An ordinary user calling the privileged RPCs is rejected | ✅ | `tenant.test.ts`, `provisional-password.test.ts` |
| A suspended Company yields no business data even to its Owner; metadata stays visible | ✅ | `tenant.test.ts` + `provisioning-flow.spec.ts` |
| Suspension takes effect on an open session without a forced sign-out | ✅ | `provisioning-flow.spec.ts` |
| An expired provisional password refuses sign-in and can be regenerated | ✅ | middleware + login action; `provisional-password.test.ts` |
| A user cannot clear their own password gate | ✅ | `tenant.test.ts`, `01_identity.test.sql` |
| The contact form records, notifies and is rate limited | ✅ | `contact-requests.test.ts` — the sixth submission from one IP is refused and never stored |
| Breaking a policy makes the isolation suite fail | ✅ | §2.1 |
| lint, typecheck, unit, pgTAP, isolation, e2e, `docker build` all pass | ✅ | §2 |

---

## 5. Open items for Block 1b

1. **Denied direct PostgREST calls are not in `audit_logs`** (§3.2).
2. **The e-mail notification on a contact request is not covered by a test.** Storage is
   asserted; the notification is best-effort by design and only fires when `MAIL_FROM` is set,
   which it is not under test. A `DevMailer` assertion would close it.
3. **Logger redaction against real Supabase session objects** — still open from Block 0.
4. **`env` still has few consumers** — `src/lib/supabase/config.ts` reads `process.env`
   directly, by an explicit Block 0 decision.
5. **`.env` points at the hosted project and its URL carries a stray `/rest/v1/` suffix.**
   `supabase-js` appends its own paths, so auth calls resolve to `.../rest/v1/auth/v1/...`.
   Local developer file, not committed, but it will bite whoever assumes `npm run dev` talks to
   the local stack. The test runners no longer depend on it.
