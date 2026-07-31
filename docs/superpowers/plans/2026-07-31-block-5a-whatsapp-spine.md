# Block 5a — WhatsApp Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A listener texts a promotion's hashtag to their Station's WhatsApp number and is entered into that promotion — registered first if they are new — and told what happened.

**Architecture:** The ingestion rule lives in one `SECURITY DEFINER` SQL function so the participation and the reply that announces it commit together. The worker is a thin Next.js route triggered by `pg_cron` through `pg_net`; it holds no rule, which is what makes the master spec's "swap polling for `pgmq` later" true. Inbound HTTP verifies Meta's HMAC over the raw body, records one row per message, and returns 200 immediately.

**Tech Stack:** Next.js App Router (route handlers), TypeScript strict, Supabase Postgres 17 (plpgsql, RLS, pg_cron, pg_net), Zod, Vitest (unit), pgTAP (database), Playwright (e2e), the isolation harness in `tests/isolation/harness.ts`.

**Spec:** `docs/superpowers/specs/2026-07-31-block-5a-whatsapp-spine-design.md`. Read it before Task 1. Decision references below (D1–D9) point at its §2.

## Global Constraints

- **Everything in English** — code, comments, identifiers, commit messages, docs. The only Portuguese in this block is the four reply strings in `src/lib/integrations/whatsapp/replies.ts`, which are copy shown to listeners.
- **Vocabulary:** `Station` = `companies` row, `Organization` = `organizations` row, `Member`/listener = `members` row. Never "company" in user-facing copy.
- **Migrations are sequential and immutable once pushed.** Next free number is `0057`. Never edit a migration that already exists.
- **`ALTER TYPE ... ADD VALUE` must be alone in its migration** and the new value must not be used until a later migration. Task 4 exists only because of this.
- **Every gate is checked beside its own operation**, never inside a shared helper. Private cores are `SECURITY INVOKER` with EXECUTE granted to nobody. This is the pattern `apply_participation` (0054) established; follow it exactly.
- **No personal data in `audit_logs`** — no phone, name, e-mail, CPF or address, ever (D2, and Block 3's own rule).
- **No secret in the database** (D6). Secrets are environment variables validated at boot in `src/lib/env.ts`.
- **The gate every task must pass before its commit:** `npm run lint && npm run typecheck && npm test`. Database tasks additionally run `npm run db:test`.
- **Commit messages** state what changed and why, in the voice of the existing history (`git log`). End with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## File Structure

**New SQL migrations**

| File | Responsibility |
|---|---|
| `supabase/migrations/0057_integrations.sql` | `integration_provider` enum, `integrations` table, RLS |
| `supabase/migrations/0058_webhook_events.sql` | `webhook_event_status` enum, `webhook_events`, RLS, `prune_webhook_payloads` |
| `supabase/migrations/0059_outbox_messages.sql` | `outbox_status` enum, `outbox_messages`, RLS |
| `supabase/migrations/0060_participation_source_whatsapp.sql` | `ALTER TYPE ... ADD VALUE 'WHATSAPP'` — **nothing else** |
| `supabase/migrations/0061_member_resolution_cores.sql` | Extract three private cores out of 0033/0034; public functions keep signature and gate |
| `supabase/migrations/0062_ingest_whatsapp_event.sql` | The bot's door, and the phone normalisation it depends on |

**New TypeScript**

| File | Responsibility |
|---|---|
| `src/lib/integrations/whatsapp/signature.ts` | HMAC-SHA256 verification over a raw body |
| `src/lib/integrations/whatsapp/payload.ts` | Zod schema for Meta's webhook body; flattening it to messages |
| `src/lib/integrations/whatsapp/replies.ts` | The four reply strings and their rendering |
| `src/lib/integrations/whatsapp/transport.ts` | `WhatsAppTransport` interface |
| `src/lib/integrations/whatsapp/graph.ts` | `GraphTransport` — the real Meta Graph API client |
| `src/lib/integrations/whatsapp/fake.ts` | `FakeTransport` — records sends, fails on demand |
| `src/services/whatsapp.ts` | Worker service: claim events, call the RPC, drain the outbox |
| `src/app/api/webhooks/whatsapp/route.ts` | `GET` verification handshake, `POST` receipt |
| `src/app/api/worker/tick/route.ts` | The tick endpoint `pg_cron` calls |

**Modified**

| File | Change |
|---|---|
| `src/lib/env.ts` | Three new optional environment variables |
| `src/lib/supabase/database.types.ts` | Regenerated (`npm run db:types`) after each migration task |

**New tests**

| File | Covers |
|---|---|
| `tests/unit/whatsapp-signature.test.ts` | Task 7 |
| `tests/unit/whatsapp-payload.test.ts` | Task 8 |
| `tests/unit/whatsapp-replies.test.ts` | Task 9 |
| `tests/unit/whatsapp-transport.test.ts` | Task 10 |
| `supabase/tests/06_whatsapp.test.sql` | Tasks 1–6 |
| `tests/isolation/whatsapp.test.ts` | Task 13, including the 12-round race |

---

### Task 1: The `integrations` table

**Files:**
- Create: `supabase/migrations/0057_integrations.sql`
- Create: `supabase/tests/06_whatsapp.test.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: nothing.
- Produces: table `public.integrations` with columns `id, organization_id, company_id, provider, phone_number_id, display_phone_number, waba_id, enabled, created_at, updated_at, created_by, deleted_at, deleted_by`. Type `public.integration_provider` with one value, `'WHATSAPP'`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/06_whatsapp.test.sql`:

```sql
begin;
select plan(8);

select has_type('public', 'integration_provider', 'the provider enum exists');
select has_table('public', 'integrations', 'integrations exists');
select has_column('public', 'integrations', 'phone_number_id',
                  'integrations carries Meta''s id for the number');

select is(relrowsecurity, true, 'RLS enabled on integrations')
  from pg_class where oid = 'public.integrations'::regclass;

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'integrations'),
  0, 'no policy admits authenticated to integrations');

select ok(not has_table_privilege('authenticated', 'public.integrations', 'SELECT'),
          'authenticated may not read integrations');

-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000005f1', 'Org 5a');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005f1',
   'Station 5a', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000005c2', '00000000-0000-0000-0000-0000000005f1',
   'Station 5a Two', 'America/Sao_Paulo');

insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c1', 'WHATSAPP', '111111111111111', true);

select throws_ok($$
  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id, enabled)
  values
    ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c2',
     'WHATSAPP', '111111111111111', true)
$$, '23505', null, 'one number cannot serve two Stations');

select throws_ok($$
  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id, enabled)
  values
    ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     'WHATSAPP', '222222222222222', true)
$$, '23505', null, 'a Station cannot hold two WhatsApp numbers');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `type "public.integration_provider" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0057_integrations.sql`:

```sql
-- One WhatsApp number per Station (design spec D3). The number that received a
-- message is the only thing in an inbound payload that says which Station it
-- belongs to, so this table is the whole of "whose message is this?".
--
-- No secret lives here (D6). Under one Meta App the access token belongs to the
-- WABA and serves every number under it, so the three secrets are environment
-- variables validated at boot. When a customer brings their own WABA — Block
-- 10, which owns the configuration screen — the token moves onto this row and
-- is encrypted there.

create type public.integration_provider as enum ('WHATSAPP');

create table public.integrations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  provider        public.integration_provider not null,

  -- Meta's id for the number, at
  -- entry[].changes[].value.metadata.phone_number_id in every inbound payload.
  -- Text and not a number: Meta's ids exceed bigint range in practice and are
  -- opaque identifiers rather than quantities.
  phone_number_id      text not null check (length(btrim(phone_number_id)) > 0),
  display_phone_number text,
  waba_id              text,

  -- Defaults to false so a half-configured row cannot start taking traffic
  -- between the insert and the rest of the runbook.
  enabled boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users (id),

  constraint integrations_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint integrations_archival_shape check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
  )
);

-- Both partial, and for the same reason: moving a number from Station A to
-- Station B means soft-deleting A's row and inserting B's. A total unique
-- constraint would refuse that second insert forever, which is the shape of
-- rule this project prefers to state once rather than discover in support.
create unique index integrations_number_live
  on public.integrations (provider, phone_number_id) where deleted_at is null;
create unique index integrations_one_per_company
  on public.integrations (company_id, provider) where deleted_at is null;

alter table public.integrations enable row level security;

-- No policy follows, and that is the deny. This is a system table: service_role
-- bypasses RLS and is its only reader and writer in this block. The operator's
-- view of it is Block 10's and will arrive with the policy that admits it.

comment on table public.integrations is
  'Maps a WhatsApp number to the Station it serves. RLS is enabled with NO policy: nothing reaches this table through a user-scoped client, by design. Holds no secret (design spec D6) — the WABA access token is an environment variable until Block 10 lets a customer bring their own WABA. Both unique indexes are partial on deleted_at so a number can be moved between Stations.';
comment on column public.integrations.phone_number_id is
  'Meta''s id for the number, not the dialable number. This is what arrives in every inbound payload and the only field that resolves a message to a Station.';
comment on column public.integrations.enabled is
  'False by default so a row inserted halfway through the runbook does not start taking traffic before its environment variables exist.';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: `06_whatsapp.test.sql .. ok`, 8 of 8.

- [ ] **Step 5: Regenerate types and run the full gate**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test
```
Expected: all pass. `database.types.ts` now contains `integrations`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0057_integrations.sql supabase/tests/06_whatsapp.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(integrations): a WhatsApp number belongs to exactly one Station

RLS on with no policy, which is the deny: service_role is the only reader.
Both unique indexes are partial on deleted_at so a number can be moved
between Stations rather than being locked to the first one forever.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `webhook_events` and payload pruning

**Files:**
- Create: `supabase/migrations/0058_webhook_events.sql`
- Modify: `supabase/tests/06_whatsapp.test.sql` (raise `plan()`, append cases)

**Interfaces:**
- Consumes: `public.integrations` (Task 1), `public.integration_provider`.
- Produces: table `public.webhook_events`; type `public.webhook_event_status` = `RECEIVED | PROCESSING | DONE | FAILED`; function `public.prune_webhook_payloads(p_older_than interval) returns integer`.

- [ ] **Step 1: Write the failing test**

In `supabase/tests/06_whatsapp.test.sql`, change `select plan(8);` to `select plan(13);` and append before `select * from finish();`:

```sql
-- webhook_events --------------------------------------------------------------

select has_type('public', 'webhook_event_status', 'the event status enum exists');
select is(relrowsecurity, true, 'RLS enabled on webhook_events')
  from pg_class where oid = 'public.webhook_events'::regclass;
select ok(not has_table_privilege('authenticated', 'public.webhook_events', 'SELECT'),
          'authenticated may not read webhook_events');

insert into public.webhook_events (provider, external_id, payload) values
  ('WHATSAPP', 'wamid.TEST1', '{"hello":"world"}');

select throws_ok($$
  insert into public.webhook_events (provider, external_id, payload)
  values ('WHATSAPP', 'wamid.TEST1', '{"hello":"again"}')
$$, '23505', null, 'the same message id cannot be stored twice');

-- The row survives pruning; only the payload goes. external_id is what
-- idempotency needs and it is not personal data.
update public.webhook_events
   set received_at = now() - interval '40 days'
 where external_id = 'wamid.TEST1';
select public.prune_webhook_payloads('30 days');
select is(
  (select payload is null and external_id = 'wamid.TEST1'
     from public.webhook_events where external_id = 'wamid.TEST1'),
  true, 'pruning clears the payload and keeps the row');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `type "public.webhook_event_status" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0058_webhook_events.sql`:

```sql
-- Every inbound event, stored before anything is decided about it. The unique
-- index on (provider, external_id) is what makes the master spec's own "a
-- repeated event does not duplicate a participation" true by structure rather
-- than by the worker checking: Meta re-delivers anything it does not see a 200
-- for, so a duplicate is normal traffic and not an attack.

create type public.webhook_event_status as enum
  ('RECEIVED', 'PROCESSING', 'DONE', 'FAILED');

comment on type public.webhook_event_status is
  'DONE means "finished deciding about this", NOT "a participation happened" — it covers a recorded entry, an unknown number, and a hashtag matching nothing, with the reason in outcome. FAILED means try again. Conflating the two is how a permanently unroutable message gets retried forever.';

create table public.webhook_events (
  id       uuid primary key default gen_random_uuid(),
  provider public.integration_provider not null,

  -- The WhatsApp MESSAGE id (wamid...), never the request id: Meta packs
  -- several messages into one POST, so one HTTP request becomes N rows here and
  -- idempotency is per message.
  external_id text not null check (length(btrim(external_id)) > 0),

  integration_id  uuid references public.integrations (id),
  -- Null until the number resolves. A message sent to a number this
  -- installation does not serve belongs to no Station, and saying so with null
  -- is honester than inventing one.
  organization_id uuid references public.organizations (id),
  company_id      uuid,

  payload jsonb,
  status  public.webhook_event_status not null default 'RECEIVED',
  outcome text,
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text,
  received_at     timestamptz not null default now(),
  next_attempt_at timestamptz,
  processed_at    timestamptz,

  constraint webhook_events_external_id_unique unique (provider, external_id)
);

create index webhook_events_pending
  on public.webhook_events (coalesce(next_attempt_at, received_at))
  where status in ('RECEIVED', 'FAILED');

alter table public.webhook_events enable row level security;
-- No policy. See integrations (0057) for why that is the deny and not an
-- oversight.

-- Design spec D9. The payload holds a phone number and a WhatsApp profile name
-- — personal data at rest in a table Block 3's anonymize_member does not reach.
-- Nulling it keeps the row, so a replayed message is still refused a year
-- later while the content that made it personal is gone. This block ships the
-- function; Block 11 schedules it alongside the rest of N7.
create or replace function public.prune_webhook_payloads(
  p_older_than interval default '30 days')
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  update public.webhook_events
     set payload = null
   where payload is not null
     and received_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.prune_webhook_payloads(interval) from public;
grant execute on function public.prune_webhook_payloads(interval) to service_role;

comment on table public.webhook_events is
  'One row per inbound message, written before anything is decided about it. (provider, external_id) unique is the idempotency guarantee the master spec asks for, held structurally. payload is nullable because prune_webhook_payloads (design spec D9) clears it after 30 days while keeping the row.';
comment on column public.webhook_events.external_id is
  'The WhatsApp message id (wamid...), never the HTTP request id: Meta packs several messages into one POST and idempotency is per message.';
comment on column public.webhook_events.outcome is
  'Why this event finished. With status DONE it distinguishes recorded from no_integration, no_hashtag, no_promotion, promotion_cancelled and outside_window — all of which are silent to the listener (design spec D4) and all of which somebody will eventually have to explain.';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: 13 of 13.

- [ ] **Step 5: Regenerate types and run the gate**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0058_webhook_events.sql supabase/tests/06_whatsapp.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(webhooks): one row per message, and the id outlives the payload

The unique index on (provider, external_id) is the idempotency guarantee,
held by the schema rather than by the worker remembering. external_id is a
message id and not a request id, because Meta packs several messages into
one POST.

prune_webhook_payloads nulls the payload after 30 days and keeps the row:
what idempotency needs is the id, which is not personal data, and the
payload holds a phone and a profile name that anonymize_member cannot reach.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `outbox_messages`

**Files:**
- Create: `supabase/migrations/0059_outbox_messages.sql`
- Modify: `supabase/tests/06_whatsapp.test.sql`

**Interfaces:**
- Consumes: `public.integrations`, `public.integration_provider`.
- Produces: table `public.outbox_messages`; type `public.outbox_status` = `PENDING | SENDING | SENT | FAILED`.

- [ ] **Step 1: Write the failing test**

Change `plan(13)` to `plan(17)` and append:

```sql
-- outbox_messages -------------------------------------------------------------

select has_type('public', 'outbox_status', 'the outbox status enum exists');
select is(relrowsecurity, true, 'RLS enabled on outbox_messages')
  from pg_class where oid = 'public.outbox_messages'::regclass;
select ok(not has_table_privilege('authenticated', 'public.outbox_messages', 'SELECT'),
          'authenticated may not read outbox_messages');

insert into public.outbox_messages
  (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key)
values
  ('WHATSAPP', '00000000-0000-0000-0000-0000000005a1',
   '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
   '11999998888', 'ok', 'p1:confirmation');

select throws_ok($$
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key)
  values
    ('WHATSAPP', '00000000-0000-0000-0000-0000000005a1',
     '00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     '11999998888', 'ok again', 'p1:confirmation')
$$, '23505', null, 'reprocessing cannot send the same confirmation twice');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `type "public.outbox_status" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0059_outbox_messages.sql`:

```sql
-- Outbound traffic as rows, drained by the worker. The point of the table is
-- that a reply is enqueued in the SAME transaction as the participation it
-- announces, so there is no state in which a listener is entered and never told
-- or told and not entered.

create type public.outbox_status as enum ('PENDING', 'SENDING', 'SENT', 'FAILED');

create table public.outbox_messages (
  id              uuid primary key default gen_random_uuid(),
  provider        public.integration_provider not null,
  integration_id  uuid not null references public.integrations (id),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  to_phone text not null check (length(btrim(to_phone)) > 0),
  body     text not null check (length(btrim(body)) > 0),

  -- Unique, and that is the whole mechanism. Reprocessing a parked event by
  -- hand must not send its confirmation a second time, and this holds it rather
  -- than the worker being careful. Shape: '<participation_id>:confirmation'.
  dedupe_key text not null check (length(btrim(dedupe_key)) > 0),

  status          public.outbox_status not null default 'PENDING',
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  external_id     text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,

  constraint outbox_messages_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint outbox_messages_dedupe_unique unique (provider, dedupe_key)
);

create index outbox_messages_sendable
  on public.outbox_messages (next_attempt_at)
  where status in ('PENDING', 'SENDING');

alter table public.outbox_messages enable row level security;
-- No policy. See integrations (0057).

comment on table public.outbox_messages is
  'Outbound messages as rows, so a reply commits in the same transaction as the participation it announces. dedupe_key is unique: reprocessing an event by hand cannot send its confirmation twice, and that is held by the schema rather than by the worker remembering. RLS enabled with no policy — service_role only.';
comment on column public.outbox_messages.external_id is
  'The wamid Meta returns once it accepts the send. Null until then, and null forever on a row that never succeeded.';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: 17 of 17.

- [ ] **Step 5: Regenerate types and run the gate**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0059_outbox_messages.sql supabase/tests/06_whatsapp.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(outbox): the reply commits with the participation it announces

dedupe_key is unique, so reprocessing a parked event by hand cannot send a
second confirmation. Held by the schema rather than by the worker being
careful, for the same reason the webhook_events id is.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `participation_source` gains `'WHATSAPP'`

This task exists only because of a Postgres rule, and it must contain nothing else.

**Files:**
- Create: `supabase/migrations/0060_participation_source_whatsapp.sql`

**Interfaces:**
- Consumes: `public.participation_source` (0052).
- Produces: the enum value `'WHATSAPP'`, usable from migration 0061 onward.

- [ ] **Step 1: Write the failing test**

Change `plan(17)` to `plan(18)` and append:

```sql
select ok(
  'WHATSAPP' = any(enum_range(null::public.participation_source)::text[]),
  'a participation can have arrived by WhatsApp');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — the assertion is false.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0060_participation_source_whatsapp.sql`:

```sql
-- This migration adds one enum value and MUST contain nothing else.
--
-- ALTER TYPE ... ADD VALUE may run inside a transaction block, but the value it
-- adds cannot be USED until that transaction commits. Every migration runs in a
-- transaction, so the first statement that writes 'WHATSAPP' has to live in a
-- later file. That is 0062. Merging the two would fail at db push and pass
-- every test that never ran a real migration — which is the worst combination
-- available.
--
-- p_source is recorded and not consulted: 0054's comment is explicit that it
-- says how a row arrived and decides nothing about who may write it.

alter type public.participation_source add value 'WHATSAPP';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: 18 of 18.

- [ ] **Step 5: Run the gate**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0060_participation_source_whatsapp.sql supabase/tests/06_whatsapp.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(participations): an entry can arrive by WhatsApp

Alone in its migration on purpose: ALTER TYPE ... ADD VALUE cannot use the
value it adds in the same transaction, and every migration is one. Merging
this into the function that writes it would pass every test and fail at
db push.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The three private member-resolution cores

The bot cannot call `resolve_or_create_member` (0054): it is `SECURITY INVOKER` and its callees gate on `has_permission(..., auth.uid())`, which is NULL for `service_role`. This task extracts the mechanics so the bot's door can reach the *same* rule instead of a copy of it. **Every public signature, gate and behaviour is preserved.**

Read `supabase/migrations/0033_member_dedup.sql` and `0034_member_rpcs.sql` in full before writing anything.

**Files:**
- Create: `supabase/migrations/0061_member_resolution_cores.sql`
- Modify: `supabase/tests/06_whatsapp.test.sql`

**Interfaces:**
- Consumes: `find_member_by_identifier` (0033), `create_member` and `link_member_to_company` (0034).
- Produces:
  - `public.apply_member_lookup(p_org uuid, p_phone text, p_email text, p_cpf_hash text, p_passport text) returns uuid` — the identifier match with **no visibility filter**; null when nothing matches.
  - `public.apply_member_creation(<the 18 parameters of create_member, unchanged, in the same order>) returns uuid` — insert plus the `member_company_links` insert, no gate.
  - `public.apply_member_link(p_member_id uuid, p_company_id uuid, p_org uuid, p_actor uuid) returns void` — the link insert, no gate, idempotent.
  - All three `SECURITY INVOKER`, EXECUTE granted to nobody.

- [ ] **Step 1: Write the failing test**

Change `plan(18)` to `plan(22)` and append:

```sql
-- The private cores ------------------------------------------------------------
-- EXECUTE for nobody is the guarantee: these are reachable only from inside a
-- SECURITY DEFINER body that has already checked its own gate.

select ok(not has_function_privilege('authenticated',
            'public.apply_member_lookup(uuid,text,text,text,text)', 'EXECUTE'),
          'authenticated may not call apply_member_lookup');
select ok(not has_function_privilege('service_role',
            'public.apply_member_lookup(uuid,text,text,text,text)', 'EXECUTE'),
          'service_role may not call apply_member_lookup either');
select ok(not has_function_privilege('authenticated',
            'public.apply_member_link(uuid,uuid,uuid,uuid)', 'EXECUTE'),
          'authenticated may not call apply_member_link');

-- The public door still finds what it always found.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000005d1', '00000000-0000-0000-0000-0000000005f1',
   'Ouvinte Cinco', '11999997777');
select is(
  public.apply_member_lookup('00000000-0000-0000-0000-0000000005f1',
                             '11999997777', null, null, null),
  '00000000-0000-0000-0000-0000000005d1'::uuid,
  'the lookup core matches on the normalised phone');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.apply_member_lookup(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0061_member_resolution_cores.sql`. The worked example below is `create_member`, whose body you are moving verbatim; do the identical transformation for the other two.

```sql
-- Block 5's bot needs the listener rules that Block 3 holds, and cannot reach
-- them: find_member_by_identifier and create_member gate on
-- has_permission(..., auth.uid()), and inside a SECURITY DEFINER body entered
-- by service_role auth.uid() is NULL.
--
-- The rejected alternative was reimplementing the dedup on the bot's path. That
-- is literally one rule with two entrances — the defect Block 4b was returned
-- for twice — and the rule duplicated would be the Organization-scoped dedup
-- that Block 3 exists to hold.
--
-- So: the mechanics move into private cores and each public door keeps its own
-- gate beside its own operation, exactly as apply_participation (0054) is
-- reached by record_participation and import_participations. The public
-- signatures, their gates and their behaviour are UNCHANGED; only the body
-- moves. Every Block 3 test must still pass untouched, and that is this
-- migration's real acceptance criterion.
--
-- All three cores are SECURITY INVOKER with EXECUTE for nobody. Making them
-- DEFINER would let a future GRANT turn one into an unchecked write path — the
-- reasoning 0054 gives for apply_participation, and it applies unchanged here.

-- 1. The identifier match, lifted out of find_member_by_identifier (0033).
--    NO visibility filter: this answers "does this Organization already know
--    this person?", and member_reachable — which answers "may the caller see
--    them?" — stays in the public function where the gate belongs.
create or replace function public.apply_member_lookup(
  p_org       uuid,
  p_phone     text,
  p_email     text,
  p_cpf_hash  text,
  p_passport  text
)
returns uuid
language sql
stable
set search_path = pg_catalog, public
as $$
  select m.id
  from public.members m
  where m.organization_id = p_org
    and m.deleted_at is null
    and (
      (public.normalize_phone(p_phone) is not null
        and m.phone_normalized = public.normalize_phone(p_phone))
      or (public.normalize_email(p_email) is not null
        and m.email_normalized = public.normalize_email(p_email))
      or (nullif(lower(btrim(coalesce(p_cpf_hash, ''))), '') is not null
        and m.cpf_hash = nullif(lower(btrim(coalesce(p_cpf_hash, ''))), ''))
      or (nullif(btrim(coalesce(p_passport, '')), '') is not null
        and m.passport = nullif(btrim(coalesce(p_passport, '')), ''))
    )
  limit 1;
$$;

revoke execute on function
  public.apply_member_lookup(uuid, text, text, text, text) from public;

comment on function public.apply_member_lookup(uuid, text, text, text, text) is
  'The identifier match, shared by find_member_by_identifier (0033) and the WhatsApp door (0062) so the two cannot drift. PRIVATE: SECURITY INVOKER, EXECUTE for nobody. Deliberately has NO visibility filter — it answers whether the Organization already knows this person; member_reachable answers whether the caller may see them, and stays in the public function beside the gate. Normalisation goes through normalize_phone/normalize_email so this can never disagree with members.phone_normalized, which is generated from the same functions (0031).';

-- 2. Registration plus the Station link, lifted out of create_member (0034).
--    Parameters are create_member's, in the same order, so the delegation below
--    is a positional pass-through and a reordering cannot silently typecheck.
create or replace function public.apply_member_creation(
  p_company_id           uuid,
  p_full_name            text,
  p_phone                text,
  p_email                text,
  p_cpf_hash             text,
  p_cpf_last_digits      text,
  p_passport             text,
  p_birth_date           date,
  p_address_line         text,
  p_address_number       text,
  p_address_complement   text,
  p_neighbourhood        text,
  p_city                 text,
  p_state                text,
  p_postal_code          text,
  p_discovery_source     text,
  p_first_contact_at     timestamptz,
  p_first_contact_origin text,
  p_actor                uuid
)
returns uuid
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  -- MOVE the body of create_member (0034) here verbatim, from the `insert into
  -- public.members` through the `member_company_links` insert and the
  -- audit_logs insert, with two changes and no others:
  --   * v_actor becomes the p_actor parameter (the bot has none, and passes
  --     NULL — design spec D2);
  --   * the has_permission check does NOT come with it. It stays in
  --     create_member, beside the operation, where a reader looking for "who
  --     may do this" finds it.
  -- The FOR SHARE on the Station row comes with the body: it protects the
  -- Station's deleted_at through to the member_company_links insert, and
  -- 0034's comment says so.
  raise exception 'replace this body with create_member''s, per the comment above';
end;
$$;

revoke execute on function public.apply_member_creation(
  uuid, text, text, text, text, text, text, date, text, text, text, text, text,
  text, text, text, timestamptz, text, uuid) from public;

-- 3. The link insert, lifted out of link_member_to_company (0034). Idempotent:
--    the bot may be re-entering a listener already linked, and a reprocessed
--    event must not raise on the second pass.
create or replace function public.apply_member_link(
  p_member_id  uuid,
  p_company_id uuid,
  p_org        uuid,
  p_actor      uuid
)
returns void
language sql
set search_path = pg_catalog, public
as $$
  insert into public.member_company_links (member_id, company_id, organization_id, linked_by)
  values (p_member_id, p_company_id, p_org, p_actor)
  on conflict do nothing;
$$;

revoke execute on function
  public.apply_member_link(uuid, uuid, uuid, uuid) from public;

-- Now rewrite the three public functions to delegate. Each keeps its exact
-- signature, its gate and its error messages; only the mechanics leave. Worked
-- example — create_member becomes:
--
--   ... existing declarations, the FOR SHARE lookup and the not-found raise ...
--   if not public.has_permission('members.create', p_company_id) then
--     raise log 'create_member denied: actor=% company=%', v_actor, p_company_id;
--     raise exception 'permission denied: members.create required' using errcode = '42501';
--   end if;
--   if v_name is null then
--     raise exception 'listener name is required' using errcode = '22023';
--   end if;
--   return public.apply_member_creation(
--     p_company_id, v_name, p_phone, p_email, p_cpf_hash, p_cpf_last_digits,
--     p_passport, p_birth_date, p_address_line, p_address_number,
--     p_address_complement, p_neighbourhood, p_city, p_state, p_postal_code,
--     p_discovery_source, p_first_contact_at, p_first_contact_origin, v_actor);
--
-- Do the same for find_member_by_identifier (which keeps member_reachable and
-- its visible/elsewhere/none contract, and calls apply_member_lookup for the
-- match) and for link_member_to_company (which keeps its members.create gate
-- and calls apply_member_link).
```

- [ ] **Step 4: Prove Block 3 did not change**

Run: `npm run db:reset && npm run db:test`
Expected: `03_promotions`, `05_participations` and every other existing file pass **unchanged**, and `06_whatsapp` reaches 22 of 22. If any Block 3 assertion moved, the extraction changed behaviour — revert and redo it.

- [ ] **Step 5: Prove it through the API too**

Run: `npm run test:isolation`
Expected: PASS. `tests/isolation/members.test.ts` exercises the gates through real JWTs; it is the check that the gate stayed on the public door.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test
git add supabase/migrations/0061_member_resolution_cores.sql supabase/tests/06_whatsapp.test.sql src/lib/supabase/database.types.ts
git commit -m "refactor(members): the resolution rules get a private core, as participations did

The bot cannot call resolve_or_create_member: its callees gate on
has_permission against auth.uid(), which is NULL for service_role. The
alternative was reimplementing Block 3's dedup on the bot's path -- one rule
with two entrances, the defect 4b was returned for twice.

So the mechanics move into three SECURITY INVOKER cores with EXECUTE for
nobody, and each public door keeps its own gate beside its own operation.
Signatures, gates and messages are unchanged; every Block 3 test passes
untouched, which is what this commit is really claiming.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The bot's door — `ingest_whatsapp_event`

**Files:**
- Create: `supabase/migrations/0062_ingest_whatsapp_event.sql`
- Modify: `supabase/tests/06_whatsapp.test.sql`

**Interfaces:**
- Consumes: everything from Tasks 1–5, plus `apply_participation` (0054) and `promotions` (0040).
- Produces:
  - `public.whatsapp_local_phone(p_wa_phone text) returns text` — the country-code normalisation.
  - `public.ingest_whatsapp_event(p_event_id uuid) returns jsonb`, `SECURITY DEFINER`, EXECUTE **only** to `service_role`. Returns `{ "outcome": text, "status": text|null, "participation_id": uuid|null }`.

**Before writing:** `members.phone_normalized` is digits-only (`normalize_phone`, 0031). An operator typing `(11) 99999-8888` stores `11999998888`; WhatsApp delivers the sender as `5511999998888`, **with the country code**. Without normalisation these never match, the unique index does not collide, and the bot registers a second record for somebody Block 3 already knows — the exact opposite of what the dedup exists for. That is what `whatsapp_local_phone` is for, and it is the first thing this migration defines.

- [ ] **Step 1: Write the failing tests**

Change `plan(22)` to `plan(34)` and append:

```sql
-- Phone normalisation ----------------------------------------------------------

select is(public.whatsapp_local_phone('5511999998888'), '11999998888',
          'a Brazilian mobile loses its country code');
select is(public.whatsapp_local_phone('551133334444'), '1133334444',
          'a Brazilian landline loses its country code');
select is(public.whatsapp_local_phone('11999998888'), '11999998888',
          'a number already local is left alone');
select is(public.whatsapp_local_phone('351912345678'), '351912345678',
          'a non-Brazilian number is left whole');

-- The door ---------------------------------------------------------------------

select ok(not has_function_privilege('authenticated',
            'public.ingest_whatsapp_event(uuid)', 'EXECUTE'),
          'authenticated may not run the bot door');
select ok(has_function_privilege('service_role',
            'public.ingest_whatsapp_event(uuid)', 'EXECUTE'),
          'service_role may run the bot door');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, yes_button_label, no_button_label)
values
  ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c1', 'Disney', '2026-08-01Z', '2026-08-31Z',
   true, '#EUQUERO', 'Quero!', 'Nao');

-- A helper so each case below is one insert and one call.
create or replace function pg_temp.ingest(
  p_wamid text, p_from text, p_text text, p_at timestamptz,
  p_number text default '111111111111111')
returns jsonb language plpgsql as $$
declare v_id uuid;
begin
  insert into public.webhook_events (provider, external_id, payload)
  values ('WHATSAPP', p_wamid, jsonb_build_object(
    'metadata', jsonb_build_object('phone_number_id', p_number),
    'from', p_from, 'profile_name', 'Ouvinte Bot',
    'timestamp', extract(epoch from p_at)::bigint::text,
    'text', p_text))
  returning id into v_id;
  return public.ingest_whatsapp_event(v_id);
end $$;

select is(pg_temp.ingest('wamid.A1', '5511988887777', 'quero participar #EUQUERO !!',
                         '2026-08-10T12:00:00Z') ->> 'outcome',
          'recorded', 'a hashtag in a messy sentence is recorded');
select is(pg_temp.ingest('wamid.A2', '5511988887777', '#EUQUERO',
                         '2026-08-10T13:00:00Z') ->> 'status',
          'DUPLICATE', 'the same person twice is a duplicate, not a second entry');
select is(
  (select count(*)::int from public.members
    where organization_id = '00000000-0000-0000-0000-0000000005f1'
      and phone_normalized = '11988887777'),
  1, 'the listener was registered once, without the country code');
select is(pg_temp.ingest('wamid.A3', '5511988886666', 'bom dia',
                         '2026-08-10T12:00:00Z') ->> 'outcome',
          'no_hashtag', 'a message with no hashtag is finished and silent');
select is(pg_temp.ingest('wamid.A4', '5511988886666', '#NADA',
                         '2026-08-10T12:00:00Z') ->> 'outcome',
          'no_promotion', 'an unknown hashtag is finished and silent');
select is(pg_temp.ingest('wamid.A5', '5511988886666', '#EUQUERO',
                         '2026-09-10T12:00:00Z') ->> 'outcome',
          'outside_window', 'a message after the promotion closed says so');
select is(pg_temp.ingest('wamid.A6', '5511988886666', '#EUQUERO',
                         '2026-08-10T12:00:00Z', '999999999999999') ->> 'outcome',
          'no_integration', 'a message to a number we do not serve is finished');

-- No personal data in the audit trail (design spec D2).
select is(
  (select count(*)::int from public.audit_logs
    where action = 'ingest_whatsapp_event'
      and detail::text like '%98888%'),
  0, 'no phone number reaches audit_logs');
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run db:test`
Expected: FAIL — `function public.whatsapp_local_phone(text) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0062_ingest_whatsapp_event.sql`:

```sql
-- The bot's door. It is the third entrance to apply_participation and the only
-- one not gated on has_permission: the worker runs as service_role, has no
-- auth.uid(), and there is no user whose permissions could be checked. What
-- stands in for the gate is the integrations row — a message is ingested only
-- if it arrived at a number this installation serves and has switched on.
--
-- 0054's comment predicted this function: "Block 5 will have no choice about
-- recording what happened to a message it received."

-- Members store phones digits-only (normalize_phone, 0031), and an operator
-- types a local number: (11) 99999-8888 becomes 11999998888. WhatsApp delivers
-- the sender WITH the country code, 5511999998888. Matched raw, those never
-- meet, the unique index does not collide, and the bot registers a second
-- record for somebody Block 3 already knows.
--
-- Known limit, stated rather than discovered: this strips +55 only. A Brazilian
-- mobile that gained its ninth digit after the listener was registered still
-- reads as a different person, and so does any other country's numbering. Block
-- 9's ETL reconciliation (L1) faces the same problem against legacy data and is
-- where a general answer belongs.
create or replace function public.whatsapp_local_phone(p_wa_phone text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when d is null then null
    -- 55 + 2-digit area code + 8 or 9 subscriber digits.
    when length(d) in (12, 13) and left(d, 2) = '55' then substr(d, 3)
    else d
  end
  from (select public.normalize_phone(p_wa_phone) as d) s;
$$;

revoke execute on function public.whatsapp_local_phone(text) from public;

comment on function public.whatsapp_local_phone(text) is
  'The sender of a WhatsApp message as this database stores phones. Strips a Brazilian country code so an inbound 5511999998888 matches a listener an operator registered as (11) 99999-8888 — without this the bot duplicates every listener Block 3 already knows, because members.phone_normalized is digits-only and the two strings simply differ. Strips +55 only; the ninth-digit change and other countries are Block 9''s reconciliation problem (L1).';

create or replace function public.ingest_whatsapp_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event      public.webhook_events%rowtype;
  v_integ      public.integrations%rowtype;
  v_from       text;
  v_local      text;
  v_profile    text;
  v_text       text;
  v_when       timestamptz;
  v_tag        text;
  v_promo      public.promotions%rowtype;
  v_diag       public.promotions%rowtype;
  v_member     uuid;
  v_result     jsonb;
  v_status     text;
  v_part       uuid;
  v_outcome    text;
begin
  -- Two ticks must not take the same event. The loser skips rather than
  -- blocking: a blocked worker holds its transaction open for no gain, and the
  -- event will still be there next tick.
  select * into v_event
  from public.webhook_events
  where id = p_event_id and status in ('RECEIVED', 'FAILED')
  for update skip locked;

  if not found then
    return jsonb_build_object('outcome', 'skipped', 'status', null,
                              'participation_id', null);
  end if;

  update public.webhook_events set status = 'PROCESSING' where id = v_event.id;

  v_from    := v_event.payload ->> 'from';
  v_profile := nullif(btrim(coalesce(v_event.payload ->> 'profile_name', '')), '');
  v_text    := coalesce(v_event.payload ->> 'text', '');
  v_local   := public.whatsapp_local_phone(v_from);
  -- WhatsApp sends the message timestamp as epoch seconds, as a string.
  v_when    := to_timestamp((v_event.payload ->> 'timestamp')::bigint);

  select * into v_integ
  from public.integrations
  where provider = 'WHATSAPP'
    and phone_number_id = v_event.payload -> 'metadata' ->> 'phone_number_id'
    and enabled
    and deleted_at is null;

  if not found then
    return public.finish_whatsapp_event(v_event.id, 'no_integration', null, null);
  end if;

  update public.webhook_events
     set integration_id = v_integ.id,
         organization_id = v_integ.organization_id,
         company_id = v_integ.company_id
   where id = v_event.id;

  -- The first hashtag in the message. A real one is "quero participar
  -- #EUQUERO !!", not a bare tag, and 0040 already constrains a stored hashtag
  -- to '^#[^[:space:]#]{1,39}$' — the same shape, matched here against free
  -- text.
  v_tag := lower((regexp_match(v_text, '#[^[:space:]#]{1,39}'))[1]);

  if v_tag is null then
    return public.finish_whatsapp_event(v_event.id, 'no_hashtag', null, null);
  end if;

  -- EVERYTHING from here judges the message by ITS OWN timestamp, never by
  -- now(). An event reprocessed an hour later has to be decided as of when the
  -- person actually wrote — which is what 4c's symmetric interval window was
  -- fixed to support, and what keeps step 6 below from refusing a promotion
  -- this step just matched.
  --
  -- promotions_hashtag_no_overlap (0040) guarantees at most one row here at any
  -- instant, including a past one. whatsapp_enabled needs no predicate:
  -- promotions_whatsapp_shape makes a non-null hashtag imply it.
  select * into v_promo
  from public.promotions
  where company_id = v_integ.company_id
    and lower(hashtag) = v_tag
    and deleted_at is null
    and cancelled_at is null
    and v_when >= starts_at and v_when < ends_at;

  if not found then
    -- One diagnostic lookup, ignoring window and cancellation, so an operator
    -- asked "why didn't it work?" gets three answers instead of one. All three
    -- are silent to the listener (design spec D4); the distinction is for the
    -- person who has to explain it.
    select * into v_diag
    from public.promotions
    where company_id = v_integ.company_id
      and lower(hashtag) = v_tag
      and deleted_at is null
    order by starts_at desc
    limit 1;

    if not found then
      v_outcome := 'no_promotion';
    elsif v_diag.cancelled_at is not null then
      v_outcome := 'promotion_cancelled';
    else
      v_outcome := 'outside_window';
    end if;
    return public.finish_whatsapp_event(v_event.id, v_outcome, null, null);
  end if;

  v_member := public.apply_member_lookup(
    v_integ.organization_id, v_local, null, null, null);

  if v_member is null then
    -- first_contact_at / first_contact_origin are write-once and are, in
    -- update_member's own words, "the evidence behind the owner's decision
    -- (spec 7) that a listener who messages a Station first has authorised the
    -- reply". The bot fills in the record Block 3 designed for it rather than
    -- inventing a second one.
    v_member := public.apply_member_creation(
      v_integ.company_id, coalesce(v_profile, 'Ouvinte WhatsApp'), v_local,
      null, null, null, null, null, null, null, null, null, null, null, null,
      null, v_when, 'WHATSAPP', null);
  else
    -- Design spec D8: known to the Organization but not to this Station. Link
    -- and let them enter. Duplicating would defeat the dedup; refusing would
    -- turn a real listener away from a promotion they are eligible for.
    perform public.apply_member_link(
      v_member, v_integ.company_id, v_integ.organization_id, null);
  end if;

  v_result := public.apply_participation(
    v_promo.id, v_member, v_when, 'WHATSAPP', '[]'::jsonb);

  v_status := v_result ->> 'status';
  v_part   := (v_result ->> 'participation_id')::uuid;

  -- The reply, in the same transaction as the entry it announces. dedupe_key is
  -- unique, so reprocessing this event by hand cannot send it twice.
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body, dedupe_key)
  values
    ('WHATSAPP', v_integ.id, v_integ.organization_id, v_integ.company_id,
     v_from, public.whatsapp_reply_body(v_promo.id, v_member, v_status), 
     v_part::text || ':confirmation')
  on conflict (provider, dedupe_key) do nothing;

  return public.finish_whatsapp_event(v_event.id, 'recorded', v_status, v_part);
end;
$$;

revoke execute on function public.ingest_whatsapp_event(uuid) from public;
grant execute on function public.ingest_whatsapp_event(uuid) to service_role;

comment on function public.ingest_whatsapp_event(uuid) is
  'One inbound message, decided end to end in one transaction: the Station from the number, the promotion from the hashtag, the listener from the phone, the entry through apply_participation, and the reply into the outbox. The third entrance to apply_participation and the only one not gated on has_permission -- the worker is service_role and there is no user to check, so the integrations row stands in for the gate. Everything is judged by the MESSAGE timestamp and never by now(), so a reprocessed event is decided as of when the person wrote. The reply commits with the entry, which is why there is no state where a listener is entered and never told. Writes its own audit row with no phone in it (design spec D2); apply_participation writes its own about the participation.';
```

**Two helpers this function calls must be written in the same migration, above it:**

`public.finish_whatsapp_event(p_event_id uuid, p_outcome text, p_status text, p_part uuid) returns jsonb` — sets `status = 'DONE'`, `outcome`, `processed_at = now()`, writes the `ingest_whatsapp_event` audit row (`actor_id` NULL; detail carrying `integration_id`, `wamid` = the event's `external_id`, `promotion_id`, `member_id` and `outcome`, and **no phone**), and returns the jsonb result shape. `SECURITY INVOKER`, EXECUTE for nobody.

`public.whatsapp_reply_body(p_promotion_id uuid, p_member_id uuid, p_status text) returns text` — renders the four strings from Task 9's table, with `{promoção}` from `promotions.name`, `{n}` from `max_entries_per_member`, and `{hora}` computed from the member's last `VALID` participation plus `min_hours_between_entries`, rendered `at time zone` the Station's `companies.timezone`. `SECURITY INVOKER`, EXECUTE for nobody.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`
Expected: 34 of 34.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test
git add supabase/migrations/0062_ingest_whatsapp_event.sql supabase/tests/06_whatsapp.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(whatsapp): one message decided in one transaction

The entry and the reply that announces it commit together, so there is no
state where a listener is concorrendo and never knew, or was told about an
entry that does not exist.

whatsapp_local_phone exists because members store phones digits-only and an
operator types a local number, while WhatsApp delivers the country code.
Matched raw, the bot would register a second record for every listener
Block 3 already knows.

Everything is judged by the message timestamp, never now(): a reprocessed
event has to be decided as of when the person wrote, or the promotion this
function just matched is refused by the window check inside
apply_participation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Environment and signature verification

**Files:**
- Modify: `src/lib/env.ts`
- Create: `src/lib/integrations/whatsapp/signature.ts`
- Create: `tests/unit/whatsapp-signature.test.ts`

**Interfaces:**
- Produces: `verifyMetaSignature(rawBody: string, header: string | null, appSecret: string): boolean`.
- Produces env keys `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WORKER_TICK_SECRET` — all `.optional()`, because CI and `next build` run without them.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/whatsapp-signature.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMetaSignature } from '@/lib/integrations/whatsapp/signature';

const SECRET = 'test-app-secret';
const sign = (body: string) =>
  `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

describe('verifyMetaSignature', () => {
  const raw = '{"object":"whatsapp_business_account","entry":[]}';

  it('accepts a signature over the exact bytes received', () => {
    expect(verifyMetaSignature(raw, sign(raw), SECRET)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(verifyMetaSignature(raw, null, SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    expect(verifyMetaSignature(raw, sign(raw).slice(7), SECRET)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    const other = `sha256=${createHmac('sha256', 'wrong').update(raw).digest('hex')}`;
    expect(verifyMetaSignature(raw, other, SECRET)).toBe(false);
  });

  // The trap this whole module exists for. Verifying a re-serialised parsed
  // body is how this check silently stops working: key order and whitespace
  // change, the HMAC no longer matches what Meta signed, and the usual "fix" is
  // to disable the check.
  it('rejects a body that was parsed and re-serialised', () => {
    const reserialised = JSON.stringify(JSON.parse(raw));
    const spaced = '{"object": "whatsapp_business_account", "entry": []}';
    expect(spaced).not.toBe(reserialised);
    expect(verifyMetaSignature(reserialised, sign(spaced), SECRET)).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    expect(verifyMetaSignature(raw, 'sha256=abc', SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/whatsapp-signature.test.ts`
Expected: FAIL — cannot resolve `@/lib/integrations/whatsapp/signature`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/integrations/whatsapp/signature.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs the RAW request body with the App Secret and sends the digest in
 * `X-Hub-Signature-256`. The caller must pass the bytes it actually received —
 * a body that was parsed and re-serialised has different whitespace and key
 * order, so its HMAC will not match, and the usual response to that failure is
 * to switch the check off. `tests/unit/whatsapp-signature.test.ts` asserts the
 * failure so it is a caught mistake rather than a mysterious one.
 *
 * Returns false for every malformed input instead of throwing: this runs on an
 * unauthenticated route, and an exception there is a different status code and
 * a stack trace in a log.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(header.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }

  // timingSafeEqual throws on a length mismatch, which would leak the length
  // through an exception rather than a comparison.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
```

- [ ] **Step 4: Add the environment variables**

In `src/lib/env.ts`, inside `envSchema`, after `NEXT_PUBLIC_SITE_URL`:

```ts
  // WhatsApp Cloud API. Optional so CI and `next build` run without them; the
  // webhook route refuses to serve when they are missing rather than the whole
  // app refusing to boot (design spec D6 — no secret lives in the database).
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  // Shared secret pg_cron presents to the worker tick.
  WORKER_TICK_SECRET: z.string().min(1).optional(),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/whatsapp-signature.test.ts tests/unit/env.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/lib/env.ts src/lib/integrations/whatsapp/signature.ts tests/unit/whatsapp-signature.test.ts
git commit -m "feat(whatsapp): verify Meta's signature over the bytes we received

The re-serialised-body failure has its own test. It is how this check
silently stops working -- whitespace and key order change, the HMAC stops
matching, and the usual fix is to turn the check off.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Payload parsing and message flattening

**Files:**
- Create: `src/lib/integrations/whatsapp/payload.ts`
- Create: `tests/unit/whatsapp-payload.test.ts`

**Interfaces:**
- Produces: `type InboundMessage = { wamid: string; phoneNumberId: string; from: string; profileName: string | null; text: string; timestamp: string }`.
- Produces: `flattenWebhookBody(body: unknown): InboundMessage[]` — returns `[]` for anything that is not a text message, and never throws.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/whatsapp-payload.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { flattenWebhookBody } from '@/lib/integrations/whatsapp/payload';

const body = (messages: unknown[], contacts: unknown[] = []) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '551133334444', phone_number_id: '1111' },
            contacts,
            messages,
          },
        },
      ],
    },
  ],
});

const textMessage = (id: string, text: string) => ({
  from: '5511988887777',
  id,
  timestamp: '1786000000',
  type: 'text',
  text: { body: text },
});

describe('flattenWebhookBody', () => {
  it('returns one message per wamid, not one per request', () => {
    const result = flattenWebhookBody(
      body([textMessage('wamid.A', '#EUQUERO'), textMessage('wamid.B', '#OUTRA')]),
    );
    expect(result.map((m) => m.wamid)).toEqual(['wamid.A', 'wamid.B']);
    expect(result[0].phoneNumberId).toBe('1111');
    expect(result[0].text).toBe('#EUQUERO');
  });

  it('picks the profile name up from contacts by wa_id', () => {
    const result = flattenWebhookBody(
      body([textMessage('wamid.A', 'oi')], [
        { wa_id: '5511988887777', profile: { name: 'Joana' } },
      ]),
    );
    expect(result[0].profileName).toBe('Joana');
  });

  it('leaves the profile name null when contacts do not carry it', () => {
    expect(flattenWebhookBody(body([textMessage('wamid.A', 'oi')]))[0].profileName).toBeNull();
  });

  // Delivery and read receipts arrive on the same webhook and carry no
  // participation. Storing them would make the table mostly noise.
  it('ignores status callbacks', () => {
    const statuses = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '1111' },
                statuses: [{ id: 'wamid.A', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    expect(flattenWebhookBody(statuses)).toEqual([]);
  });

  it('ignores non-text messages', () => {
    const audio = { from: '551199', id: 'wamid.C', timestamp: '1786000000', type: 'audio' };
    expect(flattenWebhookBody(body([audio]))).toEqual([]);
  });

  it('returns [] rather than throwing on rubbish', () => {
    expect(flattenWebhookBody(null)).toEqual([]);
    expect(flattenWebhookBody({ entry: 'not an array' })).toEqual([]);
    expect(flattenWebhookBody({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/whatsapp-payload.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `src/lib/integrations/whatsapp/payload.ts`:

```ts
import { z } from 'zod';

/** One inbound text message, flattened out of Meta's nested envelope. */
export interface InboundMessage {
  wamid: string;
  phoneNumberId: string;
  from: string;
  profileName: string | null;
  text: string;
  /** Epoch seconds, as a string — which is how Meta sends it. */
  timestamp: string;
}

const textMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().min(1),
  type: z.literal('text'),
  text: z.object({ body: z.string() }),
});

const contactSchema = z.object({
  wa_id: z.string(),
  profile: z.object({ name: z.string() }).optional(),
});

const bodySchema = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string().min(1) }),
            contacts: z.array(contactSchema).optional(),
            // Anything that is not a text message is dropped below rather than
            // refused here: a delivery receipt is a valid payload we have no
            // use for, not a malformed one.
            messages: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});

/**
 * Meta packs several messages into one POST, so one HTTP request becomes N
 * rows in `webhook_events` and idempotency is per message id.
 *
 * Returns `[]` and never throws. This runs on an unauthenticated route after
 * the signature check, where a 500 on an unexpected shape is a worse answer
 * than an empty list: Meta re-delivers anything it does not see a 200 for, so
 * throwing turns one odd payload into a retry loop.
 */
export function flattenWebhookBody(body: unknown): InboundMessage[] {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return [];

  const out: InboundMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const { metadata, contacts, messages } = change.value;
      if (!messages) continue;

      const names = new Map(
        (contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null] as const),
      );

      for (const raw of messages) {
        const message = textMessageSchema.safeParse(raw);
        if (!message.success) continue;
        out.push({
          wamid: message.data.id,
          phoneNumberId: metadata.phone_number_id,
          from: message.data.from,
          profileName: names.get(message.data.from) ?? null,
          text: message.data.text.body,
          timestamp: message.data.timestamp,
        });
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/whatsapp-payload.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/lib/integrations/whatsapp/payload.ts tests/unit/whatsapp-payload.test.ts
git commit -m "feat(whatsapp): one POST becomes N messages, and rubbish becomes none

Idempotency is per message id, so the envelope has to be flattened before
anything is stored. Returns [] rather than throwing: Meta re-delivers what
it does not see a 200 for, so an exception on an odd payload is a retry
loop rather than an error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The four replies

**Files:**
- Create: `src/lib/integrations/whatsapp/replies.ts`
- Create: `tests/unit/whatsapp-replies.test.ts`

**Interfaces:**
- Produces: `renderReply(input: { status: 'VALID' | 'DUPLICATE' | 'TOO_SOON' | 'OVER_LIMIT'; promotionName: string; nextChanceAt: Date | null; timezone: string; ceiling: number | null }): string`.

These strings are the reference copy. `whatsapp_reply_body` (Task 6) renders the same four in SQL; this module is what the unit tests pin and what the owner edits. **If you change one, change both** — the pgTAP case in Task 6 and the unit case here must not disagree.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/whatsapp-replies.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderReply } from '@/lib/integrations/whatsapp/replies';

const base = {
  promotionName: 'Disney',
  nextChanceAt: null,
  timezone: 'America/Sao_Paulo',
  ceiling: null,
};

describe('renderReply', () => {
  it('confirms a valid entry by name', () => {
    expect(renderReply({ ...base, status: 'VALID' })).toBe(
      'Pronto! Você está participando de Disney. Boa sorte!',
    );
  });

  it('tells a repeat entrant they are already in', () => {
    expect(renderReply({ ...base, status: 'DUPLICATE' })).toBe(
      'Você já está participando de Disney.',
    );
  });

  // Rendered in the Station's timezone, not the server's and not the
  // listener's, which we do not know.
  it('gives the next chance in the Station timezone', () => {
    expect(
      renderReply({
        ...base,
        status: 'TOO_SOON',
        nextChanceAt: new Date('2026-08-10T17:30:00Z'),
      }),
    ).toBe('Você já participou há pouco. Sua próxima chance é às 14:30.');
  });

  it('names the ceiling when there is one', () => {
    expect(renderReply({ ...base, status: 'OVER_LIMIT', ceiling: 3 })).toBe(
      'Você já usou suas 3 chances nesta promoção.',
    );
  });

  it('falls back when the ceiling is unknown', () => {
    expect(renderReply({ ...base, status: 'OVER_LIMIT' })).toBe(
      'Você já usou todas as suas chances nesta promoção.',
    );
  });

  it('falls back when the next chance is unknown', () => {
    expect(renderReply({ ...base, status: 'TOO_SOON' })).toBe(
      'Você já participou há pouco. Tente novamente mais tarde.',
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/whatsapp-replies.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `src/lib/integrations/whatsapp/replies.ts`:

```ts
export type ReplyStatus = 'VALID' | 'DUPLICATE' | 'TOO_SOON' | 'OVER_LIMIT';

export interface ReplyInput {
  status: ReplyStatus;
  promotionName: string;
  /** When the listener may enter again; null when it cannot be computed. */
  nextChanceAt: Date | null;
  /** The Station's IANA timezone (`companies.timezone`). */
  timezone: string;
  /** `promotions.max_entries_per_member`, or null when uncapped. */
  ceiling: number | null;
}

/**
 * The four sentences the bot sends, one per outcome apply_participation
 * returns. The listener hears nothing at all in every other case — an unknown
 * hashtag, a cancelled promotion, a message outside the window (design spec
 * D4): replying to unmatched text would turn the Station's number into a paid
 * loudspeaker for whoever pointed traffic at it.
 *
 * This is copy, not logic. The owner edits it.
 *
 * `whatsapp_reply_body` (migration 0062) renders the same four in SQL, because
 * the reply has to be enqueued in the transaction that wrote the entry. The
 * duplication is deliberate and narrow — six strings — and the pgTAP case in
 * that migration asserts the same text this file does.
 */
export function renderReply(input: ReplyInput): string {
  switch (input.status) {
    case 'VALID':
      return `Pronto! Você está participando de ${input.promotionName}. Boa sorte!`;
    case 'DUPLICATE':
      return `Você já está participando de ${input.promotionName}.`;
    case 'TOO_SOON':
      return input.nextChanceAt
        ? `Você já participou há pouco. Sua próxima chance é às ${formatTime(input.nextChanceAt, input.timezone)}.`
        : 'Você já participou há pouco. Tente novamente mais tarde.';
    case 'OVER_LIMIT':
      return input.ceiling === null
        ? 'Você já usou todas as suas chances nesta promoção.'
        : `Você já usou suas ${input.ceiling} chances nesta promoção.`;
  }
}

function formatTime(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(at);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/whatsapp-replies.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/lib/integrations/whatsapp/replies.ts tests/unit/whatsapp-replies.test.ts
git commit -m "feat(whatsapp): four sentences, and silence everywhere else

The time is rendered in the Station's timezone -- not the server's and not
the listener's, which we do not know.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: The transport

**Files:**
- Create: `src/lib/integrations/whatsapp/transport.ts`
- Create: `src/lib/integrations/whatsapp/graph.ts`
- Create: `src/lib/integrations/whatsapp/fake.ts`
- Create: `tests/unit/whatsapp-transport.test.ts`

**Interfaces:**
- Produces: `interface WhatsAppTransport { sendText(input: { phoneNumberId: string; to: string; body: string }): Promise<SendResult> }`
- Produces: `type SendResult = { ok: true; externalId: string } | { ok: false; retryable: boolean; error: string }`
- Produces: `class GraphTransport implements WhatsAppTransport` (constructor takes the access token and an optional `fetch`), `class FakeTransport implements WhatsAppTransport` (records `sent`, and `failNext(retryable)`).

The `retryable` flag is the whole reason `SendResult` is not a boolean: a bad number must not be retried forever, and a 429 or 5xx must not be discarded.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/whatsapp-transport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { GraphTransport } from '@/lib/integrations/whatsapp/graph';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';

const input = { phoneNumberId: '1111', to: '5511988887777', body: 'oi' };

function stubFetch(status: number, payload: unknown) {
  return async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

describe('GraphTransport', () => {
  it('returns the wamid Meta accepted', async () => {
    const transport = new GraphTransport(
      'token',
      stubFetch(200, { messages: [{ id: 'wamid.OUT' }] }),
    );
    expect(await transport.sendText(input)).toEqual({ ok: true, externalId: 'wamid.OUT' });
  });

  it('marks a rate limit retryable', async () => {
    const transport = new GraphTransport('token', stubFetch(429, { error: { message: 'slow down' } }));
    const result = await transport.sendText(input);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('marks a server error retryable', async () => {
    const transport = new GraphTransport('token', stubFetch(503, {}));
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: true });
  });

  // A bad number never becomes a good one. Retrying it forever is how an
  // outbox fills with rows nobody looks at.
  it('marks a rejected recipient permanent', async () => {
    const transport = new GraphTransport(
      'token',
      stubFetch(400, { error: { message: 'Invalid parameter' } }),
    );
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: false });
  });

  it('marks a network failure retryable rather than throwing', async () => {
    const transport = new GraphTransport('token', async () => {
      throw new Error('ECONNRESET');
    });
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: true });
  });
});

describe('FakeTransport', () => {
  it('records what it was asked to send', async () => {
    const transport = new FakeTransport();
    await transport.sendText(input);
    expect(transport.sent).toEqual([input]);
  });

  it('fails once when told to', async () => {
    const transport = new FakeTransport();
    transport.failNext(true);
    expect(await transport.sendText(input)).toMatchObject({ ok: false, retryable: true });
    expect(await transport.sendText(input)).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/whatsapp-transport.test.ts`
Expected: FAIL — cannot resolve the modules.

- [ ] **Step 3: Write the three modules**

`src/lib/integrations/whatsapp/transport.ts`:

```ts
/** What happened to one outbound message. */
export type SendResult =
  | { ok: true; externalId: string }
  | { ok: false; retryable: boolean; error: string };

export interface SendTextInput {
  phoneNumberId: string;
  to: string;
  body: string;
}

/**
 * The seam the master spec means by a "decoupled" integration layer: a module
 * boundary, not a network hop. It is what lets CI prove the whole block with no
 * production secret anywhere near it.
 *
 * `retryable` is why SendResult is not a boolean. A rejected recipient never
 * becomes a good one and must not be retried; a 429 or a 5xx must not be
 * discarded.
 */
export interface WhatsAppTransport {
  sendText(input: SendTextInput): Promise<SendResult>;
}
```

`src/lib/integrations/whatsapp/graph.ts`:

```ts
import type { SendResult, SendTextInput, WhatsAppTransport } from './transport';

const GRAPH_VERSION = 'v21.0';

/**
 * The real Meta Graph API client.
 *
 * Every reply this block sends is a response to an inbound message, so it falls
 * inside WhatsApp's 24-hour customer service window where free-form text is
 * allowed and no approved template is needed (design spec D5). The first
 * Station-initiated message — a draw result, Block 6 — will need a template,
 * and this method is not it.
 */
export class GraphTransport implements WhatsAppTransport {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText({ phoneNumberId, to, body }: SendTextInput): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { body, preview_url: false },
          }),
        },
      );
    } catch (cause) {
      // A connection that failed says nothing about the request being wrong.
      return { ok: false, retryable: true, error: String(cause) };
    }

    const payload: unknown = await response.json().catch(() => ({}));

    if (response.ok) {
      const id = extractMessageId(payload);
      return id
        ? { ok: true, externalId: id }
        : { ok: false, retryable: true, error: 'accepted without a message id' };
    }

    // 429 and 5xx are the cases that come back on their own. Everything else —
    // a malformed number, a revoked token, a number outside the allowed list —
    // returns the same answer however many times it is asked.
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, retryable, error: extractError(payload) ?? `HTTP ${response.status}` };
  }
}

function extractMessageId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages[0];
  if (typeof first !== 'object' || first === null) return null;
  const id = (first as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function extractError(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}
```

`src/lib/integrations/whatsapp/fake.ts`:

```ts
import type { SendResult, SendTextInput, WhatsAppTransport } from './transport';

/** Records sends instead of making them. The transport CI uses. */
export class FakeTransport implements WhatsAppTransport {
  readonly sent: SendTextInput[] = [];
  private failure: { retryable: boolean } | null = null;
  private counter = 0;

  /** The next send fails once, then normal service resumes. */
  failNext(retryable: boolean): void {
    this.failure = { retryable };
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    if (this.failure) {
      const { retryable } = this.failure;
      this.failure = null;
      return { ok: false, retryable, error: 'fake failure' };
    }
    this.sent.push(input);
    this.counter += 1;
    return { ok: true, externalId: `wamid.FAKE${this.counter}` };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/whatsapp-transport.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/lib/integrations/whatsapp/transport.ts src/lib/integrations/whatsapp/graph.ts src/lib/integrations/whatsapp/fake.ts tests/unit/whatsapp-transport.test.ts
git commit -m "feat(whatsapp): a transport with a retryable flag, and a fake for CI

SendResult is not a boolean because a rejected recipient never becomes a
good one, and a 429 must not be discarded. The two cases need different
answers and the outbox needs to know which it got.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: The webhook route

**Files:**
- Create: `src/app/api/webhooks/whatsapp/route.ts`
- Create: `tests/unit/whatsapp-route.test.ts`

**Interfaces:**
- Consumes: `verifyMetaSignature` (Task 7), `flattenWebhookBody` (Task 8), `getSystemSupabase()` from `src/lib/supabase` (read that module first and follow its existing export name for the service-role client).
- Produces: `GET` (Meta's verification handshake) and `POST` (receipt) at `/api/webhooks/whatsapp`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/whatsapp-route.test.ts`. Mock the Supabase module so this stays a unit test; assert the four behaviours that are the route's whole job:

```ts
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const inserted: unknown[] = [];
vi.mock('@/lib/supabase', () => ({
  getSystemSupabase: () => ({
    from: () => ({
      upsert: (rows: unknown) => {
        inserted.push(rows);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

const SECRET = 'test-app-secret';
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';

const { GET, POST } = await import('@/app/api/webhooks/whatsapp/route');

const sign = (raw: string) =>
  `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;

const post = (raw: string, signature: string | null) =>
  POST(
    new Request('http://localhost/api/webhooks/whatsapp', {
      method: 'POST',
      body: raw,
      headers: signature ? { 'x-hub-signature-256': signature } : {},
    }),
  );

const payload = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: '1111' },
            messages: [
              { id: 'wamid.A', from: '5511988887777', timestamp: '1786000000',
                type: 'text', text: { body: '#EUQUERO' } },
            ],
          },
        },
      ],
    },
  ],
});

beforeEach(() => { inserted.length = 0; });

describe('GET /api/webhooks/whatsapp', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const response = await GET(
      new Request(
        'http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345',
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('12345');
  });

  it('refuses a wrong verify token', async () => {
    const response = await GET(
      new Request(
        'http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345',
      ),
    );
    expect(response.status).toBe(403);
  });
});

describe('POST /api/webhooks/whatsapp', () => {
  it('stores one row per message and answers 200', async () => {
    const response = await post(payload, sign(payload));
    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(1);
  });

  // Writing unverified events would let anyone fill the table.
  it('refuses an invalid signature and writes nothing', async () => {
    const response = await post(payload, 'sha256=deadbeef');
    expect(response.status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a missing signature and writes nothing', async () => {
    const response = await post(payload, null);
    expect(response.status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  // Meta re-delivers anything it does not see a 200 for.
  it('answers 200 to a signed payload carrying nothing we use', async () => {
    const statuses = JSON.stringify({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: '1111' },
        statuses: [{ id: 'wamid.A', status: 'read' }] } }] }],
    });
    const response = await post(statuses, sign(statuses));
    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/whatsapp-route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Write the route**

Read `src/lib/supabase/` first and use its existing service-role client accessor; do not create a second one. Create `src/app/api/webhooks/whatsapp/route.ts`:

```ts
import { getSystemSupabase } from '@/lib/supabase';
import { flattenWebhookBody } from '@/lib/integrations/whatsapp/payload';
import { verifyMetaSignature } from '@/lib/integrations/whatsapp/signature';

// The raw body is the signed artefact. Next must not parse it for us.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Meta's one-time verification handshake. It is how the callback URL is
 * registered, and it runs again whenever the URL is re-saved in the App
 * dashboard.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = process.env.WHATSAPP_VERIFY_TOKEN;

  if (
    !token ||
    url.searchParams.get('hub.mode') !== 'subscribe' ||
    url.searchParams.get('hub.verify_token') !== token
  ) {
    return new Response('forbidden', { status: 403 });
  }
  return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
}

/**
 * Receipt, and nothing more. The order below is the security of this route:
 * verify the signature over the bytes received, then store, then answer 200
 * fast — Meta re-delivers anything slow, and a duplicate delivery is normal
 * traffic rather than an attack.
 *
 * Nothing here decides anything about a promotion. That is
 * ingest_whatsapp_event's, called by the worker, so this route stays inside
 * Meta's timeout however slow the database is.
 */
export async function POST(request: Request): Promise<Response> {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    // Refusing to serve beats accepting unverified traffic. This is a
    // deployment fault, not a caller fault, and 503 says so.
    return new Response('not configured', { status: 503 });
  }

  const raw = await request.text();

  if (!verifyMetaSignature(raw, request.headers.get('x-hub-signature-256'), appSecret)) {
    // Nothing is written. Storing unverified events would let anyone fill the
    // table by POSTing to a URL that is, by design, public.
    return new Response('unauthorized', { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('ok', { status: 200 });
  }

  const messages = flattenWebhookBody(body);
  if (messages.length === 0) {
    // Delivery and read receipts land here. They carry no participation and
    // storing them would make the table mostly noise before anything reads it.
    return new Response('ok', { status: 200 });
  }

  const { error } = await getSystemSupabase()
    .from('webhook_events')
    .upsert(
      messages.map((message) => ({
        provider: 'WHATSAPP' as const,
        external_id: message.wamid,
        payload: {
          metadata: { phone_number_id: message.phoneNumberId },
          from: message.from,
          profile_name: message.profileName,
          text: message.text,
          timestamp: message.timestamp,
        },
      })),
      { onConflict: 'provider,external_id', ignoreDuplicates: true },
    );

  if (error) {
    // 500 makes Meta re-deliver, which is what we want: the message is not
    // stored, so it is not lost either.
    return new Response('storage failed', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/whatsapp-route.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/app/api/webhooks/whatsapp/route.ts tests/unit/whatsapp-route.test.ts
git commit -m "feat(whatsapp): receive, verify, store, and answer 200 fast

Verification comes before storage because the URL is public by design and an
unverified write is anybody's write. Nothing here decides anything about a
promotion, so the route stays inside Meta's timeout however slow the
database is.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: The worker

**Files:**
- Create: `src/services/whatsapp.ts`
- Create: `src/app/api/worker/tick/route.ts`
- Create: `tests/unit/whatsapp-worker.test.ts`

**Interfaces:**
- Produces: `runTick(deps: { supabase: SupabaseClient<Database>; transport: WhatsAppTransport }): Promise<{ ingested: number; sent: number; failed: number }>`
- Produces: `POST /api/worker/tick`, which rejects any request whose `x-worker-secret` header does not equal `WORKER_TICK_SECRET`.

Constants, from the spec: **50** events and **50** outbox rows per tick; retry ladder **1s, 4s, 16s, 64s, 256s**, parked at **5** attempts.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/whatsapp-worker.test.ts` covering the four behaviours that are not the database's:

```ts
import { describe, expect, it } from 'vitest';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';
import { BACKOFF_SECONDS, nextAttemptDelay } from '@/services/whatsapp';

describe('nextAttemptDelay', () => {
  it('follows the ladder the spec fixed', () => {
    expect(BACKOFF_SECONDS).toEqual([1, 4, 16, 64, 256]);
    expect(nextAttemptDelay(0)).toBe(1);
    expect(nextAttemptDelay(3)).toBe(64);
  });

  // Parked, not retried forever. An outbox that keeps rows nobody looks at is
  // indistinguishable from one that is working.
  it('returns null once the attempts are spent', () => {
    expect(nextAttemptDelay(5)).toBeNull();
    expect(nextAttemptDelay(9)).toBeNull();
  });
});

describe('FakeTransport wiring', () => {
  it('is the transport a tick uses when no token is configured', async () => {
    const transport = new FakeTransport();
    const result = await transport.sendText({ phoneNumberId: '1', to: '2', body: 'x' });
    expect(result).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/whatsapp-worker.test.ts`
Expected: FAIL — cannot resolve `@/services/whatsapp`.

- [ ] **Step 3: Write the service**

Create `src/services/whatsapp.ts`:

```ts
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import type { WhatsAppTransport } from '@/lib/integrations/whatsapp/transport';

/** Batch caps, so one tick stays inside a serverless function timeout. */
export const EVENT_BATCH = 50;
export const OUTBOX_BATCH = 50;

/**
 * The retry ladder, in seconds. Five attempts and then the row is parked —
 * an outbox that keeps retrying rows nobody looks at is indistinguishable
 * from one that is working.
 */
export const BACKOFF_SECONDS = [1, 4, 16, 64, 256] as const;

/** Seconds to wait before attempt number `attempts + 1`, or null when spent. */
export function nextAttemptDelay(attempts: number): number | null {
  return BACKOFF_SECONDS[attempts] ?? null;
}

export interface TickResult {
  ingested: number;
  sent: number;
  failed: number;
}

/**
 * One tick. It holds NO rule about promotions, listeners or entries — those are
 * ingest_whatsapp_event's, in one transaction per event. That is what makes the
 * master spec's promise real: swapping this polling loop for pgmq later changes
 * the trigger and nothing else.
 *
 * Each event is ingested in its own transaction, so one poisonous event cannot
 * roll back a batch. A backlog larger than the cap simply takes more ticks;
 * nothing is dropped, because the selection reads the table rather than being
 * handed a list.
 */
export async function runTick(deps: {
  supabase: SupabaseClient<Database>;
  transport: WhatsAppTransport;
}): Promise<TickResult> {
  const { supabase, transport } = deps;
  const result: TickResult = { ingested: 0, sent: 0, failed: 0 };

  const { data: events } = await supabase
    .from('webhook_events')
    .select('id')
    .in('status', ['RECEIVED', 'FAILED'])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${new Date().toISOString()}`)
    .order('received_at', { ascending: true })
    .limit(EVENT_BATCH);

  for (const event of events ?? []) {
    const { error } = await supabase.rpc('ingest_whatsapp_event', { p_event_id: event.id });
    if (error) {
      await markEventFailed(supabase, event.id, error.message);
      result.failed += 1;
    } else {
      result.ingested += 1;
    }
  }

  const { data: pending } = await supabase
    .from('outbox_messages')
    .select('id, integration_id, to_phone, body, attempts, integrations(phone_number_id)')
    .eq('status', 'PENDING')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(OUTBOX_BATCH);

  for (const row of pending ?? []) {
    const phoneNumberId = row.integrations?.phone_number_id;
    if (!phoneNumberId) continue;

    const send = await transport.sendText({
      phoneNumberId,
      to: row.to_phone,
      body: row.body,
    });

    if (send.ok) {
      await supabase
        .from('outbox_messages')
        .update({ status: 'SENT', external_id: send.externalId, sent_at: new Date().toISOString() })
        .eq('id', row.id);
      result.sent += 1;
      continue;
    }

    const attempts = row.attempts + 1;
    const delay = send.retryable ? nextAttemptDelay(row.attempts) : null;

    await supabase
      .from('outbox_messages')
      .update(
        delay === null
          ? { status: 'FAILED', attempts, last_error: send.error }
          : {
              status: 'PENDING',
              attempts,
              last_error: send.error,
              next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
            },
      )
      .eq('id', row.id);
    result.failed += 1;
  }

  return result;
}

async function markEventFailed(
  supabase: SupabaseClient<Database>,
  id: string,
  message: string,
): Promise<void> {
  const { data } = await supabase
    .from('webhook_events')
    .select('attempts')
    .eq('id', id)
    .single();

  const attempts = (data?.attempts ?? 0) + 1;
  const delay = nextAttemptDelay(attempts - 1);

  await supabase
    .from('webhook_events')
    .update({
      status: 'FAILED',
      attempts,
      last_error: message,
      next_attempt_at:
        delay === null ? null : new Date(Date.now() + delay * 1000).toISOString(),
    })
    .eq('id', id);
}
```

- [ ] **Step 4: Write the tick route**

Create `src/app/api/worker/tick/route.ts`:

```ts
import { getSystemSupabase } from '@/lib/supabase';
import { GraphTransport } from '@/lib/integrations/whatsapp/graph';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';
import { runTick } from '@/services/whatsapp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * What pg_cron calls, through pg_net, every 10 seconds. The shared secret is
 * the whole of its authentication: this endpoint drains queues and must not be
 * reachable by anyone who finds the URL.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.WORKER_TICK_SECRET;
  if (!secret) return new Response('not configured', { status: 503 });
  if (request.headers.get('x-worker-secret') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  // No token configured means no real sending is possible. The fake keeps the
  // ingestion half working in a local stack rather than failing the tick.
  const transport = token ? new GraphTransport(token) : new FakeTransport();

  const result = await runTick({ supabase: getSystemSupabase(), transport });
  return Response.json(result);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/whatsapp-worker.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/services/whatsapp.ts src/app/api/worker/tick/route.ts tests/unit/whatsapp-worker.test.ts
git commit -m "feat(worker): a tick that holds no rule

One transaction per event, so one poisonous event cannot roll back a batch,
and a backlog past the cap simply takes more ticks. The worker knowing
nothing about promotions is what makes swapping this loop for pgmq a change
to the trigger and nothing else.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Isolation and the race

**Files:**
- Create: `tests/isolation/whatsapp.test.ts`

**Interfaces:**
- Consumes: `tests/isolation/harness.ts` — read it first. Use `provisionCustomer`, `signInAs`, `admin`. `admin` is the service-role client; it is what stands in for the worker.

The race is the centrepiece. `RACE_ROUNDS = 12` matches `tests/isolation/participations.test.ts:661`, and the reason is 4c's: **a single green run does not prove a probabilistic detector.**

- [ ] **Step 1: Write the failing test**

Create `tests/isolation/whatsapp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { admin, provisionCustomer, signInAs } from './harness';

const RACE_ROUNDS = 12;

describe('the WhatsApp door', () => {
  it('is closed to an ordinary signed-in user', async () => {
    const customer = await provisionCustomer('wa-gate');
    const client = await signInAs(customer.ownerEmail, customer.ownerPassword);

    const { error } = await client.rpc('ingest_whatsapp_event', {
      p_event_id: '00000000-0000-0000-0000-000000000000',
    });

    // The grant is the defence; this is what proves the defence is there.
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied|does not exist/i);
  });

  it('is closed to an anonymous caller', async () => {
    const { error } = await (await import('./harness')).anonClient.rpc(
      'ingest_whatsapp_event',
      { p_event_id: '00000000-0000-0000-0000-000000000000' },
    );
    expect(error).not.toBeNull();
  });

  it('lets exactly one of two simultaneous messages become the entry', async () => {
    // Build a Station with an integration and a once-only promotion, then fire
    // two DIFFERENT message ids from the same phone at the same instant. The
    // ids differ, so idempotency cannot be what saves us -- only the advisory
    // lock in apply_participation and the partial unique index can.
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const fixture = await seedPromotionWithIntegration(`race-${round}`);

      const [a, b] = await Promise.all([
        admin.rpc('ingest_whatsapp_event', { p_event_id: fixture.eventA }),
        admin.rpc('ingest_whatsapp_event', { p_event_id: fixture.eventB }),
      ]);

      expect(a.error).toBeNull();
      expect(b.error).toBeNull();

      const { count } = await admin
        .from('participations')
        .select('id', { count: 'exact', head: true })
        .eq('promotion_id', fixture.promotionId)
        .eq('status', 'VALID');

      expect(count, `round ${round} produced ${count} valid entries`).toBe(1);
    }
  }, 120_000);
});
```

Write `seedPromotionWithIntegration(label)` in the same file. It must: provision a customer, insert an `integrations` row through `admin`, insert a promotion with `whatsapp_enabled`, a hashtag unique to the label, and a window containing `now()`, then insert **two** `webhook_events` rows with different `external_id`s, the same `from`, the same `phone_number_id` and the same `timestamp`. It returns `{ promotionId, eventA, eventB }`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:isolation`
Expected: FAIL — the seed helper does not exist yet, then the assertions.

- [ ] **Step 3: Implement the seed helper and make the suite pass**

Follow the fixture style in `tests/isolation/participations.test.ts`. Add an `anonClient` export to `tests/isolation/harness.ts` if it is not already exported — an anon-key client with no session.

- [ ] **Step 4: Run it and confirm every round**

Run: `npm run test:isolation`
Expected: PASS. If any round reports 2, the lock or the index is not doing its job — **do not** re-run until it goes green; that is the failure the twelve rounds exist to catch.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add tests/isolation/whatsapp.test.ts tests/isolation/harness.ts
git commit -m "test(whatsapp): the door is shut, and the race runs twelve times

Two different message ids from the same phone at the same instant, so
idempotency cannot be what saves the invariant -- only the advisory lock and
the partial unique index can. Twelve rounds because one green run does not
prove a probabilistic detector, which is the lesson 4c paid for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Scheduling, the runbook, and the block report

**Files:**
- Create: `supabase/migrations/0063_schedule_worker_tick.sql`
- Create: `docs/block-5a-runbook.md`
- Create: `docs/block-5a-report.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a `pg_cron` job named `whatsapp-worker-tick`, the operator runbook, and the block's verification report.

- [ ] **Step 1: Write the scheduling migration**

Create `supabase/migrations/0063_schedule_worker_tick.sql`:

```sql
-- The trigger, and deliberately the only thing that knows the worker exists.
--
-- Second-level schedules need pg_cron >= 1.5. Verify on the target with
--   select extversion from pg_extension where extname = 'pg_cron';
-- and fall back to '* * * * *' (one minute) if it is older; nothing breaks, the
-- backlog just drains more slowly.
--
-- The URL and the shared secret are per-environment and are NOT in this file:
-- committing them would put a secret in the repository and pin the deployment
-- to whatever host was current the day it was written. The runbook
-- (docs/block-5a-runbook.md) sets them through Vault, which is where a hosted
-- Supabase project keeps this kind of value.

create extension if not exists pg_cron with schema cron;
create extension if not exists pg_net with schema extensions;

-- Idempotent: re-running this migration against a database that already has the
-- job replaces it rather than raising.
select cron.unschedule('whatsapp-worker-tick')
where exists (select 1 from cron.job where jobname = 'whatsapp-worker-tick');

select cron.schedule(
  'whatsapp-worker-tick',
  '10 seconds',
  $$
  select net.http_post(
    url     := current_setting('app.worker_tick_url', true),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-worker-secret', current_setting('app.worker_tick_secret', true)),
    body    := '{}'::jsonb
  ) where current_setting('app.worker_tick_url', true) is not null;
  $$
);

comment on extension pg_net is
  'Lets pg_cron reach the worker tick over HTTP. The database calling the app is the one direction this block needs; nothing calls back the other way except the app''s own service-role client.';
```

- [ ] **Step 2: Verify the job exists**

Run: `npm run db:reset` then, against the local stack:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select jobname, schedule from cron.job where jobname = 'whatsapp-worker-tick';"
```
Expected: one row. If `pg_cron` is unavailable locally, record that in the report and verify on the hosted project instead — do not silently skip it.

- [ ] **Step 3: Write the runbook**

Create `docs/block-5a-runbook.md`. It must be executable by the owner without reading any code, and cover, in order:

1. **The three secrets**, and that they go in `.env.local` (or Vercel project settings), never in the repository and never into a chat: `WHATSAPP_APP_SECRET` (Meta App → Settings → Basic → App Secret), `WHATSAPP_VERIFY_TOKEN` (any string you invent, used once), `WHATSAPP_ACCESS_TOKEN` (System User token with `whatsapp_business_messaging`), plus `WORKER_TICK_SECRET` (any long random string).
2. **The database settings** for the cron job: `alter database postgres set app.worker_tick_url = '<https://your-app>/api/worker/tick';` and the same for `app.worker_tick_secret`.
3. **The `integrations` row** — the SQL insert, with `phone_number_id` from Meta → WhatsApp → API Setup, and `enabled = true` only once the rest is in place.
4. **Registering the callback** — Meta → WhatsApp → Configuration → Callback URL `https://<host>/api/webhooks/whatsapp`, the verify token from step 1, and subscribing to the `messages` field. For a local test, the tunnel command.
5. **The end-to-end check:** send `#<hashtag>` from a real phone; expect a reply; then confirm with the three queries — the `webhook_events` row `DONE`/`recorded`, the `participations` row `VALID` with `source = 'WHATSAPP'` and `created_by` null, and the `outbox_messages` row `SENT` with a `wamid`.
6. **What to do when nothing happens** — the outcome values and what each means, taken from the `webhook_events.outcome` column comment.

- [ ] **Step 4: Write the block report**

Create `docs/block-5a-report.md`, following `docs/block-4c-report.md`'s structure: what was built, the gate table with **this block's own numbers** (lint, typecheck, unit count, pgTAP count, isolation count, e2e), every decision D1–D9 with where it landed in code, what was deliberately left out, and an honest "Concerns" section. Two entries belong in Concerns before anything else is added:

- **`whatsapp_local_phone` strips +55 only.** A Brazilian mobile that gained its ninth digit after the listener was registered still reads as a different person, and no other country's numbering is handled. Named because it will produce duplicate listeners in production, not because it is theoretical.
- **The reply copy exists twice** — `replies.ts` and `whatsapp_reply_body` (0062) — because the reply must be enqueued in the transaction that writes the entry. Six strings, asserted in both suites, and the first place to look when a reply reads oddly.

- [ ] **Step 5: Run the whole gate**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test && npm run test:isolation && npm run test:e2e
```
Expected: all pass. Record the real numbers in the report — not estimates.

- [ ] **Step 6: Commit and open the PR**

```bash
git add supabase/migrations/0063_schedule_worker_tick.sql docs/block-5a-runbook.md docs/block-5a-report.md
git commit -m "docs(block-5a): the runbook the owner runs, and what the gates actually said

The cron job carries no URL and no secret: both are per-environment
settings, and committing them would put a secret in the repository and pin
the deployment to one host.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin block-5a
gh pr create --base main --title "Block 5a — The WhatsApp spine" --body "<summary, gate table, and the two Concerns from the report>"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: §3.1→1, §3.2→2, §3.3→3, §3.4→1/2/3 (RLS with no policy, asserted in each), §3.5→4, §4.1→11, §4.2→12, §4.3→6, §5→5, §6.1→10, §6.2→9, §6.3→2/12 (outcomes and the ladder), §6.4→14, §7→7–13, §8→nothing (correctly — it is the out-of-scope list), §9→nothing (carried defects, untouched by design), §10→D8, implemented in Task 6 and flagged in the Task 14 report.

**One gap found and closed while reviewing:** the design says the audit row carries no phone, but nothing would have failed if it did. Task 6's pgTAP now asserts it directly (`detail::text like '%98888%'` returns zero rows), because a rule belonging to another block is exactly the kind that no test in this block would otherwise notice breaking.

**Type consistency.** `SendResult`/`SendTextInput`/`WhatsAppTransport` (Task 10) are used unchanged in Task 12. `InboundMessage` (Task 8) is consumed only inside Task 11. `nextAttemptDelay`/`BACKOFF_SECONDS` are defined in Task 12 and asserted in its own test. `apply_member_lookup`/`apply_member_creation`/`apply_member_link` are declared in Task 5 and called in Task 6 with the same arities their `revoke` statements name. `finish_whatsapp_event` and `whatsapp_reply_body` are called in Task 6 and specified in the same task.

**Known duplication, accepted:** the four reply strings exist in `replies.ts` and in `whatsapp_reply_body`. The SQL copy is required — the reply must be enqueued inside the transaction that writes the entry — and both suites assert the same text. It is named in the report rather than hidden.
