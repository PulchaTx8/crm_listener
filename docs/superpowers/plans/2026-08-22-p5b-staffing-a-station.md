# P5b — staffing a Station: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Station's owner staffs their own Station — and the invitation door
stops telling whoever uses it which e-mail addresses already exist on the
platform.

**Architecture:** Two of the four `users.manage` doors already carry a company
and simply ask the wrong function; they move from `has_org_permission` to
`has_permission`. The invitation doors gate at the Stations the invitation names
rather than at the Organization. And `create_invitation` stops raising for an
address that already has an account: under D17 a user belongs to the platform and
may be staff anywhere, so that is an ordinary operation — making it **succeed**
removes the differential instead of masking the message.

**Tech Stack:** PostgreSQL / PL/pgSQL, Supabase migrations, pgTAP.

**Spec:** `docs/superpowers/specs/2026-08-22-station-root-and-platform-identity-design.md`
— block **P5b** of §11; decisions **D17** and **D19**.

## Global Constraints

- **Everything in English** — identifiers, comments, error messages, docs, commit
  messages.
- **Never edit a merged migration in place.** Copy forward from the migration
  holding the **live** definition, confirmed against `pg_proc` and never inferred
  from a grep for `create or replace` — that pattern misses a `drop` +
  `create function` pair, which is how P2 nearly reverted the country feature.
- **Migration numbers `0281`–`0283`.** The highest on `main` is
  `0280_station_owner_backfill.sql`.
- **The full local gate set**, because CI runs more than `npm run build`:
  ```
  npm run db:reset && npm run db:test
  npx vitest run --config vitest.isolation.config.ts --reporter=default \
      --reporter=json --outputFile=<path>.json    # read the JSON, not the summary
  npm run lint && npm run typecheck && npm test && npm run build
  npm run seed:branding && CI=1 npx playwright test --workers=1
  ```
  **Never through a pipe.** `cmd | tail` returns `tail`'s exit code, which
  reported two green e2e runs that had failed.

---

## What this block is NOT

The live catalogue names twelve functions gating on `has_org_permission`. Only
four are here, and the reasons the others are not matter:

- **`change_org_role`, `remove_member`** act on the **Organization** — who is in
  the group, and at what org role. That is group administration, which D19 leaves
  with the group. They keep `has_org_permission`.
- **`create_role`, `update_role`, `delete_role`** gate on `roles.manage`, and
  `roles` is still Organization-scoped. Descending the permission without the
  table would let a Station's owner edit a definition their sibling Stations
  depend on. Both descend together in **P7**, which rewrites the seven
  Organization-only tables regardless.
- **`block_member`, `lift_member_block`** are **P5c** — the Organization-wide
  block is retired there rather than rescoped here.
- **`find_member_by_identifier`** is the deduplication door, deliberately
  Organization-wide (`0033`: *"THE ONE PLACE IN THIS PROJECT THAT READS ACROSS THE
  VISIBILITY BOUNDARY BY DESIGN"*). It stays.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0281_staffing_gates_descend.sql` (create) | `assign_company_role` and `remove_company_access` gate at the Station. |
| `supabase/migrations/0282_invitation_gates_descend.sql` (create) | `create_invitation` gates at the Stations it names and stops refusing an existing account; `revoke_invitation` follows. |
| `supabase/migrations/0283_accept_an_account_already_here.sql` (create) | `accept_invitation` tolerates a person already in the group or the Station, and an owner invitation takes Station ownership. |
| `supabase/tests/78_staffing_a_station.test.sql` (create) | The block's assertions. |

---

### Task 1: A Station's owner staffs their own Station

**Files:**
- Create: `supabase/migrations/0281_staffing_gates_descend.sql`
- Create: `supabase/tests/78_staffing_a_station.test.sql`
- Read (do not modify): `supabase/migrations/0017_role_rpcs.sql` — `assign_company_role` and `remove_company_access`

Confirm the source before copying:

```bash
docker exec supabase_db_CRM_-_LISTENER psql -U postgres -d postgres -tAc \
  "select p.proname, pg_get_function_identity_arguments(p.oid) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in
          ('assign_company_role','remove_company_access')"
```

**Interfaces:**
- Consumes: `public.has_permission(text, uuid)` — `0121`, with P5a's Station-owner branch (`0279`)
- Preserves: both signatures exactly, so every caller is untouched

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/78_staffing_a_station.test.sql`:

```sql
begin;
select plan(4);

-- ---------------------------------------------------------------------------
-- P5b. A STATION'S OWNER STAFFS THEIR OWN STATION.
--
-- assign_company_role and remove_company_access already take a company; they
-- simply asked has_org_permission about it, so the answer was "does this person
-- administer the GROUP" for a question about one Station. A Station's owner --
-- the concept 0278 built and 0280 gave to every existing Organization owner --
-- could not staff the Station they own.
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000078f1', 'Org P5b');

insert into public.companies (id, organization_id, name, timezone, status) values
  ('00000000-0000-0000-0000-0000000078c1', '00000000-0000-0000-0000-0000000078f1',
   'Station P5b one', 'America/Sao_Paulo', 'active'),
  ('00000000-0000-0000-0000-0000000078c2', '00000000-0000-0000-0000-0000000078f1',
   'Station P5b two', 'America/Sao_Paulo', 'active');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000078a1', 'station-owner-p5b@example.test'),
  ('00000000-0000-0000-0000-0000000078a2', 'newcomer-p5b@example.test');

-- Owner of Station one only. Never of Station two.
insert into public.company_memberships (user_id, company_id, organization_id, is_owner) values
  ('00000000-0000-0000-0000-0000000078a1', '00000000-0000-0000-0000-0000000078c1',
   '00000000-0000-0000-0000-0000000078f1', true);

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000078e1', '00000000-0000-0000-0000-0000000078f1',
   'Station P5b Viewer');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000078e1', 'members.view');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000078a1", "role": "authenticated"}';

select lives_ok($$
  -- (p_company_id, p_user_id, p_role_id) -- the Station comes FIRST; pg_proc is
  -- the authority on that, and reading it the other way round passes two uuids
  -- that are both valid and both wrong.
  select public.assign_company_role(
    '00000000-0000-0000-0000-0000000078c1',
    '00000000-0000-0000-0000-0000000078a2',
    '00000000-0000-0000-0000-0000000078e1')
$$, 'a Station''s owner gives somebody a role at the Station they own');

select is(
  (select count(*)::int from public.company_memberships
    where user_id = '00000000-0000-0000-0000-0000000078a2'
      and company_id = '00000000-0000-0000-0000-0000000078c1'
      and deleted_at is null),
  1,
  'and the membership is really there');

-- The whole point of a Station owner: it does not travel sideways.
select throws_ok($$
  select public.assign_company_role(
    '00000000-0000-0000-0000-0000000078c2',
    '00000000-0000-0000-0000-0000000078a2',
    '00000000-0000-0000-0000-0000000078e1')
$$, '42501', null,
   'and cannot staff the sister Station they do not own');

select lives_ok($$
  select public.remove_company_access(
    '00000000-0000-0000-0000-0000000078c1',
    '00000000-0000-0000-0000-0000000078a2')
$$, 'and can take that access away again');

reset request.jwt.claims;

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: assertion 1 fails — `permission denied: users.manage required`. The
Station's owner is refused at the Station they own, which is the defect.

- [ ] **Step 3: Write the migration**

```bash
{ printf -- '-- supabase/migrations/0281_staffing_gates_descend.sql\n\n'; \
  sed -n '/^create or replace function public.assign_company_role/,/^\$\$;/p' \
    supabase/migrations/0017_role_rpcs.sql; \
  printf '\n'; \
  sed -n '/^create or replace function public.remove_company_access/,/^\$\$;/p' \
    supabase/migrations/0017_role_rpcs.sql; } \
  > supabase/migrations/0281_staffing_gates_descend.sql
```

In each copy, replace the `has_org_permission('users.manage', <org>)` test with
`has_permission('users.manage', p_company_id)`, and put this above the first:

```sql
  -- P5b. THE QUESTION WAS ABOUT ONE STATION AND THE GATE ASKED ABOUT THE GROUP.
  -- Both of these doors already take a company; asking has_org_permission meant
  -- "does this person administer the Organization", so a Station's owner --
  -- 0278's concept, held by every Organization owner since 0280 -- could not
  -- staff the Station they own, and somebody with users.manage at a sister
  -- Station could.
  --
  -- has_permission carries the Station-owner branch 0279 added, so an owner
  -- passes without holding any role, which is the whole point of ownership.
```

Then append both comments, re-issued whole, naming the change.

Verify the copies:

```bash
diff \
  <(sed -n '/^create or replace function public.assign_company_role/,/^\$\$;/p' supabase/migrations/0017_role_rpcs.sql) \
  <(sed -n '/^create or replace function public.assign_company_role/,/^\$\$;/p' supabase/migrations/0281_staffing_gates_descend.sql)
```

Expected: one hunk per function — the comment and the gate. Nothing removed.

- [ ] **Step 4: Run it and watch it pass**

```bash
npm run db:reset && npm run db:test
```

Expected: `78_staffing_a_station` passes all 4. **Other files failing here name a
caller who held `users.manage` at the Organization and used it at a Station they
have no role at** — read each before changing it; that is the narrowing working.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0281_staffing_gates_descend.sql supabase/tests/78_staffing_a_station.test.sql
git commit -m "feat(p5b): a Station's owner staffs their own Station"
```

---

### Task 2: The invitation door stops naming who exists

**Files:**
- Create: `supabase/migrations/0282_invitation_gates_descend.sql`
- Modify: `supabase/tests/78_staffing_a_station.test.sql`
- Read (do not modify): `supabase/migrations/0018_invitations_1c.sql` — `create_invitation`; `supabase/migrations/0013_invitation_rpcs.sql` — `revoke_invitation`

**Interfaces:**
- Preserves both signatures exactly.

- [ ] **Step 1: Write the failing test**

Raise the plan to `select plan(8);` and append before `reset request.jwt.claims;`:

```sql
-- ---------------------------------------------------------------------------
-- THE LEAK. create_invitation raises, in these words, "this e-mail already has
-- an account on the platform" -- to anybody who may invite. That is the
-- existence D17 says a Station must never learn, and it is live today.
--
-- The fix is not a quieter message. Under D17 a user belongs to the platform and
-- may be staff at any number of Stations, so inviting an address that already
-- has an account is an ORDINARY operation: make it succeed and there is no
-- differential left to leak.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.create_invitation(
    '00000000-0000-0000-0000-0000000078f1',
    'newcomer-p5b@example.test',
    false,
    '00000000-0000-0000-0000-0000000078e1',
    array['00000000-0000-0000-0000-0000000078c1']::uuid[],
    repeat('a', 64),
    7)
$$, 'inviting an address that already has an account succeeds, exactly as a new one does');

select is(
  (select count(*)::int from public.invitations
    where email = 'newcomer-p5b@example.test' and status = 'pending'),
  1,
  'and leaves an invitation, so the two cases are indistinguishable from outside');

-- And the gate descended with it: the Stations the invitation NAMES are the ones
-- the caller must be able to invite to.
select throws_ok($$
  select public.create_invitation(
    '00000000-0000-0000-0000-0000000078f1',
    'somebody-else-p5b@example.test',
    false,
    '00000000-0000-0000-0000-0000000078e1',
    array['00000000-0000-0000-0000-0000000078c2']::uuid[],
    repeat('b', 64),
    7)
$$, '42501', null,
   'and a Station''s owner cannot invite into the sister Station they do not own');

select is(
  (select count(*)::int from public.invitations
    where email = 'somebody-else-p5b@example.test'),
  0,
  'and that refusal wrote nothing');
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: the first assertion fails with `23505: this e-mail already has an
account on the platform` — the leak, quoted back. The third may pass already,
since a Station owner does not hold Organization-level `users.invite`.

- [ ] **Step 3: Write the migration**

Copy both functions forward and make three changes to `create_invitation`:

**The gate.** Replace
`has_org_permission('users.invite', p_organization_id)` with a test that the
caller may invite to **every Station named**, keeping the Organization test for an
owner invitation, which names none:

```sql
  -- P5b. AN INVITATION IS TO STATIONS, so the gate asks about those. An OWNER
  -- invitation names none -- 0018's own branch -- and stays an Organization-level
  -- act, which D19 leaves with the group.
  if p_is_owner then
    if not public.has_org_permission('users.invite', p_organization_id) then
      raise exception 'permission denied: users.invite required' using errcode = '42501';
    end if;
  elsif exists (
    select 1 from unnest(coalesce(p_company_ids, '{}')) as cid
     where not public.has_permission('users.invite', cid)
  ) or coalesce(array_length(p_company_ids, 1), 0) = 0 then
    raise exception 'permission denied: users.invite required' using errcode = '42501';
  end if;
```

**The leak.** Delete this, entirely:

```sql
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'this e-mail already has an account on the platform' using errcode = '23505';
  end if;
```

and put in its place:

```sql
  -- WHAT USED TO BE HERE was a raise reading "this e-mail already has an account
  -- on the platform", which told anybody who may invite whether an address
  -- exists -- across the whole platform, not merely across this group. D17 says
  -- a Station learns nothing about where else somebody works, and a refusal that
  -- names the reason is exactly that leak with a helpful tone.
  --
  -- IT IS NOT REPLACED BY A QUIETER REFUSAL. Under D17 a user belongs to the
  -- platform and may be staff at any number of Stations, in any number of
  -- Organizations, so inviting an address that already has an account is an
  -- ordinary thing to do rather than a mistake to catch. The operation succeeds
  -- for both, which leaves nothing to tell apart -- and 0283 makes acceptance
  -- tolerate a person who is already here, which is the other half of it.
```

**Then `revoke_invitation`**, which takes only `p_invitation_id`, so its gate
reads the Stations off the invitation itself:

```sql
  -- P5b. Revoking is the same authority as issuing, so it asks the same
  -- question of the same Stations -- read from the invitation rather than
  -- passed in, since this door takes only an id.
  if v_inv.is_owner then
    if not public.has_org_permission('users.invite', v_inv.organization_id) then
      raise exception 'permission denied: users.invite required' using errcode = '42501';
    end if;
  elsif exists (
    select 1 from public.invitation_companies ic
     where ic.invitation_id = v_inv.id
       and not public.has_permission('users.invite', ic.company_id)
  ) then
    raise exception 'permission denied: users.invite required' using errcode = '42501';
  end if;
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npm run db:reset && npm run db:test
```

Expected: `78_staffing_a_station` passes all 8.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0282_invitation_gates_descend.sql supabase/tests/78_staffing_a_station.test.sql
git commit -m "feat(p5b): the invitation door stops naming who already exists"
```

---

### Task 3: Acceptance tolerates a person already here

Task 2 makes the invitation possible; without this it is refused at the last
step, which would be the same leak arriving later.

**Files:**
- Create: `supabase/migrations/0283_accept_an_account_already_here.sql`
- Modify: `supabase/tests/78_staffing_a_station.test.sql`
- Read (do not modify): `supabase/migrations/0018_invitations_1c.sql` — `accept_invitation`

**Interfaces:**
- Preserves `accept_invitation(p_token_hash text, p_user_id uuid, p_full_name text)`.

- [ ] **Step 1: Write the failing test**

Raise the plan to `select plan(10);` and append:

```sql
-- Accepting as somebody ALREADY in this Organization and already at this
-- Station. Both inserts below were bare, so this raised 23505 -- the invitation
-- would be created and then refused at the last step, which is the same leak
-- arriving later and harder to read.
select lives_ok($$
  select public.accept_invitation(
    repeat('a', 64),
    '00000000-0000-0000-0000-0000000078a2',
    'Newcomer P5b')
$$, 'a person already in the group accepts without colliding with themselves');

select is(
  (select status::text from public.invitations
    where email = 'newcomer-p5b@example.test'),
  'accepted',
  'and the invitation is closed');
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: a unique violation from `organization_memberships`, because the person
is already a member of that Organization.

- [ ] **Step 3: Write the migration**

Copy `accept_invitation` forward and make both inserts conflict-tolerant:

```sql
  -- 0283. THE INVITATION CAN NOW REACH SOMEBODY ALREADY HERE, so acceptance has
  -- to survive meeting them. Both of these were bare inserts, correct while
  -- create_invitation refused an existing account (0018) and wrong the moment
  -- 0282 stopped -- the invitation would be created and then fail at the last
  -- step, which is the same existence leak arriving later and harder to read.
  insert into public.organization_memberships (user_id, organization_id, role)
  values (p_user_id, v_inv.organization_id,
          case when v_inv.is_owner then 'owner'::public.org_role else 'member'::public.org_role end)
  on conflict do nothing;
```

and the same `on conflict do nothing` on the `company_memberships` insert.

**And the comment above that insert is now false.** It reads *"An owner takes no
Company membership: they reach every Station by ownership"*, which `0280` ended —
every Organization owner is an owner of each of their Stations, and `add_company`
names them at creation. Replace it, and make an owner invitation do the same:

```sql
  -- An owner reaches every Station of the group, and since 0278 that is a row
  -- rather than a branch: add_company names the Organization's owners as owners
  -- of each Station it creates, and 0280 did it for every Station that already
  -- existed. An owner arriving by invitation gets the same, or they would be the
  -- one owner in the platform holding nothing.
  if v_inv.is_owner then
    insert into public.company_memberships (user_id, company_id, organization_id, is_owner)
    select p_user_id, c.id, v_inv.organization_id, true
      from public.companies c
     where c.organization_id = v_inv.organization_id
       and c.deleted_at is null
    on conflict do nothing;
  else
    insert into public.company_memberships (user_id, company_id, organization_id, role_id)
    select p_user_id, ic.company_id, v_inv.organization_id, v_inv.role_id
      from public.invitation_companies ic
      join public.companies c on c.id = ic.company_id and c.deleted_at is null
     where ic.invitation_id = v_inv.id
    on conflict do nothing;
  end if;
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npm run db:reset && npm run db:test
```

Expected: all 10.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0283_accept_an_account_already_here.sql supabase/tests/78_staffing_a_station.test.sql
git commit -m "feat(p5b): acceptance survives meeting somebody who is already here"
```

---

### Task 4: Every gate, and what the screens were relying on

- [ ] **Step 1: Run the full set** — the one in Global Constraints, all five, exit
      codes read directly and never through a pipe.

- [ ] **Step 2: Read what e2e says.** The invitation screen is the one to watch:
      it may show an "already has an account" error state that can no longer
      happen, and a Station owner may now see Stations in the invite checklist
      that `list_manageable_companies` did not previously offer them.

- [ ] **Step 3: Commit what it found, naming it in the subject line.**

---

## Closing checklist

- [ ] Full local gate set green, each exit code read directly.
- [ ] Each copied-forward function diffs to one hunk against its live source.
- [ ] `git diff main --stat` names only the three migrations, the new test file,
      and whatever Task 4 found.
- [ ] **The three migrations are applied to the hosted database after merge.**
      None writes business data.
- [ ] **Tell the owner that inviting an existing account now works**, in the PR.
      It is a behaviour customers will notice, and it is the point of the block.
