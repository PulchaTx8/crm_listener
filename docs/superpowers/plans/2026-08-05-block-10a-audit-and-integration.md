# Block 10a — Audit Viewer and WhatsApp Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the audit trail readable by the Organization that owns it, and make a Station's WhatsApp connection configurable by the platform administrator without SQL.

**Architecture:** One `SECURITY INVOKER` listing over `audit_logs`, so the two policies that already exist keep applying; three `SECURITY DEFINER` RPCs over `integrations`, which has RLS and no policies at all. Two screens: `/audit` in the app behind `audit.view`, `/admin/integrations` in the platform console behind `is_platform_admin()`.

**Tech Stack:** Postgres/Supabase, Next.js App Router, Zod, Vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-05-block-10a-audit-and-integration-design.md`

## Global Constraints

- **Migrations are `0129`–`0130`.** The branch is cut from `block-8b` and requires `0121`–`0128`.
- **`list_audit_logs` is `SECURITY INVOKER`.** This is the block's load-bearing decision (D1) and pgTAP asserts it on `prosecdef`, because nothing about the rendered screen would reveal a `DEFINER` rewrite that quietly widened the rule.
- **No secret is ever written to the database or rendered.** The integration screen reports whether each installation-wide token is *configured*, as a boolean.
- **`audit_logs.id` is `bigint`, not uuid** — the one keyset in this codebase whose cursor is not a uuid.
- **Every integration write leaves an `audit_logs` row.**
- **All identifiers, comments, commits and documentation in English.**
- Each task ends with its own gate and its own commit.

---

## File Structure

| file | responsibility |
| --- | --- |
| `supabase/migrations/0129_list_audit_logs.sql` | the listing, `SECURITY INVOKER`, keyset + `total_count` |
| `supabase/migrations/0130_integration_rpcs.sql` | `list_integrations`, `upsert_integration`, `disable_integration` |
| `supabase/tests/23_audit_and_integrations.test.sql` | both migrations |
| `src/schemas/audit.ts` | the row and the filter schemas |
| `src/services/audit.ts` | `listAuditLogs` |
| `src/services/integrations.ts` | the three admin calls + `configuredSecrets()` |
| `src/app/(app)/audit/*` | the viewer, its filters and its list params |
| `src/app/(admin)/admin/integrations/*` | the console screen and its actions |
| `src/lib/audit/labels.ts` | action-code labels, with a fallback |
| `tests/unit/audit/*.test.ts` | labels, the actor rule, the schemas |
| `tests/isolation/audit.test.ts` | cross-Organization, and the null-`organization_id` case |
| `tests/e2e/audit.spec.ts` | an owner reads a row a fixture wrote; an admin connects a Station |

---

## Task 1: `list_audit_logs`

**Files:** create `supabase/migrations/0129_list_audit_logs.sql`, `supabase/tests/23_audit_and_integrations.test.sql`

**Interfaces:**
- Consumes: `audit_logs` and its two policies (0011/0014), `profiles`.
- Produces: `public.list_audit_logs(p_actor_id uuid, p_action text, p_target_table text, p_company_id uuid, p_from timestamptz, p_to timestamptz, p_succeeded boolean, p_cursor_at timestamptz, p_cursor_id bigint, p_limit integer)` returning `(id bigint, created_at timestamptz, actor_id uuid, actor_name text, action text, target_table text, target_id uuid, organization_id uuid, company_id uuid, company_name text, succeeded boolean, detail jsonb, total_count bigint)`.

- [ ] **Step 1: Write the failing pgTAP file.** It asserts, in order: the function exists; `prosecdef` is **false** (D1 — this is the assertion the whole block rests on); a caller with `audit.view` in one Organization sees only its rows; `total_count` equals the row count for an unfiltered call; a second page never repeats a row from the first with a `bigint` cursor; and `actor_name` is null for a row whose `actor_id` is null **and** for a profile with no `full_name`, which is why both columns ship.

- [ ] **Step 2: Run `npm run db:test`** — FAIL on `has_function`.

- [ ] **Step 3: Write the migration.** `security invoker`, `stable`, `set search_path = pg_catalog, public`. Body: one CTE joining `audit_logs` to `profiles` (left) and `companies` (left), every filter `null`-guarded, `total_count` from `count(*) over ()` or a `counted` CTE over the same source, keyset `(created_at, id) < (p_cursor_at, p_cursor_id)`, `order by created_at desc, id desc`, `limit p_limit`. Grant to `authenticated` only — `service_role` has no use for it and granting it would invite the DEFINER mistake back in through the side door.

  **The header must say why it is INVOKER**, at length: the two policies are the rule, RLS is not bypassed, and a `DEFINER` rewrite of an audit listing is the least visible way to widen a permission in this schema.

- [ ] **Step 4: Run `npm run db:test`** — PASS, and the whole suite still green.

- [ ] **Step 5: `npm run db:types`, then commit.**

```bash
git add supabase/migrations/0129_list_audit_logs.sql supabase/tests/23_audit_and_integrations.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(audit): the listing, running as the caller so the policies keep applying"
```

---

## Task 2: The integration RPCs

**Files:** create `supabase/migrations/0130_integration_rpcs.sql`; extend the pgTAP file.

**Interfaces:**
- Produces:
  - `list_integrations()` → every Company the admin can see, with its integration or nulls.
  - `upsert_integration(p_company_id uuid, p_phone_number_id text, p_waba_id text, p_display_phone_number text, p_enabled boolean)` → `uuid`.
  - `disable_integration(p_company_id uuid)` → `void` (sets `enabled = false`; does **not** delete, so the number stays claimed and the history survives).

- [ ] **Step 1: Extend the pgTAP file.** Assert: all three exist and are `SECURITY DEFINER`; each raises `42501` for a non-admin; `upsert_integration` with a `phone_number_id` already live elsewhere raises `23505` naming `integrations_number_live`; a second integration for one Company raises `23505` naming `integrations_one_per_company`; every successful write leaves exactly one `audit_logs` row with the expected `action`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Write the migration.** Each function opens with `if not public.is_platform_admin() then raise exception ... using errcode = '42501'; end if;` — **not** `has_permission`, because these are platform operations with no Company permission that could grant them. `upsert_integration` is an `insert … on conflict (company_id, provider) where deleted_at is null do update`. Audit actions: `configure_integration`, `disable_integration`.

  **Do not catch the two `23505`s here.** They are the correct refusal and the service layer maps them by constraint name; swallowing them would replace a precise error with a generic one.

- [ ] **Step 4: Run — PASS. `npm run db:types`.**

- [ ] **Step 5: Commit.**

```bash
git add supabase/migrations/0130_integration_rpcs.sql supabase/tests/23_audit_and_integrations.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(admin): configure a Station's WhatsApp number without SQL"
```

---

## Task 3: Schemas, labels and services

**Files:** create `src/schemas/audit.ts`, `src/lib/audit/labels.ts`, `src/services/audit.ts`, `src/services/integrations.ts`, `tests/unit/audit/labels.test.ts`, `tests/unit/audit/schemas.test.ts`

**Interfaces:**
- `auditRowSchema`, `auditFilterSchema`; `listAuditLogs(filters, cursor)`.
- `actionLabel(code: string): string` — lookup with the **raw code** as fallback.
- `actorLabel(row: { actor_id: string | null; actor_name: string | null }): string` — `"(system)"` only when `actor_id` is null; otherwise the name, or the id when the name is null.
- `listIntegrations()`, `upsertIntegration(input)`, `disableIntegration(companyId)`, `configuredSecrets(): { appSecret: boolean; verifyToken: boolean; accessToken: boolean }`.

- [ ] **Step 1: Write the failing unit tests.** `actionLabel('winners.reopen_deadline')` returns the raw code when unmapped and never an empty string; `actorLabel` returns `"(system)"` for a null `actor_id`, and does **not** for a null name with a real id — the distinction 0096 paid for; `configuredSecrets` reports booleans and the test asserts no value can leak through it.

- [ ] **Step 2: Run — FAIL. Step 3: implement. Step 4: run — PASS.**

  Error mapping in `services/integrations.ts`: `42501 → UnauthorizedError`; `23505` → a `ConflictError` whose message depends on `error.message` containing `integrations_number_live` ("that number already belongs to another Station") or `integrations_one_per_company` ("this Station already has an integration"); anything else → `InternalError`.

- [ ] **Step 5: Commit.**

---

## Task 4: The two screens

**Files:** create `src/app/(app)/audit/{page.tsx,list-params.ts,audit-filters.tsx,audit-grid.tsx}`, `src/app/(admin)/admin/integrations/{page.tsx,actions.ts,integration-form.tsx}`; modify `src/lib/auth/shell.ts`

- [ ] **Step 1:** `/audit` — a server component listing through `listAuditLogs`, with the filter bar and keyset controls the other listing screens use. `detail` renders in an expandable cell as formatted JSON, never summarised.

- [ ] **Step 2:** `/admin/integrations` — every Company with its integration or a blank form, plus the configured-secrets panel. The panel renders three booleans and no values.

- [ ] **Step 3:** Nav — `/audit` under a new **Administration** section in the app sidebar, guarded by nothing (the page redirects for a caller holding `audit.view` nowhere, and the policies refuse regardless — this codebase's standing "hiding a link is a courtesy" rule). `/admin/integrations` in the admin console's own nav.

- [ ] **Step 4:** `npm run build`, `npm run lint`, `npm run typecheck`. **Run `next lint` with `.next/cache/eslint` cleared** — Block 8b lost a CI run to a cached clean verdict.

- [ ] **Step 5: Commit.**

---

## Task 5: Isolation and e2e

**Files:** create `tests/isolation/audit.test.ts`, `tests/e2e/audit.spec.ts`; modify `scripts/verify-isolation-suite.mjs`

- [ ] **Step 1: The isolation test.** A user with `audit.view` in Organization A sees no row of B; **a row with a null `organization_id` reaches nobody but the platform admin**, which the policy encodes and a DEFINER rewrite would have lost; a user without `audit.view` gets an empty page rather than an error; a non-admin calling any of the three integration RPCs is refused with `42501`.

- [ ] **Step 2: Register the file** in `REQUIRED_TEST_FILES` with its full count as the floor.

- [ ] **Step 3: The e2e.** An owner opens `/audit`, filters by action, and finds a row a fixture wrote. An admin connects a Station on `/admin/integrations`, and **the audit row that write produced appears in the viewer** — which is the whole block in one assertion.

- [ ] **Step 4:** `npm run test:isolation`, `npx playwright test --workers=1`.

- [ ] **Step 5: Commit.**

---

## Task 6: Report, runbook, PR

- [ ] **Step 1:** `docs/block-10a-report.md` and `docs/block-10a-runbook.md`, in the shape the previous eleven blocks used.

- [ ] **Step 2:** The runbook's opening note is **not** 8b's. Nothing here rewrites a shared function; the deploy risk is ordinary (frontend ahead of `0129`/`0130` → `PGRST202` on two screens). What the runbook must carry instead is the operational fact: **`/admin/integrations` is now the only supported way to connect a Station**, and the three secrets remain environment variables.

- [ ] **Step 3:** Full gate, real numbers, then push and open the PR.

**The PR targets `main` and will show Block 8b's commits until PR #28 merges.** Say so in the PR body rather than letting a reviewer discover it.

---

## Self-review — spec coverage

| spec | task |
| --- | --- |
| D1 `SECURITY INVOKER` | 1 (asserted on `prosecdef`) |
| D2 the actor is two columns | 1, 3 |
| D3 detail as JSON, label with fallback | 3, 4 |
| D4 no export | — (deliberately absent) |
| D5 identifiers not secrets | 2, 3, 4 |
| D6 the two unique indexes are the taxonomy | 2, 3 |
| D7 where each screen lives | 4 |
| D8 every integration write is audited | 2, 5 (the e2e closes the loop) |
| §4 the two screens | 4 |
| §6 verification | 1, 2, 3, 5, 6 |
