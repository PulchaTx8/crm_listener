# Block 1a — Auth & Tenant Foundation — Design

- **Date:** 2026-07-26
- **Status:** Approved for the implementation plan
- **Parent spec:** `2026-07-25-crm-radios-multitenant-design.md` (§7 RBAC, §8 RLS, §11 Block 1)
- **Predecessor:** Block 0 — Technical foundation (shipped, deployed)

## 1. Why this block exists, and why it is a slice

The parent spec defines a single "Block 1 — Identity & multi-tenant" covering identity
tables, auth, invitations, RBAC, Company lifecycle and tenant-selection UI. The owner
split it in two so that the **isolation core can be verified on its own**, without RBAC
and invitation logic in the way. A tenant leak found here is unambiguous; the same leak
found inside a larger block is a needle in a haystack.

- **1a (this document):** authentication, session, tenant tables, RLS, the provisioning
  path, and the isolation test harness.
- **1b (later):** granular permissions as data, invitations, Company selector,
  consolidated view, administration screens.

## 2. The business model drives the design

PulchatX is sold **by subscription, with a contract signed before access**. There is no
self-serve signup. This is not a UI preference — it is the security boundary of the
product, and it has three consequences that shape everything below.

1. **Provisioning is the only way in.** If it fails, nobody can use the product. It is
   infrastructure, not convenience.
2. **Public signup must be disabled in Supabase itself.** Omitting a signup page from our
   UI stops nobody: the Supabase Auth API accepts `signUp` from any origin while the
   setting is enabled. If it stays on, anyone creates an account and the subscription
   model is decoration. This is a **mandatory configuration with an automated test that
   fails if it is ever re-enabled.**
3. **Access must be revocable.** A subscription that cannot be cut off leaves deleting
   the customer's data as the only recourse. Hence `companies.status`.

### 2.1 Onboarding flow (owner-defined)

```
Interested party fills /contato        → contact_requests (rate limited) + e-mail to the owner
Owner negotiates and closes            → (outside the system)
Owner provisions in /admin/customers   → user + organization + company + memberships
                                       → provisional password, shown once
Customer signs in                      → forced password change → in
Non-payment                            → company suspended → data blocked
```

## 3. Data model

| Table | Purpose |
|---|---|
| `profiles` | app-level user data; `must_change_password`, `provisional_expires_at` |
| `organizations` | top level; created at provisioning time, always active |
| `companies` | `status` (`active`/`suspended`), `timezone`, `provisioned_by`, `provisioned_at` |
| `organization_memberships` | `user_id`, `organization_id`, `role` (`owner`/`operator`/`viewer`) |
| `company_memberships` | same, per Company |
| `platform_admins` | who may provision and suspend; the app owner |
| `contact_requests` | the only public write in the system |
| `audit_logs` | provisioning, suspension, password changes, failed privileged calls |

Conventions inherited from the parent spec (§4.4): UUID keys, `timestamptz` in UTC, soft
delete via `deleted_at`, partial unique indexes `WHERE deleted_at IS NULL`, explicit
indexes on `(user_id, organization_id)` and `(user_id, company_id)`.

**`role` is a column, not a table.** Granular permissions arrive in 1b as tables that read
this column; the column is not discarded. 1a only needs to answer "is this user the
Owner?", and two tables plus a join to answer that would be premature.

## 4. RLS — the core of the slice

RLS helpers **query the membership tables on every check** rather than reading JWT claims.
The decisive property is that **revocation takes effect immediately**: removing someone
from a Company cuts their access in the same instant, even with an open session. Claims in
a token would stay valid until it refreshed — up to an hour. The parent spec's priority
order puts security ahead of performance, and this is exactly that trade. Helpers are
`STABLE`, so PostgreSQL reuses the result within a statement, and the membership indexes
above keep the subquery cheap.

**Two visibilities, deliberately separate:**

```
companies (metadata):   is_org_member(organization_id)
                        → the Owner sees a suspended Company, with its badge

has_company_access(c):  membership exists AND company.status = 'active'
                        → the helper every business table uses from Block 2 onward
```

Without this split, a suspended customer would see an empty screen with no explanation
instead of a clear "subscription suspended" state.

Helper functions: `is_platform_admin()`, `is_org_member(org)`, `is_owner(org)`,
`has_company_access(company)`. `has_permission(perm, company)` belongs to 1b.

`USING (true)` is forbidden (§8). `organization_id` / `company_id` arriving from the client
are never trusted without a check.

## 5. Provisioning crosses two systems

Creating the user is the Supabase Auth Admin API; creating organization, company and
memberships is SQL. **There is no transaction spanning the two.** If the second step fails,
an orphaned auth user remains — able to authenticate, belonging to no tenant. That is worse
than failing outright, because it is invisible until someone signs in.

Design:

1. Generate the provisional password (CSPRNG).
2. Create the auth user via the Admin API (`service_role`, server-side only).
3. Call `provision_customer(...)` — one PL/pgSQL function creating organization, company,
   both memberships **with role `owner`**, the profile flags and the audit entry, atomically
   (parent spec H2).
4. **If step 3 fails, delete the auth user created in step 2** and report the failure.
5. Return the password to the screen, once.

Every outcome is audited, failures included.

### 5.1 Subscription control

`suspend_company(company_id, reason)` and `reactivate_company(company_id)` are the
subscription levers. Because the RLS helpers query the tables on every check (§4),
**suspension takes effect immediately** — an open session loses access on its next request,
with no need to force a sign-out.

`provision_customer`, `suspend_company` and `reactivate_company` are `SECURITY DEFINER` and
therefore **re-check `is_platform_admin()` inside the function body** — RLS does not protect
a `SECURITY DEFINER` function (parent spec H2/H3). A test asserts that an ordinary user
calling any of them is rejected.

## 6. The provisional password

Generated with a CSPRNG, displayed **once**, never stored in plaintext, never logged — the
Block 0 logger already redacts `password` and `senha`. It travels outside the system
(WhatsApp, phone), so it is treated as compromised by default:

- `must_change_password` gates **every** route; the middleware redirects to the change
  screen until it is cleared.
- `provisional_expires_at` = 7 days. After that, sign-in is refused and the owner
  regenerates with one click. The password sitting in a chat history stops working on its
  own, without anyone remembering to revoke it.

## 7. Public surface

Three public routes, and no more:

| Route | Purpose |
|---|---|
| `/` | small landing — what PulchatX is, plus a call to action linking to `/contato` |
| `/contato` | the contact form and its success state |
| `/login` | customer sign-in |

There is no marketing site, so the root cannot stay a placeholder. This is **not** a
marketing build: a heading, a short description, one link.

`/contato` writes to `contact_requests`. It is the only unauthenticated write in the system,
which makes it the abuse surface:

- **Rate limited by IP** through `PostgresRateLimiter` and `rate_limit_counters` — built and
  verified in Block 0, and until now with no consumer.
- Only `platform_admins` may read the table; the `INSERT` policy allows `anon` and nothing
  else.
- Stores `ip_hash`, never the raw address (data minimisation, §9).

An e-mail notifies the owner via the Block 0 `mailer`. Storage is the source of truth: a
failed e-mail must not lose a lead.

## 8. Session

`middleware.ts` refreshes the session on every request. This is the debt Block 0 recorded as
its number one item: `user-client.ts` swallows cookie-write failures **by design**, on the
documented assumption that middleware renews the session. Without it, sessions expire
silently and the customer is logged out with no explanation.

Auth flows in 1a: **sign in, sign out, change password, reset password**. No sign-up.

## 9. Generated database types

`supabase gen types typescript` threaded through both clients. Today `.from()` and `.rpc()`
are untyped, and that is precisely how a library `any` bypassed `noUncheckedIndexedAccess`
in Block 0 — the strict flag was defeated, not satisfied. Doing this before the schema grows
is far cheaper than after.

## 10. Testing

The Vitest isolation harness becomes permanent infrastructure for every later block. It
creates **real users, signs them in for real, and uses the same `createUserClient()` the
application uses** — never `service_role` (parent spec M3). This matters because the most
likely real-world defect is not a badly written policy; it is the application reaching for
the wrong client. Only an end-to-end harness catches that.

Cases:

| Assertion | Why it is not obvious |
|---|---|
| A cannot read B's Company data | the baseline |
| A cannot **write** to B's Company | `INSERT`/`UPDATE` policies are the ones people forget |
| Public `signUp` fails | the subscription model depends on it |
| An ordinary user cannot call `provision_customer` | `SECURITY DEFINER` bypasses RLS |
| A suspended Company yields no data, even to its Owner | the gate must not depend on the UI |
| Every route redirects while `must_change_password` is set | a gate with one hole is no gate |
| The contact form is rate limited | the only public write |

pgTAP continues to cover schema and permissions, extending the Block 0 smoke test.

## 11. Definition of done

- Provisioning creates user, organization, company and memberships, or fails cleanly with
  no orphaned auth user.
- The customer signs in with the provisional password, is forced to change it, and reaches
  the application.
- An expired provisional password refuses sign-in and can be regenerated.
- A cross-tenant access attempt **fails under a real JWT**, for reads and writes.
- Public `signUp` is refused by the hosted project, proven by a test.
- A suspended Company delivers no business data; its metadata stays visible; and the block
  takes effect on an already-open session without forcing a sign-out.
- The contact form records, notifies and is rate limited.
- `lint`, `typecheck`, unit, e2e, isolation and pgTAP suites all pass.

## 12. Out of scope (1b and later)

Granular permissions as data · invitations with token and expiry · Company selector ·
consolidated view · administration console beyond the provisioning and suspension screens ·
member, prize and promotion domains.

## 13. Open risks

- **Provisioning is a single point of failure.** No customer exists without it. Mitigated by
  the compensating delete and by auditing failures, but it deserves the closest review in
  the block.
- **Public signup depends on hosted configuration**, not only on code. The test asserts the
  live behaviour precisely because a panel setting can be changed by hand at any time.
- **Custom SMTP is required** for password reset to work in production; the built-in Supabase
  sender is rate limited and unsuitable. The same configuration serves 1b's invitations.
