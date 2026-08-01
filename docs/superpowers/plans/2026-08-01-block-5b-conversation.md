# Block 5b — The conversation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bot holds a short conversation — one composed consent message, then the listener details the promotion asks for, then its questions — and enters the listener only when it completes.

**Architecture:** The step list is computed once when the hashtag arrives and stored; each inbound message advances a cursor. The conversation is a pure function of (steps, answers, message), so it is testable with no database and no WhatsApp. Everything is written in one transaction on the last step. Conversation state lives behind a `ConversationStore` interface — Postgres by default, Redis by environment variable — while the per-conversation lock stays in Postgres so it works for both.

**Tech Stack:** Next.js App Router route handlers, TypeScript strict, Supabase Postgres 17 (plpgsql, RLS), Zod, Vitest, pgTAP, Playwright, the isolation harness in `tests/isolation/harness.ts`, WhatsApp Cloud API interactive messages.

**Spec:** `docs/superpowers/specs/2026-08-01-block-5b-conversation-design.md`. Read it before Task 1. Decision references (D1–D10) point at its §2.

## Global Constraints

- **Everything in English** — code, comments, identifiers, commit messages. The only Portuguese is listener-facing copy.
- **Vocabulary:** `Station` = a `companies` row, `Organization` = an `organizations` row, `Member`/listener = a `members` row.
- **Migrations are sequential.** Next free number is `0065`. Never edit a migration that has been applied outside a local stack; within this unmerged branch, editing in place is sanctioned with a clean `supabase db reset` as the proof.
- **Every gate is checked beside its own operation**, never inside a shared helper. Private cores are `SECURITY INVOKER` with EXECUTE granted to nobody — the pattern `apply_participation` (0054) and the Block 5a cores (0061) established.
- **`service_role` needs an explicit grant on every new table.** This schema revokes Supabase's default ACL and grants back by hand; 5a shipped three tables with the comment and without the grant, and the whole block was non-functional. Every new table gets `revoke all … from anon, authenticated`, `revoke truncate … from service_role`, and the exact verbs the code issues — no more.
- **No personal data in `audit_logs`.** Block 3's rule, absolute.
- **The gate before every commit:** `npm run lint && npm run typecheck && npm test`, plus `npm run db:test` when SQL changes. On `npm run test:isolation` only a **guard-complete** run counts — there is a known worker-death flake; re-run rather than record a short run.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **This repo sets `noUncheckedIndexedAccess`.** In tests `toBe(v)`/`toEqual(v)`/`toBeNull()` are safe with optional chaining; `toBeUndefined()`/`toBeFalsy()` can pass vacuously on an empty array.

---

## File Structure

**New migrations**

| File | Responsibility |
|---|---|
| `supabase/migrations/0065_conversation_tables.sql` | `promotions.data_validity_months`, `member_field_confirmations` + backfill, `promotion_refusals`, `whatsapp_conversations` |
| `supabase/migrations/0066_conversation_rpcs.sql` | `whatsapp_conversation_steps`, `start_whatsapp_conversation`, `complete_whatsapp_conversation`, `record_whatsapp_refusal` |
| `supabase/migrations/0067_ingest_starts_conversation.sql` | `ingest_whatsapp_event` diverts: start a conversation instead of entering |

**New TypeScript**

| File | Responsibility |
|---|---|
| `src/lib/integrations/whatsapp/interactive.ts` | Building Cloud API interactive payloads: buttons with an optional image header, and lists |
| `src/lib/conversation/steps.ts` | `Step` types and the step-list shape |
| `src/lib/conversation/engine.ts` | The pure function: (conversation, message) → (outbound, next state) |
| `src/lib/conversation/store.ts` | `ConversationStore` interface and its key type |
| `src/lib/conversation/postgres-store.ts` | Default driver |
| `src/lib/conversation/redis-store.ts` | Optional driver, selected by env |
| `src/services/conversation.ts` | The turn: load, run the engine, persist, enqueue |

**Modified**

| File | Change |
|---|---|
| `src/lib/integrations/whatsapp/transport.ts` | `sendInteractive` beside `sendText` |
| `src/lib/integrations/whatsapp/graph.ts` | Real implementation |
| `src/lib/integrations/whatsapp/fake.ts` | Records interactive sends too |
| `src/services/whatsapp.ts` | The tick runs conversation turns |
| `src/app/api/webhooks/whatsapp/route.ts` | Fires a tick after storing (D9); qualifies the `wamid` comment (spec §8) |
| `src/lib/env.ts` | `REDIS_URL`, optional |
| `supabase/tests/06_whatsapp.test.sql` | 5a's single-message assertions become conversation assertions |

---

### Task 1: The three tables and the column

**Files:**
- Create: `supabase/migrations/0065_conversation_tables.sql`
- Create: `supabase/tests/08_conversation.test.sql`

**Interfaces:**
- Produces: `promotions.data_validity_months integer`; tables `member_field_confirmations`, `promotion_refusals`, `whatsapp_conversations`.

- [ ] **Step 1: Write the failing pgTAP file**

Create `supabase/tests/08_conversation.test.sql` beginning `begin; select plan(14);` and asserting, in this order: the column exists on `promotions`; a negative value is refused (`throws_ok`, `23514`); each of the three tables exists; RLS is enabled on all three; `service_role` holds `SELECT` on `member_field_confirmations`; `anon` holds no `TRUNCATE` on any of the three; a `member_field_confirmations` row whose `(member_id, organization_id)` disagree is refused (`23503`); and inserting the same `(member_id, field)` twice is refused (`23505`). End with `select * from finish(); rollback;`.

Seed fixtures with UUIDs in the `…0008xx` range so they cannot collide with `06_whatsapp`'s `…0005xx` block.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `column "data_validity_months" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0065_conversation_tables.sql`:

```sql
-- Block 5b. The conversation needs three things the schema does not have: a
-- per-promotion freshness rule, a per-field record of when a listener's data
-- was last confirmed, and somewhere to put a refusal that is not a bad entry.

-- D1. Null means no freshness requirement and a filled field is never asked
-- again; 0 means every requested field is asked every time. It pairs with
-- requested_fields, which says WHICH fields -- this says how old they may be.
alter table public.promotions
  add column data_validity_months integer
    check (data_validity_months is null or data_validity_months >= 0);

comment on column public.promotions.data_validity_months is
  'How old a value on the listener''s record may be and still be accepted for this promotion, in months. Null = no requirement. 0 = ask every time. Pairs with requested_fields: that column says which fields, this one says how stale they may be.';

-- D2. PER FIELD, not per record, and the reason is the listener who uses the
-- system most: one timestamp on members would be refreshed by every
-- conversation, so somebody entering weekly through promotions that ask only
-- for city would never be asked for their address again at any age. The
-- feature would switch itself off for the heaviest participant.
--
-- `field` is the SAME enum the promotion marks, so the two sides cannot name
-- different things.
create table public.member_field_confirmations (
  member_id       uuid not null,
  organization_id uuid not null references public.organizations (id),
  field           public.promotion_requested_field not null,
  confirmed_at    timestamptz not null default now(),

  primary key (member_id, field),

  constraint member_field_confirmations_member_org_fk
    foreign key (member_id, organization_id)
    references public.members (id, organization_id)
);

create index member_field_confirmations_member
  on public.member_field_confirmations (member_id);

alter table public.member_field_confirmations enable row level security;

-- Unlike webhook_events, this is not a system-only table: the operator's
-- screens will show when a field was last confirmed. The policy mirrors
-- members_select_reachable (0035) so a row is visible exactly when its listener
-- is.
create policy member_field_confirmations_select_reachable
  on public.member_field_confirmations for select to authenticated
  using (public.member_reachable(member_id, organization_id, 'members.view'));

revoke all on public.member_field_confirmations from anon, authenticated;
revoke truncate on public.member_field_confirmations from service_role;
grant select on public.member_field_confirmations to authenticated;
grant select, insert, update on public.member_field_confirmations to service_role;

-- D3. Data an operator typed counts as confirmed when it was typed. The
-- backfill uses created_at and NOT updated_at: a 2024 record whose phone was
-- corrected yesterday would otherwise report a fresh address, and created_at
-- never claims a field is newer than can be proved.
insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at)
select m.id, m.organization_id, f.field, m.created_at
from public.members m
cross join lateral (values
  ('full_name'::public.promotion_requested_field, m.full_name),
  ('address',          m.address_line),
  ('city',             m.city),
  ('neighbourhood',    m.neighbourhood),
  ('age',              m.birth_date::text),
  ('cpf',              m.cpf_hash),
  ('passport',         m.passport),
  ('discovery_source', m.discovery_source)
) as f(field, value)
where m.deleted_at is null
  and nullif(btrim(coalesce(f.value, '')), '') is not null
on conflict do nothing;

-- D4. A refusal is not a bad entry. Block 4c's reasoning holds: a fifth
-- participation_status would let the draw's "VALID only" filter go on looking
-- complete while hiding a different kind of fact.
create table public.promotion_refusals (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null,
  member_id       uuid not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  refused_at      timestamptz not null default now(),
  source          public.participation_source not null,

  constraint promotion_refusals_promotion_fk
    foreign key (promotion_id, company_id)
    references public.promotions (id, company_id),
  constraint promotion_refusals_member_org_fk
    foreign key (member_id, organization_id)
    references public.members (id, organization_id),
  constraint promotion_refusals_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);

create index promotion_refusals_promotion on public.promotion_refusals (promotion_id);

alter table public.promotion_refusals enable row level security;

create policy promotion_refusals_select_reachable
  on public.promotion_refusals for select to authenticated
  using (public.has_permission('promotions.view', company_id));

revoke all on public.promotion_refusals from anon, authenticated;
revoke truncate on public.promotion_refusals from service_role;
grant select on public.promotion_refusals to authenticated;
grant select, insert on public.promotion_refusals to service_role;

-- D5/D6. The default ConversationStore. The Redis driver holds the same shape
-- with a native TTL and nothing to sweep; this one carries expires_at and the
-- worker sweeps it on the tick it already runs.
--
-- Keyed on (integration, phone) and NOT on the listener: the key has to work
-- before anybody has been resolved.
create table public.whatsapp_conversations (
  integration_id uuid not null references public.integrations (id),
  phone          text not null check (length(btrim(phone)) > 0),
  state          jsonb not null,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (integration_id, phone)
);

create index whatsapp_conversations_expiry on public.whatsapp_conversations (expires_at);

alter table public.whatsapp_conversations enable row level security;
-- No policy: a system table, like webhook_events. service_role only.

revoke all on public.whatsapp_conversations from anon, authenticated;
revoke truncate on public.whatsapp_conversations from service_role;
grant select, insert, update, delete on public.whatsapp_conversations to service_role;

comment on table public.whatsapp_conversations is
  'The default ConversationStore (design spec D6). DELETE is granted here and nowhere else in this block, because a finished conversation is removed rather than tombstoned -- there is nothing in it worth keeping once the entry is written, and the row holds a phone number. RLS on with no policy: service_role only.';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: `08_conversation.test.sql` 14 of 14, suite total up by 14.

- [ ] **Step 5: Prove the backfill is real**

Run, against the local stack:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "select count(*) from public.member_field_confirmations;"
```

If the seed has members with filled fields the count is non-zero. If it is zero, seed one member with an address and re-run `db:reset` — a backfill nobody has seen run is a backfill nobody knows works.

- [ ] **Step 6: Regenerate types, run the gate, commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test
git add supabase/migrations/0065_conversation_tables.sql supabase/tests/08_conversation.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(conversation): a freshness rule, a per-field record of it, and somewhere to put a no

The confirmation is per field and not per record because a single timestamp
breaks for the listener who uses the system most: enter weekly through
promotions that ask only for city and your address is never asked again at
any age.

The backfill uses created_at rather than updated_at -- a 2024 record whose
phone was corrected yesterday would otherwise report a fresh address.

Every table carries the service_role grant explicitly. Block 5a shipped
three with the comment and without the grant and was non-functional end to
end until somebody checked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Which steps this listener needs

**Files:**
- Create: `supabase/migrations/0066_conversation_rpcs.sql` (this task writes the first function in it)
- Modify: `supabase/tests/08_conversation.test.sql`

**Interfaces:**
- Consumes: Task 1's column and `member_field_confirmations`.
- Produces: `public.whatsapp_conversation_steps(p_promotion_id uuid, p_member_id uuid) returns jsonb` — an ordered array of step objects, `SECURITY INVOKER`, EXECUTE for nobody.

Step objects have exactly these shapes and later tasks depend on them:

```json
{"kind": "consent"}
{"kind": "field", "field": "city"}
{"kind": "question", "question_id": "…", "question_kind": "QUIZ"}
```

- [ ] **Step 1: Write the failing tests**

Raise `plan(14)` to `plan(22)` and append cases covering: a promotion with no requested fields and no questions yields **consent alone**; a field that is empty is included; a field filled and confirmed **inside** the window is excluded; the same field one day **outside** the window is included; `data_validity_months` null excludes every filled field; `data_validity_months = 0` includes every requested field; questions appear in `position` order after the fields; and the fields appear in the enum's own order regardless of the order they were marked.

Build the fixtures so the window cases differ by one day either side of the boundary — a fixture a month clear of it would pass against an implementation that compared years.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.whatsapp_conversation_steps(uuid, uuid) does not exist`.

- [ ] **Step 3: Write the function**

In `supabase/migrations/0066_conversation_rpcs.sql`:

```sql
-- The step list, computed ONCE when the hashtag arrives (design spec D7).
-- Recomputing it per message would cost a round trip per turn and would let a
-- field that was fresh at the start expire mid-conversation; computing it once
-- also means editing a promotion does not change a conversation somebody is
-- already having.
--
-- PRIVATE: SECURITY INVOKER, EXECUTE for nobody, called only from inside a
-- SECURITY DEFINER body -- the shape apply_participation (0054) established.
create or replace function public.whatsapp_conversation_steps(
  p_promotion_id uuid,
  p_member_id    uuid
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  with promo as (
    select requested_fields, data_validity_months
    from public.promotions where id = p_promotion_id
  ),
  -- The enum's own order, which is the order the bot asks in (4a spec D6:
  -- the owner was asked whether a field would ever need settings of its own
  -- and said no, which is what makes the list a column rather than a table).
  wanted as (
    select f.field, f.ord
    from promo,
         unnest(promo.requested_fields) with ordinality as u(field, i)
    join lateral (
      select u.field as field,
             array_position(enum_range(null::public.promotion_requested_field), u.field) as ord
    ) f on true
  ),
  stale as (
    select w.field
    from wanted w
    cross join promo
    where
      -- Empty is asked whatever the validity says.
      public.member_field_value(p_member_id, w.field) is null
      or promo.data_validity_months is not null
         and coalesce(
               (select c.confirmed_at from public.member_field_confirmations c
                 where c.member_id = p_member_id and c.field = w.field),
               '-infinity'::timestamptz
             ) < now() - make_interval(months => promo.data_validity_months)
    order by w.ord
  )
  select jsonb_build_array(jsonb_build_object('kind', 'consent'))
      || coalesce((select jsonb_agg(jsonb_build_object('kind', 'field', 'field', field))
                     from stale), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object(
                            'kind', 'question',
                            'question_id', q.id,
                            'question_kind', q.kind) order by q.position)
                     from public.promotion_questions q
                    where q.promotion_id = p_promotion_id), '[]'::jsonb);
$$;

revoke execute on function public.whatsapp_conversation_steps(uuid, uuid) from public;
```

Write `public.member_field_value(p_member_id uuid, p_field public.promotion_requested_field) returns text` in the same migration, above it: a `CASE` mapping each enum value to its column on `members` (`full_name`, `address_line`, `city`, `neighbourhood`, `birth_date::text`, `cpf_hash`, `passport`, `discovery_source`), returning `nullif(btrim(...), '')` so a blank string counts as empty. `SECURITY INVOKER`, EXECUTE for nobody. **The eight-way mapping lives in exactly this one function** — every other place that needs it calls here, so a ninth field is one edit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`
Expected: 22 of 22 in `08_conversation`.

- [ ] **Step 5: Mutation-prove the boundary**

Change `<` to `<=` in the staleness comparison, re-run, and confirm the one-day-inside case flips. Restore and confirm byte-identical. Report both outputs. A boundary written the wrong way round is the defect this block's whole test discipline exists to catch.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test
git add supabase/migrations/0066_conversation_rpcs.sql supabase/tests/08_conversation.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(conversation): the list of what this listener still has to answer

Computed once, at the start. Recomputing per message would cost a round trip
per turn and let a field that was fresh at the start expire mid-conversation.

The eight-way enum-to-column mapping lives in member_field_value and nowhere
else, so a ninth requested field is one edit rather than a search.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Interactive messages

**Files:**
- Create: `src/lib/integrations/whatsapp/interactive.ts`
- Create: `tests/unit/whatsapp-interactive.test.ts`
- Modify: `src/lib/integrations/whatsapp/transport.ts`, `graph.ts`, `fake.ts`
- Modify: `tests/unit/whatsapp-transport.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Interactive =
    | { kind: 'buttons'; body: string; imageUrl: string | null;
        buttons: { id: string; title: string }[] }
    | { kind: 'list'; body: string; menuTitle: string; buttonLabel: string;
        rows: { id: string; title: string }[] };
  export function buildInteractivePayload(i: Interactive): unknown;
  ```
- Produces on `WhatsAppTransport`: `sendInteractive(input: { phoneNumberId: string; to: string; interactive: Interactive }): Promise<SendResult>`.

The consent message the owner specified is **one** message: the promotion name (or its call to action) as the body, the banner as an image header when `use_art` is set, and two reply buttons. Not three messages.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/whatsapp-interactive.test.ts` asserting the built payload shape against the Cloud API's documented form: `type: 'interactive'`, `interactive.type` of `'button'` or `'list'`, an image header present only when `imageUrl` is non-null, `action.buttons[].reply.{id,title}` for buttons, and `action.sections[0].rows[].{id,title}` plus `action.button` for lists.

Include two cases that pin real Cloud API limits, because exceeding them is a 400 the listener never sees: **at most three buttons**, and a button title of **at most 20 characters**. Assert the builder refuses rather than sending something Meta will reject — a promotion whose `yes_button_label` is long is a configuration mistake that must surface at build time.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/whatsapp-interactive.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the builder and extend the transport**

Write `interactive.ts` with the union above and `buildInteractivePayload`, throwing a named error for more than three buttons or a title over 20 characters. Add `sendInteractive` to the `WhatsAppTransport` interface, implement it in `GraphTransport` by POSTing the built payload to the same endpoint `sendText` uses, and in `FakeTransport` by recording it in a `sentInteractive` array alongside `sent`.

Keep `sendText` unchanged — the four reply strings 5a ships still go out as plain text.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/whatsapp-interactive.test.ts tests/unit/whatsapp-transport.test.ts`
Expected: PASS, and the 15 pre-existing transport cases unchanged.

- [ ] **Step 5: Mutation-prove the limits**

Remove the three-button check, confirm that one test and only that one fails. Restore byte-identical. Report the output.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/lib/integrations/whatsapp/interactive.ts src/lib/integrations/whatsapp/transport.ts src/lib/integrations/whatsapp/graph.ts src/lib/integrations/whatsapp/fake.ts tests/unit/whatsapp-interactive.test.ts tests/unit/whatsapp-transport.test.ts
git commit -m "feat(whatsapp): one composed message, not three

The consent step is a single interactive message -- the promotion's name, the
banner as an image header, and two reply buttons. The builder refuses more
than three buttons or a title over twenty characters, because both are a 400
from Meta that the listener never sees and the operator cannot diagnose.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The conversation engine

This is the task the whole architecture exists to make possible: a pure function, no database, no network.

**Files:**
- Create: `src/lib/conversation/steps.ts`, `src/lib/conversation/engine.ts`
- Create: `tests/unit/conversation-engine.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Step =
    | { kind: 'consent' }
    | { kind: 'field'; field: RequestedField }
    | { kind: 'question'; questionId: string; questionKind: 'QUIZ' | 'MULTIPLE_CHOICE' | 'ESSAY' };

  export interface Conversation {
    integrationId: string; phone: string;
    promotionId: string; memberId: string;
    steps: Step[]; cursor: number;
    answers: { fields: Partial<Record<RequestedField, string>>; questions: { questionId: string; optionId: string | null; answerText: string | null }[] };
    reprompts: number;
    expiresAt: string;
  }

  export type Turn =
    | { kind: 'prompt'; conversation: Conversation; outbound: Outbound }
    | { kind: 'refused'; outbound: Outbound }
    | { kind: 'complete'; conversation: Conversation; }
    | { kind: 'abandon'; outbound: Outbound }
    | { kind: 'ignore' };

  export function advance(c: Conversation, message: InboundAnswer, ctx: PromptContext): Turn;
  export function firstPrompt(c: Conversation, ctx: PromptContext): Outbound;
  ```
  `PromptContext` carries what the prompts need and the engine must not fetch: the promotion's name, art url, call-to-action, button labels, the question prompts and their options, and the field labels.

- [ ] **Step 1: Write the failing tests**

Cover, with no I/O: the consent prompt is one interactive message with the image header only when an art url is present; pressing the NO button returns `refused`; pressing YES advances to the first substantive step or returns `complete` when there is none; a field answer is stored and the cursor advances; a `QUIZ` renders as a list and a chosen option id is stored; an `ESSAY` accepts free text; an unusable answer returns a `prompt` with the same cursor and `reprompts` incremented; the **fourth** failure at one step returns `abandon`; `reprompts` resets when a step is answered; and an answer arriving for a cursor past the end returns `ignore`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/unit/conversation-engine.test.ts`
Expected: FAIL — cannot resolve `@/lib/conversation/engine`.

- [ ] **Step 3: Write the engine**

Write `steps.ts` (types only) and `engine.ts`. The engine must not import anything from `@/services`, `@/lib/supabase`, or the transport — if it needs a value, it comes in through `PromptContext`. Enforce that by inspection: a single import from those paths is the design failing.

Field validation lives here, per field kind: `age` parses as a date the listener could have been born on, `cpf` normalises to eleven digits, everything else is non-blank after trimming. A bad value is a re-prompt, never a stored value.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/conversation-engine.test.ts`

- [ ] **Step 5: Mutation-prove the two that hide**

Remove the `reprompts` reset, and confirm the "long conversation with scattered mistakes" case fails. Then make `advance` return `complete` when the cursor is at the last step rather than past it, and confirm the off-by-one is caught. Restore byte-identical after each; report both.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/lib/conversation/steps.ts src/lib/conversation/engine.ts tests/unit/conversation-engine.test.ts
git commit -m "feat(conversation): the whole conversation as a pure function

(steps, answers, message) -> (outbound, next state). No database, no
WhatsApp, no clock. That is what computing the step list once buys, and it
is why every branch here is unit-testable without a stack running.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The store, its default driver, and one contract suite

**Files:**
- Create: `src/lib/conversation/store.ts`, `src/lib/conversation/postgres-store.ts`
- Create: `tests/unit/conversation-store-contract.ts` (a suite factory, not a test file)
- Create: `tests/isolation/conversation-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ConversationKey { integrationId: string; phone: string }
  export interface ConversationStore {
    load(key: ConversationKey): Promise<Conversation | null>;
    save(key: ConversationKey, value: Conversation): Promise<void>;
    clear(key: ConversationKey): Promise<void>;
  }
  export function conversationStoreContract(make: () => Promise<ConversationStore>): void;
  ```

No compare-and-set in the interface: the advisory lock in Task 7 serialises writers, and a second concurrency mechanism here would be two answers to one question.

- [ ] **Step 1: Write the contract suite and the failing test**

`conversationStoreContract` registers `describe`/`it` blocks covering: a load with nothing stored returns null; save-then-load round-trips every field including nested answers; clear removes it; a second save replaces rather than appends; and **an expired conversation loads as null**. The expiry case is what stops the two drivers diverging on the property that matters most.

`tests/isolation/conversation-store.test.ts` calls it with the Postgres driver built on the harness's `admin` client.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:isolation`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the interface and the Postgres driver**

The driver reads and writes `whatsapp_conversations` through the service-role client, computing `expires_at` as now plus the window. **The window is thirty minutes (D5) and is a named exported constant**, not a literal in two places.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test:isolation` — guard-complete only.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test
git add src/lib/conversation/store.ts src/lib/conversation/postgres-store.ts tests/unit/conversation-store-contract.ts tests/isolation/conversation-store.test.ts scripts/verify-isolation-suite.mjs
git commit -m "feat(conversation): one contract, so the drivers cannot diverge quietly

The expiry case is the one that matters: an optional driver nobody exercises
is an optional driver nobody can trust.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The Redis driver

**Files:**
- Create: `src/lib/conversation/redis-store.ts`
- Create: `tests/isolation/conversation-store-redis.test.ts`
- Modify: `src/lib/env.ts`

**Interfaces:**
- Consumes: Task 5's `ConversationStore` and `conversationStoreContract`.
- Produces: `RedisConversationStore`, and `REDIS_URL` as an **optional** env var.

- [ ] **Step 1: Add the env var and the driver's test**

`REDIS_URL: z.string().url().optional()` in `src/lib/env.ts`. The test file calls `conversationStoreContract` with the Redis driver and **skips the whole suite when `REDIS_URL` is unset**, so CI and every developer without Redis stay green. Print a line saying it skipped — a silently skipped suite is a suite that rots.

- [ ] **Step 2: Run it to confirm it skips cleanly**

Run: `npm run test:isolation` with `REDIS_URL` unset.
Expected: the suite reports skipped, not failed, and the guard still passes.

- [ ] **Step 3: Write the driver**

`SET key value EX <window>` and `GET`/`DEL`. The native TTL replaces `expires_at`; there is nothing to sweep.

- [ ] **Step 4: Run the contract against a real Redis**

Start one (`docker run --rm -p 6379:6379 redis:7-alpine`), set `REDIS_URL`, run the suite, and report the output. **A driver whose contract suite has never actually run is not a driver**, and the skip in step 1 makes that easy to hide.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/lib/conversation/redis-store.ts tests/isolation/conversation-store-redis.test.ts src/lib/env.ts
git commit -m "feat(conversation): the optional driver, held to the same contract

Skipped when REDIS_URL is unset so CI needs no new service, and run against
a real Redis before this commit -- an optional driver that has never been
exercised is worse than none, because it looks like a choice.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Starting the conversation

**Files:**
- Modify: `supabase/migrations/0066_conversation_rpcs.sql`
- Create: `supabase/migrations/0067_ingest_starts_conversation.sql`
- Modify: `supabase/tests/06_whatsapp.test.sql`, `supabase/tests/08_conversation.test.sql`

**Interfaces:**
- Produces: `public.start_whatsapp_conversation(...)` and the amended `ingest_whatsapp_event`.

**This changes 5a's headline behaviour and its tests.** After this task no hashtag enters directly: every one starts a conversation. `06_whatsapp.test.sql`'s cases that assert `recorded` on a single message must become cases that assert a conversation was started and no participation was written. **Convert them; do not delete them** — three earlier rounds in Block 5a deleted assertions while fixing something else, and each was caught in review.

- [ ] **Step 1: Write the failing tests**

In `08_conversation.test.sql`: a hashtag produces a `whatsapp_conversations` row whose state carries the step list; **no** `participations` row exists yet; and the pre-check (D8) refuses before any conversation is created when the listener is already over the promotion's ceiling.

In `06_whatsapp.test.sql`: convert the single-message cases as described above.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run db:test`

- [ ] **Step 3: Write the divert**

`start_whatsapp_conversation` builds the state from `whatsapp_conversation_steps` and inserts into `whatsapp_conversations`. In `0067`, `ingest_whatsapp_event` replaces its `apply_participation` call with: the read-only pre-check, then the conversation start, then the consent prompt into the outbox.

**Take `pg_advisory_xact_lock` on `(integration_id, phone)` at the top**, hashed the way `apply_participation` hashes its pair. This is the lock every later turn depends on and it belongs here, where the conversation begins.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`

- [ ] **Step 5: Run the gate and commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test && npm run test:isolation
git add supabase/migrations/0066_conversation_rpcs.sql supabase/migrations/0067_ingest_starts_conversation.sql supabase/tests/ src/lib/supabase/database.types.ts
git commit -m "feat(conversation): a hashtag now opens a conversation, not an entry

This changes Block 5a's headline path deliberately: no message enters
directly any more, because the listener has to be able to say no and to be
asked for what the promotion wants. 5a's single-message assertions are
converted rather than deleted -- they still describe a real path, just one
that now ends at a prompt.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The turn, and the final write

**Files:**
- Create: `src/services/conversation.ts`
- Modify: `supabase/migrations/0066_conversation_rpcs.sql`
- Modify: `src/services/whatsapp.ts`
- Modify: `supabase/tests/08_conversation.test.sql`
- Create: `tests/unit/conversation-turn.test.ts`

**Interfaces:**
- Consumes: the engine (Task 4), the store (Task 5), `sendInteractive` (Task 3).
- Produces: `runConversationTurn(deps, event): Promise<TurnOutcome>`; `public.complete_whatsapp_conversation(...)` and `public.record_whatsapp_refusal(...)`.

- [ ] **Step 1: Write the failing tests**

pgTAP for `complete_whatsapp_conversation`: it writes the member fields, one confirmation row per answered field with `confirmed_at = now()`, the participation through `apply_participation` with the answers array, the outbox reply, and deletes the conversation — **all or nothing**. Force a failure in the middle (an answer naming a question from another promotion, which `apply_participation` already refuses) and assert none of the five landed.

Also: the participation is judged by the **final message's** timestamp, not the opening one. Fixture: a promotion that closes between the two, asserting the entry is refused.

Vitest for `runConversationTurn` against a fake store and `FakeTransport`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run db:test && npx vitest run tests/unit/conversation-turn.test.ts`

- [ ] **Step 3: Write them**

`complete_whatsapp_conversation` does the five writes in one transaction. `record_whatsapp_refusal` writes the refusal row, deletes the conversation, and enqueues the goodbye.

`runConversationTurn` loads the state, calls `advance`, and acts on the `Turn`: `prompt` saves and enqueues; `refused` calls the refusal RPC; `complete` calls the completion RPC; `abandon` clears and enqueues; `ignore` does nothing.

**The state is written after the turn's database work, never before** (spec §4.3). Non-final turns have no database work, so the save is the only write.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test && npx vitest run tests/unit/conversation-turn.test.ts`

- [ ] **Step 5: Mutation-prove the atomicity and the clock**

Split the completion into two transactions and confirm the all-or-nothing case fails. Then judge the entry by the opening timestamp and confirm the closes-mid-conversation case fails. Restore byte-identical after each; report both.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test && npm run db:test
git add supabase/migrations/0066_conversation_rpcs.sql src/services/conversation.ts src/services/whatsapp.ts supabase/tests/08_conversation.test.sql tests/unit/conversation-turn.test.ts src/lib/supabase/database.types.ts
git commit -m "feat(conversation): everything lands together, or nothing does

Five writes in one transaction on the last step: the member fields, the
confirmations, the participation, the reply, and the conversation's own
removal. An abandoned conversation writes nothing, which is what makes an
incomplete confirmation not count.

The entry is judged by the LAST message's timestamp. Somebody who starts at
14:00 and finishes at 14:20 on a promotion that closed at 14:10 is refused;
judging by the opening message would make the closing moment mean nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The tick trigger, and the sweep

**Files:**
- Modify: `src/app/api/webhooks/whatsapp/route.ts`, `src/services/whatsapp.ts`
- Modify: `supabase/migrations/0066_conversation_rpcs.sql`
- Modify: `tests/unit/whatsapp-route.test.ts`

**Interfaces:**
- Produces: `public.sweep_expired_conversations()`; the route's fire-and-forget tick.

- [ ] **Step 1: Write the failing tests**

Route test: a successfully stored message triggers exactly one tick call, and a **rejected** one (bad signature, 401) triggers none. Mock the tick endpoint. pgTAP: the sweep deletes an expired conversation and leaves a live one.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/unit/whatsapp-route.test.ts && npm run db:test`

- [ ] **Step 3: Write them**

The route fires the tick **after** the 200 is decided, without awaiting, guarded so a failure cannot turn a stored message into an error. State in the comment that this is safe because the app runs as a long-lived Node process in a container and not on a platform that freezes after the response — the correction the 5a fix wave had to make to comments naming the wrong runtime.

The sweep runs in `runTick` beside the existing reclaim.

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test
git add src/app/api/webhooks/whatsapp/route.ts src/services/whatsapp.ts supabase/migrations/0066_conversation_rpcs.sql tests/unit/whatsapp-route.test.ts
git commit -m "feat(conversation): the turn does not wait ten seconds for the next tick

Without the trigger every turn waits up to a full cron interval and a
six-step conversation accumulates half a minute of silence. Fired after the
200 is decided and never awaited, so a failing tick cannot turn a stored
message into an error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Confirmations from the operator's screen

**Files:**
- Modify: `supabase/migrations/0066_conversation_rpcs.sql` (extend `update_member`'s delegation), `supabase/tests/08_conversation.test.sql`

**Interfaces:**
- Consumes: `member_field_confirmations`, `update_member` (0034), `apply_member_update`'s core if one exists.

Spec §9: an operator's save refreshes the confirmation **only for fields whose value actually changed**. Refreshing all of them on every save reintroduces D2's frequent-participant problem at operator scale — an operator who opens and saves a record would silently mark every field fresh.

- [ ] **Step 1: Write the failing tests**

Saving a record with one field changed refreshes exactly that field's confirmation; the untouched fields keep their old `confirmed_at`; and clearing a field to blank **removes** its confirmation, because empty is asked whatever the validity says.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Write it**

Compare old and new per field inside the update, using `member_field_value` from Task 2 so the eight-way mapping still lives in one place.

- [ ] **Step 4: Run the tests, mutation-prove, gate, commit**

Mutation: refresh every field on every save and confirm the untouched-field case fails. Restore byte-identical.

---

### Task 11: Isolation, the boundary, and the double-send race

**Files:**
- Create: `tests/isolation/conversation.test.ts`
- Modify: `tests/e2e/whatsapp-boundary.spec.ts`, `scripts/verify-isolation-suite.mjs`

- [ ] **Step 1: Write the failing tests**

**The boundary, per 5a's hardest lesson.** For each of the four new tables, drive the exact write the application issues through the harness's `admin` client — the same service-role construction `createServiceClient()` uses — and assert it succeeds. Three defects in 5a existed only because nothing crossed that seam, and pgTAP cannot see it because it runs as `postgres`.

**The double-send race, twelve rounds.** Two messages from one phone fired with `Promise.all` against a live conversation must advance the cursor exactly once and store exactly one answer. Twelve rounds because one green run does not prove a probabilistic detector — 4c's lesson.

**A full conversation end to end**, through `runTick`, from hashtag to entry, asserting the participation, the confirmations, and the outbox rows.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Make them pass**

- [ ] **Step 4: Mutation-prove the lock**

Remove `pg_advisory_xact_lock` from the turn path and confirm the race goes red. Report which round. Restore byte-identical.

- [ ] **Step 5: Raise the isolation floor, run the gate, commit**

Update `scripts/verify-isolation-suite.mjs` so the new file's `minTests` matches its real count.

---

### Task 12: Runbook and report

**Files:**
- Modify: `docs/block-5a-runbook.md` (or create `docs/block-5b-runbook.md` if the sections do not fold in cleanly — say which you chose)
- Create: `docs/block-5b-report.md`
- Modify: `src/app/api/webhooks/whatsapp/route.ts`

- [ ] **Step 1: Qualify the inherited comment**

Spec §8: that file says the raw `wamid` lives in "the only place it lives" without qualifying that this is true of the **inbound** id. Fix it while you are in the file.

- [ ] **Step 2: Write the runbook additions**

How to set `data_validity_months` on a promotion and what each value means; how to turn Redis on (`REDIS_URL`) and how to tell which driver is live; the thirty-minute window and that a listener who returns later starts over; that a promotion now takes **two messages minimum** and why; and how to read `promotion_refusals` to tell refusal from abandonment.

- [ ] **Step 3: Write the block report**

Follow `docs/block-5a-report.md`. The gate table carries this block's own measured numbers — run the suites, do not copy. The Concerns section is the part that matters: at minimum, that every existing promotion changes behaviour on deploy (one message becomes two), and whatever the implementation actually found.

- [ ] **Step 4: Run the whole gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test && npm run test:isolation && CI=1 npx playwright test
```

Record the real numbers. **Do not open the PR** — the owner decides when it opens.

---

## Self-Review

**Spec coverage.** D1→Task 1; D2→Tasks 1, 2, 10; D3→Task 1's backfill; D4→Tasks 1, 8; D5→Tasks 1, 5, 9; D6→Tasks 5, 6; D7→Task 2; D8→Tasks 7, 8; D9→Task 9; D10→Task 4 (the re-prompt) and Task 7 (silence, inherited from 5a's path). Spec §3.1→Task 1; §3.2→Tasks 1, 10; §3.3→Tasks 1, 8; §4.1→Task 2; §4.2→Task 8; §4.3→Tasks 7, 11; §4.4→Tasks 5, 6; §5→Tasks 4, 8, 11; §6→every task's own tests plus Task 11; §7 is the out-of-scope list; §8→Task 12.

**One gap found while reviewing, then settled by the owner:** the spec's §4.1 was vague about what the consent message actually contains. The owner specified it on 2026-08-01, in this order:

> **banner → promotion name → call to action → the two buttons**

which is exactly the Cloud API's interactive-button shape: an image header, a text body, and the action. The name and the call to action both live in the **body**, the name first, separated by a blank line. When `call_to_action` is empty the body is the name alone; when `use_art` is false there is no header and the message starts at the body. Task 3 builds it and Task 4's consent test asserts that order — including the two degenerate cases, because a promotion configured with neither art nor a call to action must still produce a message somebody can answer.

**Type consistency.** `Step`, `Conversation` and `Turn` are declared in Task 4 and consumed unchanged in Tasks 5, 6 and 8. `ConversationKey`/`ConversationStore` are declared in Task 5 and consumed in 6 and 8. `Interactive` and `sendInteractive` are declared in Task 3 and consumed in 4 and 8. `member_field_value` is written in Task 2 and reused in Task 10 — the plan's only cross-task SQL reuse, and deliberately so.

**A known behavioural change, stated rather than discovered:** after Task 7 no hashtag enters directly. Every promotion that exists takes one more message than it did. Task 7 converts 5a's assertions rather than deleting them, and Task 12's report must say it plainly.
