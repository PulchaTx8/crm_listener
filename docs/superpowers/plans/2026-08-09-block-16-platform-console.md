# Block 16 — The Platform Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the platform console into an **Organizations** screen and a **Stations** screen, give each an editable record, add blocking at both levels, and carry the Station's WhatsApp integration and API keys into its record.

**Architecture:** Two new routes under `/admin`, each a Server Component that reads everything its dialog will show — including, for the Stations screen, the profile and the keys of *every* Station in the selected Organization, which is affordable only because the list is filtered (spec §9). Blocking is a nullable timestamp on `organizations`, enforced in the two functions every access decision passes through.

**Tech Stack:** Next.js App Router, Supabase Postgres with plpgsql RPCs, Zod, Vitest, pgTAP, Playwright, next-intl.

**Design spec:** `docs/superpowers/specs/2026-08-09-block-16-platform-console-design.md`. Read it before Task 1; every `D<n>` below points into its §2.

---

## Global Constraints

- **Migrations are `0154`–`0158`.** The last existing is `0153_company_profile.sql`.
- **Branch is `block-16-platform-console`**, already created from `main` and already carrying `175b8b1` (the platform-admin runbook fix) and the spec.
- Every function is `SECURITY DEFINER` with `set search_path = pg_catalog, public`, every one gets an explicit `revoke execute … from public` before any `grant`, and console doors are granted to `authenticated` and gated on `is_platform_admin()`.
- **`update_*` doors write every field they take on every call, never merged.** Anything uploaded rather than typed — and anything that denies access — gets a writer of its own.
- Code, comments, commits and `docs/` in English. UI strings through next-intl in **all three** of `messages/en.json`, `messages/es.json`, `messages/pt.json`.
- **Never `git add -A`.** `scripts/seed-demo.mjs`, `.dockerignore` and `Manual/` carry the owner's uncommitted work. Every `git add` names files.
- **Verification:** `npm run typecheck`, `npm run lint`, `npm test`, `npx supabase db reset --local` then `npx supabase test db supabase/tests --local`, `npm run test:isolation`, `npm run test:e2e`.
- After any migration changing a signature, `npm run db:types`.
- The pgTAP runner takes a **positional path and `--local`**, not `--file`.
- In plpgsql, append to a `text[]` with `array_append`, never `|| 'literal'` — Postgres reads the literal as an array and fails with *malformed array literal*.
- A Supabase RPC parameter **without a SQL default is generated as required**; anything optional in the API needs `default null`, which forces it after the required ones in the signature.
- `.select('…')` must be **one literal string**; a concatenation collapses PostgREST's row type to `GenericStringError`.

---

## File Structure

**Database**

| File | Responsibility |
| --- | --- |
| `0154_organization_profile.sql` | `billing_entity` enum, `organizations`' 15 columns, CHECKs |
| `0155_company_contact_and_fiscal.sql` | `companies`' 12 columns, CHECKs, `update_company_profile` gains them |
| `0156_organization_blocking.sql` | `block_organization` / `unblock_organization`, and the two enforcement points |
| `0157_organization_doors.sql` | `provision_organization`, `update_organization`, `list_organizations`; drops `provision_customer` |
| `0158_console_helpers.sql` | `get_integration(company_id)`, `list_api_credentials_for(uuid[])` |

**Application**

| File | Responsibility |
| --- | --- |
| `src/lib/tax-id.ts` | CNPJ normalisation and display formatting |
| `src/services/organizations.ts` | provision, update, list, block, unblock |
| `src/services/company-profile.ts` | extended with the twelve new fields |
| `src/services/api-credentials.ts` | `listApiCredentialsFor(companyIds)` |
| `src/app/(admin)/admin/organizations/` | page, grid, record dialog, actions |
| `src/app/(admin)/admin/stations/` | page, grid with the combobox, record dialog, actions |
| `src/app/(admin)/admin/customers/` | **deleted**, replaced by a redirect |
| `src/app/(admin)/admin/integrations/` | **deleted**; its form moves into the Station record |
| `src/lib/record-params.ts` | `ORGANIZATION_TABS`, `STATION_TABS`; `CUSTOMER_TABS` removed |
| `src/lib/auth/shell.ts` | the three PLATAFORMA items |

**Tests**

| File | Responsibility |
| --- | --- |
| `supabase/tests/36_organization_profile.test.sql` | columns, CHECKs, the doors |
| `supabase/tests/37_organization_blocking.test.sql` | both enforcement points |
| `tests/unit/tax-id.test.ts` | the normaliser |
| `tests/isolation/organization-blocking.test.ts` | **the block's most important test** — the owner is locked out too |
| `tests/e2e/platform-console.spec.ts` | provision a group, add a Station, fill its record |

---

## Task 1: The Organization's own columns

**Files:**
- Create: `supabase/migrations/0154_organization_profile.sql`, `supabase/tests/36_organization_profile.test.sql`

**Interfaces:**
- Produces: `public.billing_entity` enum (`'ORGANIZATION'`, `'STATIONS'`); on `public.organizations` — `legal_name`, `tax_id`, `municipal_registration`, `fiscal_email`, `billing_entity` (not null, default `'STATIONS'`), `address_line`, `address_number`, `address_complement`, `neighbourhood`, `city`, `state`, `postal_code`, `suspended_at`, `suspended_by`, `suspension_reason`.

- [ ] **Step 1: Write the failing test**

`supabase/tests/36_organization_profile.test.sql`, `select plan(7);`

```sql
begin;
select plan(7);

select has_column('public', 'organizations', 'tax_id', 'an organization can carry a CNPJ');
select has_column('public', 'organizations', 'billing_entity', 'and say who issues the invoice');
select has_column('public', 'organizations', 'suspended_at', 'and be blocked');

-- D7: the default is what is true today. Nothing has ever been recorded at the
-- group level, so the group cannot be the emitter until somebody says so.
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000f1', 'Org profile');
select is(
  (select billing_entity::text from public.organizations
    where id = '00000000-0000-0000-0000-0000000000f1'),
  'STATIONS', 'a new organization invoices per station until told otherwise');

-- Fourteen digits and nothing else: punctuation is stripped before it arrives,
-- the way normalize_phone (0031) treats a telephone.
select throws_ok(
  $$update public.organizations set tax_id = '12.345.678/0001-99'
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  '23514', null, 'a CNPJ with punctuation is refused; it is normalised by the caller');

select lives_ok(
  $$update public.organizations set tax_id = '12345678000199'
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  'and fourteen digits are accepted');

-- The pair shape every archival column in this schema uses: a time and a
-- person, or neither.
select throws_ok(
  $$update public.organizations set suspended_at = now()
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  '23514', null, 'a block with no author is refused');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx supabase test db supabase/tests/36_organization_profile.test.sql --local`
Expected: FAIL — `column "tax_id" does not exist`.

- [ ] **Step 3: Write the migration**

`0154_organization_profile.sql`. The enum first, then one `alter table … add column` listing all fifteen, then the CHECKs:

- `organizations_tax_id_shape`: `tax_id is null or tax_id ~ '^[0-9]{14}$'`
- `organizations_block_shape`: `(suspended_at is null) = (suspended_by is null)`
- `organizations_fiscal_email_shape`: `fiscal_email is null or fiscal_email ~ '@'`

Carry these comments, because each records a decision the spec argues:

- On `billing_entity`: it says **who emits**, never who **has** — the Station keeps its own invoicing data whatever this says (D7), and a value here must never be read as permission to blank a column.
- On `tax_id`: fourteen digits, punctuation stripped by the caller. **The check digits are not verified** — that is a mod-11 calculation, it belongs in the application, and a well-formed-but-wrong CNPJ is a data-entry problem a human notices rather than a corruption the database must prevent.
- On `suspended_at`: a nullable timestamp rather than a second `status` enum. `companies` has one because it has since `0003`; a second enum with the same two values, named for the wrong table, would be a thing to keep in step for no gain.
- On the address: the same seven names `members` (0031) and `companies` (0153) already use, so there is not a third address shape in one database.

- [ ] **Step 4: Run the test and the whole suite**

Run: `npx supabase db reset --local && npx supabase test db supabase/tests --local`
Expected: `36_organization_profile` — 7 passing, everything else still green.

- [ ] **Step 5: Regenerate types and commit**

```bash
npm run db:types
git add supabase/migrations/0154_organization_profile.sql supabase/tests/36_organization_profile.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(console): an Organization gets an address, an invoicing identity and a lock"
```

---

## Task 2: The Station's contact and invoicing columns

**Files:**
- Create: `supabase/migrations/0155_company_contact_and_fiscal.sql`
- Modify: `supabase/tests/35_company_profile.test.sql` (raise the plan, append)

**Interfaces:**
- Produces: on `public.companies` — `contact_email`, `contact_phone`, `website_url`, `instagram_url`, `facebook_url`, `youtube_url`, `tagline`, `description`, `legal_name`, `tax_id`, `municipal_registration`, `fiscal_email`.
- `update_company_profile` gains all twelve, **after** its existing parameters and each with `default null`.

- [ ] **Step 1: Write the failing tests**

Append to `35_company_profile.test.sql`, raising `plan(9)` to `plan(12)`:

```sql
select has_column('public', 'companies', 'tax_id',
  'a station carries its own CNPJ, whatever the group''s selector says');
select has_column('public', 'companies', 'contact_email', 'and a contact address');

-- D7, the half that makes the design correct: the selector answers who EMITS,
-- never who HAS. A station's invoicing data is a fact about the station and
-- survives any setting on its group.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_organization'
      and 'p_company_tax_id' = any(p.proargnames)),
  0::bigint,
  'nothing on the organization door can reach into a station''s invoicing data');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx supabase test db supabase/tests/35_company_profile.test.sql --local`

- [ ] **Step 3: Write the migration**

`0155`. The twelve columns, `companies_tax_id_shape` mirroring `0154`'s, then **drop and recreate** `update_company_profile` with the twelve new trailing parameters.

**DROP + CREATE, never `create or replace`.** Twelve new parameters change the signature, and `create or replace` leaves Postgres holding both overloads with every eleven-argument caller silently resolving to the old body — the trap `0047`, `0055`, `0102` and `0138` each hit. Dropping resets the ACL, so restate the `revoke`/`grant` pair.

Keep `0153`'s body and add the twelve to the `SET` list and to the audit `before`/`after`. It still takes **no** `p_thumb_url`.

- [ ] **Step 4: Verify and commit**

```bash
npx supabase db reset --local && npx supabase test db supabase/tests --local
npm run db:types
git add supabase/migrations/0155_company_contact_and_fiscal.sql supabase/tests/35_company_profile.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(console): a Station gets contact details and an invoicing identity"
```

---

## Task 3: Blocking, and the owner's second door

**This is the task the block turns on. Do not compress it.**

**Files:**
- Create: `supabase/migrations/0156_organization_blocking.sql`, `supabase/tests/37_organization_blocking.test.sql`

**Interfaces:**
- Produces: `block_organization(p_organization_id uuid, p_reason text)`, `unblock_organization(p_organization_id uuid)`, both gated on `is_platform_admin()` and granted to `authenticated`.
- Modifies: `has_company_access_for(uuid, uuid)` and `is_owner_of_company_for(uuid, uuid)` — same signatures, `create or replace`.

- [ ] **Step 1: Audit every caller before writing anything**

```bash
grep -rn "is_owner_for\|is_owner_of_company" supabase/migrations/*.sql | grep -v "^.*create or replace function"
```

For **each** hit, write one line in the migration's header comment saying whether it sits behind `has_company_access` (covered) or reaches a row directly (needs the condition). This list goes in the block's report. *"We think we got them all"* is not a proof, and this grep is the proof.

- [ ] **Step 2: Write the failing test**

`37_organization_blocking.test.sql`. pgTAP runs as superuser with a null `auth.uid()`, so it can prove the **shape** — that both functions mention `organizations` — and the doors' gate. The behaviour is Task 12's isolation test.

```sql
begin;
select plan(6);

select has_function('public', 'block_organization', array['uuid','text'], 'the block door exists');
select has_function('public', 'unblock_organization', array['uuid'], 'and its reverse');

-- Both doors, not one. A block written only into has_company_access_for stops
-- the staff and lets the OWNER through — the one person a blocked group most
-- needs to stop — because is_owner_of_company_for checks no status at all.
select ok(
  (select prosrc like '%organizations%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'has_company_access_for'),
  'access through a membership consults the organization');

select ok(
  (select prosrc like '%organizations%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_owner_of_company_for'
      and pronargs = 2),
  'and so does the owner''s own door');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000f2', 'Org blocking');

-- No session, so is_platform_admin() is false.
select throws_ok(
  $$select public.block_organization('00000000-0000-0000-0000-0000000000f2', 'nope')$$,
  '42501', null, 'blocking a group requires the platform admin');
select throws_ok(
  $$select public.unblock_organization('00000000-0000-0000-0000-0000000000f2')$$,
  '42501', null, 'and so does releasing one');

select * from finish();
rollback;
```

- [ ] **Step 3: Run it and watch it fail**

- [ ] **Step 4: Write the migration**

`0156`. Restate both access functions with the organization condition, and write the two doors.

```sql
create or replace function public.has_company_access_for(p_user_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.companies c
    -- Block 16, D5. The group's lock, applied to EVERY caller including the
    -- platform admin, exactly as the Station's own `status` already is.
    join public.organizations o
      on o.id = c.organization_id
     and o.suspended_at is null
    where c.id = p_company_id
      and c.status = 'active'
      and c.deleted_at is null
      and (
        public.is_platform_admin_for(p_user_id)
        or public.is_owner_for(p_user_id, c.organization_id)
        or exists (
          select 1 from public.company_memberships cm
          where cm.user_id = p_user_id
            and cm.company_id = c.id
            and cm.deleted_at is null
        )
      )
  );
$$;

-- THE SECOND DOOR, and the one an implementer misses. 0044's policies admit the
-- owner through this to rows everyone else is denied — an archived promotion,
-- for one — and it has never checked a status of any kind. Without the same
-- condition here, blocking a group stops the staff and leaves the owner
-- browsing.
create or replace function public.is_owner_of_company_for(p_user_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_platform_admin_for(p_user_id)
      or exists (
        select 1
        from public.companies c
        join public.organizations o
          on o.id = c.organization_id and o.suspended_at is null
        where c.id = p_company_id
          and public.is_owner_for(p_user_id, c.organization_id)
      );
$$;
```

`block_organization` takes the reason, stamps `suspended_at`/`suspended_by`, and writes an audit row naming the organization. `unblock_organization` clears all three. Both refuse a non-admin **before** reading anything, and both are silent about a group already in the state asked for — a console that double-submits must not produce an error somebody investigates.

- [ ] **Step 5: Verify and commit**

```bash
npx supabase db reset --local && npx supabase test db supabase/tests --local
npm run db:types
git add supabase/migrations/0156_organization_blocking.sql supabase/tests/37_organization_blocking.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(console): blocking a group locks its staff and its owner alike"
```

---

## Task 4: The Organization's doors

**Files:**
- Create: `supabase/migrations/0157_organization_doors.sql`
- Modify: `supabase/tests/36_organization_profile.test.sql` (raise the plan, append)

**Interfaces:**
- Produces:
  - `provision_organization(p_user_id uuid, p_organization_name text) returns uuid`
  - `update_organization(p_organization_id uuid, p_name text, p_legal_name text default null, p_tax_id text default null, p_municipal_registration text default null, p_fiscal_email text default null, p_billing_entity public.billing_entity default 'STATIONS', p_address_line text default null, p_address_number text default null, p_address_complement text default null, p_neighbourhood text default null, p_city text default null, p_state text default null, p_postal_code text default null) returns void`
  - `list_organizations() returns table (id uuid, name text, station_count bigint, station_names text, owner_email text, suspended_at timestamptz, suspension_reason text, created_at timestamptz)`
- Drops: `provision_customer(uuid, text, text, text)`.

- [ ] **Step 1: Write the failing tests** — that `provision_organization` creates an Organization and **no** Company (D1), that `update_organization` refuses a non-admin, and that `provision_customer` is gone.

```sql
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'provision_customer'),
  0::bigint,
  'the old two-in-one provisioning door is gone, not left beside its replacement');
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Write the migration**

`provision_organization` is `provision_customer`'s body minus the `companies` insert. Keep the profile update (`must_change_password`, seven-day expiry) and the audit row; the audit's `company_id` becomes null, which `audit_logs` allows.

`list_organizations` returns the owner by joining `organization_memberships` on `role = 'owner'` and `profiles` for the e-mail, and the Station count and names from live `companies`.

**Drop `provision_customer` in this same file**, with a comment: two provisioning doors where one creates a Station and one does not is a coin-flip waiting to be got wrong.

- [ ] **Step 4: Verify and commit**

```bash
npx supabase db reset --local && npx supabase test db supabase/tests --local
npm run db:types
git add supabase/migrations/0157_organization_doors.sql supabase/tests/36_organization_profile.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(console): provision, rename and list Organizations"
```

---

## Task 5: The two console helpers

**Files:**
- Create: `supabase/migrations/0158_console_helpers.sql`

**Interfaces:**
- `get_integration(p_company_id uuid)` — `list_integrations`' single-Company sibling, same columns.
- `list_api_credentials_for(p_company_ids uuid[])` — `list_api_credentials`' bulk sibling, same columns plus `company_id`, so the Stations screen reads every listed Station's keys in **one** query rather than one per row (spec §9).

Both gated on `is_platform_admin()`, granted to `authenticated`.

- [ ] **Step 1–4:** test → fail → write → verify → commit, as above.

```bash
git commit -m "feat(console): read one Station's integration, and many Stations' keys, in one call"
```

---

## Task 6: The CNPJ normaliser

**Files:**
- Create: `src/lib/tax-id.ts`, `tests/unit/tax-id.test.ts`

**Interfaces:**
- `normaliseTaxId(typed: string): string | null` — digits only; null for blank; null for anything that is not exactly fourteen digits after stripping.
- `formatTaxId(stored: string | null): string` — `12.345.678/0001-99`, or `''`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { formatTaxId, normaliseTaxId } from '@/lib/tax-id';

describe('normaliseTaxId', () => {
  it('strips the punctuation people actually type', () => {
    expect(normaliseTaxId('12.345.678/0001-99')).toBe('12345678000199');
  });
  it('accepts digits already bare', () => {
    expect(normaliseTaxId('12345678000199')).toBe('12345678000199');
  });
  it('reads a blank as absent rather than as empty string', () => {
    expect(normaliseTaxId('   ')).toBeNull();
  });
  it('refuses the wrong number of digits rather than storing a stub', () => {
    // organizations_tax_id_shape would refuse it anyway, with a constraint name
    // where the operator needs a sentence.
    expect(normaliseTaxId('123')).toBeNull();
  });
  it('does NOT verify the check digits', () => {
    // Deliberate (spec §6.1): a well-formed but wrong CNPJ is a data-entry
    // problem a human notices, not a corruption the database must prevent.
    expect(normaliseTaxId('00000000000000')).toBe('00000000000000');
  });
});

describe('formatTaxId', () => {
  it('renders what a person recognises', () => {
    expect(formatTaxId('12345678000199')).toBe('12.345.678/0001-99');
  });
  it('renders nothing for nothing', () => {
    expect(formatTaxId(null)).toBe('');
  });
});
```

- [ ] **Step 2–5:** run → fail → implement → pass → commit.

```bash
git commit -m "feat(console): one place that knows how a CNPJ is stored and shown"
```

---

## Task 7: The services

**Files:**
- Create: `src/services/organizations.ts`
- Modify: `src/services/company-profile.ts`, `src/services/api-credentials.ts`

**Interfaces:**
- `provisionOrganization({ name, ownerEmail, ownerName }, accessToken): Promise<{ organizationId, email, password }>` — creates the auth user and its `profiles` row first, exactly as `services/provisioning.ts` does today, then calls the RPC.
- `updateOrganization(input, accessToken): Promise<void>`
- `listOrganizations(accessToken): Promise<OrganizationRow[]>`
- `blockOrganization(id, reason, accessToken)` / `unblockOrganization(id, accessToken)`
- `listApiCredentialsFor(companyIds: string[], accessToken): Promise<Map<string, ApiCredentialRow[]>>`
- `CompanyProfileInput` gains the twelve fields of Task 2.

Each maps `42501` to `UnauthorizedError`, `P0002` to `NotFoundError`, `22023`/`23514` to `ValidationError`, everything else to `InternalError`.

- [ ] **Steps:** typecheck after each file; commit once all three compile.

```bash
git commit -m "feat(console): services for Organizations, and the Station profile's new fields"
```

---

## Task 8: The tab vocabulary

**Files:** `src/lib/record-params.ts`

- [ ] Replace `CUSTOMER_TABS` with:

```ts
export const ORGANIZATION_TABS = ['data', 'owner', 'stations'] as const;
export type OrganizationTab = (typeof ORGANIZATION_TABS)[number];

export const STATION_TABS = ['data', 'whatsapp', 'keys'] as const;
export type StationTab = (typeof STATION_TABS)[number];
```

First element is the tab a record opens on and the fallback for an unknown `tab=`; append, never insert.

Removing `CUSTOMER_TABS` breaks `customers/page.tsx` and `customers-grid.tsx` — expected, and Task 11 deletes both. Until then `npm run typecheck` fails, so **do not commit this task alone**; fold it into Task 9's commit.

---

## Task 9: The Organizations screen

**Files:** `src/app/(admin)/admin/organizations/{page,organizations-grid,organization-record-dialog,actions}.tsx`

- [ ] The page reads `list_organizations()` and passes the whole list down. There is no keyset paging: the platform has tens of Organizations, not thousands, and the screen that had paging was listing Stations.
- [ ] The record's three tabs per D2 — **Dados** (name, invoicing block, emitter selector, Bloquear with a reason), **Proprietário** (e-mail, and the provisional-password button moved from the old customer record), **Emissoras** (read-only, each linking to `/admin/stations?organization=<id>`).
- [ ] **Everything the dialog shows comes from the page's own read.** Nothing is fetched on open — `use-record-dialog.ts` changes the URL without a server round trip, and Block 15's form failed precisely by forgetting that (spec §9).
- [ ] Blocking asks for a reason and states in words what it is about to do: the group **and every Station under it**, owner included.

```bash
git commit -m "feat(console): the Organizations screen, and a record that can be renamed"
```

---

## Task 10: The Stations screen

**Files:** `src/app/(admin)/admin/stations/{page,stations-grid,station-record-dialog,actions}.tsx`

- [ ] `?organization=<id>` selects the group; the combobox writes it with a real navigation, so the server re-reads. Nothing is listed until one is chosen.
- [ ] For the selected Organization, the page reads **in one pass**: the Stations, each one's profile columns, `list_api_credentials_for` over all of them, and `get_integration` per Station. Affordable because the list is three or four rows (D3).
- [ ] The record's three tabs per D4 — **Dados da Emissora** (Block 15's fields plus Task 2's twelve), **Integração WhatsApp** (the form lifted from `admin/integrations`), **API Keys** (Block 15's tab).
- [ ] The row menu keeps Bloquear/Desbloquear, which is today's suspend/reactivate relabelled (D5.1).

```bash
git commit -m "feat(console): the Stations screen, filtered by Organization"
```

---

## Task 11: Navigation, and the two screens that go

**Files:** `src/lib/auth/shell.ts`; delete `src/app/(admin)/admin/customers/` and `src/app/(admin)/admin/integrations/`; add `src/app/(admin)/admin/customers/page.tsx` as a redirect.

- [ ] PLATAFORMA becomes exactly `Organizações`, `Emissoras`, `Pedidos de contato`.
- [ ] `/admin/customers` → `redirect('/admin/organizations')`, so a bookmarked address lands somewhere sensible.
- [ ] Delete both old directories **after** confirming every export they held has a new home. `credential-forms.tsx` holds the provisional-password form — that moves to the Organization record, it does not die.

```bash
npm run typecheck && npm run lint
git commit -m "feat(console): three items under PLATAFORMA, and two screens retired"
```

---

## Task 12: The proof that matters

**Files:** `tests/isolation/organization-blocking.test.ts`; register it in `scripts/verify-isolation-suite.mjs` with `minTests`.

- [ ] Provision a group with **two** Stations, an owner, and a member holding a role.
- [ ] Assert both reach their Stations.
- [ ] Block the group.
- [ ] Assert **both** are now refused — the member through `has_company_access`, **the owner through `is_owner_of_company`**. A version of this test that checks only the member passes against the exact defect D5 warns about.
- [ ] Assert the second Station is refused too, not just the one tested.
- [ ] Unblock; assert both are back.

```bash
npm run test:isolation
git commit -m "test(console): blocking a group refuses its owner, not only its staff"
```

> The isolation suite intermittently dies with `Worker exited unexpectedly`. It is a known flake with no established cause; re-run once. A second identical failure is a real failure.

---

## Task 13: Translations, documentation, and the sweep

- [ ] Every new string into the `admin` namespace of `messages/en.json`, `messages/es.json`, `messages/pt.json`.
- [ ] `docs/PERMISSIONS.md`: blocking at both levels and the two enforcement points. `docs/DATABASE.md`: the twenty-seven columns and the new doors. The block report with the `is_owner_*` audit from Task 3 Step 1.
- [ ] Full sweep:

```bash
npm run typecheck && npm run lint && npm test
npx supabase db reset --local && npx supabase test db supabase/tests --local
npm run test:isolation && npm run test:e2e
git status --short   # expect only the owner's own uncommitted files
```

```bash
git commit -m "docs: the console split, and where a block is enforced"
git push -u origin block-16-platform-console
```

---

## Self-Review Notes

**Spec coverage.** D1 → Task 4; D2 → Task 9; D3 → Task 10; D4 → Task 10; D5/D5.1 → Tasks 3, 10, 12; D6 → Task 11; D7 → Tasks 1, 2; D8 → Tasks 1, 2; D9 → nothing, deliberately — it is a decision *not* to build invoicing. Spec §9's defect is closed by Tasks 9 and 10 loading eagerly.

**Where this plan gives instructions rather than code.** Tasks 9, 10 and 11 describe components instead of transcribing them: they follow `customers-grid.tsx`, `customer-record-dialog.tsx` and `integration-form.tsx` closely enough that a stale transcription here would be worse than reading the originals. Task 3, which is the one that can be silently wrong, carries its SQL in full.

**Ordering constraints.** Task 8 breaks the build on its own and must be committed with Task 9. Task 11 must not delete `admin/customers/` until `credential-forms.tsx` has moved. Task 3 must follow Task 1, which creates the column it enforces.
