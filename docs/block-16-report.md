# Block 16 — The Platform Console — Verification Report

**Branch:** `block-16-platform-console`, from `main` (`386cdc5`).
**Five migrations, `0154`–`0158`.** PR base is `main`.

---

## 1. What shipped

The console had **one screen for two records**. `/admin/customers` listed
`companies` and called them customers, so four rows could equally mean four
customers or one customer with four radios, with no way to tell from the screen.
The owner found this on 2026-08-09, looking at four rows.

It is now two screens:

- **`/admin/organizations`** — the customer groups. Each has a record with three
  tabs: its own data (name, invoicing identity, address, who issues the invoice),
  its owner (with the reissue-password button), and its Stations.
- **`/admin/stations`** — the radios of **one** group, chosen with a combobox.
  Each has a record with three tabs: the Station's data, its WhatsApp
  integration, and its API keys.

**`/admin/integrations` is gone.** It was a list of every Station on the platform
with a card each — a Stations screen wearing another name, and the second one
this console had. Its form is now the WhatsApp tab of the Station it configures,
and the installation-credentials panel went with it.

**Blocking works at both levels.** `suspend_company` stops one radio;
`block_organization` stops the customer — every Station, every member, and the
owner.

`/admin/customers` redirects to `/admin/organizations`: a platform admin has had
it bookmarked since Block 1c, and a 404 is a worse answer than the screen that
replaced it.

---

## 2. The audit that decided the block's design

`0156` was not written until this had been run:

```bash
grep -rn "is_owner_for(\|is_owner_of_company\|public.is_owner(" supabase/migrations
```

The spec predicted **two** shapes. It found **three**, and the third changed the
implementation:

| # | shape | where | covered by |
| --- | --- | --- | --- |
| 1 | `has_company_access_for` | `0121`; every `has_permission_for` ANDs it | the condition, restated |
| 2 | `is_owner_of_company_for` | `0121`; read by `0051`, `0090`, `0095`, `0096`, `0120`, `0124`, `0125` | inherited — it calls `is_owner_for` |
| 3 | **`public.is_owner(organization_id)`, called directly by more than twenty policies** | `0006`, `0015`, `0016`, `0021`, `0024`, `0032`, `0033`, `0035` (**four times, on `members`**), `0036`, `0044` onward | the condition, in `is_owner_for` |

Shape 3 is why the plan's approach would have been incomplete. `members` is
Organization-scoped, so its four policies never touch `has_company_access` at
all — a block written only into (1) and (2) would have left a blocked group's
owner reading and writing its **entire audience**.

So the condition went into `is_owner_for`, and all twenty obey without being
edited. That is the only version of this change that is not a list somebody has
to keep complete by hand.

**What it cost, stated rather than discovered.** `is_owner_for` stopped being a
pure predicate: it used to mean *"does this person own this Organization"* and
now means *"…and is the Organization usable"*. `has_company_access_for` has had
exactly that shape since `0121`, so this is the house's existing trade rather
than a new one. The one caller that needs the pure question keeps it, by name:
`is_owner_including_blocked`, with exactly one caller
(`companies_select_org_member`) and a comment saying it must stay that way.

---

## 3. The proof that matters, measured by mutation

`tests/isolation/organization-blocking.test.ts`, four cases, registered in
`scripts/verify-isolation-suite.mjs` with `minTests: 4`.

Every access assertion is made **twice**, once as the owner and once as the
staff. A version that checks only the staff **passes against the exact defect
D5 warns about**.

That is not an argument; it was measured. Reverting `is_owner_for` to its
pre-`0156` body and re-running the file:

```
× refuses the owner and the staff alike, across every Station, and releases both
  AssertionError: expected true to be false
  tests/isolation/organization-blocking.test.ts:97
```

Line 97 is `expect(await ownsCompany(ownerClient, customer.companyId)).toBe(false)` —
the owner's own door.

**The asymmetry that mutation exposed, and the reason the owner's door is
asserted separately rather than assumed to follow from access:** lines 95–96,
which check `has_company_access` for the same owner, **still passed** under the
mutation. `has_company_access_for` states the lock a second time inside its
non-admin branch, so the membership path survives a broken `is_owner_for` and
the ownership path does not. A test that checked only "can the owner reach the
Station" would have been green against a build where the owner could still read
every archived promotion and the whole audience.

The database was restored with `npx supabase db reset --local` and the full
suite re-run green before anything was committed.

---

## 4. Where the implementation departed from the plan, and why

**`list_organizations` returns more than the plan specified.** The plan gave it
eight columns (`id, name, station_count, station_names, owner_email,
suspended_at, suspension_reason, created_at`). That set cannot render the screen
the same plan describes: the record's Data tab needs the invoicing identity and
the address, the Owner tab needs the owner's **user id** for the reissue button,
and the Stations tab needs each Station's **id** to link to
`/admin/stations?organization=…`, which a joined `station_names` string cannot
provide. It returns the whole record plus `owner_user_id`, and the page reads
the Stations in one query of its own.

**Task 2 was skipped by the previous session and picked up here.** Migration
`0155` was left unallocated and `0156` written next; the slot was filled rather
than renumbered.

**The e2e surface was larger than the plan foresaw.** Dropping
`provision_customer` broke **eight** specs calling it directly and **fourteen**
driving the retired console. Two helpers absorbed that:
`tests/e2e/provision.ts` exports `provisionCustomer` (RPC fixture, two calls
where there was one) and `provisionThroughConsole` (the real journey, two screens
where there was one). The isolation harness kept the name `provisionCustomer`
and changed only its body, so its ~200 call sites are untouched.

**The installation-credentials panel was rescued.** Deleting
`/admin/integrations` would have taken with it the three-boolean panel its own
comment called *"the most useful row on the screen"*. It moved to the WhatsApp
tab, repeated per Station deliberately: the person asking *"why does this radio
receive no messages"* is looking at one radio, and *"the access token is not
set"* is half the answers.

---

## 5. Decisions worth keeping

**A block is its own door, not a field on `update_organization`.** That function
writes every field it takes on every call, so a lock on its list could be set or
cleared by omission. Same reasoning as `set_company_thumb` (`0153`).

**A reason is required.** This is the heaviest control in the console — it denies
the owner and every member across every Station at once — and somebody will be
asked why, possibly months later. `organizations_block_shape` already refuses a
block with no author; the reason is the same argument one field over.

**Blocking twice is silent.** A console that double-submits must not produce an
error somebody investigates, and blocking an already-blocked group is not a
failure by any reading.

**`billing_entity` says who EMITS, never who HAS.** Each Station keeps its own
*razão social* and CNPJ whatever the group's selector says.
`35_company_profile.test.sql` asserts that no parameter on the Organization door
can reach a Station's invoicing data.

**The CNPJ check digits are deliberately not verified.** Refusing a number an
operator read correctly off a contract that carries its own typo is a support
call, not a saved record.

---

## 6. Verification

| gate | result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | no warnings or errors |
| `npm test` | 86 files, 1029 cases |
| `npx supabase db reset --local && npx supabase test db supabase/tests --local` | 40 files, 1556 cases |
| `npm run test:isolation` | 32 files, 309 cases; every file above its floor |
| `npm run test:e2e` | see §7 |
| `npm run build` | clean |

New pgTAP: `38_console_helpers.test.sql` (11). Extended:
`35_company_profile.test.sql` (9→12), `36_organization_profile.test.sql` (7→26),
`01_identity.test.sql` (the anon-reachability assertion now names
`provision_organization`).

New unit: `tests/unit/tax-id.test.ts` (9).

---

## 7. Open items

None outstanding at the time of writing beyond the e2e run recorded in the PR.
