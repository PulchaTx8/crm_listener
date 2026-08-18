# Block 29c — Consent and Opt-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-channel marketing consent for listeners — how it is collected, how it is withdrawn, and the set-at-a-time predicate that answers "who may this Station send to on this channel".

**Architecture:** Two values on the existing `member_consent_type` enum; no new consent table, because `member_consents` (0032) already is one. Collection through the two doors a listener arrives by (the WhatsApp conversation and the widget), each once per listener per Station. Withdrawal through three routes: a hashed unsubscribe token behind a public page that writes only on POST, stop words on WhatsApp inbound, and an operator recording by hand. One `stable` set function is what Block 29d will consume.

**Tech Stack:** PostgreSQL 17 (RLS, pgTAP), Next.js 15 App Router (Server Actions, `typedRoutes`), TypeScript, Zod, next-intl, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-block-29c-consent-and-optout-design.md`

## Global Constraints

- Comments explain WHY, never WHAT. A comment that states something **false** is a defect of the same severity as false code.
- No new user-facing English strings outside `messages/{en,pt,es}.json`. Zod message strings inside `src/schemas/` are an established exception and stay English.
- The generated Supabase types file (`src/lib/supabase/database.types.ts`) is generated, never hand-edited. Regenerate with the repo's own script after any migration.
- One string literal for a PostgREST `.select(...)`, never a concatenation — the types are inferred from the literal.
- `create or replace` preserves a function's ACL; `drop` + `create` destroys it. Any function recreated here is recreated from its **live** definition (`pg_get_functiondef`), never from the migration that first created it. `psql` is **not installed** on this machine; use a Node script with the repo's `pg` dependency against `LOCAL_SUPABASE_DB_URL`.
- pgTAP `plan(N)` is the file's **running total**, not this task's addition.
- A migration that adds an enum value carries nothing else.
- Gate order is `db:reset` → `db:test` → `test:isolation`. `db:test` after another suite gives a red that is not code.
- Every conditionally rendered `<Button>` gets a distinct `key`. Two buttons in one position let React reuse the DOM node and the survivor inherits `type="submit"` — this project has shipped that defect.

## Naming collision to avoid

`src/lib/conversation/engine.ts` **already exports** `CONSENT_YES_ID = 'consent_yes'` and `CONSENT_NO_ID = 'consent_no'`. Those are the promotion's **rules** acceptance, not marketing. Nothing in this plan reuses, renames, or extends them. The marketing step's button ids are `marketing_yes` / `marketing_no`, and its constants are `MARKETING_YES_ID` / `MARKETING_NO_ID`.

## A forward risk, recorded rather than designed around

Spec §8 requires the eligibility function be `security invoker`, so "who may I reach" respects the caller's RLS. That is right for a screen. Block 29d's send loop may run in a worker with **no user identity** — the failure Block 8b already met once — and an invoker function returns nothing to an identity-less caller. This plan follows the spec. Task 2 records the constraint in the function's own comment so 29d meets it as a documented decision rather than as an empty result set.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0228_marketing_consent_vocabulary.sql` | Four `ALTER TYPE … ADD VALUE`, nothing else |
| `supabase/migrations/0229_marketing_eligibility.sql` | `members_marketing_eligible_bulk` |
| `supabase/migrations/0230_unsubscribe_tokens.sql` | Token table, issue/consume doors, retention sweep |
| `supabase/tests/65_marketing_consent.test.sql` | pgTAP for all three migrations |
| `src/lib/consent/stop-words.ts` | Normalising and matching PARAR / CANCELAR / DESCADASTRAR |
| `src/lib/conversation/steps.ts` | The `marketing_consent` step in the `Step` union |
| `src/lib/conversation/engine.ts` | The step's prompt and turn, the two system-message defaults |
| `src/services/consent.ts` | Eligibility read, token issue and consume |
| `src/app/(public)/unsubscribe/[token]/page.tsx` | GET renders; a Server Action writes |
| `src/app/(widget)/w/[publicKey]/enter-promotion.tsx` | The unchecked checkbox |
| `src/lib/mailer/index.ts` | `MailMessage.headers` for `List-Unsubscribe` |
| `src/app/(app)/members/format.ts` | Two consent-type labels |

---

### Task 1: The vocabulary

**Files:**
- Create: `supabase/migrations/0228_marketing_consent_vocabulary.sql`, `supabase/tests/65_marketing_consent.test.sql`

**Interfaces:**
- Produces: `member_consent_type` values `whatsapp_marketing`, `email_marketing`; `system_message_key` values `MARKETING_CONSENT`, `MARKETING_STOPPED`.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/65_marketing_consent.test.sql`:

```sql
begin;
select plan(4);

-- Block 29c. Consent per channel, and the two things the conversation says
-- about it. Separate values rather than one 'marketing' because §18 of the
-- original request is precisely that an e-mail opt-out must not stop WhatsApp.
select ok(
  'whatsapp_marketing' = any(enum_range(null::public.member_consent_type)::text[]),
  'a listener can consent to WhatsApp marketing');

select ok(
  'email_marketing' = any(enum_range(null::public.member_consent_type)::text[]),
  'and to e-mail marketing, separately');

select ok(
  'MARKETING_CONSENT' = any(enum_range(null::public.system_message_key)::text[]),
  'the conversation has a text for asking');

select ok(
  'MARKETING_STOPPED' = any(enum_range(null::public.system_message_key)::text[]),
  'and one for confirming a stop');

select finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: `65_marketing_consent.test.sql` fails four assertions.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0228_marketing_consent_vocabulary.sql`:

```sql
-- supabase/migrations/0228_marketing_consent_vocabulary.sql

-- Block 29c, Task 1. The vocabulary, and nothing else.
--
-- ALONE IN ITS OWN MIGRATION, which is this project's rule for ALTER TYPE ADD
-- VALUE: PostgreSQL refuses to use a new enum value in the same transaction
-- that added it, so any statement here that referenced one of these four would
-- fail on the migration's own run rather than later.
--
-- TWO CONSENT VALUES, NOT ONE. A single 'marketing' value could not express
-- "stop e-mailing me but keep the WhatsApp", which is exactly what §18 of the
-- original request asks for. Per-channel by construction beats per-channel by
-- convention.
--
-- sponsor_communication is deliberately untouched (spec D5): it names a
-- sponsor's communication rather than the Station's campaigns, nothing has ever
-- collected it, and dropping an enum value in PostgreSQL is not cheap.
alter type public.member_consent_type add value if not exists 'whatsapp_marketing' after 'sponsor_communication';
alter type public.member_consent_type add value if not exists 'email_marketing' after 'whatsapp_marketing';

-- The conversation asks, and confirms a stop. Both are system messages so a
-- Station can say them in its own voice, like everything else it says.
alter type public.system_message_key add value if not exists 'MARKETING_CONSENT' after 'COUNTRY';
alter type public.system_message_key add value if not exists 'MARKETING_STOPPED' after 'MARKETING_CONSENT';
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: `Result: PASS`.

- [ ] **Step 5: Find every hand-written count this moved**

`system_message_key` gaining two values moves counts no compiler holds. The gender block moved four of them and the compiler saw none.

Run:
```bash
grep -rn "toHaveCount(1[0-9])\|toHaveLength(1[0-9])" tests/ | grep -iE "system|message|template"
grep -rn "SYSTEM_MESSAGE" tests/unit/ | head
```
Update every count that counts `system_message_key`. `tests/e2e/templates.spec.ts` pins `toHaveCount(15)`; it becomes 17.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0228_marketing_consent_vocabulary.sql supabase/tests/65_marketing_consent.test.sql tests/
git commit -m "feat(consent): two channels a listener answers about separately"
```

---

### Task 2: The eligibility predicate

**Files:**
- Create: `supabase/migrations/0229_marketing_eligibility.sql`
- Modify: `supabase/tests/65_marketing_consent.test.sql`

**Interfaces:**
- Consumes: Task 1's enum values; `message_channel` (0222, Block 29b-1).
- Produces: `members_marketing_eligible_bulk(p_member_ids uuid[], p_company_id uuid, p_channel public.message_channel) returns table (member_id uuid, eligible boolean)`.

- [ ] **Step 1: Write the failing pgTAP**

Bump to `select plan(17);` and append before `finish()`:

```sql
-- Task 2. The predicate Block 29d resolves an audience with.
select has_function('public', 'members_marketing_eligible_bulk',
  array['uuid[]','uuid','public.message_channel'],
  'the set-at-a-time eligibility question exists');

-- A Station, an Organization, and four listeners in four states.
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000029c1', 'Org consent');
insert into public.companies (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000029c2', '00000000-0000-0000-0000-0000000029c1', 'Radio Consent');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000000029a1', '00000000-0000-0000-0000-0000000029c1', 'Nunca perguntada'),
  ('00000000-0000-0000-0000-0000000029a2', '00000000-0000-0000-0000-0000000029c1', 'Disse sim'),
  ('00000000-0000-0000-0000-0000000029a3', '00000000-0000-0000-0000-0000000029c1', 'Disse sim e depois nao'),
  ('00000000-0000-0000-0000-0000000029a4', '00000000-0000-0000-0000-0000000029c1', 'Apagada');

insert into public.member_company_links (member_id, company_id, organization_id)
select id, '00000000-0000-0000-0000-0000000029c2', '00000000-0000-0000-0000-0000000029c1'
  from public.members where organization_id = '00000000-0000-0000-0000-0000000029c1';

insert into public.member_consents
  (organization_id, member_id, company_id, consent_type, granted, granted_at)
values
  ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a2',
   '00000000-0000-0000-0000-0000000029c2', 'whatsapp_marketing', true, now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a3',
   '00000000-0000-0000-0000-0000000029c2', 'whatsapp_marketing', true, now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a3',
   '00000000-0000-0000-0000-0000000029c2', 'whatsapp_marketing', false, now() - interval '1 day');

update public.members set anonymized_at = now()
 where id = '00000000-0000-0000-0000-0000000029a4';

-- THE ASYMMETRY THIS BLOCK TURNS ON (spec D1). No row at all means NOT eligible
-- on WhatsApp, because Meta requires opt-in for a marketing template and
-- enforces it through number quality -- and eligible on e-mail, which goes out
-- on the existing relationship with one-click withdrawal.
select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a1']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  false, 'never asked means not eligible on WhatsApp');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a1']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'EMAIL')),
  true, 'and eligible on e-mail, which is the whole asymmetry');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a2']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  true, 'a listener who said yes is eligible');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a3']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  false, 'and a later withdrawal beats the earlier yes');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a4']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'EMAIL')),
  false, 'an erased listener is never a recipient, whatever the channel default says');

-- THE TIEBREAK. granted_at defaults to now(), which is CONSTANT within a
-- transaction -- two rows written in one transaction carry the same timestamp,
-- and without `id desc` the winner is the planner's choice. Block 29b-1's
-- whole-branch review found this same defect one layer up.
insert into public.member_consents
  (organization_id, member_id, company_id, consent_type, granted, granted_at)
values
  ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a1',
   '00000000-0000-0000-0000-0000000029c2', 'email_marketing', true,  '2026-01-01'),
  ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a1',
   '00000000-0000-0000-0000-0000000029c2', 'email_marketing', false, '2026-01-01');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a1']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'EMAIL')),
  false, 'two rows at one instant resolve by id, not by the planner');

-- AN ORGANIZATION-WIDE SUSPENSION, which is member_blocks.company_id = NULL.
-- The subtle one: a predicate matching only on equality lets this listener go
-- on receiving campaigns from every Station in the Organization.
insert into public.member_blocks (organization_id, member_id, company_id, kind, reason)
values ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a2',
        null, 'suspension', 'probe');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a2']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  false, 'an Organization-wide suspension bars every Station in it');

-- A DRAW BAN IS NOT A SUSPENSION. member_block_kind carries both; 'draw_ban'
-- means "may not win a draw" and says nothing about messages. Barring it here
-- would punish a listener for something else entirely.
update public.member_blocks set lifted_at = now(), lift_reason = 'probe'
 where member_id = '00000000-0000-0000-0000-0000000029a2';
insert into public.member_blocks (organization_id, member_id, company_id, kind, reason)
values ('00000000-0000-0000-0000-0000000029c1', '00000000-0000-0000-0000-0000000029a2',
        '00000000-0000-0000-0000-0000000029c2', 'draw_ban', 'probe');

select is(
  (select eligible from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a2']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  true, 'but a draw ban does not stop a campaign');

-- Set-at-a-time: one call, one row per member asked about, no member invented.
select is(
  (select count(*)::int from public.members_marketing_eligible_bulk(
     array['00000000-0000-0000-0000-0000000029a1',
           '00000000-0000-0000-0000-0000000029a2',
           '00000000-0000-0000-0000-0000000029a3']::uuid[],
     '00000000-0000-0000-0000-0000000029c2', 'WHATSAPP')),
  3, 'one row per member asked about');

select ok(
  has_function_privilege('authenticated',
    'public.members_marketing_eligible_bulk(uuid[],uuid,public.message_channel)', 'EXECUTE'),
  'authenticated may ask');

select ok(
  not has_function_privilege('anon',
    'public.members_marketing_eligible_bulk(uuid[],uuid,public.message_channel)', 'EXECUTE'),
  'anon may not');

select ok(
  not has_function_privilege('public',
    'public.members_marketing_eligible_bulk(uuid[],uuid,public.message_channel)', 'EXECUTE'),
  'and PUBLIC holds nothing');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -8`
Expected: the file fails; `has_function` is the first to go.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0229_marketing_eligibility.sql`:

```sql
-- supabase/migrations/0229_marketing_eligibility.sql

-- Block 29c, Task 2. Who this Station may send to, on this channel.
--
-- SET-AT-A-TIME, in the shape members_blocked_bulk (0036) already holds. Block
-- 29d resolves audiences of thousands; a function answering one listener would
-- be N round trips for a question the database can answer in one pass.
--
-- SECURITY INVOKER, and this is the one place this file departs from 0036's
-- shape deliberately. "Who may I reach" has to be answered under the RLS of
-- whoever is asking, not of whoever wrote the function: there is no privilege
-- to lend here, only a filtered read, and a definer function would hand every
-- caller a view of consent rows their own policies would refuse them.
--
-- THE CONSEQUENCE FOR BLOCK 29d, recorded here so it is met as a decision
-- rather than as an empty result: a caller with NO user identity -- a worker
-- draining a queue, the failure Block 8b already met once -- gets nothing back
-- from this function. 29d's send loop must call it as somebody.
create or replace function public.members_marketing_eligible_bulk(
  p_member_ids uuid[],
  p_company_id uuid,
  p_channel    public.message_channel
)
returns table (member_id uuid, eligible boolean)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with asked as (
    select unnest(p_member_ids) as id
  ),
  -- The consent type this channel is about. Written as a mapping rather than
  -- as two functions because the four layers below are identical for both.
  channel as (
    select case p_channel
             when 'WHATSAPP' then 'whatsapp_marketing'
             else 'email_marketing'
           end::public.member_consent_type as consent_type,
           -- Layer 4: the default when nothing was ever recorded (spec D1).
           (p_channel = 'EMAIL') as default_eligible
  ),
  latest as (
    select distinct on (mc.member_id)
           mc.member_id, mc.granted
      from public.member_consents mc, channel ch
     where mc.company_id = p_company_id
       and mc.consent_type = ch.consent_type
       and mc.member_id = any(p_member_ids)
     -- granted_at DESC, id DESC: granted_at defaults to now(), constant within
     -- a transaction, so two rows written together tie and the winner would
     -- otherwise be whichever the planner reached first.
     order by mc.member_id, mc.granted_at desc, mc.id desc
  )
  select a.id,
         -- Layers 1 and 2 are bars, not preferences: they cannot be overridden
         -- by a consent row, which is why they sit outside the coalesce.
         m.anonymized_at is null
         and not exists (
           select 1 from public.member_blocks b
            where b.member_id = a.id
              and b.organization_id = co.organization_id
              -- NULL company_id MEANS THE WHOLE ORGANIZATION (0032's own
              -- comment). Matching only on equality would let an
              -- Organization-wide suspension go on receiving campaigns from
              -- every Station in it -- the widest possible miss.
              and (b.company_id is null or b.company_id = p_company_id)
              -- 'suspension' ONLY. member_block_kind also carries 'draw_ban',
              -- which means "may not win a draw" and says nothing about
              -- messages; barring it here would silently punish a listener for
              -- something else. This is also why members_blocked_bulk (0036) is
              -- not reused: it treats any active block as blocking, which is
              -- right for its question and wrong for this one.
              and b.kind = 'suspension'
              -- A block is active by its dates, not by its existence: 0036
              -- derives the same three conditions at read time, and a lifted or
              -- expired suspension must not bar anybody.
              and b.lifted_at is null
              and b.starts_at <= now()
              and (b.ends_at is null or b.ends_at > now())
         )
         and coalesce(l.granted, ch.default_eligible)
    from asked a
    cross join channel ch
    join public.members m on m.id = a.id
    -- The Station's Organization, which the block check needs: a suspension is
    -- recorded against an Organization, and a row from another one must never
    -- bar a listener here.
    join public.companies co on co.id = p_company_id
    left join latest l on l.member_id = a.id;
$$;

revoke execute on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) from public;
grant execute on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) to authenticated;

comment on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) is
  'Block 29c. Which of these listeners this Station may send a campaign to on this channel. Four layers, first no wins: members.anonymized_at is an absolute bar; an active member_blocks suspension bars; the LATEST member_consents row for (member, company, type) decides; and absent any row the channel default applies -- WhatsApp requires an explicit yes, e-mail does not. SECURITY INVOKER on purpose: a caller with no user identity gets nothing back, so Block 29d must call it as somebody.';
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: `Result: PASS`, `65_marketing_consent.test.sql ... ok`.

- [ ] **Step 5: Prove the tiebreak assertion bites**

Change `order by mc.member_id, mc.granted_at desc, mc.id desc` to drop `, mc.id desc`. Re-run `npm run db:test`.
Expected: the tiebreak assertion becomes unreliable — it may pass. **If it passes, say so in your report rather than claiming the mutation proved anything**: `distinct on` without a total order is undefined, not wrong, and an undefined result that happens to be right is exactly why the tiebreak is written down. Restore the clause either way.

- [ ] **Step 6: Regenerate types and commit**

```bash
npm run db:types
npx tsc --noEmit
git add supabase/migrations/0229_marketing_eligibility.sql supabase/tests/65_marketing_consent.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(consent): the four layers that decide who a campaign may reach"
```

---

### Task 3: The stop words

**Files:**
- Create: `src/lib/consent/stop-words.ts`, `tests/unit/stop-words.test.ts`

**Interfaces:**
- Produces: `export function isStopWord(text: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/stop-words.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isStopWord } from '@/lib/consent/stop-words';

describe('the WhatsApp stop words', () => {
  it.each(['PARAR', 'parar', 'Parar', ' parar ', 'PARAR!'])(
    'recognises %j',
    (text) => expect(isStopWord(text)).toBe(true),
  );

  it.each(['CANCELAR', 'cancelar', 'DESCADASTRAR', 'descadastrar'])(
    'recognises %j too',
    (text) => expect(isStopWord(text)).toBe(true),
  );

  it('recognises an accented spelling, because people type it', () => {
    // Somebody typing on a phone keyboard produces "descadastrár" or worse.
    // Comparing without accents costs one normalise and buys the difference
    // between a listener leaving and a listener complaining.
    expect(isStopWord('descadastrár')).toBe(true);
  });

  it('does NOT treat SAIR as a stop word', () => {
    // The widget has carried a "Sair" since Block 19b meaning end-the-session.
    // Two things sharing a name while doing different things is how an
    // afternoon disappears -- and here it would convert somebody closing a
    // conversation into somebody withdrawing consent.
    expect(isStopWord('SAIR')).toBe(false);
  });

  it('does not match a word that merely contains one', () => {
    // "parara" is not "parar", and a listener answering a question about their
    // city must not be unsubscribed by a substring.
    expect(isStopWord('pararam de tocar')).toBe(false);
    expect(isStopWord('quero cancelar minha participacao')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/stop-words.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot resolve `@/lib/consent/stop-words`.

- [ ] **Step 3: Write the module**

Create `src/lib/consent/stop-words.ts`:

```ts
/**
 * The words that stop a Station's campaigns, typed into WhatsApp.
 *
 * WHY THESE EXIST AT ALL: without them Block 29d would send marketing through a
 * channel with no exit. Meta measures that as a complaint rate against the
 * number, and a number with a poor quality rating stops delivering to everyone
 * — so this is not only the listener's right, it is the deliverability of every
 * other message the Station sends.
 *
 * WHOLE MESSAGE, NOT SUBSTRING. A listener answering "which city" with "quero
 * cancelar minha participacao" is talking about a promotion, not withdrawing
 * consent, and unsubscribing them for a word inside a sentence would be a
 * withdrawal nobody asked for.
 *
 * "SAIR" IS DELIBERATELY ABSENT. The widget has carried a "Sair" since Block
 * 19b meaning end-the-session; giving the same word a second meaning in the
 * conversation would make the two indistinguishable in a bug report.
 */
const STOP_WORDS = new Set(['parar', 'cancelar', 'descadastrar']);

/**
 * Accents stripped and case folded before comparison, because the alternative
 * is a listener who typed "PARAR!" on a phone keyboard staying subscribed.
 * Trailing punctuation goes the same way for the same reason.
 */
export function isStopWord(text: string): boolean {
  const normalised = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return STOP_WORDS.has(normalised);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/stop-words.test.ts 2>&1 | tail -6`
Expected: `Tests 12 passed (12)`.

- [ ] **Step 5: Prove the substring case bites**

Change the final `replace(/[^a-z]/g, '')` line so the function tests
`STOP_WORDS.has(...)` against each whitespace-separated token instead of the
whole message. Re-run.
Expected: `does not match a word that merely contains one` fails on
`'quero cancelar minha participacao'`. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/lib/consent/stop-words.ts tests/unit/stop-words.test.ts
git commit -m "feat(consent): the words that stop a campaign, and the one that does not"
```

---

### Task 4: The conversation step

**Files:**
- Modify: `src/lib/conversation/steps.ts`, `src/lib/conversation/engine.ts`, `tests/unit/conversation-engine.test.ts`

**Interfaces:**
- Consumes: `isStopWord` (Task 3); `MARKETING_CONSENT` / `MARKETING_STOPPED` (Task 1).
- Produces: `Step` gains `{ kind: 'marketing_consent' }`; `MARKETING_YES_ID`, `MARKETING_NO_ID`, `marketingAnswerFromButtonId`.

**Read before writing:** `engine.ts` already exports `CONSENT_YES_ID`/`CONSENT_NO_ID` for the promotion's **rules** acceptance. Do not reuse, rename, or extend them.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/conversation-engine.test.ts`:

```ts
import {
  MARKETING_NO_ID,
  MARKETING_YES_ID,
  marketingAnswerFromButtonId,
} from '@/lib/conversation/engine';

describe('the marketing consent step', () => {
  it('uses button ids of its own, never the rules-consent ones', () => {
    // engine.ts has carried CONSENT_YES_ID/CONSENT_NO_ID since Block 5b for
    // accepting a promotion's rules. A shared id would make "I accept the
    // rules" and "send me campaigns" the same tap.
    expect(MARKETING_YES_ID).toBe('marketing_yes');
    expect(MARKETING_NO_ID).toBe('marketing_no');
  });

  it('reads a tap as an answer', () => {
    expect(marketingAnswerFromButtonId(MARKETING_YES_ID)).toBe(true);
    expect(marketingAnswerFromButtonId(MARKETING_NO_ID)).toBe(false);
  });

  it('reads anything else as no answer at all', () => {
    // null, not false: a listener who typed something is not a listener who
    // declined, and recording a decline they did not make is the one outcome
    // this step must never produce.
    expect(marketingAnswerFromButtonId('consent_yes')).toBeNull();
    expect(marketingAnswerFromButtonId('whatever')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/conversation-engine.test.ts 2>&1 | tail -6`
Expected: FAIL — the three exports do not exist.

- [ ] **Step 3: Extend the step union**

In `src/lib/conversation/steps.ts`, the `Step` union becomes:

```ts
export type Step =
  | { kind: 'consent' }
  | { kind: 'field'; field: RequestedField }
  | { kind: 'question'; questionId: string; questionKind: QuestionKind }
  // NOT a RequestedField, and that is the structural decision of Block 29c.
  // Requested fields are what a PROMOTION asks and an operator picks from; as
  // one of those, whether the product asks for marketing consent at all would
  // depend on each operator remembering to tick a box, and compliance would be
  // a per-promotion accident. It is a step of the engine instead.
  | { kind: 'marketing_consent' };
```

- [ ] **Step 4: Add the engine's half**

In `src/lib/conversation/engine.ts`, beside the existing consent constants:

```ts
/**
 * The marketing step's own button ids.
 *
 * SEPARATE FROM CONSENT_YES_ID/CONSENT_NO_ID above, which are the promotion's
 * rules acceptance. Sharing them would make one tap mean two consents, which is
 * exactly the bundling the LGPD treats as no consent at all.
 */
export const MARKETING_YES_ID = 'marketing_yes';
export const MARKETING_NO_ID = 'marketing_no';

/**
 * Null rather than false for an unrecognised tap: a listener who typed
 * something has not declined, and writing a `granted = false` row they never
 * asked for is worse than asking again.
 */
export function marketingAnswerFromButtonId(buttonId: string): boolean | null {
  if (buttonId === MARKETING_YES_ID) return true;
  if (buttonId === MARKETING_NO_ID) return false;
  return null;
}
```

Add both keys to `SYSTEM_MESSAGE_DEFAULTS`:

```ts
  MARKETING_CONSENT:
    'Quer receber novidades e promoções desta rádio pelo WhatsApp? Você pode parar quando quiser.',
  MARKETING_STOPPED:
    'Pronto! Você não vai mais receber campanhas desta rádio por aqui.',
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run 2>&1 | tail -5 && npx tsc --noEmit`
Expected: all tests pass; no TypeScript output.

`SYSTEM_MESSAGE_DEFAULTS` is `Record<SystemMessageKey, string>` — total over the enum — so a missing key fails the build rather than shipping a blank message. If `tsc` complains about the two new keys, the types were not regenerated in Task 2; regenerate them.

- [ ] **Step 6: Commit**

```bash
git add src/lib/conversation/ tests/unit/conversation-engine.test.ts
git commit -m "feat(conversation): a consent step that is the engine's, not a promotion's"
```

---

### Task 5: The unsubscribe token

**Files:**
- Create: `supabase/migrations/0230_unsubscribe_tokens.sql`
- Modify: `supabase/tests/65_marketing_consent.test.sql`

**Interfaces:**
- Produces: table `unsubscribe_tokens`; `issue_unsubscribe_token(p_member_id uuid, p_company_id uuid, p_token_hash text, p_campaign_label text) returns uuid`; `consume_unsubscribe_token(p_token_hash text, p_all_stations boolean) returns table (member_id uuid, company_id uuid, stations_left int)`.

- [ ] **Step 1: Write the failing pgTAP**

Bump to `select plan(27);` and append before `finish()`:

```sql
-- Task 5. The token behind an unsubscribe link.
select has_table('public', 'unsubscribe_tokens', 'the token table exists');

select col_type_is('public', 'unsubscribe_tokens', 'token_hash', 'text',
  'the hash is stored, never the token');

select has_function('public', 'issue_unsubscribe_token',
  array['uuid','uuid','text','text'], 'a campaign can mint one');

select has_function('public', 'consume_unsubscribe_token',
  array['text','boolean'], 'and the public page can spend it');

-- Spending it writes the withdrawal, scoped to the sending Station (spec D3).
select lives_ok($$
  select public.issue_unsubscribe_token(
    '00000000-0000-0000-0000-0000000029a2',
    '00000000-0000-0000-0000-0000000029c2',
    repeat('a', 64),
    'Campanha de Natal')
$$, 'a token is minted for a listener and a Station');

select is(
  (select company_id from public.consume_unsubscribe_token(repeat('a', 64), false)),
  '00000000-0000-0000-0000-0000000029c2'::uuid,
  'spending it names the Station that sent');

select is(
  (select granted from public.member_consents
    where member_id = '00000000-0000-0000-0000-0000000029a2'
      and consent_type = 'email_marketing'
    order by granted_at desc, id desc limit 1),
  false, 'and writes the withdrawal');

select is(
  (select origin from public.member_consents
    where member_id = '00000000-0000-0000-0000-0000000029a2'
      and consent_type = 'email_marketing'
    order by granted_at desc, id desc limit 1),
  'unsubscribe:Campanha de Natal',
  'naming the campaign the listener was reading when they left');

-- A SPENT TOKEN IS SPENT. Mail clients prefetch and people click twice; the
-- second use must not be a second write.
select throws_ok($$
  select public.consume_unsubscribe_token(repeat('a', 64), false)
$$, 'P0002', null, 'a spent token cannot be spent again');

select throws_ok($$
  select public.consume_unsubscribe_token(repeat('f', 64), false)
$$, 'P0002', null, 'and an unknown one answers the same way, telling an attacker nothing');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -8`
Expected: the file fails from `has_table` onward.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0230_unsubscribe_tokens.sql`:

```sql
-- supabase/migrations/0230_unsubscribe_tokens.sql

-- Block 29c, Task 5. The token behind "descadastrar" in a campaign e-mail.
--
-- SHAPED ON widget_link_tokens (0178), retention in 0183, and for the same
-- reasons: the hash is stored and never the token, because a table read is not
-- a way to act as somebody; and the URL carries a random value rather than an
-- internal id, because an id in a link is an invitation to change it.
--
-- ONE YEAR, and the asymmetry is deliberate. This token grants exactly one
-- capability: stopping mail. Leaked, somebody unsubscribes another person --
-- low harm, and reversible by re-subscribing. A short expiry instead means a
-- listener who opens the mail a fortnight later cannot leave, which is the path
-- to a formal complaint rather than a quiet unsubscribe.
create table public.unsubscribe_tokens (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  member_id       uuid not null references public.members (id),
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  campaign_label  text,
  expires_at      timestamptz not null default now() + interval '1 year',
  consumed_at     timestamptz,
  created_at      timestamptz not null default now(),

  constraint unsubscribe_tokens_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);

alter table public.unsubscribe_tokens enable row level security;

-- NO POLICY, deliberately. Nothing reads this table as a user: the public page
-- reaches it only through consume_unsubscribe_token below, which is SECURITY
-- DEFINER precisely so an unauthenticated visitor can spend a token without
-- being able to read the table it lives in.
comment on table public.unsubscribe_tokens is
  'Block 29c. One-time tokens behind the unsubscribe link in a campaign e-mail. Hashed like widget_link_tokens (0178); RLS on with no policy, because the only reachable path is consume_unsubscribe_token.';

create index unsubscribe_tokens_sweep_idx on public.unsubscribe_tokens (expires_at);

create function public.issue_unsubscribe_token(
  p_member_id      uuid,
  p_company_id     uuid,
  p_token_hash     text,
  p_campaign_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  select organization_id into v_org from public.companies where id = p_company_id and deleted_at is null;
  if v_org is null then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  insert into public.unsubscribe_tokens
    (organization_id, company_id, member_id, token_hash, campaign_label)
  values (v_org, p_company_id, p_member_id, p_token_hash, p_campaign_label)
  returning id into v_id;

  return v_id;
end;
$$;

create function public.consume_unsubscribe_token(
  p_token_hash   text,
  p_all_stations boolean default false
)
returns table (member_id uuid, company_id uuid, stations_left int)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tok   public.unsubscribe_tokens;
  v_count int := 0;
begin
  -- One statement claims it: `consumed_at is null` inside the UPDATE means two
  -- simultaneous clicks cannot both win, which a SELECT-then-UPDATE would allow.
  update public.unsubscribe_tokens t
     set consumed_at = now()
   where t.token_hash = p_token_hash
     and t.consumed_at is null
     and t.expires_at > now()
  returning t.* into v_tok;

  -- ONE ANSWER FOR THREE CASES -- unknown, spent, expired. An attacker probing
  -- tokens learns nothing from the difference, and the listener sees the same
  -- page either way.
  if v_tok.id is null then
    raise exception 'no usable token' using errcode = 'P0002';
  end if;

  if p_all_stations then
    -- Exactly the Stations this listener is linked to, and no more: a group
    -- with five Stations must not become five withdrawals for a listener who
    -- only ever joined two.
    insert into public.member_consents
      (organization_id, member_id, company_id, consent_type, granted, origin)
    select l.organization_id, v_tok.member_id, l.company_id, ct, false,
           'unsubscribe-all:' || coalesce(v_tok.campaign_label, '')
      from public.member_company_links l
      cross join (values ('email_marketing'::public.member_consent_type),
                         ('whatsapp_marketing'::public.member_consent_type)) as t(ct)
     where l.member_id = v_tok.member_id
       and l.organization_id = v_tok.organization_id;
    get diagnostics v_count = row_count;
  else
    insert into public.member_consents
      (organization_id, member_id, company_id, consent_type, granted, origin)
    values (v_tok.organization_id, v_tok.member_id, v_tok.company_id, 'email_marketing', false,
            'unsubscribe:' || coalesce(v_tok.campaign_label, ''));
    v_count := 1;
  end if;

  return query select v_tok.member_id, v_tok.company_id, v_count;
end;
$$;

revoke execute on function public.issue_unsubscribe_token(uuid, uuid, text, text) from public;
grant execute on function public.issue_unsubscribe_token(uuid, uuid, text, text) to authenticated;

-- anon HOLDS THIS ONE, and it is the only door in this project that it holds
-- for a write. The visitor clicking "descadastrar" has no account and never
-- will; the alternative is asking somebody to log in before they may stop
-- receiving mail, which is the pattern that produces complaints instead.
revoke execute on function public.consume_unsubscribe_token(text, boolean) from public;
grant execute on function public.consume_unsubscribe_token(text, boolean) to anon, authenticated;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: `Result: PASS`.

- [ ] **Step 5: Prove the double-spend guard bites**

Remove `and t.consumed_at is null` from the UPDATE. Re-run `npm run db:test`.
Expected: `a spent token cannot be spent again` fails. Restore.

- [ ] **Step 6: Regenerate types and commit**

```bash
npm run db:types
npx tsc --noEmit
git add supabase/migrations/0230_unsubscribe_tokens.sql supabase/tests/65_marketing_consent.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(consent): a one-time token that stops mail and proves nothing else"
```

---

### Task 6: The service layer

**Files:**
- Create: `src/services/consent.ts`, `tests/unit/consent-service.test.ts`

**Interfaces:**
- Consumes: Task 2's and Task 5's functions.
- Produces: `unsubscribeTokenHash(raw: string): string`; `newUnsubscribeToken(): { raw: string; hash: string }`; `consumeUnsubscribeToken(rawToken: string, allStations: boolean): Promise<{ memberId: string; companyId: string; stationsLeft: number }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/consent-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { newUnsubscribeToken, unsubscribeTokenHash } from '@/services/consent';

describe('the unsubscribe token', () => {
  it('hashes to the shape the column constrains', () => {
    // unsubscribe_tokens.token_hash carries check (token_hash ~ '^[0-9a-f]{64}$').
    // A hash of a different width or case would be refused by the database at
    // insert time -- on a send, in production, for every recipient at once.
    expect(unsubscribeTokenHash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic, because the link is hashed twice — minting and spending', () => {
    expect(unsubscribeTokenHash('same')).toBe(unsubscribeTokenHash('same'));
  });

  it('mints a raw token that is not the hash', () => {
    // The raw value goes in the URL and the hash goes in the table. Returning
    // the same string for both would put the stored secret in every e-mail.
    const { raw, hash } = newUnsubscribeToken();
    expect(raw).not.toBe(hash);
    expect(unsubscribeTokenHash(raw)).toBe(hash);
  });

  it('mints a different token every time', () => {
    const a = newUnsubscribeToken().raw;
    const b = newUnsubscribeToken().raw;
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/consent-service.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot resolve `@/services/consent`.

- [ ] **Step 3: Write the service**

Create `src/services/consent.ts`. Follow `src/services/widget-installations.ts` for how this project hashes a link token and how it builds a Supabase client — read it first and mirror it rather than inventing a second way. The module needs:

```ts
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';

/**
 * SHA-256, hex, lower case -- the exact shape unsubscribe_tokens.token_hash
 * constrains (`^[0-9a-f]{64}$`). The constraint is not decoration: it is what
 * makes a mistake here fail on the first insert rather than on the first click.
 */
export function unsubscribeTokenHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * The raw token goes in the URL; the hash goes in the table. They are returned
 * together exactly once, at mint time, because the raw value is never
 * recoverable afterwards -- which is the whole point of storing the hash.
 */
export function newUnsubscribeToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: unsubscribeTokenHash(raw) };
}
```

plus `consumeUnsubscribeToken(rawToken, allStations)`, which calls
`consume_unsubscribe_token` through the **anon** client (the visitor has no
session), maps `P0002` to a `NotFoundError` from `@/lib/errors`, and returns the
row. Mirror the error mapping in `src/services/templates.ts`'s
`mapTemplateError`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/consent-service.test.ts 2>&1 | tail -6 && npx tsc --noEmit`
Expected: `Tests 4 passed (4)`; no TypeScript output.

- [ ] **Step 5: Commit**

```bash
git add src/services/consent.ts tests/unit/consent-service.test.ts
git commit -m "feat(consent): the token minted once and never recoverable"
```

---

### Task 7: The public unsubscribe page

**Files:**
- Create: `src/app/(public)/unsubscribe/[token]/page.tsx`
- Modify: `messages/en.json`, `messages/pt.json`, `messages/es.json`

**Interfaces:**
- Consumes: `consumeUnsubscribeToken` (Task 6).

**Read before writing:** `src/app/(public)/delete-data/page.tsx` is the precedent — a public page whose Server Action writes, reads `x-forwarded-for` for the client IP, and redirects with a query parameter carrying the receipt.

- [ ] **Step 1: Write the page**

The GET renders the Station's name, what unsubscribing means, and two buttons — each in its own `<form>` posting to a Server Action, with a distinct `key`:

- *Leave this Station* → `consumeUnsubscribeToken(token, false)`
- *Leave every Station of this group* → `consumeUnsubscribeToken(token, true)`

```tsx
/**
 * THE GET WRITES NOTHING, and that is the whole design of this file.
 *
 * Corporate mail filters and antivirus scanners PREFETCH links to inspect them.
 * A route that acted on GET would unsubscribe every listener whose employer
 * scans mail -- silently, with nobody having clicked, and visible only as a
 * campaign whose audience collapsed. The GET renders a page with buttons; the
 * Server Action behind each button is a POST, and it is the POST that writes.
 *
 * The same reasoning is why this page is not "one-click": one click that a
 * machine can perform is not the listener's click.
 */
```

Rate limit the action through `src/lib/rate-limit`, keyed on the client IP read
from `x-forwarded-for` exactly as `delete-data/page.tsx` reads it. **Block 11c's
trap applies:** behind the proxy the limiter must see the real client address,
or it limits the proxy as though it were one person.

A spent, expired, or unknown token renders the same sentence — the service maps
all three to `NotFoundError`, and the page must not distinguish them.

- [ ] **Step 2: Add the copy to all three catalogues**

Namespace `unsubscribe`: the heading, the explanation, the two button labels,
the success sentence for each scope, and the one sentence covering spent /
expired / unknown. Real Portuguese and Spanish — this product's listeners are
Brazilian, and this page is the one a listener sees at their most annoyed.

- [ ] **Step 3: Run the gates**

Run: `npx tsc --noEmit && npm run lint 2>&1 | tail -2 && npx vitest run tests/unit/i18n 2>&1 | tail -4`
Expected: clean, clean, catalogue tests passing.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(public)/unsubscribe" messages
git commit -m "feat(consent): the page a listener leaves from, which a scanner cannot"
```

---

### Task 8: `List-Unsubscribe`

**Files:**
- Modify: `src/lib/mailer/index.ts`, `tests/unit/mailer.test.ts`

**Interfaces:**
- Produces: `MailMessage` gains `headers?: Record<string, string>`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/mailer.test.ts`:

```ts
it('passes custom headers through to the transport', async () => {
  // List-Unsubscribe is the difference between Gmail showing a one-tap
  // unsubscribe and Gmail treating the sender as one with no exit. It costs
  // two lines here and it is deliverability, not decoration.
  const mailer = new DevMailer();
  await mailer.send({
    to: 'a@b.test',
    subject: 'x',
    text: 'y',
    headers: { 'List-Unsubscribe': '<https://app.test/unsubscribe/abc>' },
  });
  expect(mailer.sent[0]?.headers?.['List-Unsubscribe']).toBe(
    '<https://app.test/unsubscribe/abc>',
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/mailer.test.ts 2>&1 | tail -6`
Expected: FAIL — `headers` is not a property of `MailMessage`.

- [ ] **Step 3: Add the field**

In `src/lib/mailer/index.ts`, `MailMessage` gains:

```ts
  /**
   * Extra RFC 5322 headers. Block 29c needs exactly two -- List-Unsubscribe and
   * List-Unsubscribe-Post -- and they belong on the message rather than on the
   * transport because they name a URL that is per recipient.
   */
  headers?: Record<string, string>;
```

`SmtpMailer.send` passes `headers` straight to `sendMail`, which nodemailer
already accepts under that name.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/mailer.test.ts 2>&1 | tail -6 && npx tsc --noEmit`
Expected: passing; no TypeScript output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailer/index.ts tests/unit/mailer.test.ts
git commit -m "feat(mailer): the header that makes a campaign look like it has an exit"
```

---

### Task 9: The widget checkbox and the operator's labels

**Files:**
- Modify: `src/app/(widget)/w/[publicKey]/enter-promotion.tsx`, the widget's participation action and schema, `src/app/(app)/members/format.ts`, `messages/{en,pt,es}.json`

- [ ] **Step 1: Add the checkbox**

In `enter-promotion.tsx`, on the screen that already collects the listener's
details, add one checkbox bound to local state, **unchecked by default**:

```tsx
{/* UNCHECKED, and it stays that way. A pre-ticked box is not affirmative
    consent under the LGPD and is the first thing an audit looks at. The
    default here is not a UX preference -- it is the legal posture. */}
```

Post it with the participation. The value reaches the server action, is parsed
by the existing Zod schema (add `marketingConsent: z.boolean().default(false)`),
and — **only after the participation is recorded** — writes a
`whatsapp_marketing` row through `record_member_consent` with
`origin = 'widget'`.

The ordering is the requirement, not an implementation detail: a listener whose
consent write fails must still be entered in the promotion.

- [ ] **Step 2: Add the two consent labels**

`src/app/(app)/members/format.ts` maps `member_consent_type` to a translation
key. Add `whatsapp_marketing` and `email_marketing`, and their strings in all
three catalogues. The Member sheet's consent form is driven by the enum, so
nothing else is needed for an operator to record either by hand — which spec §9
allows deliberately, because `member_consents.recorded_by` is what makes a
consent given by telephone defensible.

- [ ] **Step 3: Run the gates**

Run: `npx tsc --noEmit && npm run lint 2>&1 | tail -2 && npx vitest run 2>&1 | tail -4`
Expected: clean, clean, all passing.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(widget)" "src/app/(app)/members" src/schemas messages
git commit -m "feat(consent): an unticked box, and two labels the sheet already wanted"
```

---

### Task 10: The isolation suite, the e2e, and the full gate run

**Files:**
- Create: `tests/isolation/consent.test.ts`
- Modify: `tests/e2e/widget.spec.ts`, `scripts/verify-isolation-suite.mjs`

- [ ] **Step 1: Write the isolation cases**

Create `tests/isolation/consent.test.ts`, following
`tests/isolation/marketing-templates.test.ts` for its harness use. Six cases:

1. A token minted for Station A cannot be spent to unsubscribe from Station B — the returned `company_id` is A's, and B's consent rows are untouched.
2. An expired token is refused (`P0002`).
3. A spent token is refused a second time, and only **one** withdrawal row exists afterwards.
4. `p_all_stations = true` writes rows for exactly the Stations the listener is linked to — seed a third Station in the same Organization with **no** link and assert it received nothing.
5. `anon` may execute `consume_unsubscribe_token` and may **not** read `unsubscribe_tokens` directly.
6. An eligible-listener query from Station A's session never returns a listener of Station B.

Raise `minTests` in `scripts/verify-isolation-suite.mjs` to match, and add the
new file to its required list.

- [ ] **Step 2: Extend the e2e**

In `tests/e2e/widget.spec.ts`, after the existing participation steps:

- assert the marketing checkbox renders **unchecked**;
- tick it, complete the participation, and assert the database directly — a
  `whatsapp_marketing` row with `granted = true` and `origin = 'widget'` — because
  a screen saying "pronto" proves the action was reached, not that anything was
  written;
- participate a second time with the same listener and assert **no second row**
  appears, which is spec D2's "once" end to end.

- [ ] **Step 3: The GET-writes-nothing case**

Also in the e2e: mint a token, `page.goto` the unsubscribe URL, and assert the
database has **no** new `member_consents` row. Then click the button and assert
it appears.

This is the case that pins §7's decision. Without it, a later "simplification"
to a one-click GET would pass every other test in this repository while
unsubscribing every listener whose employer scans mail.

- [ ] **Step 4: Run the whole gate set, in the order that gives an honest verdict**

```bash
npm run db:reset
npm run db:test
npm run test:isolation
npx tsc --noEmit
npm run lint
npx vitest run
CI=1 npx playwright test tests/e2e/widget.spec.ts --workers=1
```

`db:reset` must precede `db:test`, and `db:test` must never run after the
isolation suite or the e2e — a database left dirty by another suite gives a red
that is not code.

**If the isolation wrapper reports INCOMPLETE**, that is a documented
pre-existing crash in this repo (`Worker exited unexpectedly`), not necessarily
this branch. Confirm before blaming code by re-running with your own reporter and
comparing the JSON against the summary line:

```bash
npx vitest run --config vitest.isolation.config.ts \
  --reporter=default --reporter=json --outputFile=./iso.json
```

A JSON report listing every file with zero failures beside a short or corrupted
summary line is that crash.

- [ ] **Step 5: Search for the pins no compiler holds**

```bash
grep -rn "toHaveCount(\|toHaveLength(" tests/ | grep -iE "consent|message|system"
grep -rn "has_function(" supabase/tests/ | grep -i consent
```

- [ ] **Step 6: Commit**

```bash
git add tests scripts
git commit -m "feat(consent): the tenancy cases, and the GET that must stay inert"
```

---

## Self-Review

**Spec coverage.** §3's D1 → Task 2's asymmetry assertions. D2 → Task 4 (the step) and Task 9 (the checkbox), with "once" proved in Task 10's e2e. D3 → Task 5's `p_all_stations` and Task 10's case 4. D4 → Task 3. D5 → Task 1's comment; nothing touches `sponsor_communication`. §4 → Task 1. §5's four layers and the tiebreak → Task 2. §6 → Tasks 4 and 9. §7's token, expiry, GET/POST split, rate limit, `List-Unsubscribe` and stop words → Tasks 5, 7, 8 and 3. §8 → Task 2. §9 → Task 9's Step 2. §10's test table → spread across the tasks that own each behaviour, with the tenancy cases and the GET case in Task 10.

**Placeholders.** Tasks 7 and 9 describe screens rather than reproducing them, which is deliberate: both modify files whose surrounding patterns dominate the result, and each names the precedent file to copy (`delete-data/page.tsx`, `members-filters.tsx`). Every SQL step, every test, and every module carries its actual content.

**Type consistency.** `members_marketing_eligible_bulk` takes `(uuid[], uuid, public.message_channel)` in Task 2 and is called with that signature in Task 10. `consume_unsubscribe_token(text, boolean)` is defined in Task 5 and wrapped in Task 6 as `consumeUnsubscribeToken(rawToken, allStations)`. `MARKETING_YES_ID`/`MARKETING_NO_ID` are defined in Task 4 and used nowhere else in this plan. `unsubscribeTokenHash` and `newUnsubscribeToken` are defined in Task 6 and consumed by 29d, not here.

**One gap found and closed while reviewing.** Task 5's `p_all_stations` branch writes **both** consent types, while the single-Station branch writes only `email_marketing`. That is intentional and now stated: a listener clicking "leave every Station" is asking to stop hearing from the group, and honouring that on e-mail while leaving WhatsApp running would be the narrowest possible reading of a plainly broad request. The single-Station click comes from an e-mail and stops e-mail; the group action stops everything.
