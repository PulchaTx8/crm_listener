# PulchaTX — Multi-Tenant CRM Design Document (v1)

- **Date:** 2026-07-25
- **Status:** Approved for the implementation plan
- **Revision:** rev3 (2026-07-26) — 3rd pass: language migration to English + PulchaTX vocabulary. See §16 Changelog.
- **Source:** "MASTER PROMPT — Development of a Multi-Tenant CRM" (owner-supplied)
- **Review author:** brainstorming session (Claude Code)

This document consolidates the decisions taken in the brainstorming session, refines the master specification and defines the **block-based development plan**. It is the basis for the implementation plan (skill `writing-plans`).

> **Vocabulary (owner decision, 2026-07-26).** The product is **PulchaTX**, a **CRM for entertainment companies** — it is explicitly *not* radio-only.
> **Organization** (top level) → **Company/Station** (the business tenant) → data. Every multi-tenant table carries `organization_id` + `company_id`.
> **Station** is the domain word for the customer's business; the underlying entity keeps its shipped identifiers — table `companies`, column `company_id`, RLS helper `has_company_access()`.
> **Member** is the audience base that enters promotions and receives prizes (table `members`) — it replaces the former "Listener/Ouvinte".
> Because `Member` now means the audience, internal panel-user links are named **`organization_memberships`** / **`company_memberships`** (never `*_members`).

---

## 1. Key decisions (fixed in this session)

| # | Decision | Choice | Consequence |
|---|----------|--------|-------------|
| D1 | Platform | **Greenfield on Supabase/PostgreSQL** | The existing app in `pulsar-listener-crm` (Next.js + Prisma + SQL Server + NextAuth) is **archived**. The legacy SQL Server database of the "Listener" system becomes **a migration source only (one-off ETL)**. |
| D2 | WhatsApp | **Core in v1** | Real ingestion of participations via the WhatsApp Cloud API from v1 (signed webhook, idempotency, asynchronous processing, reprocessing). |
| D3 | Music module | **In v1, with migration** | The music domain (catalog, categories, requests, shows) — **absent from §22 of the spec** — must be **modelled from scratch** and migrated from the legacy system. |
| D4 | Tenant isolation | **RLS + service layer (defense in depth)** | RLS enabled on every multi-tenant table using the user's JWT; the backend operates with the user's token for tenant data; `service_role` restricted to system routines (webhook, cron, ETL). |
| D5 | Sequencing | **Core-first with a vertical slice (strategy A)** | Foundation and multi-tenant first; inventory de-risked before everything that depends on it; audit/observability/isolation tests as cross-cutting concerns from the start. |

**Rule for unspecified decisions** (inherited from §36 of the spec): choose the **safest** and **simplest to maintain** alternative, document it, and create **per-Company configuration** whenever the rule may vary.

**Priorities, in this order:** security → data integrity → multi-tenant isolation → correctness of the inventory rules → traceability → usability → performance → extensibility → looks.

---

## 2. Product vision

Multi-tenant CRM for entertainment companies (**Stations**) to manage the **relationship with their Members** and the whole **prize distribution cycle** of promotions. It is **not** a sales CRM.

Domains: Organizations → Companies/Stations → (members, prizes, inventory, promotions, quizzes, participations, draws, deliveries, returns, music, reports, integrations).

Mandatory terminology (§2 of the spec): **User** (administrative access), **Member** (the Station's audience, no panel access in v1), **Company/Station** (the business tenant), **Organization** (groups the Companies of an owner/group).

---

## 3. Architecture

### 3.1 Stack

- **Frontend/Backend:** Next.js (App Router), React, **TypeScript strict** (no unjustified `any`), Server Components by default, Client Components only when necessary. Server Actions and API Routes with a clear separation of responsibilities.
- **UI:** Tailwind CSS + **shadcn/ui (Radix)** — accessible, no lock-in. *(Replaces the legacy app's Bootstrap+Tailwind mix.)*
- **Forms/validation:** React Hook Form + **Zod** (runtime validation, derived types).
- **Tables/server state:** TanStack Table + TanStack Query; virtualization when needed.
- **Charts:** Recharts. **Dates:** date-fns (+ date-fns-tz). **Export:** ExcelJS (Excel), native CSV, **`@react-pdf/renderer`** (PDF). *(L3: a single PDF library.)*
- **Database/infra:** Supabase (PostgreSQL, Auth, Storage, RLS, migrations, PL/pgSQL functions, `pg_cron`, Edge Functions and Realtime **only where they add value**).
- **Tests (N9):** **Vitest** (unit/services), **Playwright** (e2e), and **RLS/DB** tests with **pgTAP** *or* a harness that authenticates as a real user (JWT). *(Detail in §11.)*
- **Transactional app e-mail (N10):** provider decoupled behind a `mailer` interface — **SMTP** (configured per environment) with **Resend** as the managed option. **Auth** e-mails (confirm/reset/invite) use the Supabase Auth mechanism; **app notifications** use the `mailer`.
- **Rate limiting (N6):** **shared** store (serverless has no memory across instances) — default is a **counter in Postgres** (`rate_limit_counters` table + atomic function); **Upstash Redis** as an option if volume demands it. Decoupled interface.
- **Deploy:** full Dockerfile + Vercel target (app) + managed Supabase. Storage layer and integrations **decoupled** so as not to couple to a single provider.

### 3.2 Layers (per feature)

```
UI (Server/Client Components)
  → Server Actions / API Routes  (authentication + orchestration)
    → services/       (business rules, granular authorization, orchestration)
      → repositories/ (data access/queries via the user client → RLS enforced)
        → PL/pgSQL RPC (critical atomic operations: inventory, draw, delivery)
schemas/  (Zod)   permissions/  (RBAC)   audit/  (trail)   lib/integrations/ (decoupled)
```

Rules: no business logic inside React components; no rule duplicated in multiple places; focused files (one clear purpose per unit).

**H2 — Where transactions live.** With the user client going through PostgREST/JWT (D4) you **cannot** run an interactive multi-statement transaction from Next.js. Therefore **every atomic multi-step operation (link, unlink, reserve, draw, cancel draw, deliver, return, write off, adjust) is encapsulated in a PL/pgSQL function called by RPC** (`.rpc(...)`). The `services/` layer orchestrates and validates permission; atomicity and invariants live in the database function. Reads and simple CRUD keep going through PostgREST with RLS.

### 3.3 Two Supabase clients (decision D4)

- **User client (default):** created per request with the **user's JWT/session**. Every read/write of tenant data goes through it → **RLS is genuinely enforced**.
- **System client (`service_role`, isolated):** used **only** in: the WhatsApp webhook, cron jobs, migration ETL and platform operations. Never exposed to the client; never used to serve an ordinary user request.
- **`SECURITY DEFINER` functions re-authorize on their own (H2/H3).** RPC functions that need to write the ledger/projection or query at organization scope may run as `SECURITY DEFINER` (bypassing RLS). In that case it is **mandatory** to re-check tenant + permission **inside the function body** (`has_company_access`, `has_permission`), because RLS does not protect them. Audit every invocation.

The service layer **always** validates granular permission before operating (backend authorization), even with RLS enabled — defense in depth.

### 3.4 Folder structure (target)

```
src/
  app/ components/
  features/ { auth, organizations, companies, users, members, prizes,
              inventory, promotions, quizzes, participations, draws,
              deliveries, returns, music, reports, integrations, admin }
  lib/ services/ repositories/ schemas/ types/ hooks/ utils/ constants/
  permissions/ audit/
supabase/ { migrations/, seed/, functions/ }
tests/ docs/
```

---

## 4. Data model

### 4.1 Tables from the spec (§22) — retained

Identity/tenant: `profiles, organizations, organization_memberships, companies, company_memberships, roles, permissions, role_permissions, membership_roles, invitations` *(N1)*.

Members: `members, member_company_links, member_consents, member_notes, member_documents, member_blocks`.

Prizes/inventory: `prize_categories, prizes, inventory_movements` (ledger), `inventory_balances` (per-prize projection), `promotion_prize_balances` (per-promotion projection — see §5/H1).
- **M1:** `inventory_locations` and the `TRANSFER_IN/TRANSFER_OUT` movements are **out of v1** (YAGNI). Balance is per `(company, prize)`. Reintroduce `location_id` only when there is a real multi-warehouse need.

Promotions: `promotions, promotion_whatsapp_settings, promotion_requested_fields, promotion_questions, promotion_question_options, promotion_prizes`.

Participations/draw/delivery: `participations, participation_answers, draws, draw_entries, winners, winner_status_history, deliveries, delivery_documents, return_cases, return_case_history`.

Infra: `files, integrations, webhook_events, notifications, audit_logs, saved_reports`.
- **L3:** `files` is the **generic** file table (bucket, unpredictable path, MIME, size, owner, retention); `member_documents` and `delivery_documents` **reference** `files`. In v1 `notifications` has **in-app** (default) and **e-mail** (via `mailer`, §3.1) channels.

### 4.2 Music domain — **new** (gap in §22, decision D3)

All of them with `organization_id` + `company_id` + timestamps + soft delete:

- `music_genres` — music categories/genres. *(legacy: derived from `catalog_medias`)*
- `record_labels` — record labels. *(legacy: `Cad_Gravadoras`)*
- `artists` — artists/performers. *(legacy: `catalog_artists`)*
- `songs` (media) — title, `artist_id`, `label_id`, `genre_id`, **nationality** (domestic/international), **vocal gender** (male/female), duration, internal code, status. *(legacy: `catalog_medias`)*
- `shows` — the Station's shows/programmes. *(legacy: `listener_shows`)*
- `music_requests` — `member_id`, `song_id`, `show_id`, channel/origin, `requested_at`, status. *(legacy: `ouvintes_ped_musica`)*

These indicators feed the **Music Dashboard** (total, new in the period, most requested, most requested category, domestic/international, male/female).

### 4.3 Additional tables — **incorporated ideas + findings**

- `idempotency_keys` — generic reusable key for sensitive Server Actions (delivery, linking) beyond webhooks (idea #2).
- `entitlements` — features/limits contracted per Company; the basis for "the Administrator enables features" and future billing (idea #4).
- `outbox_messages` — outbox for reliable outbound traffic (WhatsApp/AI/outbound webhooks) with reprocessing (idea #5).
- `platform_admins` — link for users who are the **Administrator (App owner)**, cross-tenant.
- `invitations` *(N1)* — user invitation: `organization_id`, `company_id?`, `email`, `role_id`, `token` (hashed), `status` (`PENDING/ACCEPTED/REVOKED/EXPIRED`), `expires_at`, `invited_by`.
- `document_access_logs` *(N2)* — one log row per view of a sensitive document: `file_id`, `member_id?`, `company_id`, `viewed_by`, `viewed_at`, `ip`, `user_agent`, `purpose`.
- `rate_limit_counters` *(N6)* — atomic counters for rate limiting in Postgres (key, window, count) when Redis is not used.

### 4.4 Schema conventions

UUID primary keys; `timestamptz` (store in UTC, display in the Company's timezone); explicit FKs, checks, uniqueness and indexes; **soft delete** (`deleted_at`), status and anonymization instead of physical deletion; optimistic versioning where needed. Composite indexes on `organization_id`, `company_id`, `status`, dates, promotion, member, prize, **normalized phone** and **normalized document (hash)** — every index documented (§22).

- **N5 — Uniqueness × soft delete.** Every business uniqueness constraint (phone/e-mail/CPF-hash/passport per org; promotion integration code; prize internal code) is implemented as a **partial unique index** `... WHERE deleted_at IS NULL`, so records can be archived and re-registered without colliding with logically deleted rows.
- **L2 — Timezone in period filters.** Every "current month / previous month / current year / custom period / comparison" slice (dashboard and reports) computes its bounds **in the Company's timezone** (`companies.timezone`), not in UTC.

### 4.5 Member: organization scope × per-Company access (H3)

A Member is **shared across the Organization** (deduplicated per org; the detail screen shows "Companies they took part in") but **access is per Company**. Explicit rule:

- **Visibility:** a user only sees a `member` that has `member_company_links` for **at least one Company they have access to** (RLS via `EXISTS` + `has_company_access`, never `USING (true)`).
- **Cross-Company aggregated details:** the "Companies they took part in" history only lists Companies the user has access to.
- **Org-scoped dedup without leakage:** duplicate checking via a **`SECURITY DEFINER`** function at org scope that returns only **"exists / does not exist" (+ the id when the user already has access)**. Merging duplicates requires an elevated permission and is audited.

---

## 5. Inventory rules (critical core)

Model: **ledger + two projections** (§14.2–14.3, §24):

- `inventory_movements` = **immutable ledger**. Never edit/delete; corrections only via a new movement.
- `inventory_balances` = **projection per `(company, prize)`** (accounting view of stock).
- `promotion_prize_balances` = **projection per `promotion_prize`** — linked / drawn / delivered / remaining **per promotion** (**H1**). Every movement that names a promotion updates **both** projections in the same transaction.

**Why two projections (H1):** the same prize may be linked to several promotions at once; "linked/drawn/awaiting pickup/delivered" only make sense per `(prize, promotion)`.

**"Bucket" model (partition of physical stock) and canonical equation (M5):**

```
physical_stock  = available + reserved + linked + awaiting_pickup + pending_return
usable_stock    = available            (free to link/draw; reserved does NOT count)
(outside physical) = delivered, written_off
```

| Movement | Effect |
|----------|--------|
| `INITIAL_ENTRY` / `PURCHASE_ENTRY` / `MANUAL_ENTRY` / `ADJUSTMENT_POSITIVE` | + available |
| `MANUAL_EXIT` / `ADJUSTMENT_NEGATIVE` | − available |
| `RESERVATION` / `RESERVATION_RELEASE` | available ↔ reserved |
| `PROMOTION_LINK` / `PROMOTION_UNLINK` | available ↔ linked |
| `DRAW` / `DRAW_CANCEL` | linked ↔ awaiting_pickup |
| `DELIVERY` | awaiting_pickup → delivered |
| `RETURN_PENDING` | awaiting_pickup → pending_return |
| `RETURN_TO_STOCK` | pending_return → available |
| `WRITE_OFF` | (pending_return \| awaiting_pickup) → written_off |

**Invariants (validated in the RPC function, inside a transaction, + `CHECK >= 0` on each bucket):** every bucket ≥ 0; each transition checks the source bucket before moving; do not link more than available; do not draw more than linked; do not deliver more than awaiting_pickup; do not unlink below what has already been drawn (per-promotion projection — H1); do not deliver the same drawn prize twice (idempotency).

Every operation runs in a **PL/pgSQL function (RPC)** with a **lock** (`SELECT ... FOR UPDATE` on the balance row) + an **idempotency key** + a record in `audit_logs`. See H2 (§3.2/§3.3) about `SECURITY DEFINER`.

**Reconciliation job** (idea #3): recomputes both projections from the ledger and alerts on divergences.

---

## 6. Draw, deadline and delivery

- **Draw** (§17): eligibility validated (excludes blocked members), manual or random method with **CSPRNG** or a reproducible/auditable process (store seed + algorithm); records eligible participants, parameters, winners, runners-up and audit evidence; allows cancelling/redoing with a justification.
- **Effect of the draw on inventory:** the `DRAW` movement moves linked → awaiting_pickup (in both projections), associates the prize with the Member and prevents double assignment.
- **Referential chain (M4):** `draw → winner → delivery` carries `promotion_prize_id` (and `draw_id`/`winner_id`) so that **the delivery decrements the correct promotion's counter**. `deliveries` references `winners`; `winners` references `draw_entries`/`promotion_prizes`.
- **Pickup deadline** (§18): **frozen at the moment of the draw**. A prize may have a default deadline; a promotion may override it.
- **Deadline cron** (`pg_cron` + Edge Function, idempotent): processes expired deadlines → `RETURN_PENDING` + notifies; allows extending/returning/writing off. A cron failure raises an alert (§31).
- **Runners-up (N8):** when the winner does not collect the prize (return/write-off), there is an explicit **promote runner-up** flow: it creates a new `winner` from the runner-up, **recomputes/rearms the deadline**, generates a coherent inventory movement (the prize moves back from `pending_return`/`awaiting_pickup` to the new winner) and records it in `winner_status_history`.
- **"Allows return" flag (N11):** the return flow honours the `prizes.allows_return_to_stock` field: if **true**, it offers `RETURN_TO_STOCK`; if **false**, the outcome is `WRITE_OFF` (with a mandatory reason). The UI does not offer a return when the prize does not allow it.
- **Delivery** (§13.4): idempotent transactional flow — locate Member → verify → responsible party/masked document → **receipt in a private bucket** → confirm → `DELIVERY` movement → audit → receipt.

---

## 7. RBAC and permissions (§7)

Roles: **Owner** (owner of the Organization), **Operator**, **Viewer**, and **Administrator = App owner** (cross-tenant super-admin, via `platform_admins` / `is_platform_admin()`).

Roles and permissions are **data** (`roles, permissions, role_permissions, membership_roles`), with per-Company granularity. Granular permissions (e.g. `members.create`, `inventory.reserve`, `promotions.publish`, `deliveries.execute`, `reports.export`, `users.invite`, `companies.manage`) + **`reports.consolidated`** for the consolidated view.

**Invitations (N1):** the Owner, or a user holding `users.invite`, creates an `invitations` row (hashed token + expiry) → e-mail via `mailer` → the invitee accepts (authenticating with Supabase Auth) → acceptance creates `organization_memberships`/`company_memberships` with the invitation's role and marks it `ACCEPTED`. An invitation can be **revoked** and it **expires**.

Company lifecycle: created by the Owner → **pending** → **enabled by the Administrator**. The Administrator also blocks Companies/users and enables features (`entitlements`).

**Every sensitive operation validates permission in the backend** (§33).

---

## 8. RLS (§23)

- RLS **enabled** on every multi-tenant table, covering `SELECT/INSERT/UPDATE/DELETE`.
- Helper functions: `is_org_member(org)`, `has_company_access(company)`, `has_permission(perm, company)`, `is_owner(org)`, `is_platform_admin()`, `belongs_to_tenant(record)`.
- **Members (H3):** policy via `EXISTS` over `member_company_links` + `has_company_access`; dedup via a `SECURITY DEFINER` function that only returns existence.
- **`SECURITY DEFINER` functions (H2):** re-check tenant + permission internally and audit. A mandatory pattern, covered by tests.
- **Storage (N12):** **private** buckets; RLS policies on `storage.objects` restricting by **per-Company path prefix** (`{company_id}/...`); no public bucket for documents. Upload/download only through the backend (see N2).
- **Forbidden:** `USING (true)`. `organization_id`/`company_id` coming from the client are never accepted without a check.
- The super-admin has a **controlled and audited** bypass via `is_platform_admin()`, never via an exposed `service_role`.

---

## 9. Security and LGPD (§8, §9)

Security: Zod + UUID validation; sanitization; SQLi/XSS/CSRF protection; secure cookies; headers + **nonce-based CSP** (Next.js); upload limit/validation (size, MIME, extension); unpredictable file names; **signed URLs** for private documents; **rate limiting with a shared store** (N6); attempt lockout; security logs; protection against user enumeration; error messages without internal details; secrets server-side only; env validated at boot; least privilege. Never expose `service_role`, webhook secrets, tokens, credentials, sensitive data, internal paths or stack traces in production.

LGPD:
- Minimization; purpose limitation; consent (date + origin); anonymization; logical deletion; configurable retention; audit trail; document access control; **recording who consulted sensitive data**; data-subject export; data-subject anonymization.
- **CPF/passport:** **normalized hash** for dedup + masked last digits; document image **only in a private bucket**, per-Company access, view logging and configurable retention (idea #7).
- **Per-view document logging (N2):** the "record who viewed it" requirement is **not** satisfied by a plain signed URL (it is reusable). Decision: **downloads go through an app proxy endpoint** that (a) checks permission, (b) writes `document_access_logs`, (c) streams the file; the signed URL is internal, **short-lived**, and never handed directly to the client for sensitive documents.
- **Anonymization × immutable audit (N4):** `audit_logs` is immutable, but it must not "resurrect" the personal data of an anonymized subject. Policy: for entities carrying personal data, the sensitive fields are written to the audit trail **masked/pseudonymized** (or as a reference to the `member_id`, not the raw value). Anonymizing the subject replaces the data in the source table; the audit history keeps only the pseudonymized form. The anonymization **event** itself is audited.
- **Retention (N7):** a **retention cron** (`pg_cron`) walks documents and subject data whose deadline has expired and applies deletion/anonymization according to the per-Company policy. Idempotent, audited, with a failure alert.

---

## 10. Integrations (§32) — WhatsApp core in v1

A **decoupled** integration layer. Every webhook: **validate signature → record in `webhook_events` → respond 200 fast → process asynchronously → record failures → allow reprocessing**. Prepared for the WhatsApp Cloud API, AI, message import, automatic Member registration, intent detection, music requests, external APIs.

**M2 — Asynchronous mechanism (decision):**
- **Inbound:** the webhook persists into `webhook_events` (unique `external_id` = idempotency) and returns 200. A **worker** — an Edge Function triggered by **`pg_cron`** at a short interval — consumes pending events idempotently (`RECEIVED → PROCESSING → DONE/FAILED`), with retry/backoff and manual reprocessing.
- **Outbound:** `outbox_messages` drained by the same worker.
- **Evolution:** swap polling for **`pgmq`** without changing the worker contract.

**WhatsApp ingestion flow (v1):** event → dedup by `external_id` → identify the promotion (by number/hashtag) → create/associate the Member (dedup §4.5) → **create the participation enforcing the rules (N3)** → parse the quiz answers.

**N3 — Participation rules under concurrency.** "Allows more than one participation", "limit per person" and "minimum interval between participations" are validated **transactionally**, with a **lock on `(promotion, member)`** (advisory lock or `SELECT ... FOR UPDATE`) inside the RPC that creates the participation, and reinforced by a **constraint** (e.g. a partial unique index when `allows_multiple = false`). That way near-simultaneous messages cannot break the limit. Participations that violate the rule end up `INVALID/DUPLICATE` with a reason.

---

## 11. Block-based development plan

**Mandatory cross-cutting work in every block:** RLS on the new tables · Zod validation · `audit_logs` for sensitive operations · tests (unit/integration) · `lint` + `typecheck` + tests gate · documentation update.

**Multi-tenant isolation tests in CI (idea #1, M3):** from Block 1 onwards, the harness **creates real test users, logs in and uses the user's JWT** (never `service_role`) to assert that access to another Company's data **fails**, and that `SECURITY DEFINER` functions reject callers without permission. Tooling: **Vitest** (unit/service), **Playwright** (e2e), **pgTAP**/authenticated harness (RLS/DB) — N9.

### Block 0 — Technical foundation
Next.js App Router + TS strict; Tailwind + shadcn/ui; Zod, RHF, TanStack Table/Query, Recharts, ExcelJS, `@react-pdf/renderer`; **Vitest + Playwright + pgTAP** (N9); `mailer` interface (SMTP/Resend — N10); rate limit interface + `rate_limit_counters` (N6); Supabase CLI + migrations; **env validation at boot**; two Supabase clients (D4); error taxonomy (§25); structured logs + correlation; CI; Dockerfile.
**Done when:** the app starts locally and in CI; `lint`/`typecheck`/tests pass; an invalid env blocks boot; both clients are documented.

### Block 1 — Identity & multi-tenant
Identity/tenant tables + **`invitations`** (N1); Supabase Auth (signup/login/logout/reset/confirm); **invite/accept flow** with token+expiry creating the membership (N1); RLS functions; Company lifecycle (pending → enabled); Company selector + consolidated view.
**Done when:** create account → org → 2 Companies → **invite/accept** → restrict to 1 Company works; a **cross-access test (user JWT) fails as expected**; invitations expire/revoke.

### Block 2 — Inventory & prizes (critical core)
`prize_categories, prizes, inventory_movements` (ledger), `inventory_balances` + `promotion_prize_balances` (H1); RPC functions per movement with idempotency/lock/`CHECK`, buckets and the canonical equation (§5); reconciliation; UI for registration, accounting view, movements, adjustments/reservations.
**Done when:** invariants (buckets ≥ 0, transitions) are covered by tests; a negative balance is impossible; reconciliation finds no divergence on the seed.

### Block 3 — Members
Member tables; CRUD + server-side filters + details; block/hold/archive/anonymize; org-scoped dedup via `SECURITY DEFINER` (§4.5) + **partial unique indexes** (N5); RLS via `member_company_links`; LGPD (consent; documents via **download proxy + `document_access_logs`** — N2; pseudonymized audit — N4).
**Done when:** dedup prevents duplicates **without leaking a Member from another Company**; a document is only reachable through the proxy, with per-access logging; anonymization leaves no personal data in the audit trail.

### Block 4 — Promotions, quiz & participations
Promotion/quiz/participation tables; tabs; **transactional prize linking** (RPC, uses Block 2 and the per-promotion projection); state machine; manual participation + import; **enforcement of the per-person limit/interval (N3)**.
**Done when:** it does not link above what is available; does not unlink below what has been drawn; **the per-person limit/interval cannot be broken under concurrency**; invalid states are blocked; import is idempotent.

### Block 5 — WhatsApp Cloud API
`integrations, webhook_events`, worker (`pg_cron`→Edge Function) and `outbox_messages` (M2); webhook with signature + idempotency + async + reprocessing; ingestion → dedup → Member → participation (with N3) → answers.
**Done when:** a repeated event does not duplicate a participation; an invalid signature is rejected; the worker processes pending events and allows reprocessing.

### Block 6 — Draws & deliveries
Draw/delivery/return tables with the `promotion_prize_id` chain (M4); eligibility; auditable CSPRNG draw; **frozen deadline**; **runner-up promotion (N8)**; **allows-return flag (N11)**; idempotent transactional delivery; private receipt; return to stock; **deadline cron** + notification.
**Done when:** a prize is not delivered twice; a delivery decrements the correct promotion; an expired deadline automatically becomes a pending return; a runner-up can be promoted with coherent stock/deadline; the return honours the prize's flag.

### Block 7 — Music
Model the Music domain (§4.2); UI (dashboard, catalogs, categories, requests, maintenance); legacy migration.
**Done when:** music requests are listable/filterable; the music dashboard shows its indicators; legacy data is migrated and verified.

### Block 8 — Dashboard & reports
3 dashboards (Members/Music/Promotions) with a Company/period/consolidated filter (periods in the Company's timezone — L2) and charts; efficient aggregate queries; reports with Excel/CSV/PDF export; **asynchronous generation for large ones**; `saved_reports`.
**Done when:** the §12 indicators match the seed; period slices check out in the Company's timezone; a large report generates asynchronously without blocking the client.

### Block 9 — Legacy migration (ETL)
**Runtime (N13):** a **single versioned Node script** (`supabase/seed`/`scripts`) that reads SQL Server with `mssql` and writes to Supabase with `service_role`; it runs outside the app (dev/ops), with logging and idempotent re-execution. Migrates members, promotions, prizes/inventory (**opening balance via `INITIAL_ENTRY`**), music; reconciliation and a divergence report. *(Interlocks with Blocks 3 and 7.)*
- **L1:** since WhatsApp (Block 5) may already have created Members, the ETL **reconciles by dedup** (phone/e-mail/CPF-hash/passport at org scope): it matches or creates, never duplicates; merges are audited.
**Done when:** source×target counts match; opening balances match; no duplicate Member after the merge; divergences are reported.

### Block 10 — Full administration
Administrator (App owner) console: enable/block Companies and users, enable features (`entitlements`), WhatsApp webhook configuration; org admin: Companies, users, invitations, roles/permissions, per-Company configuration, audit viewer.
**Done when:** a pending Company only operates after being enabled; blocking a Company/user takes effect; the audit trail is queryable.

### Block 11 — Quality, security & production
E2E (§28 flows); security review (headers, **nonce CSP**, rate limiting, upload/MIME); observability (health, metrics, error monitoring, **alerts for cron/integration/retention failures**); **retention cron (N7)** validated; docs (ARCHITECTURE/SECURITY/DATABASE/PERMISSIONS/DEPLOYMENT); controlled seed; deploy (Docker + Vercel/Supabase; backup/PITR documented).
**Done when:** the §35 E2E flows pass end to end; documentation is delivered; the deploy is reproducible.

---

## 12. Incorporated ideas (beyond the spec)

1. Audit + **isolation tests as a CI gate** from Block 1 (with JWT — M3).
2. **Generic** `idempotency_keys` (Server Actions + webhooks).
3. **Reconciliation** of the two ledger↔balance projections with alerting.
4. **Entitlements** per Company (basis for future billing).
5. **Outbox pattern** for reliable outbound traffic.
6. **Explicit state machines** (promotion, participation, drawn prize).
7. **CPF/document:** normalized hash + masking; image only in a private bucket.
8. **shadcn/ui** instead of Bootstrap.

---

## 13. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Broad v1 (prizes + WhatsApp + Music + migration) | Core-first sequencing; early vertical slice; DoD per block. |
| Inventory correctness under concurrency | Ledger + two projections + PL/pgSQL RPC with locking + heavy tests in Block 2. |
| Per-promotion prize commitment poorly tracked (H1) | `promotion_prize_balances` projection + the "do not unlink below what was drawn" invariant. |
| Breaking the participation limit under concurrency (N3) | Lock on `(promotion, member)` + a constraint in the participation RPC. |
| Cross-tenant leakage / shared Member (H3) | RLS via `member_company_links`; `SECURITY DEFINER` dedup; isolation tests with JWT. |
| Sensitive data leaking via URL/audit (N2/N4) | Download proxy + `document_access_logs`; pseudonymized audit. |
| `service_role` bypassing RLS by accident | Isolated system client; `SECURITY DEFINER` functions re-authorize (H2). |
| Inconsistent legacy migration / duplication with WhatsApp (L1) | Dedup reconciliation in the ETL + divergence report (Block 9). |
| AI and WhatsApp cost/latency | Decoupled layer + outbox + async worker (M2). |

---

## 14. v1 acceptance criteria (§35)

End-to-end flow with multi-tenant security: create account → Organization → 2 Companies → invite a user restricted to 1 Company → register Members per Company → **block cross-access** → register prizes → add stock → reserve → create a promotion → link prizes (**block linking above the balance**) → record a participation → run the draw → create a winner → record the deadline → deliver with a **private receipt** → update stock correctly → process an uncollected prize → return it to stock → generate a report → export it → record the audit entry.

---

## 15. Next steps

1. Owner review of this document.
2. Generation of the **implementation plan** (skill `writing-plans`), starting with **Block 0**.
3. Each block: implement → `lint`/`typecheck`/tests → security review → document what is done/pending → only then move on (§34).

---

## 16. Changelog

- **rev3 (2026-07-26)** — Language migration and product vocabulary:
  - Document converted to English (prose only; technical substance, decision IDs and block structure unchanged).
  - Product named **PulchaTX**, described as "CRM for entertainment companies"; "radio" is no longer the primary term anywhere. Radio-specific examples generalized to entertainment.
  - **Station** adopted as the domain word for the business tenant, while the entity keeps its shipped identifiers (`companies`, `company_id`, `has_company_access()`).
  - Audience renamed **Listener/Ouvinte → Member**: `listeners` → `members`, `listener_company_links` → `member_company_links`, `listener_consents/notes/documents/blocks` → `member_*`, `listener_id` → `member_id`.
  - Naming collision resolved: internal panel-user links are `organization_memberships`/`company_memberships` (was `organization_members`/`company_members`), and `member_roles` → `membership_roles` to keep "member" meaning the audience.
  - Planned-schema identifiers translated: `prizes.permite_retorno_ao_estoque` → `prizes.allows_return_to_stock`; `permite_multipla` → `allows_multiple`; the inventory bucket names in the canonical equation (§5); `radio_shows` → `shows`. Legacy SQL Server table names (`catalog_medias`, `Cad_Gravadoras`, `catalog_artists`, `listener_shows`, `ouvintes_ped_musica`) are **unchanged** — they are the migration source.
- **rev2 (2026-07-26)** — 2nd review pass (completeness/security/LGPD):
  - **N1:** `invitations` table + flow (invite/accept/expiry/revocation). §4.1, §4.3, §7, Block 1.
  - **N2:** per-view logging via a **download proxy** + `document_access_logs` (a plain signed URL is not enough). §4.3, §9, Block 3.
  - **N3:** transactional enforcement of the participation limit/interval (lock on promotion+member). §10, Block 4.
  - **N4:** anonymization × immutable audit — sensitive fields pseudonymized in the audit trail. §9, Block 3.
  - **N5:** **partial** unique indexes (`WHERE deleted_at IS NULL`). §4.4.
  - **N6:** rate limiting with a shared store (`rate_limit_counters` in Postgres / Upstash). §3.1, §9, Block 0.
  - **N7:** LGPD **retention cron**. §9, Block 11.
  - **N8:** **runner-up promotion** to winner flow. §6, Block 6.
  - **N9:** test stack defined (Vitest + Playwright + pgTAP/harness). §3.1, §11, Block 0.
  - **N10:** app e-mail provider (`mailer` SMTP/Resend). §3.1, §4.1.
  - **N11:** the `allows_return_to_stock` flag gates `RETURN_TO_STOCK` vs `WRITE_OFF`. §6.
  - **N12:** Storage RLS policies by Company prefix. §8.
  - **N13:** ETL runtime (Node script with `mssql` + `service_role`). Block 9.
- **rev1 (2026-07-26)** — 1st pass: H1–H3, M1–M5, L1–L3.
- **rev0 (2026-07-25)** — Initial approved version (decisions D1–D5, block plan 0–11).
