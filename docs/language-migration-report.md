# Language & vocabulary migration — report

Branch `rename-and-english`, based on `main@28a3ad3`.
Date: 2026-07-26.

Converts the codebase from PT-BR to English and adopts the PulchatX product identity and
domain vocabulary. This is a translation and renaming pass — **no behaviour was redesigned**.

---

## 1. Decisions applied

**Product identity.** The application is **PulchatX**, described as **"CRM for entertainment
companies"**. It is not radio-only; "rádio"/"radio" is no longer the primary term anywhere.

**Domain vocabulary.**

| Old (spec, PT-BR) | New | Notes |
|---|---|---|
| Organização | **Organization** | top level; groups Companies/Stations |
| Empresa / Rádio | **Station** *(prose)* / `companies` *(schema)* | the business tenant |
| Ouvinte / Listener | **Member** | the audience that enters promotions and receives prizes; table `members` |

Hierarchy: `Organization → Company/Station → data`. Every multi-tenant table carries
`organization_id` + `company_id`.

### 1.1 Mid-task correction from the owner — recorded

The original brief instructed renaming the business tenant from `companies` to `stations`
(table `stations`, column `station_id`, RLS helper `has_station_access()`, internal links
`station_memberships`). **That instruction was cancelled while this work was in progress.**

The corrected decision is: **Station = Companies. Keep `companies`.**

- In schema and in every identifier, **nothing was renamed**: table `companies`, column
  `company_id`, RLS helper `has_company_access()`.
- "Station" is a **prose-level** domain word that replaces "rádio"/"emissora"; the entity is
  written as "Company/Station" where the text refers to the `companies` entity explicitly.
- Internal panel-user links are `organization_memberships` / `company_memberships`
  (**not** `station_memberships`).

**What had to be undone:** nothing. The correction arrived before the spec — the only file
that carries this vocabulary — had been written, and before either delegated document had
applied any glossary term (neither operational doc discusses the tenant model at all). The
`src/`, `tests/` and `supabase/` conversions completed prior to the correction contain no
tenant vocabulary whatsoever, so they were unaffected.

**Verified:** `stations`, `station_id`, `has_station_access`, `station_memberships` appear
**0 times** across `src/`, `tests/`, `supabase/`, the converted docs, `package.json`,
`.env.example`, `Dockerfile`, `README.md` and `.github/`.

### 1.2 The `Member` naming collision

The spec planned `organization_members` / `company_members` for *internal panel users*, which
collides with `Member` now meaning the audience. Resolution applied throughout:

- audience → `members`
- internal user links → `organization_memberships` / `company_memberships`
- `member_roles` → **`membership_roles`** (see §4, judgement call)

---

## 2. What was converted

### Code — `src/`
Every comment, JSDoc, error message and UI string. `package.json` `name`: `crm-listener` →
`pulchatx` (and the two matching `name` fields in `package-lock.json`, validated with
`npm ci --dry-run`).

- `src/app/layout.tsx` — metadata title `PulchatX`, description `CRM for entertainment
  companies`; `<html lang>` changed `pt-BR` → `en` (the UI is now English).
- `src/app/page.tsx` — heading `PulchatX — Foundation OK`, button `Get started`.
- `src/lib/env.ts` — throw message `Configuração de ambiente inválida —` →
  `Invalid environment configuration —`.
- `src/lib/supabase/config.ts` — both throw messages translated.
- `src/lib/logger.ts`, `src/lib/rate-limit/index.ts`, `src/lib/mailer/index.ts`,
  `src/lib/supabase/{service,user}-client.ts`, `src/instrumentation.ts`,
  `src/app/api/health/route.ts`, `src/app/globals.css`, `src/lib/supabase/README.md`.

### Tests — `tests/`
All `describe`/`it` names and every assertion that depended on a translated string.

### SQL — `supabase/`
- `0001_extensions.sql` — comments only.
- `0002_rate_limit.sql` — **comments only**; see §5.
- `tests/00_smoke.test.sql` — assertion descriptions; `plan(7)` and the assertion count are
  unchanged.

### Configuration
`.env.example` (comments only — variable names untouched, they are contracts with the
deployed environment), `Dockerfile`, `.github/workflows/ci.yml` (comments + one step name;
job structure untouched), `next.config.mjs`, `tailwind.config.ts`, `README.md`.

### Documentation
`docs/bloco-0-handoff.md`, `docs/deploy-readiness-report.md`,
`docs/deploy-supabase-hospedado.md`, and
`docs/superpowers/specs/2026-07-25-crm-radios-multitenant-design.md` (prose translated **and**
new vocabulary applied; decision table D1–D5, hypotheses H1–H3/M1–M5/L1–L3/N1–N13 and all
technical substance kept intact). A `rev3` changelog entry records the rename inline.

---

## 3. Deliberately left alone

| Item | Reason |
|---|---|
| `docs/superpowers/plans/2026-07-26-bloco-0-fundacao-tecnica.md` | **Scope call — flagged for override.** 2169-line completed historical record of an executed block; it will never drive work again. Left in PT-BR with a short English note at the top marking it a pre-decision historical artifact and pointing at the spec for current vocabulary. |
| `supabase/config.toml` | Generated. Its `project_id = "CRM_-_LISTENER"` derives from the working-directory name. |
| Git history and commit messages | Already written. |
| Legacy SQL Server table names in the spec (`catalog_medias`, `Cad_Gravadoras`, `catalog_artists`, `listener_shows`, `ouvintes_ped_musica`) | They are the ETL migration **source**; renaming them would make Block 9 wrong. |
| `pulsar-listener-crm`, and "Listener" as the legacy system's proper name | Real names of the archived app and the legacy product. |
| Portuguese redaction keys in `src/lib/logger.ts` (`senha`, `cpf`, `passaporte`) | See §4. |
| Fenced transcripts in `docs/deploy-readiness-report.md` | Captured evidence; see §5. |

---

## 4. Judgement calls where translation touched meaning

1. **PT-BR field names kept in the logger redaction list.** `REDACT_FIELDS` in
   `src/lib/logger.ts` retains `senha`, `cpf` and `passaporte`. These are *data* keys the
   stack encounters, not identifiers we own: the legacy database being migrated (Block 9) uses
   those column names, and `cpf`/`passaporte` are Brazilian PII that the product genuinely
   handles. Removing them to satisfy the English-only policy would have been a **silent
   security regression** the day the ETL starts logging. The list is documented in English
   explaining why, and `tests/unit/logger.test.ts` still exercises the `senha` key with a
   comment saying so.

2. **`member_roles` → `membership_roles`.** The owner's resolution renamed internal links to
   `*_memberships` but did not name this table. Left as `member_roles` it would read as "roles
   of an audience Member", which is exactly the collision the decision set out to remove. It
   holds the roles of an internal *membership*, so `membership_roles` follows the resolution.
   Flagging it because it is an extrapolation, not a literal instruction.

3. **Planned-schema identifiers that were Portuguese.** `prizes.permite_retorno_ao_estoque` →
   `prizes.allows_return_to_stock`, and `permite_multipla` → `allows_multiple`. These are
   *future* schema described in the spec (nothing is shipped), so the English-only policy
   applies. The gating semantics (N11) are unchanged.

4. **Inventory bucket names in the canonical equation (§5).** `estoque_físico / disponível /
   reservado / vinculado / aguardando_retirada / retorno_pendente / entregue / baixado` →
   `physical_stock / available / reserved / linked / awaiting_pickup / pending_return /
   delivered / written_off`. These become column names in Block 2. The movement enum values
   (`INITIAL_ENTRY` … `WRITE_OFF`) were already English and are **byte-identical**.

5. **`radio_shows` → `shows`.** Generalized rather than deleted, per the instruction to
   generalize radio-specific material to entertainment. Its legacy source table
   `listener_shows` is unchanged.

6. **`<html lang="pt-BR">` → `lang="en"`.** A real behavioural change (affects screen readers
   and browser translation prompts), but the served UI is now English, so leaving `pt-BR`
   would have been incorrect. Called out because it is not merely a string edit.

7. **Master prompt title.** The spec's `Source:` line quoted the owner-supplied document
   "PROMPT MESTRE — Desenvolvimento de CRM Multi-Tenant para Rádios". Translated to
   "MASTER PROMPT — Development of a Multi-Tenant CRM (owner-supplied)". Translating a
   document's proper title makes it harder to find; noted in case the original title should be
   restored verbatim.

8. **Pre-existing inconsistency preserved, not silently fixed.** `docs/bloco-0-handoff.md`
   says the plan was corrected "nas quatro vezes" (four times) while the section lists **five**
   bullets. Rendered literally as "all four times" rather than corrected — it is a factual
   discrepancy in the original that the owner should resolve.

---

## 5. Production-safety notes

**`0002_rate_limit.sql` is already applied to production.** No DDL, grant, RLS statement or
function body was altered — only comments. Verified by `npm run db:reset` + `npm run db:test`
(7 pgTAP assertions still pass).

**One caveat worth the owner's attention:** the `comment on table public.rate_limit_counters`
string *was* translated (explicitly sanctioned by the brief). Comments carry no behaviour, but
this means the local schema now has an English table comment while the hosted project still
has the Portuguese one. If anyone runs `supabase db diff --linked --schema public`, it may no
longer report the clean `No schema changes found` recorded in
`docs/deploy-supabase-hospedado.md`. Re-running/pushing the migration is not planned, so this
is a **documentation-only drift** — but it is real, and it is the one place where this branch
and production disagree.

**Captured transcripts left verbatim.** In `docs/deploy-readiness-report.md` the prose is
English but everything inside fenced code blocks is preserved byte-for-byte, including the old
`crm-listener` image tag, Portuguese labels printed by ad-hoc verification scripts, and the
boot error as it read at the time (`Error: Configuração de ambiente inválida — …`, now emitted
as `Error: Invalid environment configuration — …`). An editorial note was added at the top of
that document so a reader does not grep the codebase for strings that no longer exist.
Alternative: translate those labels too, at the cost of evidence integrity — flagged rather
than decided unilaterally.

---

## 6. Verification

All run from a clean tree on this branch. Every command passed.

| Command | Result |
|---|---|
| `npm run lint` | `✔ No ESLint warnings or errors` (pre-existing `next lint` deprecation notice only) |
| `npm run typecheck` | clean, no output |
| `npm run test` | **7 files, 22 tests passed** |
| `npm run test:e2e` | **1 passed** (`home shows the foundation heading`) |
| `npm run db:reset` | migrations `0001`, `0002` applied |
| `npm run db:test` | **`Files=1, Tests=7 … Result: PASS`** |
| `docker build -t pulchatx:dev .` | image built and tagged `pulchatx:dev` |
| `npm ci --dry-run` | `up to date` (lockfile name sync validated) |

Tests that were coupled to translated strings and updated together with their source:

- `tests/e2e/home.spec.ts` — assertion `/Fundação OK/` → `/Foundation OK/`, changed in the
  same commit as `src/app/page.tsx`.
- `tests/unit/env.test.ts` — assertion `/Configuração de ambiente inválida/` →
  `/Invalid environment configuration/`. The other assertions match variable names
  (`/SUPABASE_SERVICE_ROLE_KEY/`) and were safe.
- `tests/unit/supabase-config.test.ts` — asserts `/service role/i`; the new message
  `Missing Supabase service config (service role)` still satisfies it, so the test is
  unchanged apart from its `it` name.
- `supabase/tests/00_smoke.test.sql` — 7 descriptions translated, `plan(7)` untouched.

---

## 7. Leftover grep

Searched `src/`, `tests/`, `supabase/`, the converted docs, `package.json`, `.env.example`,
`Dockerfile`, `README.md` and `.github/` for `rádio`, `radio`, `ouvinte`, `listener`,
`empresa`, `organização`, plus a ~90-word Portuguese function-word list.

| Term | Hits | Status |
|---|---|---|
| `rádio` | 0 | — |
| `radio` | 3 | All deliberate: the vocabulary note ("not radio-only") and two `rev3` changelog lines documenting the rename. |
| `ouvinte` | 4 | All deliberate: vocabulary note, two changelog lines, and the legacy table `ouvintes_ped_musica`. |
| `listener` | 25 | All legitimate — see below. |
| `empresa` | 0 | — |
| `organização` | 0 | — |
| `stations` / `station_id` / `has_station_access` / `station_memberships` | **0** | Confirms §1.1. |

Breakdown of `listener`:

- **19** — captured verbatim terminal output in `docs/deploy-readiness-report.md` (old image
  tag `crm-listener:dev`, npm banner `crm-listener@0.1.0`, and the repo path
  `M:/CRM - LISTENER`).
- **3** — the English socket sense ("the proxy may hit an interface with no listener") in
  `Dockerfile` ×2 and `docs/bloco-0-handoff.md` ×1.
- **1** — `supabase/config.toml`, `project_id = "CRM_-_LISTENER"` (generated, out of scope).
- **2** — the spec: legacy table `listener_shows` and legacy repo `pulsar-listener-crm`.

Portuguese function-word sweep: the only surviving hits are the intentional logger redaction
keys (§4.1), the proper noun "São Paulo" (a Supabase region label), the fenced transcripts
in the deploy-readiness report (§5), and false positives from `.com` e-mail addresses.

---

## 8. Open items for the owner

1. **Override candidate:** the Block 0 plan was left in PT-BR (§3). Say the word and it gets
   converted.
2. **`member_roles` → `membership_roles`** (§4.2) is an extrapolation — confirm or revert.
3. **`comment on table` drift vs. production** (§5) — confirm the documentation-only drift is
   acceptable, or revert that one string.
4. **Fenced-transcript labels** in the deploy-readiness report (§5) — leave as evidence, or
   translate.
5. **Master prompt title** (§4.7) — keep translated, or restore the Portuguese original.
