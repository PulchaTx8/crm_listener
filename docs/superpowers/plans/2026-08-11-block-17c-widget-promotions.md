# Block 17c — Widget Promotions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A listener identified by 17a reads a promotion's rules inside the widget, agrees, answers what the promotion asks, and the entry lands in `participations` with source `WEB`.

**Architecture:** Two migrations (an enum value alone, then the column, a shared field-writer and two doors), one server-actions file, one client panel with three states, and a rules field on the operator's promotions form. Nothing partial is ever written — the walk is browser state and one door writes everything in a single transaction.

**Tech Stack:** Next.js 15 App Router (server actions), Supabase Postgres 17, pgTAP, Vitest, Playwright, next-intl, Zod, Tailwind.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-11-block-17c-widget-promotions-design.md`. D1–D6 live there; this plan implements them and does not re-decide.
- **Migrations are `0170` and `0171`.** The repository is at `0169`. Confirm with `ls supabase/migrations | tail -3` first.
- **`ALTER TYPE … ADD VALUE` gets its own file** — 0082, 0091, 0151, 0160 and 0166 each paid for that rule.
- **Every widget door:** `security definer`, `set search_path = pg_catalog, public`, `revoke execute … from public`, `grant execute … to service_role`.
- **Never retype a shipped function body.** If a signature must change, `grep -l "function public.<name>" supabase/migrations/*.sql` and take the body from the **last** file, extracted by script. This is how 0168 silently reverted 0163's public-key pin.
- **`readSessionFor`, never `readSession`,** in anything that serves a request.
- **Every user-visible string** goes through `messages/{en,pt,es}.json` — note the file is `pt.json`, not `pt-BR.json`.
- **Catalogue edits:** read, `JSON.parse`, mutate, then write `(JSON.stringify(o, null, 2) + '\n').replace(/\n/g, '\r\n')`. These files are CRLF, and a shell heredoc with an apostrophe in it has already corrupted them once.
- **Local stack:** `npm run db:reset` (guarded, local only), `npm run seed:demo`. `npm run db:test` needs a freshly reset database.

---

## File Structure

| file | responsibility |
| --- | --- |
| `supabase/migrations/0170_widget_participation_source.sql` | `WEB` on `participation_source`, alone |
| `supabase/migrations/0171_widget_promotions.sql` | `promotions.rules`, `apply_member_field_values`, the two doors |
| `supabase/tests/42_widget_promotions.test.sql` | pgTAP for the helper and both doors |
| `src/schemas/widget-promotions.ts` | the two input shapes |
| `src/lib/widget/promotion-mapping.ts` | the pure half — refusal narrowing, step shapes |
| `src/app/(widget)/w/[publicKey]/promotion-actions.ts` | `listPromotionsAction`, `enterPromotionAction` |
| `src/app/(widget)/w/[publicKey]/enter-promotion.tsx` | list → walk → done |
| `src/app/(widget)/w/[publicKey]/menu.tsx` | the second button enables |
| the operator's promotions form + `src/services/promotions.ts` | the rules field |
| `tests/e2e/widget.spec.ts` | the journey, continuing 17a's |

---

### Task 1: The enum value

**Files:** Create `supabase/migrations/0170_widget_participation_source.sql`

**Interfaces:** Produces `'WEB'` on `public.participation_source`.

- [ ] **Step 1: Confirm the number**

Run: `ls supabase/migrations | tail -3`. Expected: highest is `0169_music_requests_listener_note.sql`.

- [ ] **Step 2: Write it**

```sql
-- supabase/migrations/0170_widget_participation_source.sql

-- Block 17c. ONE ADD VALUE AND NOTHING ELSE IN THIS FILE.
--
-- ALTER TYPE ... ADD VALUE cannot share a transaction with a statement that
-- USES the value. Separate files are separate transactions, and 0171 uses this
-- one. 0082, 0091, 0151, 0160 and 0166 each paid for this rule.

alter type public.participation_source add value 'WEB';

comment on type public.participation_source is
  'How an entry reached this product. MANUAL is an operator recording it; IMPORT is the legacy migration; WHATSAPP is this product''s own bot; WEB is Block 17c -- a listener standing on the Station''s own website, through the embedded widget. Also the source recorded on a promotion_refusals row, so a refusal carries the door it came through.';
```

- [ ] **Step 3: Apply and verify**

Run: `npm run db:reset`
Then: `docker exec supabase_db_CRM_-_LISTENER psql -U postgres -d postgres -t -c "select string_agg(enumlabel, ', ' order by enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'participation_source';"`
Expected: `MANUAL, IMPORT, WHATSAPP, WEB`

- [ ] **Step 4: Fix the enum assertion that will now fail**

Run: `npm run db:test`. A pgTAP file pins the exact list of this enum, exactly as `14_music_catalogue` pinned `music_request_channel` for 0166. Find it with `grep -rn "participation_source" supabase/tests/*.sql`, add `'WEB'` to the expected array, and extend the comment above it to say what WEB means. **Update it — never loosen it into a subset check.**

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0170_widget_participation_source.sql supabase/tests/
git commit -m "feat(17c): WEB joins the participation sources"
```

---

### Task 2: The column, the shared field-writer, and the two doors

**Files:**
- Create: `supabase/migrations/0171_widget_promotions.sql`
- Create: `supabase/tests/42_widget_promotions.test.sql`

**Interfaces:**
- Consumes: `'WEB'` (Task 1); `public.whatsapp_conversation_steps(uuid, uuid)`; `public.apply_participation(uuid, uuid, timestamptz, public.participation_source, jsonb)` — **the live one is 0069, not 0054**; `public.widget_music_request_context(text, uuid)` (0167) for the three shared refusals.
- Produces:
  - `public.apply_member_field_values(p_member_id uuid, p_fields jsonb) returns void`
  - `public.widget_promotions(p_public_key text, p_member_id uuid) returns jsonb`
  - `public.widget_enter_promotion(p_public_key text, p_member_id uuid, p_promotion_id uuid, p_consent boolean, p_fields jsonb, p_answers jsonb) returns jsonb`
  - `promotions.rules text`

**Read first:** `supabase/migrations/0071_complete_conversation.sql` lines 150–200 — the reference implementation for what an entry writes. `supabase/tests/41_widget_music_request.test.sql` for the fixture style.

**The eight-way mapping**, from 0071 and 0065, keyed by `promotion_requested_field` (`full_name, address, city, neighbourhood, age, cpf, passport, discovery_source`):

| key in `p_fields` | column on `members` |
| --- | --- |
| `full_name` | `full_name` |
| `address` | `address_line` |
| `city` | `city` |
| `neighbourhood` | `neighbourhood` |
| `age` | `birth_date` (cast to `date`) |
| `cpf` | `cpf_hash` |
| `passport` | `passport` |
| `discovery_source` | `discovery_source` |

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/42_widget_promotions.test.sql`, `select plan(13)`. Fixtures follow `41_widget_music_request.test.sql`: one Organization, two Stations with an installation each, one member linked to the first only. Add one promotion with `rules` set and one without, both live.

The thirteen assertions:

1. `widget_promotions` lists the promotion **with** rules.
2. …and does **not** list the one without (D3).
3. …and refuses `unknown_listener` for the other Station's key.
4. `widget_enter_promotion` with the right fields and answers returns `ok`.
5. The row in `participations` carries `source = 'WEB'`.
6. `created_by` on it is null.
7. A `member_consents` row of type `rules` exists for that member.
8. One `member_field_confirmations` row per field answered.
9. The member's own columns took the values.
10. **A payload missing a requested field is refused with `missing_answers`** — the assertion the spec calls the most important, because it is what keeps the screen from becoming the authority on what to ask.
11. `p_consent = false` writes `promotion_refusals` with `source = 'WEB'` and **no** participation.
12. A closed promotion (`ends_at` in the past) is refused with `promotion_closed`.
13. A second entry is refused when `allow_multiple_entries` is false.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx supabase test db supabase/tests/42_widget_promotions.test.sql --local`
Expected: FAIL — `function public.widget_promotions(...) does not exist`.
(The flag is a positional path plus `--local`; there is no `--file`.)

- [ ] **Step 3: Write the migration**

Structure, in this order:

```sql
alter table public.promotions add column rules text;

comment on column public.promotions.rules is
  'What a listener agrees to when they enter, Block 17c (D2). NULLABLE, and the null case is meaningful rather than broken: a promotion with no rules does not appear in the widget at all (D3), because an agreement box above nothing is what this column exists to prevent. Every promotion that existed before 17c has null here, so the widget list is empty at every Station until an operator writes the first one.';

-- The write half of the eight-way mapping, extracted so this block does not
-- become its THIRD copy. 0065's member_field_value reads it; 0071's
-- complete_conversation writes it inline and is deliberately left alone here --
-- rewriting a shipped body is how 0168 reverted 0163's public-key pin. A ninth
-- requested field is an edit in 0065, in 0071 AND here until they converge.
create function public.apply_member_field_values(p_member_id uuid, p_fields jsonb)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.members where id = p_member_id;
  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  -- coalesce per field so an unanswered one is left alone rather than blanked:
  -- the step list only contains what was asked, and a walk re-run could carry
  -- fewer answers than the record already holds. 0071's own reasoning.
  update public.members m set
    full_name        = coalesce(nullif(btrim(p_fields ->> 'full_name'), ''), m.full_name),
    address_line     = coalesce(nullif(btrim(p_fields ->> 'address'), ''), m.address_line),
    city             = coalesce(nullif(btrim(p_fields ->> 'city'), ''), m.city),
    neighbourhood    = coalesce(nullif(btrim(p_fields ->> 'neighbourhood'), ''), m.neighbourhood),
    birth_date       = coalesce((nullif(btrim(p_fields ->> 'age'), ''))::date, m.birth_date),
    cpf_hash         = coalesce(nullif(btrim(p_fields ->> 'cpf'), ''), m.cpf_hash),
    passport         = coalesce(nullif(btrim(p_fields ->> 'passport'), ''), m.passport),
    discovery_source = coalesce(nullif(btrim(p_fields ->> 'discovery_source'), ''), m.discovery_source),
    updated_at       = now()
  where m.id = p_member_id;

  -- One confirmation per field the listener ACTUALLY answered, stamped now:
  -- the confirmation records when we were told.
  insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at)
  select p_member_id, v_org, k::public.promotion_requested_field, now()
  from jsonb_object_keys(coalesce(p_fields, '{}'::jsonb)) k
  on conflict (member_id, field) do update set confirmed_at = excluded.confirmed_at;
end;
$$;
```

Then `widget_promotions`, which reuses `widget_music_request_context` (0167) for the three shared refusals — **do not write a fourth copy of them** — and selects live promotions with `rules is not null`, each with `already_entered`.

Then `widget_enter_promotion`, in this order: the three shared refusals → the promotion belongs to this Station and is open (`promotion_closed`) → **recompute `whatsapp_conversation_steps` server-side and check the payload answers exactly it** (`missing_answers`) → if `p_consent` is false, insert `promotion_refusals` with `'WEB'` and return → otherwise `apply_member_field_values`, the `member_consents` row of type `rules`, `apply_participation(..., 'WEB', p_answers)`, and an `audit_logs` row with `actor_id` null.

- [ ] **Step 4: Run until green**

Run: `npm run db:reset && npm run db:test`
Expected: `42_widget_promotions.test.sql` — 13 of 13, and every other file still passing.

- [ ] **Step 5: Prove the important assertion bites**

Temporarily delete the `missing_answers` check from the door with `create or replace` in psql, re-run the file, and confirm assertion 10 fails. Restore with `npm run db:reset`. A test that passes when the guard is gone is not a test.

- [ ] **Step 6: Isolation**

Run: `npm run test:isolation`. If a case lists `promotions` columns, add `rules`. If a worker dies and the suite's own guard reports fewer files than it collected, re-run once — that has happened twice and been clean on the second run both times.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0171_widget_promotions.sql supabase/tests/42_widget_promotions.test.sql
git commit -m "feat(17c): the promotion doors, and a shared writer for the eight requested fields"
```

---

### Task 3: The input shapes

**Files:** Create `src/schemas/widget-promotions.ts`, `tests/unit/widget-promotions-schema.test.ts`

**Interfaces:** Produces `listPromotionsSchema`, `enterPromotionSchema` and their inferred types.

- [ ] **Step 1: Write the failing test**

```typescript
import { enterPromotionSchema } from '@/schemas/widget-promotions';

const BASE = { promotionId: '00000000-0000-0000-0000-000000000001', consent: 'on' };

it('reads the agreement checkbox as a boolean', () => {
  expect(enterPromotionSchema.parse({ ...BASE, fields: '{}', answers: '[]' }).consent).toBe(true);
  expect(
    enterPromotionSchema.parse({ ...BASE, consent: '', fields: '{}', answers: '[]' }).consent,
  ).toBe(false);
});

it('refuses a promotion id that is not a uuid', () => {
  expect(
    enterPromotionSchema.safeParse({ ...BASE, promotionId: 'nope', fields: '{}', answers: '[]' })
      .success,
  ).toBe(false);
});

it('parses fields and answers out of their JSON strings', () => {
  const parsed = enterPromotionSchema.parse({
    ...BASE,
    fields: '{"city":"Santos"}',
    answers: '[{"questionId":"00000000-0000-0000-0000-000000000002","optionId":null,"answerText":"sim"}]',
  });
  expect(parsed.fields).toEqual({ city: 'Santos' });
  expect(parsed.answers).toHaveLength(1);
});

it('refuses a field name no promotion can ask for', () => {
  expect(
    enterPromotionSchema.safeParse({ ...BASE, fields: '{"salary":"9000"}', answers: '[]' }).success,
  ).toBe(false);
});

it('refuses JSON that is not JSON', () => {
  expect(
    enterPromotionSchema.safeParse({ ...BASE, fields: 'not json', answers: '[]' }).success,
  ).toBe(false);
});
```

- [ ] **Step 2: Run it, watch it fail, then implement**

`.strict()` throughout, like `src/schemas/widget.ts`. `fields` is a record whose keys are constrained to the eight values of `promotion_requested_field` — `z.enum(['full_name','address','city','neighbourhood','age','cpf','passport','discovery_source'])` — so a key the schema does not know is refused before it reaches a door that would ignore it silently. Both JSON payloads arrive as strings from a form and are parsed inside the schema with a `try`/`catch` that fails the parse rather than throwing.

- [ ] **Step 3: Commit**

```bash
npx vitest run tests/unit/widget-promotions-schema.test.ts
git add src/schemas/widget-promotions.ts tests/unit/widget-promotions-schema.test.ts
git commit -m "feat(17c): the shapes the widget's promotion panel may post"
```

---

### Task 4: The pure half, and the actions

**Files:**
- Create: `src/lib/widget/promotion-mapping.ts`, `tests/unit/widget-promotion-mapping.test.ts`
- Create: `src/app/(widget)/w/[publicKey]/promotion-actions.ts`

**Interfaces:**
- Consumes: Task 3's schemas; Task 2's doors; `readSessionFor`, `callerIp`, `ipKey`, `withinLimits`, `readAnswer` (all already extracted into `@/lib/widget/`).
- Produces:
  - `listPromotionsAction(publicKey: string): Promise<ListState>`
  - `enterPromotionAction(previous: EnterState, formData: FormData): Promise<EnterState>`
  - `interface WidgetPromotion { id: string; name: string; rules: string; artUrl: string | null; thumbUrl: string | null; alreadyEntered: boolean; steps: WidgetStep[] }`
  - `type WidgetStep = { kind: 'consent' } | { kind: 'field'; field: string } | { kind: 'question'; questionId: string; questionKind: string }`
  - `type EnterRefusal = 'invalid' | 'no_session' | 'rate_limited' | 'promotion_closed' | 'already_entered' | 'missing_answers' | 'listener_anonymized' | 'unknown_installation' | 'refused' | 'failed'`

**Why the mapping is its own module:** a `'use server'` file may export nothing but async functions, so anything pure written inside it cannot be imported by a test. This is the same split 17b made for `music-mapping.ts`, and for the same reason.

- [ ] **Step 1: Write the failing mapping test**

```typescript
import { enterRefusal } from '@/lib/widget/promotion-mapping';

it('passes through the reasons the panel has a sentence for', () => {
  for (const r of ['promotion_closed', 'already_entered', 'missing_answers', 'listener_anonymized', 'unknown_installation']) {
    expect(enterRefusal(r)).toBe(r);
  }
});

it('turns unknown_listener into no_session, which is what they can act on', () => {
  expect(enterRefusal('unknown_listener')).toBe('no_session');
});

it('turns a reason it does not know into failed rather than passing it on', () => {
  expect(enterRefusal('invented_by_a_later_migration')).toBe('failed');
  expect(enterRefusal(null)).toBe('failed');
});
```

- [ ] **Step 2: Implement the mapping, then the actions**

Limits, beside 17b's in shape: `LIST_PER_IP_MINUTE = { limit: 20, windowSeconds: 60 }` and `ENTER_PER_IP_HOUR = { limit: 20, windowSeconds: 3600 }`.

`enterPromotionAction` takes the member from `session.claims.memberId` and **never** from the form. `listPromotionsAction` takes a bare `publicKey` and is not a `useActionState` pair, exactly like 17b's `getWaitAction`.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run tests/unit/ && npm run typecheck && npm run lint
git add src/lib/widget/promotion-mapping.ts "src/app/(widget)/w/[publicKey]/promotion-actions.ts" tests/unit/widget-promotion-mapping.test.ts
git commit -m "feat(17c): the widget's promotion actions"
```

**If `npm run typecheck` says the RPC name is not assignable**, run `npm run db:types` — the generated types have not seen the new doors. Optional RPC arguments generate as `string | undefined`, so pass `undefined` and never `null` for them.

---

### Task 5: The panel

**Files:**
- Create: `src/app/(widget)/w/[publicKey]/enter-promotion.tsx`
- Modify: `src/app/(widget)/w/[publicKey]/menu.tsx`, the three catalogues

- [ ] **Step 1: Enable the second button**

`menu.tsx` already holds `panel` state from 17b (`'menu' | 'song'`). Add `'promotion'`, drop the second button's `disabled` and `title`, and delete the `{/* Block 17c. */}` comment above it — it names work that is now done.

- [ ] **Step 2: Build the three states**

**List:** name, `thumbUrl` if present, and a muted "already entered" line where `alreadyEntered`.

**Walk**, per §6 of the spec:
1. the art (`artUrl`), the rules in a `max-h-64 overflow-y-auto` box, and the agreement checkbox
2. every `kind: 'field'` step on one screen
3. one screen per `kind: 'question'` step

**Done:** entered, or refused-and-recorded when the listener declined.

Disagreeing submits with `consent` unchecked and lands on the refusal message — it is a real path, not an abandonment.

- [ ] **Step 3: Catalogue keys, three languages**

Use the Node read/parse/mutate/write recipe from the Global Constraints. Then verify:

```bash
node -e "const f=require('fs');const k=l=>Object.keys(JSON.parse(f.readFileSync('messages/'+l+'.json','utf8')).widget).sort().join(',');if(k('en')!==k('pt')||k('en')!==k('es'))throw new Error('widget keys differ');console.log('three catalogues agree')"
```

- [ ] **Step 4: Gates and commit**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add "src/app/(widget)/w/[publicKey]/" messages/
git commit -m "feat(17c): the widget's promotion panel, in three languages"
```

---

### Task 6: The rules field on the operator's form

**Files:** the promotions form and `src/services/promotions.ts`; find them with `grep -rln "promotions" src/app/\(app\)/promotions | head`

- [ ] **Step 1: Read how the form saves today**

The promotion write goes through an RPC. Find it, and check whether its signature must change — if it must, `grep -l "function public.<name>" supabase/migrations/*.sql`, take the body from the **last** file, and extract it **by script** rather than retyping it. If instead the service writes columns directly, this task is a field and a mapping.

- [ ] **Step 2: Write the failing test, implement, and gate**

A textarea, optional, with a sentence saying a promotion without rules does not appear in the widget — the operator should learn D3 where the consequence is, not from a document.

- [ ] **Step 3: Commit**

```bash
npm run lint && npm run typecheck && npm run test && npm run db:test
git commit -m "feat(17c): a promotion carries the rules a listener agrees to"
```

---

### Task 7: The journey

**Files:** Modify `tests/e2e/widget.spec.ts`

- [ ] **Step 1: Extend the existing journey**

It ends with 17b's request assertions. Continue from there — the session is already minted in a third-party frame, which is the thing worth proving and the thing a fresh test would skip.

The `beforeAll` must seed a promotion **with rules** for `journeyCompanyId` (already module-scope from 17b). Walk: open the panel → the list shows it → agree → fill the fields → answer → confirmation. Then read `participations` back with `admin` and assert `source = 'WEB'`, `created_by` null, and a `member_consents` row of type `rules`.

- [ ] **Step 2: Run it**

```bash
rm -rf .next && npm run db:reset && npm run seed:branding
npx playwright test tests/e2e/widget.spec.ts --workers=1
```

If chunks 404 or the layout collapses, kill any `next dev` first — a stale dev server serves a dead `layout.css` and the mobile header stops being hidden.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/widget.spec.ts
git commit -m "test(17c): the journey from a website visitor to an entry in participations"
```

---

### Task 8: The full gate, the documents, the PR

- [ ] **Step 1: Every suite, in CI's order**

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run db:reset && npm run db:test
npm run test:isolation
npm run db:reset && npm run seed:branding && npm run test:e2e
```

- [ ] **Step 2: Documents**

`docs/WIDGET.md` gains section 9: what the second button does, that a promotion without rules is invisible **and that this makes the list empty at every Station on the day it ships**, and the consent divergence with WhatsApp.

- [ ] **Step 3: PR**

Body states: the six decisions, the empty-list consequence, the consent divergence and that WhatsApp will follow, and the three-copy field mapping now down to two writers.

- [ ] **Step 4: After the merge, apply the migrations**

**The deploy does not carry them.** This has now broken production twice — Block 13a and Block 17b, the second time visible to the owner as "Algo deu errado" in the widget. Run `npx supabase migration list --linked`; a filled `local` beside an empty `remote` is the whole diagnosis. Apply `0170` and `0171` **before** telling anybody it is live.

**Never `supabase db reset --linked`.**

---

## Self-Review

**Spec coverage.** §3 D1 → Task 2 (`widget_promotions` lists every live promotion). D2 → Tasks 2 and 6. D3 → Task 2 (`rules is not null`, pinned by assertion 2) and Task 6's helper text. D4 → Task 4 (one door call at the end; no progress table anywhere in the plan). D5 → Task 2 (the `member_consents` row, assertion 7). D6 → Task 5's three screens. §4 → the architecture line and Task 4. §5 → Task 2 Step 3, including the deliberate decision not to touch 0071. §6 → Task 5. §7 → Task 2. §8 → Tasks 1 and 2. §9 → the assertions in each task plus Task 8. §10 → Tasks 3–6. §12's risks → Task 8's PR body and `docs/WIDGET.md`.

**Type consistency.** `WidgetPromotion` and `WidgetStep` are defined in Task 4 and consumed in Task 5 under those names. `EnterRefusal`'s members match the reasons Task 2's door returns, plus the three the action itself produces (`invalid`, `no_session`, `rate_limited`) and `refused` for the declined path.

**One gap found and closed:** Task 1 originally ended at the migration. A pgTAP file pins `participation_source`'s exact list — the same shape that failed for `music_request_channel` when 0166 landed — so Step 4 now updates it, and says explicitly not to loosen it into a subset check.
