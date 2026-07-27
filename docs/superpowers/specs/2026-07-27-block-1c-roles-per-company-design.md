# Block 1c — Roles & per-Company assignment — Design

**Date:** 2026-07-27
**Supersedes:** the fixed-role model of Block 1b (`member_role` as the source of
permissions). Block 1b named this successor in its own migration comments —
`0011_member_management.sql` says "Per-Company roles arrive in Block 1c".

---

## 1. What this block is, and what it deliberately is not

Today a user's powers come from one of three roles hard-coded in an enum, and
which power each role holds is written in a migration. The owner of an
Organization chooses nothing.

This block replaces that with **roles the owner creates** — call them job titles:
Manager, Director, Producer — each holding a set of powers picked from a
system-defined catalogue, and **assigned per Company**. The same person can be a
Manager at one Station and a viewer at another, or absent from a third entirely.

It is **not** the inventory block. No `inventory.*` permission is seeded here.
Block 2 introduces its own permissions in its own migration, and they appear in
this block's screen without it being touched — that is the test of whether the
catalogue was built right.

## 2. Decisions taken

Fixed by the product owner on 2026-07-27:

1. **The Organization is the root.** Directly beneath it sit roles, Companies and
   users. A role belongs to the Organization and is reusable across its Companies.
2. **A user is attached to one or more Companies, always with a role.** There is
   no membership without a role. "In the Company but permitted nothing" is not a
   representable state.
3. **Powers come from a system-defined list.** The owner composes roles out of
   it; they cannot invent a power. Each block adds its own entries.
4. **Administering roles is itself one of those powers**, so the owner may
   delegate it.
5. **The owner can always do everything**, holds no role, and is not listed in
   any Company's membership.
6. **To widen a user's powers you change their role, or change what that role
   holds.** There is no per-user exception on top of a role.
7. **One role per user per Company.** Not a set to be unioned.

## 3. Consequences worth stating before the code

**A role assigned in one Company can carry Organization-wide power.** Roles
belong to the Organization; `users.invite`, `users.manage`, `audit.view` and
`roles.manage` are Organization-scoped. Granting a role holding one of them, in
any single Company, grants it for the whole Organization. That is the intended
reading of "Director" — but it must be visible, so the role editor labels those
permissions as Organization-wide rather than burying them beside per-Company
ones.

**Editing a role takes effect on the next request.** Permissions are read from
the tables on every check, never from a JWT claim (Block 1a §4). Unchecking a box
cuts a team off immediately, with no sign-out. This is the correct behaviour for
revocation and a sharp edge for mistakes; the editor therefore shows how many
users hold the role before saving.

**A suspended Company grants nothing, including its Organization-scoped
permissions.** Otherwise a lapsed subscription would still leave someone able to
invite users and read the audit trail.

## 4. Data model

### 4.1 `roles`

```
id               uuid primary key
organization_id  uuid not null references organizations (id)
name             text not null
description      text
created_by       uuid references auth.users (id)
created_at, updated_at, deleted_at
```

Partial unique index on `(organization_id, lower(name)) where deleted_at is null`
— two live "Manager" roles in one Organization is a mistake, and an archived one
must not block reuse of the name (spec N5).

### 4.2 `role_permissions`

The existing table is keyed by the `member_role` enum and holds seeded rows only.
It is **dropped and recreated** keyed by `role_id`:

```
role_id          uuid not null references roles (id) on delete cascade
permission_code  text not null references permissions (code)
primary key (role_id, permission_code)
```

No data is migrated: the three seeded rows all granted the owner, and the owner
now bypasses the lookup entirely.

### 4.3 `permissions` gains three columns

```
module         text not null   -- 'organization', 'inventory', 'members', …
label          text not null   -- human sentence shown beside the checkbox
scope          permission_scope not null  -- 'organization' | 'company'
display_order  integer not null default 0
```

`module` and `label` exist so the editor can render the catalogue without the UI
carrying a hard-coded copy of it; `scope` decides which helper resolves the code,
and is what lets the editor warn that a permission reaches beyond one Company.
Block 1b's three codes are backfilled as `module = 'organization'`, `scope =
'organization'`.

New code introduced here: **`roles.manage`** — create, edit and delete the
Organization's roles.

### 4.4 `company_memberships`

Gains `role_id uuid not null`, gains `organization_id uuid not null`, and
**loses `role`**. Keeping the old column would leave a value nothing maintains
and everything reads wrong — the exact defect Block 1b removed from the
invitation model.

Cross-Organization assignment is made **structurally impossible** rather than
checked in application code:

```
alter table roles     add constraint roles_id_org_unique     unique (id, organization_id);
alter table companies add constraint companies_id_org_unique unique (id, organization_id);

company_memberships (company_id, organization_id) references companies (id, organization_id)
company_memberships (role_id,    organization_id) references roles     (id, organization_id)
```

Two composite foreign keys sharing one `organization_id` column force the Company
and the role to belong to the same Organization. A leaked role id from another
tenant is rejected by the database, with no trigger to forget and no RPC to
bypass.

`one role per Company per user` needs no extra rule: it is one column, so a
second value cannot exist. The existing partial unique index on
`(user_id, company_id) where deleted_at is null` continues to prevent duplicate
rows.

### 4.5 `organization_memberships` collapses to owner or member

`member_role` had three values, of which only `owner` still carries meaning at
Organization level — `operator` and `viewer` were shorthands for permission sets
that are now roles. The column migrates to a new `org_role` enum of
`('owner', 'member')`, mapping `operator` and `viewer` to `member`. `member_role`
is then dropped, once the invitation column below has moved off it too.

### 4.6 The owner leaves the Company membership table

`provision_customer` currently inserts a `company_memberships` row for the owner.
With a mandatory role that row would need one, making the owner the only user in
the system obliged to hold a role in order to exercise powers they hold by
ownership.

Instead the owner is recognised at Organization level and `has_company_access`
gains an `is_owner` term. The migration deletes existing owner rows from
`company_memberships`, and `provision_customer` stops writing them.

### 4.7 Existing data

Non-owner memberships today hold `operator` or `viewer`, and Block 1b seeded
**no** permissions for either — they can sign in and see nothing. The migration
therefore creates, per affected Organization, a role named after the old value
with **an empty permission set**, and points those memberships at it. That is not
a downgrade: it is the same power, now visible as a row the owner can edit.

`organization_id` is backfilled from each membership's Company before the column
is made `not null` and the composite foreign keys are added; the owner rows of
§4.6 are deleted first, so no row needs a role that would have to be invented for
someone who does not use one.

## 5. Permission resolution

Three functions are rewritten. All keep the shape Block 1b arrived at the hard
way: **the permission-code existence check sits outside every bypass**, so a
typo'd code returns false even for a platform admin.

**`has_company_access(company)`** — Company is active, and (platform admin **or**
owner of its Organization **or** a live membership row exists).

**`has_permission(code, company)`** — code exists **and** `has_company_access`
**and** (platform admin **or** owner of its Organization **or** the membership's
role grants the code).

**`has_org_permission(code, org)`** — code exists **and** (platform admin **or**
owner **or** a live membership in *any active, non-deleted* Company of that
Organization whose role grants the code).

The active-Company term in the third function is the mechanism behind the
suspension rule in §3.

## 6. Operations

Every one is a `SECURITY DEFINER` function that re-checks the caller, writes to
`audit_logs`, and on denial uses `RAISE LOG` rather than an audit insert — an
insert followed by `RAISE` never commits (Block 1a §3.2).

`roles.manage` and `users.manage` are Organization-scoped, so the two functions
that take a `company_id` resolve the Company's Organization first and check with
`has_org_permission` against that — never against a Company id the caller
supplied.

| Function | Requires | Notes |
|---|---|---|
| `create_role(org, name, description, codes[])` | `roles.manage` | Rejects an unknown code rather than skipping it: silently dropping one yields a role weaker than the screen showed. |
| `update_role(role_id, name, description, codes[])` | `roles.manage` | Replaces the permission set atomically. |
| `delete_role(role_id)` | `roles.manage` | Refused while any live membership uses it. Reassign first — soft-deleting a role in use would leave people powerless with nothing on screen to explain it. |
| `assign_company_role(company_id, user_id, role_id)` | `users.manage` | Creates the membership or moves it to another role. The composite FKs reject a foreign role. |
| `remove_company_access(company_id, user_id)` | `users.manage` | Soft delete. Cuts on the next request. |
| `add_company(org_id, name, timezone)` | platform admin | §8. |

`change_member_role` from Block 1b becomes `change_org_role`, taking the new
two-value enum, and no longer propagates anything to `company_memberships` —
Company powers are now the role's business, not the Organization role's.

## 7. Invitations

The invitation carries the attachment the model requires:

```
is_owner  boolean not null default false
role_id   uuid references roles (id)          -- null iff is_owner
role      -- dropped
+ invitation_companies (invitation_id, company_id)
```

with `check ((is_owner and role_id is null) or (not is_owner and role_id is not null))`.

`create_invitation` refuses a non-owner invitation naming no Company, and refuses
Companies outside the Organization. `accept_invitation` creates the Organization
membership and, for a non-owner, one `company_memberships` row per selected
Company at the invited role. The owner may then refine per Company on the Team
screen.

Acceptance remains single-use, re-validated under a row lock, with one message
for every failure — unchanged from Block 1b.

## 8. A second Company

Per-Company roles cannot be exercised, demonstrated or tested against an
Organization that can only ever have one Company, and today only
`provision_customer` creates one, at contract time.

This block adds `add_company`, platform-admin only, and a form in the existing
customers console. The self-service lifecycle from spec §7 (owner requests →
platform enables → billing) stays in Block 10; nothing here pre-empts it.

## 9. RLS

`roles` and `role_permissions` are readable by members of the owning
Organization — a user must be able to see the name of the role they hold, and a
manager needs the full list. Neither table takes an INSERT/UPDATE/DELETE grant:
writes arrive only through the functions in §6.

```
roles_select_org_member     using (deleted_at is null and is_org_member(organization_id))
role_permissions_select_org using (exists (select 1 from roles r
                                            where r.id = role_id and is_org_member(r.organization_id)))
```

`permissions` keeps its Block 1b policy. `company_memberships` keeps its policy;
the new columns are covered by it. `service_role` receives `select` on both new
tables and nothing more — the same explicit grant every table needs, since
`BYPASSRLS` does not substitute for one (Block 1a §3.9).

## 10. Screens

**Roles** (`/roles`) — the Organization's roles, with a count of how many users
hold each. The editor renders the catalogue grouped by module, with the
Organization-wide ones marked as such. Visible when `roles.manage` is held.

**Team** (`/team`) — extended from Block 1b. Each member now shows one row per
Company with their role there, a dropdown to change it, and a way to remove them
from that Company. Owners appear once, marked as owner, with nothing to set.

**Invite** — owner toggle, role select, Company checkboxes.

**Companies** — `/app` lists the Companies the signed-in user can reach, which is
also how a member discovers they were added to a second Station. The full
selector and consolidated view remain out of scope.

Every screen is a courtesy: each write re-checks in the database, and hiding a
link is never the boundary.

## 11. Testing

**pgTAP** — the composite FKs reject a role from another Organization; a
membership cannot be inserted without a role; an unknown permission code resolves
false even for a platform admin; the owner resolves true without any membership
row; a suspended Company yields false from all three helpers.

**Isolation, under real JWTs** — a user holding a role in Company A is refused the
same operation in Company B; unchecking a permission cuts access on the next
request with no re-authentication; deleting a role in use is refused; a member
without `roles.manage` cannot create or edit one; a user of Organization X cannot
assign a role of Organization Y even with a valid id.

**End-to-end** — the owner creates "Manager", invites a colleague into one of two
Companies at that role, and the colleague can act in that Station and is refused
in the other.

## 12. Definition of done

| Criterion | Evidence |
|---|---|
| An owner creates a role, picks permissions from the catalogue, and assigns it per Company | e2e |
| The same user holds different powers in two Companies of one Organization | isolation |
| A membership without a role cannot exist | pgTAP |
| A role from another Organization is rejected by the database, not by application code | pgTAP |
| Editing a role changes what its holders can do on the next request | isolation |
| A role in use cannot be deleted | isolation |
| `roles.manage` lets a non-owner administer roles; without it they cannot | isolation |
| A suspended Company grants nothing, including Organization-scoped permissions | pgTAP |
| An invitation carries role and Companies, and acceptance produces exactly those memberships | e2e, isolation |
| A platform admin adds a second Company to an existing Organization | isolation |
| lint, typecheck, unit, pgTAP, isolation, e2e and `docker build` all pass | CI |

## 13. Out of scope

More than one role per user per Company. Per-user exceptions on top of a role.
Owner self-service Company creation. The Company selector and consolidated
cross-Company view. Any `inventory.*` permission — those belong to Block 2, and
their appearing in this screen untouched is the proof the catalogue works.

## 14. Open risks

1. **The enum migration touches live policies and functions.** `member_role`
   appears in `organization_memberships`, `company_memberships`, `invitations`
   and four function signatures. The migration must drop and recreate the
   dependent functions in order, and the pgTAP suite is what proves nothing was
   left pointing at the old type.
2. **Removing the owner's Company membership changes an existing helper's
   meaning.** Anything that assumed "owner ⇒ row in `company_memberships`" breaks
   silently. The isolation suite covers the owner path explicitly for that reason.
3. **The invitation shape changes on the only onboarding path in the system.** A
   defect there locks new customers out rather than degrading a feature.
4. **Instant effect on role edits is a sharp edge.** Mitigated by the holder
   count in the editor and by the audit entry, not removed.
