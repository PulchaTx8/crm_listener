# Block 1b — Permissions & Invitations — Design

- **Date:** 2026-07-26
- **Status:** Approved for the implementation plan
- **Parent spec:** `2026-07-25-crm-radios-multitenant-design.md` (§7 RBAC, §8 RLS, §11 Block 1)
- **Predecessor:** Block 1a — Auth & tenant foundation (shipped; `docs/block-1a-report.md`)

## 1. What this block is, and what it deliberately is not

Block 1a built the isolation core: who a tenant is, and that one tenant cannot
reach another's data. It left every customer with exactly one user — the Owner
created at provisioning. That is not a usable product: a radio station is run by
more than one person.

This block answers two questions the product cannot ship without. **What may a
given person do?** and **how does a second person get in?** They are one slice
because they are inseparable: you invite someone *as* something.

The parent spec's Block 1b also named a Company selector and a consolidated
view. Both are removed from this slice, for different reasons.

- **The consolidated view has nothing to consolidate.** It aggregates business
  data across Companies — inventory, members, promotions — none of which exists
  before Block 2. Building it now means writing a report over empty tables. It
  belongs with Block 8.
- **The Company selector presupposes more than one Company**, and
  `provision_customer` creates exactly one. "Selector" therefore silently
  carries "create an additional Company", a new operation with its own lifecycle
  (`pending → enabled`, parent spec §7). That is **Block 1c**.

The slicing rationale is the one that split Block 1 in the first place: the
failure mode of this block is **privilege escalation**, and it is unambiguous
only when nothing else is being introduced alongside it. `has_permission` becomes
the security primitive every later block's RLS depends on.

## 2. Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Role model | Fixed system roles (`owner`/`operator`/`viewer`) | Honours the 1a decision that `role` is a column; upgrade path to per-org roles costs one nullable column |
| Permission storage | Seeded by migration, not editable at runtime | Removes the most dangerous screen in the block |
| Invitation mechanism | Own `invitations` table, hashed token, invitee chooses their password | Parent spec N1; the password never leaves the invitee's browser |
| Multiple orgs per person | Not allowed | Matches the business; keeps the acceptance page single-path |
| Last owner | The database refuses to remove the last one | A locked-out org is a support call only the product owner can answer |

## 3. The permission model

**Two tables, neither writable at runtime.**

```
permissions       (code pk, description, introduced_by_block)
role_permissions  (role member_role, permission_code, pk (role, permission_code))
```

Because roles are fixed, `role_permissions` is seeded data. Changing who may do
what is a reviewed, versioned migration — not a click in production. This is the
reason there is no role-editing screen in this block: it would be the highest-risk
surface here, and it buys nothing the business has asked for.

**Two helpers, not one.** The parent spec names `has_permission(perm, company)`,
but inviting is an Organization operation, not a Company one. Forcing it through
a Company-scoped check would make the invitation flow pick an arbitrary Company
just to satisfy the signature.

```sql
has_permission(perm, company)   -- business tables, Block 2 onward
has_org_permission(perm, org)   -- identity operations, this block
```

Both are `STABLE SECURITY DEFINER` with `set search_path`, matching the 1a helpers.
`has_org_permission` resolves through `organization_memberships.role`; it carries no
subscription check, because an Organization is always active — only Companies are
suspended (1a §3). `has_permission` resolves through `company_memberships.role`.

**Composition is the critical property.** `has_permission` does not replace
`has_company_access` — it contains it:

```sql
select exists (select 1 from public.permissions p where p.code = p_permission)
   and public.has_company_access(p_company_id)   -- membership AND active subscription
   and (
     public.is_platform_admin()
     or exists (
       select 1
       from public.company_memberships cm
       join public.role_permissions rp on rp.role = cm.role
       where cm.user_id = auth.uid()
         and cm.company_id = p_company_id
         and cm.deleted_at is null
         and rp.permission_code = p_permission
     )
   );
```

Without the `has_company_access` term, an operator of a suspended Company would
keep their permissions and the suspension would leak. The 1a rule — subscription
cut, data blocked — must hold for every future block without anyone having to
remember it.

**Fail closed, and the ordering is what makes it true.** An unknown permission
code returns false for everyone, platform admins included. The existence check
sits **outside** the admin bypass on purpose: written the obvious way, with
`is_platform_admin() OR exists(...)` alone, the admin branch short-circuits the
`OR` before `rp.permission_code` is ever compared, so `has_permission('typo',
company)` would return **true** for an admin on any active Company. That is the
exact "a typo grants access" failure this paragraph promises cannot happen.

The trap is that `has_company_access` uses the same `is_platform_admin() OR
exists(...)` shape (0005) and is correct there, because the check being bypassed
is membership. Here the bypassed check would be the validity of the permission
code itself. The shape does not transfer, and the difference is asserted by a
test rather than left to whoever writes the next helper.

**Each block owns its permission codes.** 1b seeds only what it enforces:
`users.invite`, `users.manage`, `audit.view`. Block 2 adds `inventory.reserve` in
its own migration. A permission is born beside the feature it guards, instead of a
central catalogue that drifts out of date.

The honest consequence: in this block `operator` and `viewer` hold **no
permissions at all**, and the model only distinguishes owner from non-owner. That
is not a flaw in the design — it reflects there being no business domain yet. What
it already makes testable is the risk that matters: an operator cannot invite
anyone or change anyone's role.

## 4. Invitations

```
invitations (id, organization_id, email, role,
             token_hash, status, expires_at,
             invited_by, accepted_at, accepted_by,
             revoked_at, created_at, updated_at)

unique (organization_id, lower(email)) where status = 'pending'
```

**The table stores the hash, never the token.** The token is generated in Node
with a CSPRNG; only its SHA-256 reaches the database. The RPC never sees the
plaintext, so it appears in no query log and no backup. A database dump yields no
working invitation link — the same reasoning applied to passwords, applied to a
secret that also grants access.

**`status` has three values, not four:** `pending`, `accepted`, `revoked`. There
is no `expired`, because expiry is derived from `expires_at <= now()` at read
time. An `expired` status would only be true if some cron maintained it — and
Block 1a produced exactly that defect: `provisional_expires_at` was written and
read by nothing. State nobody maintains lies. Here there is nothing to maintain.

`expires_at` is 7 days, matching the provisional password.

**The invited `role` applies to both membership levels.** Acceptance creates one
`organization_memberships` row and one `company_memberships` row per Company in the
Organization, all carrying the invited role. With one Company per Organization this
is exact; Block 1c, which introduces additional Companies, is where per-Company
role selection belongs.

### 4.1 The acceptance flow crosses two systems

Creating the auth user is the Admin API; creating the memberships is SQL. There is
no transaction spanning the two — the same shape as provisioning, and the same
compensating action.

```
1. validate token (RPC, by hash)     -> rate limited by IP
2. create auth user via Admin API    -> password chosen by the invitee
3. accept_invitation(id, user_id)    -> re-validates token, status, expiry
                                        creates profile + memberships
                                        marks ACCEPTED, audits
4. if (3) fails: delete the auth user -> compensating delete, as in 1a
```

Step 3 **re-validates rather than trusting step 1**, and the status transition is
conditional (`update ... where status = 'pending'`, checking `FOUND`). Without
that, two simultaneous accepts of the same link would create two accounts. An
invitation is single-use, and single-use is a guarantee the database owns, not one
the order of clicks provides.

**The account is created with the invitation's email**, never one the invitee
types. Otherwise anyone holding a valid token could create an account for an
arbitrary address.

**No password-change gate.** The invitee chose their own password and it never
travelled outside their browser. There is nothing to force them to change — the
material difference from the provisioning path.

### 4.2 Public surface

The acceptance page becomes the second public write in the system and the only
public path that creates users. It is protected by:

- a valid, unexpired, unused token, compared by hash;
- rate limiting by IP through the Block 0 `PostgresRateLimiter`, which gains its
  second real consumer;
- **one generic message** for invalid, expired and revoked tokens alike — three
  distinct messages would tell an attacker which guess landed close.

**If the e-mail fails, the link is shown once** on the inviter's screen for manual
relay, the same pattern as the provisional password. Storage is the source of
truth; delivery is best effort. Because the token is not stored, it cannot be
shown again later: the recovery path is revoke and re-invite.

### 4.3 An email that already has an account

Refused at creation time, with a clear message to the inviter. A person belongs to
one Organization.

This keeps the acceptance page single-path — always "create an account and choose
a password" — and avoids the alternative's hazard: offering to set a password for
an existing account from an emailed link is an account-takeover vector. If
multi-org membership is ever needed, the upgrade is to add a sign-in branch to
acceptance; no stored data changes shape.

## 5. Member management

`change_member_role(membership_id, new_role)` and `remove_member(membership_id)`,
both `SECURITY DEFINER`, both re-checking `has_org_permission('users.manage', org)`
in their own body.

**Removal is `deleted_at`, and it cuts immediately.** The RLS helpers query the
tables on every check — the 1a decision taken for exactly this reason. Someone
removed loses access on their next request, without waiting for a token to
refresh. This block inherits the property and tests it.

**The last-owner rule is a trigger, not a check inside the RPCs.** Membership
writes currently pass only through `SECURITY DEFINER` functions, so an in-RPC
check would be sufficient *today*. A constraint trigger that counts active owners
after each `UPDATE`/`DELETE` still holds when someone later adds an RPC and
forgets the rule. Same lesson as the 1a password gate: the guarantee went into the
column `GRANT`, not the policy, because the policy relied on nobody making a
mistake afterwards.

It covers both ways to reach zero owners — demoting the last one and removing the
last one — including an owner doing it to themselves.

## 6. RLS

**`has_org_permission` is used in a real policy, not only in RPC bodies.**
`invitations` is readable only by someone holding `users.invite` in that
Organization. Without this, the block would exercise the primitive exclusively
inside `SECURITY DEFINER` functions, and Block 2 would be the first to find out
whether it works in a policy — which is where it matters most.

`permissions` and `role_permissions` are readable by `authenticated` so the UI can
show what a role may do; neither has any client write grant.

**`audit_logs` stops being platform-admin-only.** With `audit.view`, an Owner sees
their own Organization's trail: who invited, who removed, who changed a role. This
gives the permission something real to guard, and gives the customer the answer to
"who did this?" without depending on the product owner.

`USING (true)` remains forbidden. Client-supplied `organization_id` is never
trusted without a check.

## 7. Testing

The isolation harness gains this block's failure class — privilege escalation —
as 1a's was tenant leakage.

| Assertion | Why it is not obvious |
|---|---|
| an operator cannot invite; an owner can | the distinction the whole block exists to make |
| A cannot read B's invitations | `invitations` holds third parties' email addresses |
| a revoked token and an expired token both fail | revoking must kill a link already sent |
| accepting twice fails the second time | single-use is the database's guarantee, not the click order's |
| the last owner cannot be removed or demoted | the dead end only the product owner could undo |
| a removed member loses access immediately | 1a's promise of instant revocation |
| a suspended Company yields no permissions | `has_permission` must compose with the subscription |
| an unknown permission code returns false, **even for a platform admin** | a typo in a policy must deny, not grant — and the admin bypass is where that guarantee is easiest to lose |

pgTAP covers structure: `role_permissions` seeded as expected, and no client write
grants on `invitations`, `permissions` or `role_permissions`.

E2E: an Owner invites → the link is shown → a fresh browser context opens it →
chooses a password → arrives at `/app` as a member of the Organization.

## 8. Definition of done

- An Owner invites a colleague; the colleague opens the link, chooses a password,
  and reaches the application as a member with the invited role.
- An operator calling the invitation or member-management RPCs is rejected, under
  a real JWT.
- A revoked invitation and an expired invitation both refuse acceptance, with the
  same generic message as an invalid one.
- The same invitation cannot be accepted twice.
- An Organization cannot be left without an owner, by any path.
- A removed member loses access on their next request, with no forced sign-out.
- A suspended Company grants no permissions, even to its Owner.
- An Owner can read their own Organization's audit trail, and no other.
- `lint`, `typecheck`, unit, e2e, isolation and pgTAP suites all pass.

## 9. Out of scope

Per-Organization custom roles · per-person permission overrides · additional
Companies and the Company selector (Block 1c) · consolidated view (Block 8) ·
administration console beyond these screens · member, prize and promotion domains.

## 10. Open risks

- **Without custom SMTP on the hosted project, invitations do not arrive.**
  Already recorded as Block 1a debt; here it stops being optional. The on-screen
  link is a mitigation, not a fix.
- **The acceptance page creates users and is public.** Token-gated, rate limited
  and generic in its errors — but it is the surface deserving the closest review
  in this block, as provisioning was in 1a.
- **`operator` and `viewer` leave this block holding no permissions.** The model
  stays lightly exercised until Block 2 brings a real domain, so the tests here
  carry more of the weight than usual.
