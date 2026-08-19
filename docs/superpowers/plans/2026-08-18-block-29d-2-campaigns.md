# Block 29d-2 — Campaigns and the Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a campaign to a send list — a queue that is also its own history, drained by the worker that already exists, honouring a listener's consent at the moment the message goes out.

**Architecture:** `message_campaigns` copies `report_runs` (0122) — queue and history in one table. `message_campaign_recipients` is both the §13 snapshot and the send queue, one row per recipient. The snapshot is taken **at campaign creation, as the operator**, because that is the only moment an identity exists to ask eligibility with. A fifth drain on the existing tick claims batches with `for update skip locked` and sends through a per-channel provider, re-checking consent on each row before it goes.

**Tech Stack:** PostgreSQL 17 (RLS, pgTAP), Next.js 15 App Router (Server Actions, `typedRoutes`), TypeScript, Zod, next-intl, nodemailer, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-block-29d-campaigns-design.md` — §5, §6, §8, and the campaign halves of §7 and §9. §2b says why the lists shipped first.

## Global Constraints

- Comments explain WHY, never WHAT. A comment that states something **false** is a defect of the same severity as false code. The previous two blocks corrected eleven between them.
- No new user-facing English strings outside `messages/{en,pt,es}.json`; real Portuguese and Spanish. Zod messages inside `src/schemas/` are an established exception.
- The generated Supabase types file is generated, never hand-edited, and **must be committed** when it changes. Run `npm run db:types` **before** `tsc` when a task adds SQL — `tsc` cannot pass against stale types for a new RPC.
- One string literal for a PostgREST `.select(...)`, never a concatenation.
- `create or replace` preserves a function's ACL; `drop` + `create` destroys it. A recreated function is rebuilt from its **live** definition (`pg_get_functiondef`), never from the migration that first created it. `psql` is **not installed**; use a Node script with the repo's `pg` dependency against `LOCAL_SUPABASE_DB_URL`.
- pgTAP `plan(N)` is a file's running total — recount with `grep -c`, never by arithmetic.
- A migration that adds a type or an enum value carries nothing else.
- Gate order is `db:reset` → `db:test` → `test:isolation`. `db:test` after another suite gives a red that is not code.
- **`git status --short` must print nothing before a `tsc` result is trusted.**
- Every conditionally rendered `<button>` gets a distinct `key`.

## Three things that changed after the spec was written

Read these before Task 1; each one settles a question the spec left implicit.

1. **`members_marketing_eligible_bulk` refuses a caller with no identity.** It was `security invoker` when the spec was drafted and is now `security definer` behind a gate admitting a platform admin, the Organization's owner, or a caller with `members.view` at that Station. The spec's "the snapshot happens at campaign creation, as the operator" is therefore not a preference — it is the only thing that works. The worker cannot call it.
2. **`service_role` holds no grant on `send_list_members`.** The worker can never read a list's people. It does not need to: the snapshot copies them into `message_campaign_recipients` at creation, and the drain reads only that.
3. **Listener erasure does not reach `send_list_members`, and that was accepted because those rows hold ids only.** `message_campaign_recipients` holds **phone numbers and e-mail addresses**, so the same gap here is not acceptable. §8 is a real obligation in this block: `anonymize_member` must reach these rows, and the retention sweep must remove them.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0241_campaign_vocabulary.sql` | `campaign_status`, `campaign_recipient_status` — types only |
| `supabase/migrations/0242_campaigns.sql` | The two tables, their indexes and RLS |
| `supabase/migrations/0243_campaign_doors.sql` | `create_campaign` (snapshot), `cancel_campaign` |
| `supabase/migrations/0244_claim_campaign_batch.sql` | The claim, modelled on `claim_outbox_batch` |
| `supabase/migrations/0245_campaign_erasure_retention.sql` | `anonymize_member` extended; the sweep |
| `supabase/tests/68_campaigns.test.sql` | pgTAP for all of the above |
| `src/lib/messaging/provider.ts` | `MessagingProvider`, the per-channel contract |
| `src/lib/messaging/email-provider.ts` | The e-mail side: frame, sender identity, `List-Unsubscribe` |
| `src/lib/messaging/whatsapp-provider.ts` | The WhatsApp side, wrapping the existing transport |
| `src/services/campaigns.ts` | Create, cancel, list; the drain |
| `src/app/(app)/messages/campaigns/` | The screen, its actions and its history |
| `tests/isolation/campaigns.test.ts` | Tenancy and the send-time consent re-check |

---

### Task 1: The vocabulary

**Files:**
- Create: `supabase/migrations/0241_campaign_vocabulary.sql`, `supabase/tests/68_campaigns.test.sql`

**Interfaces:**
- Produces: `campaign_status` (`queued`, `running`, `sent`, `failed`, `cancelled`); `campaign_recipient_status` (`pending`, `claimed`, `sent`, `failed`, `suppressed`, `cancelled`).

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/68_campaigns.test.sql`:

```sql
begin;
select plan(3);

-- Block 29d-2. Two vocabularies: what a campaign is doing, and what happened to
-- one recipient.
select is(
  (select count(*)::int from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'campaign_status'),
  5, 'a campaign is queued, running, sent, failed or cancelled');

select is(
  (select count(*)::int from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'campaign_recipient_status'),
  6, 'and a recipient has six outcomes, not five');

-- SUPPRESSED IS ITS OWN OUTCOME, and this assertion is the reason the enum has
-- six values rather than five. `failed` is our problem and earns a retry;
-- `suppressed` is the listener's choice and must never be retried. A counter
-- that added them together would hide the one fact the operator needs.
select ok(
  'suppressed' = any(enum_range(null::public.campaign_recipient_status)::text[]),
  'a listener who withdrew is suppressed, never failed');

select finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: `68_campaigns.test.sql` fails its three assertions.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0241_campaign_vocabulary.sql` with the two `create type` statements and nothing else, by the house convention that a vocabulary change lands in a file that does nothing else.

**Do not write that PostgreSQL forbids using a newly created type in the same transaction — it does not.** That restriction belongs to `ALTER TYPE … ADD VALUE` on an existing enum, and `0209_songwriter_vocabulary.sql` draws the contrast. A previous block shipped that false claim and had to correct it; the reason here is convention, and saying so is enough.

The comment must carry the `suppressed` / `failed` distinction, because it is the only one of the eleven values whose existence needs an argument.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: `Result: PASS`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0241_campaign_vocabulary.sql supabase/tests/68_campaigns.test.sql
git commit -m "feat(campaigns): six outcomes for a recipient, because a withdrawal is not a failure"
```

---

### Task 2: The two tables

**Files:**
- Create: `supabase/migrations/0242_campaigns.sql`
- Modify: `supabase/tests/68_campaigns.test.sql`

**Interfaces:**
- Produces: tables `message_campaigns`, `message_campaign_recipients`.

- [ ] **Step 1: Write the failing pgTAP**

Recount the plan with `grep -c` and append assertions covering: both tables exist; `message_campaigns` carries the Station, the list, the channel, the template, status, counters, `created_by` and §10's `cancelled_by` / `cancelled_at` / `cancel_reason`; `message_campaign_recipients` carries `campaign_id`, `member_id`, `channel`, the resolved address, the variable values, status, attempts, `next_attempt_at`, `claimed_at`, the provider message id and the error code and description; and that a partial index exists on the sendable status.

Write each assertion out in full.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -8`

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0242_campaigns.sql`. Follow `supabase/migrations/0122_report_runs.sql` for the queue-and-history shape and `supabase/migrations/0238_send_lists.sql` for the composite foreign key proving a Station and its Organization agree.

The header must carry three arguments, because each will otherwise be undone by somebody tidying:

```sql
-- QUEUE AND HISTORY IN ONE TABLE, copied from report_runs (0122), whose own
-- header gives the reason in terms that transfer exactly: a finished run is a
-- queued run with an outcome, and "is it ready?" and "what did I send last
-- month?" are one query against one table.
--
-- THE RECIPIENT TABLE IS THE SNAPSHOT *AND* THE QUEUE. They are not two things
-- that happen to share a shape -- they are the same row. Splitting them would
-- mean copying every recipient twice and keeping the copies in agreement.
--
-- THE ADDRESS IS STORED AS RESOLVED AT SNAPSHOT TIME, not looked up at send.
-- A listener who changes their number between creation and send is sent to the
-- number the campaign was built against, which is what an audit of "who did we
-- write to" has to be able to answer months later.
```

`message_campaign_recipients` holds a real person's phone number and e-mail address. Say so in the table comment and name Task 8 as where erasure and retention reach it — a reader who finds PII in a queue table and no erasure path will assume it was forgotten.

The partial index for the claim goes on the sendable status. Copy the index-condition warning from `claim_outbox_batch`'s own migration verbatim in spirit: an index whose predicate names a status the claim can also see makes the planner's choice depend on data volume, which is how a claim silently stops using it.

RLS on both. `message_campaigns` is selectable by a caller holding `messaging.view` at that Station; `message_campaign_recipients` gets **no policy**, like `send_list_members` before it — the doors and the drain reach it and nothing else does. Say that in its comment, and **revoke `truncate` from `service_role`** as `0238` does, because a queue that can be emptied by one statement is worse than a list that can.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`

- [ ] **Step 5: Regenerate types and commit**

```bash
npm run db:types
git status --short
npx tsc --noEmit
git add supabase/migrations/0242_campaigns.sql supabase/tests/68_campaigns.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(campaigns): a queue that is its own history, and a snapshot that is the queue"
```

---

### Task 3: Creating and cancelling

**Files:**
- Create: `supabase/migrations/0243_campaign_doors.sql`
- Modify: `supabase/tests/68_campaigns.test.sql`

**Interfaces:**
- Consumes: `members_marketing_eligible_bulk` (0235), `send_list_member_ids` (0240).
- Produces: `create_campaign(p_company_id uuid, p_list_id uuid, p_channel public.message_channel, p_template_id uuid, p_member_ids uuid[], p_addresses jsonb, p_variables jsonb) returns uuid`; `cancel_campaign(p_campaign_id uuid, p_reason text) returns integer`.

- [ ] **Step 1: Write the failing pgTAP**

Recount and append assertions covering: both doors exist; each raises `42501` without the right permission — **`create_campaign` needs `messaging.send`, not `messaging.manage`**, because approving a send to twenty thousand people is not the act of drafting one; `create_campaign` refuses a member not linked to that Station and a template whose Station is not this one; a WhatsApp campaign is refused when the template is not registered; `cancel_campaign` marks **pending** rows `cancelled` and leaves `claimed` ones alone, returning how many it marked; and the grants.

Write each assertion in full.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -8`

- [ ] **Step 3: Write the doors**

Both `security definer` with `set search_path = pg_catalog, public`, re-checking permission in their own body and writing an `audit_logs` row.

**The snapshot is passed in, not computed here.** `create_campaign` receives the member ids, their resolved addresses and their variable values, because eligibility was asked **as the operator** before the call — `members_marketing_eligible_bulk` is `security definer` behind a gate requiring `members.view`, and a definer door calling it would be asking with the wrong identity. Say that in the comment; it is the single most likely thing for a later reader to "simplify".

`cancel_campaign` updates only rows still `pending`. A row already `claimed` is in flight at a provider and cannot be recalled — §10 says so and the door must not pretend otherwise.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`

- [ ] **Step 5: Prove the permission split bites**

Change `create_campaign`'s check from `messaging.send` to `messaging.manage`, re-run, and confirm the assertion for a caller holding `manage` but not `send` fails. Report the verbatim line and restore.

- [ ] **Step 6: Regenerate types and commit**

```bash
npm run db:types && git status --short && npx tsc --noEmit
git add supabase/migrations/0243_campaign_doors.sql supabase/tests/68_campaigns.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(campaigns): a door that sends and a door that stops, and why they need different permissions"
```

---

### Task 4: The claim

**Files:**
- Create: `supabase/migrations/0244_claim_campaign_batch.sql`
- Modify: `supabase/tests/68_campaigns.test.sql`

**Interfaces:**
- Produces: `claim_campaign_batch(p_limit integer) returns table (id uuid, campaign_id uuid, channel public.message_channel, address text, variables jsonb, attempts integer, company_id uuid, template_name text, template_language text, body text, subject text)`.

**Read first:** the live `claim_outbox_batch` (0063/0111) via `pg_get_functiondef` — not the migration text — because it is this function's template and it has been amended since it was written.

- [ ] **Step 1: Write the failing pgTAP**

Recount and append assertions covering: the function exists; it claims only `pending` rows whose `next_attempt_at` has arrived; it marks what it claims `claimed` with `claimed_at` set; a second concurrent call returns none of the same rows; a claim older than the stale window is reclaimable; and it is granted to `service_role` and not to `authenticated` or `anon`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -8`

- [ ] **Step 3: Write the claim**

`for update skip locked` over the partial index Task 2 created. `security definer`, pinned `search_path`, granted to **`service_role` only** — the drain is the only caller, and a claim reachable by a user session is a way to take work nobody can give back.

The comment must carry `claim_outbox_batch`'s own warning about which statuses may appear in the index condition, in this function's terms.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`

- [ ] **Step 5: Prove the skip-locked bites**

Remove `skip locked`, re-run, and confirm the concurrent-claim assertion fails or hangs. If it hangs rather than failing, say so — that is the correct observation and the reason `skip locked` is there. Restore.

- [ ] **Step 6: Regenerate types and commit**

```bash
npm run db:types && git status --short && npx tsc --noEmit
git add supabase/migrations/0244_claim_campaign_batch.sql supabase/tests/68_campaigns.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(campaigns): the claim, and why two workers never take the same row"
```

---

### Task 5: The providers

**Files:**
- Create: `src/lib/messaging/provider.ts`, `src/lib/messaging/email-provider.ts`, `src/lib/messaging/whatsapp-provider.ts`, `tests/unit/messaging-providers.test.ts`

**Interfaces:**
- Consumes: `renderCampaignEmail(input: FrameInput): { html: string; text: string }` (`src/lib/mailer/frame.ts`); `MailMessage` with its `headers` field (`src/lib/mailer/index.ts`); the WhatsApp transport in `src/lib/integrations/whatsapp/`.
- Produces: `interface MessagingProvider { send(job: SendJob): Promise<SendOutcome> }`; `type SendOutcome = { ok: true; providerMessageId: string } | { ok: false; retryable: boolean; code: string; description: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/messaging-providers.test.ts` asserting: the e-mail provider renders through `renderCampaignEmail` and never assembles HTML itself; it sets both `List-Unsubscribe` and `List-Unsubscribe-Post` headers from the token it is given; it uses the Station's sender identity when one exists and the installation default when it does not; the WhatsApp provider refuses a job with no registered template rather than calling the transport; and both map a transport failure to `{ ok: false, retryable }` with `retryable` matching `graph.ts`'s own taxonomy.

Write the cases in full, with the transport and the mailer mocked.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/messaging-providers.test.ts 2>&1 | tail -6`

- [ ] **Step 3: Write the providers**

`provider.ts` holds the contract and nothing else. The two implementations hold no retry logic — **the drain owns retrying**, and a provider that retried inside itself would multiply the drain's own backoff into something nobody can reason about. Say that in the contract's comment.

The e-mail provider's comment must record why it does not build markup:

```ts
/**
 * The frame is `renderCampaignEmail`'s (29b-1) and this provider never
 * assembles HTML of its own. That module escapes the operator's text on the way
 * in, which is the whole reason this codebase depends on no sanitiser and uses
 * `dangerouslySetInnerHTML` nowhere. A second place that builds e-mail markup
 * would be a second place to get that wrong.
 */
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/messaging-providers.test.ts 2>&1 | tail -6 && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/lib/messaging tests/unit/messaging-providers.test.ts
git commit -m "feat(campaigns): two providers, one contract, and no retry inside either"
```

---

### Task 6: The drain

**Files:**
- Create: `src/services/campaigns.ts`, `tests/unit/campaign-drain.test.ts`
- Modify: `src/app/api/worker/tick/route.ts`

**Interfaces:**
- Consumes: `claim_campaign_batch` (Task 4), the providers (Task 5), `members_marketing_eligible_bulk` (0235), `issue_unsubscribe_token(p_member_id, p_company_id, p_token_hash, p_campaign_label)` (0232, `service_role` only).
- Produces: `drainCampaigns(supabase): Promise<{ claimed: number; sent: number; failed: number; suppressed: number }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/campaign-drain.test.ts` asserting: a recipient whose consent was withdrawn since the snapshot is marked **`suppressed`** and **never handed to a provider**; a retryable failure returns the row to `pending` with the next backoff and does not increment past `MAX_ATTEMPTS`; a permanent failure marks `failed` and is not retried; consecutive retryable failures park the drain; and each e-mail recipient gets its own unsubscribe token.

The consent case is this task's reason for existing — write it first.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/campaign-drain.test.ts 2>&1 | tail -6`

- [ ] **Step 3: Write the drain**

Reuse `OUTBOX_BATCH`, `BACKOFF_SECONDS`, `MAX_ATTEMPTS`, `STALE_CLAIM` and `PARKED_AT` from `src/services/whatsapp.ts` — import them rather than restating them, so the two drains cannot drift.

**The consent re-check is per row, immediately before the send**, and its comment must say why the snapshot is not enough:

```ts
/**
 * CONSENT IS ASKED AGAIN HERE, not only at snapshot (spec D1). A large campaign
 * takes hours to drain, and a listener who clicks "descadastrar" while it does
 * has, from their side, done the thing the button promised. Sending anyway is
 * the complaint that costs a WhatsApp number its quality rating -- and it is
 * indistinguishable, to them, from the button not working.
 *
 * A refusal here is `suppressed`, never `failed`: it is their choice, not our
 * error, and it must never be retried.
 */
```

- [ ] **Step 4: Wire the fifth drain**

In `src/app/api/worker/tick/route.ts`, after the four already there, in its own `try/catch`, reported into the counters. Follow the second, third and fourth drains' shape exactly — each has a comment saying why it is caught rather than thrown, and yours needs the same plus one sentence on ordering:

```ts
// Block 29d-2, the fifth drain. Last on purpose, by the principle this file's
// own header states: a listener waiting on a WhatsApp reply must not wait
// because somebody sent a campaign. This is the largest thing this tick will
// ever do, so it runs after the conversation outbox and in bounded batches.
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run 2>&1 | tail -4 && npx tsc --noEmit && npm run lint 2>&1 | tail -2`

- [ ] **Step 6: Commit**

```bash
git add src/services/campaigns.ts tests/unit/campaign-drain.test.ts "src/app/api/worker/tick/route.ts"
git commit -m "feat(campaigns): the fifth drain, and the consent it asks again before every send"
```

---

### Task 7: The screen, the history and the test send

**Files:**
- Create: `src/app/(app)/messages/campaigns/page.tsx`, `campaigns-grid.tsx`, `new-campaign-dialog.tsx`, `actions.ts`
- Modify: `src/lib/auth/shell.ts`, `messages/{en,pt,es}.json`

- [ ] **Step 1: The route and the menu entry**

*Disparo em massa* under MENSAGENS, gated on `messaging.view`, declared the way its neighbours are.

- [ ] **Step 2: The new-campaign dialog**

Choose a list, a channel and a template; show the list's reach for that channel — the number that will actually be written to, from `listReach` (29d-1) — and refuse to proceed when it is zero, saying why rather than disabling a button silently.

The **send** button is gated on `messaging.send`, separately from everything else on the screen.

- [ ] **Step 3: The test send**

A field for a phone or e-mail and a button. It assembles the message with a sample listener's variables from the chosen list, sends through the same provider, and **creates no recipient row, no campaign, and no history entry**. Say that in a comment — a test send that left a trace would corrupt the count an operator reads.

Give every conditionally rendered `<button>` a distinct `key`.

- [ ] **Step 4: The grid, which is also the history**

One table: status, list, channel, template, the four counters, who created it, when it started and finished. Cancel on a running campaign, gated on `messaging.send`. Order by something **total** — a grid ordered by a column that is null for every row was a defect two blocks ago.

- [ ] **Step 5: The copy, in three languages**

Including the four counters' labels, and a sentence for a campaign with zero reach that names the reason rather than the symptom.

- [ ] **Step 6: Run the gates**

```bash
npx tsc --noEmit && npm run lint 2>&1 | tail -2 && npx vitest run 2>&1 | tail -4 && git status --short
```

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/messages/campaigns" src/lib/auth/shell.ts messages
git commit -m "feat(campaigns): the screen that sends, and the test that leaves no trace"
```

---

### Task 8: Erasure and retention

**Files:**
- Create: `supabase/migrations/0245_campaign_erasure_retention.sql`
- Modify: `supabase/tests/68_campaigns.test.sql`, `supabase/tests/24_retention.test.sql`, `tests/isolation/retention.test.ts`

**This task exists because of a gap the previous block accepted and this one cannot.** `send_list_members` holds listener ids only, so an erased listener lingering there was recorded as tolerable. `message_campaign_recipients` holds **phone numbers and e-mail addresses**. The same gap here would leave a real person's contact details in a queue after they asked to be erased.

- [ ] **Step 1: Write the failing pgTAP**

Recount and append: `anonymize_member` clears the address and variable values on that listener's recipient rows; and the retention sweep removes rows of campaigns finished beyond the window.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -8`

- [ ] **Step 3: Extend erasure and the sweep**

**Recreate `anonymize_member` from its LIVE definition** (`pg_get_functiondef` through a Node `pg` script — `psql` is not installed), never from the migration that created it. That function has been amended at least twice, and rebuilding it from an old file would silently revert every later fix. This project has a documented incident of exactly that.

The rows are **cleared, not deleted**: a campaign's counters must still add up after an erasure, and deleting recipients would make a finished campaign's history disagree with itself. Say that in the comment.

The retention sweep gains a block for `message_campaign_recipients`, wired the way `0233` wired the unsubscribe tokens.

- [ ] **Step 4: Prove the sweep deletes, in the suite that runs it**

`sweep_retention` COMMITs internally and pgTAP wraps each file in a transaction it rolls back, so the sweep **cannot** be executed from pgTAP — `24_retention.test.sql`'s own header records this. A source-pattern assertion there proves the statement is written, not that a row is removed, because `pg_get_functiondef` returns comments too and a commented-out delete satisfies the same `like`.

So add the real proof to `tests/isolation/retention.test.ts`: seed a recipient row past the window, call the sweep through that file's existing `callSweep`, assert the row is gone. Then comment out the delete, confirm the case fails, report the verbatim line, and restore.

- [ ] **Step 5: Run the gates**

```bash
npm run db:reset && npm run db:test && npm run test:isolation
```

- [ ] **Step 6: Commit**

```bash
npm run db:types && git status --short && npx tsc --noEmit
git add supabase/migrations/0245_campaign_erasure_retention.sql supabase/tests tests src/lib/supabase/database.types.ts
git commit -m "feat(campaigns): erasure reaches the queue, because the queue holds a phone number"
```

---

### Task 9: Tenancy, the journey, and the full gate run

**Files:**
- Create: `tests/isolation/campaigns.test.ts`, `tests/e2e/campaigns.spec.ts`
- Modify: `scripts/verify-isolation-suite.mjs`

- [ ] **Step 1: The isolation cases**

Following `tests/isolation/send-lists.test.ts` for harness use. At minimum:

1. A caller with `messaging.manage` but **not** `messaging.send` cannot create a campaign (`42501`).
2. A campaign of Station A is invisible to a session of Station B.
3. `message_campaign_recipients` cannot be read directly by an authenticated caller.
4. `claim_campaign_batch` is unreachable from an authenticated session.
5. **A listener who withdrew after the snapshot is `suppressed` and never sent to** — the block's central promise, and the one case that needs a real session on both sides.
6. `cancel_campaign` marks pending rows and leaves a claimed one alone.

Raise `minTests` and register the file.

- [ ] **Step 2: The e2e**

Create a list, create a campaign from it, run the drain, and assert the **database**: the campaign's counters, and that a recipient row carries a provider message id. A screen saying "enviado" proves the action was reached, not that anything was sent.

**The `FakeTransport` returns success without a network call**, pushing what it was given into `sent` / `sentInteractive` / `sentTemplates` (`src/lib/integrations/whatsapp/fake.ts`) and failing only when a test injects a failure. So a test that checks the recipient's status became `sent` passes against the fake while proving no message was ever assembled. **Assert on those arrays** — what was handed to the transport — not on what the queue says about itself.

- [ ] **Step 3: The full gate run, in the order that gives an honest verdict**

```bash
npm run db:reset
npm run db:test
npm run test:isolation
npx tsc --noEmit
npm run lint
npx vitest run
```

then the e2e specs you touched with `CI=1 npx playwright test <spec> --workers=1`.

`db:reset` must precede `db:test`, and `db:test` must never follow the isolation suite or the e2e. If the isolation wrapper reports INCOMPLETE, that is this repo's documented `Worker exited unexpectedly` flake: re-run with `--reporter=default --reporter=json --outputFile=./iso.json`, compare the JSON against the summary line, and say which it was.

- [ ] **Step 4: The counts no compiler holds**

```bash
grep -rn "toHaveCount(\|toHaveLength(" tests/ | grep -iE "campaign|permission|messaging"
grep -rn "from public.permissions" supabase/tests/
```

- [ ] **Step 5: Commit**

```bash
git add tests scripts
git commit -m "feat(campaigns): the tenancy cases, and the withdrawal that stops a send mid-queue"
```

---

## Self-Review

**Spec coverage.** §5's queue-and-history → Task 2. §5's snapshot-as-the-operator → Task 3, with the reason recorded. §5's `suppressed` ≠ `failed` → Tasks 1, 6 and 9. §5's recipient states → Task 1. §6's fifth drain → Task 6. §6's claim → Task 4. §6's reused constants → Task 6, imported rather than restated. §6's providers and the two channels' difference → Task 5. §7's permissions, with `messaging.send` separate → Tasks 3 and 7. §8's erasure and retention → Task 8. §9's test table → spread across the tasks that own each behaviour, with the tenancy cases and the journey in Task 9. D4's test send → Task 7.

**Placeholders.** Tasks 2, 3 and 4 describe their pgTAP rather than reproducing it, and each says so and instructs the implementer to write it in full. That is a real weakness — the previous block had the same shape in one task and its assertions arrived unreviewed. Each of those three dispatches must tell its reviewer to judge every assertion against "would this fail if its guard were removed". Task 7 describes a screen and names its precedents.

**Type consistency.** `MessagingProvider`, `SendJob` and `SendOutcome` are defined in Task 5 and consumed in Task 6. `claim_campaign_batch`'s return shape is written once in Task 4's Interfaces block and read by Task 6. `create_campaign` and `cancel_campaign` are written in Task 3 and called by Task 7's actions. `drainCampaigns` is defined in Task 6 and wired in the same task.

**One gap found and closed while reviewing.** Task 3's `create_campaign` takes the addresses and variable values as parameters rather than resolving them, and the first draft did not say why. It is now stated: eligibility must be asked as the operator because `members_marketing_eligible_bulk` refuses an identity-less caller, so a definer door computing the snapshot would be asking with the wrong identity — and that is precisely the "simplification" a later reader would attempt.
