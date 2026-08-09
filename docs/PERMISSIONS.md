# Permissions

**What this answers:** how authorisation is modelled, and where the authoritative
list of permissions is — which is not this file.

---

## 1. The model

- An **Organization** owns one or more **Companies**, which the product calls
  **Stations**.
- A **member of staff** is linked to a Station with exactly **one role** there.
  The same person may hold different roles at different Stations of the same
  Organization.
- A **role** is composed from the permission catalogue, **per Company**. Roles
  are data, created at `/roles`, not code.
- The **owner** can do everything, always, and sits **outside** the link table.
  There is no role that grants what being the owner grants.
- A **platform admin** operates the installation: provisioning customers, adding
  Stations, suspending subscriptions. They are not a super-owner of anybody's
  data.

Administering roles is itself a permission, so it is **delegable** — an owner can
hand it to somebody without handing over the account.

## 2. The five functions

Every policy in the schema leans on these:

| function | asks |
| --- | --- |
| `is_platform_admin()` | is the caller an operator of this installation |
| `is_owner(organization)` | does the caller own this Organization |
| `is_owner_of_company(company)` | does the caller own the Organization this Station belongs to |
| `has_company_access(company)` | may the caller see this Station at all |
| `has_permission(key, company)` | may the caller do this specific thing here |

Since `0121` each has a `_for` sibling taking a **user id** instead of reading
`auth.uid()` — the worker has no session, and a report generated on somebody's
behalf must be generated with *their* reach, not the worker's.

The originals are one-line wrappers over the `_for` versions and carry **no body
of their own**, so the two doors cannot drift apart.
`supabase/tests/21_permission_for.test.sql` asserts exactly that, across the
whole catalogue.

## 3. The catalogue lives in the database

```sql
select key, description from public.permissions order by key;
```

**It is deliberately not copied here.** A markdown list of permission keys is
wrong the first time somebody adds one and forgets this file — and wrong
*silently*, which is worse than absent. The same reasoning applies to the roles a
given installation has: they are rows, not documentation.

## 4. Adding a permission

Three things, and the third is the one people skip:

1. A migration inserting into `public.permissions` — key, label, description.
   The role editor reads the catalogue and needs no code change to show it.
2. A policy or an RPC that actually **reads** it.
3. An **isolation** test proving a caller without it is refused. pgTAP cannot see
   this: it runs as superuser with a null `auth.uid()`.

Block 10a's `audit.view` is the warning. It existed as a key for nine blocks
before anything read it — a flag that looked like a control. If nothing reads a
permission, it is not a permission, it is a comment in a table.

## 5. The first platform admin

`public.platform_admins` accepts no client write: `0006` grants `SELECT` only,
and only to the admin themselves. This is the installation's chicken-and-egg,
solved once by hand.

**1. Authentication → Users → Add user.** Tick **Auto Confirm User**. Without it
the row is created with the e-mail unconfirmed and sign-in answers *"Invalid
login credentials"* — which reads as a wrong password and is not one.

**2. In the SQL editor** (which runs as the database owner and so bypasses the
policy), keyed by e-mail rather than by a pasted uuid:

```sql
with target as (
  select id, email from auth.users where email = 'you@example.com'
),
profile as (
  insert into public.profiles (id, email, full_name)
  select id, email, 'Your Name' from target
  on conflict (id) do nothing
  returning id
)
insert into public.platform_admins (user_id)
select id from target
on conflict (user_id) do nothing;
```

**THE `profiles` ROW IS HALF THE PROCEDURE, and the half that gets forgotten.**
Nothing creates it for you: there is no trigger on `auth.users`, and the two
places that write `profiles` (`0013`, `0018`) are the invitation paths — so a
user created through the dashboard has none. `scripts/seed-demo.mjs` inserts one
explicitly for the same reason, and its own comment says why: *"provision_customer
expects the profile to exist already"*. Skip it and you can still sign in, but
your name is blank everywhere and provisioning a customer fails.

Both statements are idempotent, so re-running the block is safe.

**3. Verify before believing it:**

```sql
select u.email,
       (p.id is not null)      as has_profile,
       (a.user_id is not null) as is_admin
  from auth.users u
  left join public.profiles       p on p.id = u.id
  left join public.platform_admins a on a.user_id = u.id
 order by u.created_at desc;
```

From then on `/admin` is reachable and everything else is born through the
interface. **There is no UI for this and that is deliberate** — a screen that
creates platform admins is a screen that can be tricked into creating one.

The symptom when it has not been done: `/admin/*` redirects to `/app` with no
message at all (`src/app/(admin)/layout.tsx`). There is a step-by-step version of
this procedure written for the operator rather than for a developer, in
Portuguese, published as an artifact — ask the owner for the link.


## Permission codes as API scopes (Block 15)

An API credential's scopes are **permission codes**, not a private vocabulary:
`api_credential_scopes.permission_code` is a foreign key against
`public.permissions`, so a scope nobody defined is refused by Postgres rather
than by application code somebody has to remember to write.

They are checked differently, though, and the difference matters when reading
the doors in `0152`. A screen asks `has_permission(code, company)`, which since
`0121` is `has_permission_for(auth.uid(), …)`. **An API caller has no
`auth.uid()`** — the route calls with the service key — so the doors check
whether the *credential row* holds the scope instead. Asking `has_permission`
there would refuse every call, always, and the refusal would look to a customer
like a problem with their roles.

The consequence to keep in mind: granting a role a permission does **not** give
any API key that permission, and revoking it does not take it away from one. The
two subjects are separate. Keys are managed in `/admin/customers`, per Station.
