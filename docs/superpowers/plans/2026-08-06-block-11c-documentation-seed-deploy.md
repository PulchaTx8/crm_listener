# Block 11c — The Documents, the Seed, the Journey and the Proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the five documents that describe the system as it stands, a demo seed that is a script rather than a fixture, the §35 acceptance journey the master spec calls the definition of done, and proof that the deploy and the backup actually work.

**Architecture:** Nothing here changes product behaviour and there are no migrations. The seed drives the same RPCs the e2e fixtures drive, signed in as the users it creates, so it exercises the real permission path. The acceptance journey drives screens only. The documents live beside the forty-two block reports and point into them for history.

**Tech Stack:** Node ESM scripts, Playwright, Supabase CLI, Docker.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-06-block-11c-documentation-seed-deploy-design.md`. Decisions cited as D1–D7.
- **Branch:** `block-11c`, already created from `block-11b`. **PR base is `main`** — #31 will have merged by then, and a base on a merged branch fails with a 404.
- **No migrations. No new product behaviour.**
- **Language:** all code, comments, documents and commit messages in English.
- **`npm run db:test` needs a freshly reset database**; after an e2e or isolation run `15_music_rpcs` fails with "more than one row returned by a subquery" and that is not a regression.
- **`supabase db reset` leaves Kong blind** — every auth call answers `createUser failed: {}` until `docker restart supabase_kong_CRM_-_LISTENER`.
- **Never edit files under `src/` while a Playwright run is in progress**: the dev server recompiles on each write and drops whatever test is mid-flight. Block 11b lost a run to this.

---

## File Structure

**Created:**
- `scripts/seed-demo.mjs` — the demo seed, and the only thing that writes demo data.
- `src/lib/security/local-only.ts` — the guard that refuses a non-local Supabase URL. In `src/` rather than beside the script so it is reachable by the unit suite.
- `tests/unit/security/local-only.test.ts`
- `tests/e2e/acceptance.spec.ts` — §35, end to end, through the screens.
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DATABASE.md`, `docs/PERMISSIONS.md`, `docs/DEPLOYMENT.md`
- `docs/block-11c-report.md`

**Modified:**
- `package.json` — one script, `seed:demo`.
- `README.md` — the front door (D7).

---

## Task 1: The guard that keeps the seed off a customer's database

**Files:**
- Create: `src/lib/security/local-only.ts`, `tests/unit/security/local-only.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `assertLocalSupabase(url: string | undefined): void` — throws with a readable message unless the URL points at a local stack.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/security/local-only.test.ts
import { describe, expect, it } from 'vitest';
import { assertLocalSupabase } from '@/lib/security/local-only';

describe('the local-only guard', () => {
  it.each([
    'http://127.0.0.1:54321',
    'http://localhost:54321',
    'http://127.0.0.1:54321/',
  ])('allows %s', (url) => {
    expect(() => assertLocalSupabase(url)).not.toThrow();
  });

  it('refuses a hosted project by name', () => {
    // The whole point. A demo Station inside a customer's database is damage
    // nobody undoes, and the seed is the one script that writes fake data.
    expect(() => assertLocalSupabase('https://djbkdyesubkedxjwcohq.supabase.co')).toThrow(
      /local/i,
    );
  });

  it('refuses an unset url rather than guessing', () => {
    expect(() => assertLocalSupabase(undefined)).toThrow();
  });

  it('is not fooled by a hosted host that merely mentions localhost', () => {
    // Substring matching would pass this. It is a real hostname somebody can buy.
    expect(() => assertLocalSupabase('https://localhost.evil.example')).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/security/local-only.test.ts`
Expected: FAIL — `Cannot find module '@/lib/security/local-only'`.

- [ ] **Step 3: Write the guard**

```ts
// src/lib/security/local-only.ts

/**
 * Block 11c, D2. Refuses to let a script touch anything but a local stack.
 *
 * `scripts/seed-demo.mjs` is the only thing in this repository that writes
 * invented data, and the environment it reads (`.env`) names the HOSTED project
 * on the maintainer's machine. One forgotten variable is the difference between
 * a demo Station and a demo Station inside a customer's database.
 *
 * Matching is on the parsed HOSTNAME, never on a substring: `localhost.evil.example`
 * contains "localhost" and is somebody else's server.
 */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertLocalSupabase(url: string | undefined): void {
  if (!url) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is not set. This script only ever runs against a local Supabase stack.',
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`NEXT_PUBLIC_SUPABASE_URL is not a URL: ${url}`);
  }

  if (!LOCAL_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Refusing to run against ${hostname}. This script writes demo data and only ever runs against a local Supabase stack — start one with \`npx supabase start\` and point NEXT_PUBLIC_SUPABASE_URL at it.`,
    );
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/security/local-only.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/security/local-only.ts tests/unit/security/local-only.test.ts
git commit -m "feat(seed): refuse to write demo data anywhere but a local stack"
```

---

## Task 2: The demo seed

**Files:**
- Create: `scripts/seed-demo.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `assertLocalSupabase` from Task 1.
- Produces: `npm run seed:demo`, printing a summary of what exists afterwards.

**Read first:** `tests/e2e/delivery-flow.spec.ts` lines 1–120. Its fixture block
already performs this exact sequence — bootstrap a platform admin, provision a
customer, sign in as the owner, build a catalogue, run a draw — and this script
is that sequence with nicer names and no assertions. **Copy its shape rather than
inventing a second way to do the same thing.**

**The one thing that catches everybody:** the RPCs are permission-gated on
`auth.uid()`, so calling them with the service key gets a refusal, not a
shortcut. The service key is used for exactly three things — creating auth
users, the `platform_admins` insert that no client may write (`0006`), and
clearing `must_change_password` so the seeded owner can be signed in without
the change-password screen. Everything else runs on a signed-in session.

- [ ] **Step 1: Write the script**

```js
// scripts/seed-demo.mjs
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from '../src/lib/security/local-only.ts';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../tests/local-supabase.ts';

/**
 * Block 11c, D2. A demo Station with the whole cycle already visible.
 *
 * NOT `supabase/seed.sql`, deliberately: that file runs on every `db reset`,
 * which is what 1397 pgTAP assertions and 44 journeys start from. Putting rows
 * in front of them turns a demo convenience into a week of red suites whose
 * failures look like regressions in whatever block does the counting.
 *
 * Idempotent by Organization name: run it twice and nothing duplicates.
 */
// Defaults to the local stack rather than to `.env`, which on the maintainer's
// machine names the HOSTED project -- `npm run seed:demo` with no ceremony is
// the entire point, and reading .env by default would make the guard below the
// only thing standing between a demo and a customer's database. The constants
// come from tests/local-supabase.ts so there is one definition of "local", not
// two that drift.
const URL = process.env.SEED_SUPABASE_URL ?? LOCAL_SUPABASE_URL;
const SERVICE_KEY = process.env.SEED_SERVICE_ROLE_KEY ?? LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SEED_ANON_KEY ?? LOCAL_SUPABASE_ANON_KEY;

// Applied to whatever it ended up with, override or default.
assertLocalSupabase(URL);

const ORGANIZATION = 'Demo Broadcasting';
const STATION = 'Demo FM';
const SECOND_STATION = 'Demo AM';
const ADMIN_EMAIL = 'admin@demo.test';
const OWNER_EMAIL = 'owner@demo.test';
const PASSWORD = 'Demo-password-1';

const admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

async function main() {
  const existing = await admin
    .from('organizations')
    .select('id')
    .eq('name', ORGANIZATION)
    .maybeSingle();
  if (existing.data) {
    console.log(`"${ORGANIZATION}" is already seeded. Nothing to do.`);
    await summarise(existing.data.id);
    return;
  }

  // 1. The platform admin. `platform_admins` accepts no client write (0006),
  // so this insert is the one the service key exists for.
  const adminUser = await createUser(ADMIN_EMAIL);
  const promoted = await admin.from('platform_admins').insert({ user_id: adminUser });
  if (promoted.error) throw new Error(`platform_admins insert: ${promoted.error.message}`);

  // 2. The customer, provisioned exactly as the console provisions one --
  // signed in as the admin, because provision_customer re-checks
  // is_platform_admin() against auth.uid() and the service key has none.
  const adminSession = await signIn(ADMIN_EMAIL);
  const ownerUser = await createUser(OWNER_EMAIL);
  const provisioned = await adminSession.rpc('provision_customer', {
    p_user_id: ownerUser,
    p_organization_name: ORGANIZATION,
    p_company_name: STATION,
    p_timezone: 'America/Sao_Paulo',
  });
  if (provisioned.error) throw new Error(`provision_customer: ${provisioned.error.message}`);
  const organizationId = provisioned.data.organization_id;
  const companyId = provisioned.data.company_id;

  // 3. A second Station, through the same RPC the console's AddStationForm
  // uses -- platform-admin only, which is why it runs on the admin session.
  const second = await adminSession.rpc('add_company', {
    p_organization_id: organizationId,
    p_name: SECOND_STATION,
    p_timezone: 'America/Sao_Paulo',
  });
  if (second.error) throw new Error(`add_company: ${second.error.message}`);

  // 4. The owner's provisional password expires and the middleware forces a
  // change before any screen. Cleared here so `npm run dev` opens straight
  // onto a full screen, which is the entire point of a demo seed.
  const cleared = await admin
    .from('profiles')
    .update({ must_change_password: false, provisional_expires_at: null })
    .eq('id', ownerUser);
  if (cleared.error) throw new Error(`clearing the provisional flag: ${cleared.error.message}`);

  const owner = await signIn(OWNER_EMAIL);

  // 5. Prizes and stock.
  const prize = await rpc(owner, 'create_prize', {
    p_company_id: companyId,
    p_name: 'Pair of tickets, Saturday show',
    p_allows_return_to_stock: true,
  });
  await rpc(owner, 'record_stock_entry', {
    p_company_id: companyId,
    p_prize_id: prize,
    p_type: 'ENTRY',
    p_quantity: 20,
    p_note: 'Demo seed',
  });

  // 6. A promotion running now, with the prize committed to it.
  const promotion = await rpc(owner, 'create_promotion', {
    p_company_id: companyId,
    p_name: 'Demo promotion — Saturday show',
    p_starts_at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    p_ends_at: new Date(Date.now() + 21 * 86_400_000).toISOString(),
    p_call_to_action: 'Send your name to take part',
  });
  await rpc(owner, 'link_prize_to_promotion', {
    p_promotion_id: promotion,
    p_prize_id: prize,
    p_quantity: 5,
  });

  // 7. Listeners and their entries. Enough that a list looks like a list.
  const names = [
    'Ana Beatriz Ferreira', 'Carlos Eduardo Lima', 'Débora Nunes',
    'Eduardo Prado', 'Fernanda Rocha', 'Gustavo Aparecido',
    'Helena Castro', 'Igor Menezes', 'Juliana Assis', 'Kléber Tavares',
  ];
  for (const [index, fullName] of names.entries()) {
    const memberId = await rpc(owner, 'create_member', {
      p_company_id: companyId,
      p_full_name: fullName,
      p_phone: `+55119${String(80000000 + index).padStart(8, '0')}`,
    });
    await rpc(owner, 'record_participation', {
      p_promotion_id: promotion,
      p_member_id: memberId,
      p_participated_at: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
      p_source: 'MANUAL',
    });
  }

  // 8. A draw that has run, so the screens open on an outcome rather than on
  // an empty state.
  const drawn = await owner.rpc('run_draw', { p_promotion_id: promotion });
  if (drawn.error) throw new Error(`run_draw: ${drawn.error.message}`);

  await summarise(organizationId);
  console.log(`\nSign in at http://localhost:3000/login as ${OWNER_EMAIL} / ${PASSWORD}`);
  console.log(`The console is at /admin as ${ADMIN_EMAIL} / ${PASSWORD}`);
}

async function createUser(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message ?? 'no user'}`);
  return data.user.id;
}

async function signIn(email) {
  const client = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

/** Calls an RPC that returns an id, and fails loudly rather than returning undefined. */
async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function summarise(organizationId) {
  const companies = await admin
    .from('companies')
    .select('id, name')
    .eq('organization_id', organizationId);
  for (const company of companies.data ?? []) {
    const members = await admin
      .from('members')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', company.id);
    console.log(`  ${company.name}: ${members.count ?? 0} listener(s)`);
  }
}

main().catch((cause) => {
  console.error(`\nseed:demo failed — ${cause.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Add the script**

In `package.json`, after `"db:types"`:

```json
    "seed:demo": "node scripts/seed-demo.mjs"
```

No flag: Node strips types on import since 22.18, and this machine is on v24.15.
That is what lets the script import the `.ts` guard and the `.ts` local-stack
constants without a build step. **If a Node older than 22.18 is ever in use**,
the import fails loudly with a syntax error — add `--experimental-strip-types`
then, and record it in the block report rather than copying the constants into a
second place.

- [ ] **Step 3: Run it against a clean stack**

```bash
npm run db:reset
docker restart supabase_kong_CRM_-_LISTENER
sleep 10
npm run seed:demo
```

Expected: a summary naming `Demo FM` with 10 listeners and `Demo AM` with 0, and
the two sign-in lines.

- [ ] **Step 4: Run it again**

Run: `npm run seed:demo`
Expected: `"Demo Broadcasting" is already seeded. Nothing to do.` and the same
summary. **The counts must be identical** — that is the idempotence claim.

- [ ] **Step 5: Prove the guard from the outside**

```bash
SEED_SUPABASE_URL=https://djbkdyesubkedxjwcohq.supabase.co npm run seed:demo
```

Expected: exit code 1 and the refusal naming the host, **before any client is
built**. Nothing is written — and note the override is deliberately not called
`NEXT_PUBLIC_SUPABASE_URL`, so a shell that happens to have the hosted
environment exported cannot steer this script by accident.

- [ ] **Step 6: Look at it in the browser**

Run `npm run dev`, sign in as `owner@demo.test`, and confirm `/promotions`,
`/members` and `/inventory` open on data rather than on empty states. A demo
seed that needs explaining is not a demo seed.

- [ ] **Step 7: Commit**

```bash
git add scripts/seed-demo.mjs package.json
git commit -m "feat(seed): a demo Station with the whole cycle already visible"
```

---

## Task 3: The §35 acceptance journey

**Files:**
- Create: `tests/e2e/acceptance.spec.ts`

**Read first:** `provisioning-flow.spec.ts` (provisioning and the password
change), `roles-flow.spec.ts` (composing a role and assigning it per Station),
`invitation-flow.spec.ts` (invite and accept), `inventory-flow.spec.ts` (prize,
entry, reservation), `promotion-prizes.spec.ts` (linking), `draw-flow.spec.ts`
(running a draw), `delivery-flow.spec.ts` (delivery and the receipt),
`pickups`/`deadline.spec.ts` (the uncollected prize), `reports.spec.ts`
(exporting), `audit.spec.ts` (the trail). **Every selector this journey needs
already exists in one of those files. Copy them; do not invent new ones.**

- [ ] **Step 1: Write the journey**

One test. Structure it with `test.step()` so a failure names the §35 stage
rather than a line number, and give it room:

```ts
// tests/e2e/acceptance.spec.ts
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';

/**
 * THE ACCEPTANCE JOURNEY (master spec §35).
 *
 * Every step below is already covered by one of this suite's other journeys.
 * This one exists because none of them covers the SEAM: the order a real
 * customer meets these screens in, from an empty database to an audited
 * delivery. It is slow and it duplicates coverage on purpose.
 *
 * NO RPC SHORTCUT ON ANY STEP THAT HAS A SCREEN -- including the second
 * Station, which the console's AddStationForm creates over add_company. The
 * service key appears exactly once, for the platform_admins insert that no
 * client may write (0006).
 */
test('§35 — from an empty database to an audited delivery', async ({ page }) => {
  test.setTimeout(300_000);
  // ... steps below
});
```

Then, inside, one `test.step()` per stage, each driving the screens the specs
named above already drive:

1. `bootstrap the platform admin` — service key: create the user, insert into
   `platform_admins`.
2. `provision the customer` — sign in at `/login`, go to `/admin/customers`,
   provision an Organization and its first Station, capture the provisional
   password from the screen.
3. `add the second Station` — the same customer's record dialog, `AddStationForm`.
4. `the owner takes the account` — sign in with the provisional password, land on
   `/change-password`, choose a real one, land on `/app`.
5. `register listeners in each Station` — `/members`, twice, once per Station.
6. `invite a colleague restricted to one Station` — compose a role at `/roles`,
   invite at `/team`, accept the invitation in a fresh context, and **assert the
   other Station is not reachable** (the cross-access block §35 names).
7. `prize, stock, reservation` — `/inventory`.
8. `promotion and linked prizes` — `/promotions`, then the prizes tab.
9. `a participation` — `/participations`.
10. `the draw` — the promotion's draws screen.
11. `the deadline` — `/pickups`.
12. `delivery with a private receipt` — deliver, attach an `image/jpeg`, and
    assert the receipt link appears.
13. `the uncollected prize returns to stock` — a second winner past its deadline,
    returned, and the stock figure moving back.
14. `a report, exported` — `/reports`, request and download.
15. `the audit trail` — `/audit`, and the delivery is in it.

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/e2e/acceptance.spec.ts`
Expected: PASS. **When a step fails, its `test.step` name tells you which §35
stage broke** — that is why the steps exist.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/acceptance.spec.ts
git commit -m "test(acceptance): §35 as one journey, from an empty database to an audited delivery"
```

---

## Task 4: ARCHITECTURE.md

**Files:**
- Create: `docs/ARCHITECTURE.md`

Sections, each explaining the model and pointing at the source rather than
copying it (D1):

1. **What this product is** — one paragraph. A CRM for radio stations: listeners,
   promotions, prize inventory, draws, deliveries, WhatsApp, music requests,
   dashboards and reports, multi-tenant by Organization → Company (Station).
2. **The layers, and what may talk to what** — Server Component reads → Server
   Action writes → service (`src/services/*`) → RPC. Name the rule that services
   never take a `SupabaseClient` from a component and that a component never
   calls an RPC directly.
3. **The two Supabase clients** — the user client bound to the caller's JWT
   (`src/lib/supabase/user-client.ts`) and the isolated service client
   (`service-client.ts`), with the rule from spec H2: the service key never
   answers a request on a user's behalf, and `SECURITY DEFINER` functions
   re-authorise rather than trusting the caller.
4. **The machine endpoints** — `/api/webhooks/whatsapp` (Meta's HMAC over the raw
   body) and `/api/worker/*` (shared secret), why both are excluded from the
   middleware matcher, and what breaks if somebody includes them.
5. **The outbox and the tick** — why outbound WhatsApp goes through
   `outbox_messages` and a ten-second tick rather than an inline HTTP call.
6. **The scheduled routines** — the five, plus `job-health-check`, and a pointer
   to `docs/block-11b-runbook.md` for how alerting reads them.
7. **Where the history lives** — the forty-two block reports and runbooks in
   `docs/`, one per block, which answer "why was this decided" where this
   document answers "how does it work".

- [ ] **Step 1: Write it**
- [ ] **Step 2: Check every file path and function name it cites actually exists**

For each `path:symbol` in the document, confirm with Grep. A document that cites
a moved file is worse than one that cites none, because it is trusted.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: ARCHITECTURE — how the system works, and where its history is"
```

---

## Task 5: SECURITY.md

**Files:**
- Create: `docs/SECURITY.md`

Sections:

1. **RLS is the primary mechanism** — every tenant table has it; the app never
   filters by Company in TypeScript and calls that security.
2. **`SECURITY DEFINER` re-authorises** — the pattern, and the rule from Block 6c
   that a definer function does not inherit the caller's policies, so it must ask
   `has_permission` itself.
3. **The isolation suite is the living proof** — pgTAP runs as superuser with a
   null `auth.uid()` and never exercises RLS at all; `tests/isolation/*` is the
   only place a policy is actually tested. 285 cases, 28 files.
4. **The headers and the CSP** — the five static ones in `next.config.mjs`, the
   nonce policy in `middleware.ts`, and the standing instruction: anybody editing
   the policy runs the full Playwright suite and reads the pass count, because
   that failure produces no error message.
5. **Machine endpoints and secrets** — Meta's HMAC, the worker secret,
   constant-time comparison, and that no secret lives in the database.
6. **Uploads** — the bucket allow-list and size cap as the barrier, the action as
   the message, and why there is no magic-byte sniffing.
7. **LGPD** — pseudonymised audit (ids, not names), `anonymize_member` as the
   subject-driven erasure, the retention sweep as the age-driven one,
   `audit_logs` kept for ever and why deleting the record of a deletion is the
   worst available outcome.
8. **Reporting a problem** — where to write. Ask the owner for the address if it
   is not already in `.env.example`; if there is none, say plainly that reports
   go to the repository owner and leave no invented address.

- [ ] **Step 1: Write it**
- [ ] **Step 2: Verify the numbers** by running the isolation suite and quoting what it printed, not this plan.
- [ ] **Step 3: Commit**

```bash
git add docs/SECURITY.md
git commit -m "docs: SECURITY — the boundaries, and the suite that proves them"
```

---

## Task 6: DATABASE.md

**Files:**
- Create: `docs/DATABASE.md`

Sections:

1. **How migrations work here** — four-digit sequence, `supabase/migrations`,
   and **the rule that a migration is never edited after it is pushed**, because
   Supabase records by version number and the edit never arrives.
2. **Nothing in CI applies them** — `npx supabase migration list --linked` after
   every merge that carries one, then `supabase db push`. Name the two drifts
   (41 migrations, then 10) so the next reader knows it is not hypothetical.
3. **The GRANT convention** — from Block 0's handoff: a new table grants nothing
   by default, and `service_role` does **not** inherit table privileges. Cite
   Block 11b's `job_health` as the case that proved it, and the pgTAP assertions
   that now hold it.
4. **Procedure versus function** — a procedure may `commit`; a function may not.
   A procedure that commits may carry **neither** `security definer` nor a `set`
   clause. **No `exception` handler in anything that commits** — the block opens
   a subtransaction and the commit raises. Point at `24_retention.test.sql` and
   `tests/isolation/retention.test.ts` for the pair of tests that hold it.
5. **Where testing happens** — pgTAP for catalogue and logic under a transaction
   that rolls back; isolation over HTTP for RLS and grants; direct Postgres
   connection for anything that commits. Say which question each answers.
6. **Extensions** — `digest()` lives in `extensions`, and why a bare call fails.
7. **The catalogue itself** — not listed. `supabase/migrations` in order, and
   `src/lib/supabase/database.types.ts` regenerated by `npm run db:types`.

- [ ] **Step 1: Write it**
- [ ] **Step 2: Commit**

```bash
git add docs/DATABASE.md
git commit -m "docs: DATABASE — the rules that are expensive to rediscover"
```

---

## Task 7: PERMISSIONS.md

**Files:**
- Create: `docs/PERMISSIONS.md`

Sections:

1. **The model** — Organization owns Companies (Stations); a member is linked to
   a Company with exactly one role; a role is composed from the permission
   catalogue **per Company**. The owner can do everything, always, and sits
   **outside** the link table.
2. **Roles are data, not code** — created at `/roles`, and administering them is
   itself a permission, so it is delegable.
3. **The five functions** — `is_platform_admin`, `is_owner`,
   `is_owner_of_company`, `has_company_access`, `has_permission`, and their
   `_for` siblings taking a user id (`0121`). One-line wrappers with no body of
   their own, so both doors always agree; `21_permission_for.test.sql` asserts
   exactly that.
4. **The catalogue is in the database** — `select key, description from
   public.permissions order by key`. **Not listed here**, and the reason is
   stated: a markdown copy is wrong the first time somebody adds a permission,
   and wrong silently.
5. **Adding a permission** — a migration that inserts into `permissions`, a
   policy or an RPC that reads it, and an isolation case that proves a caller
   without it is refused. Cite Block 10a's `audit.view` as the warning: a
   permission that nothing reads is a flag that looks like a control.
6. **The platform admin** — `platform_admins` accepts no client write; the first
   one is made by hand (Authentication → Add user, then an insert in the SQL
   editor). There is no UI and that is deliberate.

- [ ] **Step 1: Write it**
- [ ] **Step 2: Commit**

```bash
git add docs/PERMISSIONS.md
git commit -m "docs: PERMISSIONS — the model, and where the list actually lives"
```

---

## Task 8: DEPLOYMENT.md, and the two proofs

**Files:**
- Create: `docs/DEPLOYMENT.md`

Sections:

1. **The shape** — Next standalone in Docker on EasyPanel (Hostinger VPS),
   Supabase hosted (`djbkdyesubkedxjwcohq`).
2. **Build-time versus runtime** — `NEXT_PUBLIC_*` are inlined by `next build`
   and must be in **both** tabs; `SUPABASE_SERVICE_ROLE_KEY` runtime only, never
   a build arg; `SKIP_ENV_VALIDATION=1` never at runtime, because `env.ts` falls
   into the loose branch and the container boots with no configuration.
3. **The container must listen on `0.0.0.0`** and answer `/api/health`.
4. **The three database settings** — `app.worker_tick_url`,
   `app.worker_tick_secret`, `app.health_alert_url`, each with the
   `alter database postgres set …` line, and what is silently inert without each.
5. **Deploy order** — migrations first, always: `npx supabase migration list
   --linked`, `supabase db push`, `npm run db:test`, `npm run test:isolation`,
   then the frontend. Name the failure mode of the other order (`PGRST202` on
   every Export button, and a `/reports` screen that renders its own empty state).
6. **Backup and PITR** (D5) — three subsections: what the hosted project's plan
   actually retains (read from the dashboard, recorded with the date it was
   read); the restore procedure step by step; and the proof below.
7. **Rollback** — what to do when a deploy is bad, and the honest note that a
   migration is not rolled back by redeploying the previous image.

- [ ] **Step 1: Read the hosted project's backup settings**

Open the Supabase dashboard for `djbkdyesubkedxjwcohq` → Database → Backups.
Record the plan, the retention window, and whether PITR is on or is a paid
add-on. **Write down what it says, not what it ought to say.**

- [ ] **Step 2: Prove a restore, without touching production**

```bash
npx supabase db dump --linked -f /tmp/hosted-dump.sql
docker exec supabase_db_CRM_-_LISTENER psql -U postgres -c "create database restore_probe"
docker exec -i supabase_db_CRM_-_LISTENER psql -U postgres -d restore_probe < /tmp/hosted-dump.sql
```

Then compare row counts for a handful of tables between the hosted project and
`restore_probe` — `members`, `promotions`, `winners`, `audit_logs` — and record
the numbers and the date in the document.

```bash
docker exec supabase_db_CRM_-_LISTENER psql -U postgres -c "drop database restore_probe"
rm /tmp/hosted-dump.sql
```

**Delete the dump when you are done.** It is a copy of a customer's database on
a laptop.

- [ ] **Step 3: Prove the image builds from cold**

```bash
docker build --no-cache -t pulchatx:probe .
```

Expected: a successful build. Record the date and the resulting image size.
If it fails, that is a finding for this block, not a reason to skip the step.

- [ ] **Step 4: Write the document, including both proofs with their dates**
- [ ] **Step 5: Commit**

```bash
git add docs/DEPLOYMENT.md
git commit -m "docs: DEPLOYMENT — the reproducible path, and a backup that was actually restored"
```

---

## Task 9: The README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write it**

Short, and nothing that repeats the five documents:

- What PulchatX is, in two sentences.
- **Local setup in five commands**: `npm install`, `npx supabase start`,
  `npm run db:reset`, `npm run seed:demo`, `npm run dev` — with the Kong restart
  named as the thing to do when auth answers `createUser failed: {}`.
- **The suites** and what each proves, one line each: `test`, `db:test`,
  `test:isolation`, `test:e2e`.
- **Links to the five documents**, one line of description each.

- [ ] **Step 2: Follow your own instructions on a clean stack**

Run the five commands in order, from `npx supabase stop --no-backup` first. If
any step needs something the README does not mention, the README is wrong — fix
it rather than remembering it.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: a README that is a front door rather than a title"
```

---

## Task 10: The gate, the report, the PR

- [ ] **Step 1: Run every gate, in order, touching nothing while they run**

```bash
npm run lint
npm run typecheck
npm run build
npm run test
npm run db:reset
docker restart supabase_kong_CRM_-_LISTENER
npm run db:test
npm run test:isolation
npx playwright test --workers=1
```

Expected, each read as a number:
- unit: **882** (876 plus Task 1's six)
- pgTAP: **1397** — unchanged, no migrations in this block
- isolation: **285**, 28 of 28 files accounted for
- e2e: **44** (43 plus the acceptance journey)

If the isolation run reports fewer than 28 files, it is the known local flake —
run it again. **Never interpret a short run as a pass, and never weaken the guard.**

- [ ] **Step 2: Write `docs/block-11c-report.md`**

Following `docs/block-11b-report.md`'s shape: what shipped, what changed during
implementation and why (including the D4 correction — the second-Station screen
exists and an earlier draft said it did not), the gate numbers verbatim, the two
manual proofs with their dates, and a closing section stating what remains of the
project: Block 9 deferred for want of the legacy system, Block 10b deferred and
questioned.

- [ ] **Step 3: Commit, push, open the PR**

```bash
git add docs/block-11c-report.md
git commit -m "docs: the report for Block 11c"
git push -u origin block-11c
gh pr create --base main \
  --title "Block 11c — the documents, the seed, the acceptance journey and the proof" \
  --body-file docs/block-11c-report.md
```

**Base `main`.** #31 will have merged by then, and a base on a merged branch
fails with a 404.
