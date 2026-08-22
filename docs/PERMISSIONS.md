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
explicitly for the same reason. Skip it and you can still sign in, but your name
is blank everywhere and provisioning a customer fails: `provision_organization`
(`0157`) raises `P0002` when the owner has no `profiles` row, because it only
flips the flags on one that is already there.

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
two subjects are separate. Keys are managed in `/admin/stations`, per Station.


## Blocking a whole customer (Block 16)

`suspend_company` stops **one radio**. `block_organization` stops **the
customer**: every Station under the group, every member, and the owner.

The lock is a nullable `organizations.suspended_at` rather than a second
`status` enum — `companies` has one because it has had one since `0003`, and a
second enum with the same two values named for the wrong table is a thing to
keep in step for no gain. `suspended_at is not null` is the whole of the rule.

### Where it is enforced, and why it is not a list

The audit that decided the design, run before `0156` was written:

```bash
grep -rn "is_owner_for(\|is_owner_of_company\|public.is_owner(" supabase/migrations
```

It turned up **three** shapes, and the third is the one that mattered:

1. **`has_company_access_for` (`0121`)** — the door every permission check
   passes through, because `has_permission_for` ANDs it.
2. **`is_owner_of_company_for` (`0121`)** — the door `0044`'s policies admit the
   owner through to rows everyone else is denied (an archived promotion, for
   one). It checked no status of any kind.
3. **`public.is_owner(organization_id)`, called directly by more than twenty
   policies** — `0006`, `0015`, `0016`, `0021`, `0024`, `0032`, `0033`, `0035`
   (four times, on `members`), `0036`, `0044` onward. `members` is
   Organization-scoped, so those four never touch `has_company_access` at all.

So the condition went into **`is_owner_for`**, and all twenty obey without being
edited. `is_owner_of_company_for` inherits it for free, because it calls
`is_owner_for`. The membership path in `has_company_access_for` states it again,
because staff never reach `is_owner_for` at all.

**What that costs, stated rather than discovered:** `is_owner_for` stopped being
a pure predicate. It used to mean *"does this person own this Organization"* and
now means *"…and is the Organization usable"*. `has_company_access_for` has had
exactly that shape since `0121` — it folds `status = 'active'` into a question
about access — so this is the house's existing trade rather than a new one.

### The two deliberate exceptions

**The platform admin is outside the condition.** Whoever blocked a group has to
be able to look at it and release it; a condition that caught the admin too
would lock the console out of the customer it just locked.

**A blocked group's owner still SEES their Stations.** `is_owner_including_blocked`
is the pure question, and it has exactly one caller and must keep exactly one:
`companies_select_org_member`. `0006`'s own comment states the rule for a
suspended Station — the customer sees why access stopped instead of an empty
screen — and a screen that says *"no station is linked to your account"* to
somebody who has three turns a billing conversation into a support incident.
Seeing the row is all it buys; every other policy, permission and RPC refuses.

### The proof

`tests/isolation/organization-blocking.test.ts`. Every access assertion is made
twice, once as the owner and once as the staff, because a version that checks
only the staff **passes against the exact defect this design exists to prevent**.
Measured by mutation: reverting `is_owner_for` to its pre-`0156` body fails that
file at the `is_owner_of_company` assertion and nowhere else.

`supabase/tests/37_organization_blocking.test.sql` asserts the shape — the doors
exist and are gated — and stops there, because pgTAP runs as superuser with a
null `auth.uid()` where RLS never applies.

## Programmes are gated on music, and the mismatch now has four surfaces (Blocks 18 → 27 → 30c → 30e → 31a)

`/shows` now lives under **Promotions** in the sidebar, directly after
Pickups — its **third section in twelve blocks**. Audience filed it in Block
18; Catalog took it in Block 27; Block 30c moved it here, on the owner's
ruling of 2026-08-19, because a promotion can now name the Programme it
belongs to (`promotions.show_id`, `0258`) and the two screens read as one
errand. **Its permission has never moved with it, across either move.**

`shows` carries exactly one policy — `shows_select_music_view`, gated on
**`music.view`** — and no insert or update policy at all, so every write
already goes through a `SECURITY DEFINER` door. `save_show` and `end_show`
(0175) each re-check **`music.manage`** against `auth.uid()`. `show_schedules`
follows `shows` exactly. So a member who administers Promotions and holds
nothing in music sees the **Programmes** link and finds nothing behind it.

**Block 30c found a second surface of the same mismatch**, during its own
Task 4 review. `listShowOptions` (`src/services/shows.ts`) — which
fills the Programme combobox on a promotion's own record (item 17) — reads
through the caller's own client, so `shows_select_music_view`'s `music.view`
gate applies there too. The same member who cannot open `/shows` also sees
that combobox with **no options at all**, permanently reading "No programme".
The first surface is a dead link — visibly broken, and an operator learns
something is wrong. The second looks exactly like a Station that has no
Programmes; there is nothing on screen to tell the two apart.

**That is still deliberate, and the reason is still §4 of this document read
backwards.** Two fixes were weighed for Block 30c and neither is this block:

- **A `shows.view` / `shows.manage` pair** is not two rows in a table — it is
  a permissions migration, the roles screen, every seeded role, this
  document — and, decisively, **every role a customer has already
  configured, none of which would grant the new code**. Shipping either
  screen behind a permission nobody holds would hide it from everyone who has
  one today.
- **Re-gating both surfaces on `promotions.view`/`promotions.edit` instead**
  is cheaper to ship, but it takes the screen — and the combobox — away from
  whoever administers the catalogue and holds `music.view` today. It trades
  the mismatch for a different one rather than closing it.

**Block 30e found the third surface, and routed one read around the gate
rather than moving it.** Item 18 filters Participations by the band of the
Programme its promotion belongs to, so that screen has to read a schedule —
and the operator who works it need not hold anything in music. Left to RLS the
band combo would be **permanently empty for exactly them**, which is the
second surface's failure again: it does not say "you may not see this", it
says "this Programme never airs".

So `promotion_show_schedule` (`0269`) is `SECURITY
DEFINER` and re-checks **`participations.view`** at the promotion's own
Station. It returns that Programme's schedule rows and nothing else — no
listing, no search, no write — and the pgTAP file proves the same caller still
reads zero rows from `shows` directly. One read got past the gate; the section
did not move.

The three surfaces are now: the **screen** (a dead link), the **combobox** on a
promotion's record (an empty list that looks like no data), and the
**band combo** on Participations (which would have been the same empty list,
and is not). The mismatch is recorded where a reader will actually reach it:
`src/lib/auth/shell.ts` beside the nav entry, the header of
`src/app/(app)/shows/page.tsx`, the header of
`supabase/migrations/0269_promotion_show_schedule.sql`, and this section.

**Block 31a met it a fourth time and answered by SAYING LESS.** The Promotions
grid gained a Programme column, and the embedded `shows(name)` it reads is cut by
the same policy — so for an operator without `music.view` the name comes back
null on every row, and an empty cell would claim the promotion has no Programme
at all. `promotions.show_id` comes back regardless, which is what makes the two
separable: the cell reads the name when it can, a muted **Not visible** when
there IS a Programme whose name is out of reach, and a dash only when there is
none. No door was opened: Block 30e opened one for a read with no alternative,
and this cell had one.

The four surfaces are now: the **screen** (a dead link), the **combobox** on a
promotion's record (an empty list that looks like no data), the **band combo** on
Participations (which would have been the same empty list, and is not, because
`0269` reads around the gate), and the **Programme column** on the promotions
list (which says what it cannot show).

Closing it is a block of its own, and it should start by deciding what happens
to roles that already exist. Three blocks in a row have now routed around it
rather than deciding it, each time for a defensible local reason; the next one
should decide.

## The listener card is governed by `members.view`, not a new permission (Block 30a)

Pickups, Participations and Requests each already computed `members.view` for
their own reason before this block — whether the search box may filter by
listener (`canSearchPickupsByListener`, `canSearchByListener`,
`list_music_requests`' own Rule 3) — and whichever screen a listener card is
opened from now reuses that exact same boolean to decide whether the **View
the listener** button renders at all. The reveal door behind it,
`reveal_member_field` (0253, `docs/SECURITY.md` §8), asks the identical
question again in SQL: some Station the listener is linked to where the caller
holds `members.view`.

**No `members.reveal` permission was added.** The three lists already narrowed
what they project (0254) rather than what a permission gates, so the boundary
a caller crosses to open the card and the boundary they cross to reveal a
field inside it are the same one `members.view` already drew — one permission,
computed once per screen, asked again by the door itself rather than trusted
from the screen that rendered the button. A role that already grants
`members.view` for the Members screen therefore also reaches the card from all
three of these screens; nothing about who can see it changed, only where it
can be reached from.
