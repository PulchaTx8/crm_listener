# Block 30a — The Listener Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pickups, Participations and Requests stop sending a listener's telephone number to the browser, and share one read-only listener card that masks sensitive fields and reveals them one at a time, audited.

**Architecture:** The mask is the door's job — `list_pickups` and `list_participations` return four digits, the shape `list_music_requests` has returned since Block 22. One new SECURITY DEFINER door, `reveal_member_field`, returns a single whole value and writes an audit row for the asking; it is `reveal_request_phone` (0190) generalised from one request to one listener. The card reads through the existing RLS-backed `getMember` and masks in Node, so nothing sensitive reaches the browser unrevealed.

**Tech Stack:** PostgreSQL 17 (RLS, pgTAP), Next.js 15 App Router (Server Actions, `typedRoutes`), TypeScript, Zod, next-intl, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-block-30a-listener-privacy-design.md`

## Global Constraints

- Comments explain WHY, never WHAT. A comment that states something **false** is a defect of the same severity as false code.
- No new user-facing English strings outside `messages/{en,pt,es}.json`. All three catalogues get every key; `catalogue.test.ts` is the guard.
- `src/lib/supabase/database.types.ts` is generated, never hand-edited. Regenerate with `npm run db:types` after every migration.
- One string literal for a PostgREST `.select(...)`, never a concatenation — the types are inferred from the literal.
- `create or replace` preserves a function's ACL; `drop` + `create` destroys it. Any function recreated here is recreated from its **live** definition, never from the migration that first created it. `psql` is **not installed**; use a Node script with the repo's `pg` dependency against `LOCAL_SUPABASE_DB_URL`.
- pgTAP `plan(N)` is the file's **running total**, not this task's addition.
- Gate order is `npm run db:reset` → `npm run db:test` → `npm run test:isolation`. Running `db:test` after another suite gives a red that is not code.
- Every conditionally rendered `<Button>` gets a distinct `key`. Two buttons in one position let React reuse the DOM node and the survivor inherits `type="submit"` — this project has shipped that defect.
- Migrations already merged are never edited in place. A repair is a new numbered file.
- Next free migration number: **0253**. Next free pgTAP file number: **69**.

## The rule that has cost this project whole blocks

Task 3 recreates two functions. Before writing either body, dump the **live** one:

```js
// scripts/dump-fn.mjs — throwaway, do not commit
import pg from 'pg';
const c = new pg.Client(process.env.LOCAL_SUPABASE_DB_URL);
await c.connect();
const { rows } = await c.query(
  "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1",
  [process.argv[2]],
);
console.log(rows.map((r) => r.pg_get_functiondef).join('\n\n'));
await c.end();
```

Both functions happen to be defined exactly once today (`grep -l "function public.list_participations" supabase/migrations/` returns 0090 alone; the same for 0095). Dump them anyway. Re-deriving a body from an old migration reverts every later repair **without a single test turning red**.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0253_reveal_member_field.sql` | The reveal door, its revoke/grant, its comment |
| `supabase/migrations/0254_pickup_and_participation_phone_last4.sql` | `list_pickups` and `list_participations`, projection narrowed |
| `supabase/tests/69_listener_reveal.test.sql` | pgTAP for 0253 |
| `src/lib/members/mask.ts` | Pure masking rules. No React, no Next, no database |
| `src/app/(app)/members/listener-card.ts` | Server Actions: read one masked card, reveal one field |
| `src/components/members/listener-card-dialog.tsx` | The shared window |
| `src/app/(app)/pickups/hand-over-dialog.tsx` | Item 5's window |

---

### Task 1: The masking rules

Pure functions first, because every screen in the block renders them and none of them needs a database to be proved.

**Files:**
- Create: `src/lib/members/mask.ts`, `tests/unit/members-mask.test.ts`
- Modify: `src/app/(app)/music/requests/request-status.tsx`, `src/app/(app)/music/requests/requests-grid.tsx`, `src/app/(app)/music/requests/attend-dialog.tsx`, `src/app/(app)/participations/participation-dialog.tsx`

**Interfaces:**
- Produces: `maskedPhone(last4: string | null): string` — **note the return type: `string`, never null**, which is a change from the Block 22 version being moved. `lastFourDigits(value: string | null): string | null`, `maskedEmail(email: string | null): string | null`, `maskedPassport(passport: string | null): string | null`, `maskedAddress(parts: { line: string | null; number: string | null; complement: string | null }): string | null`, and `const DOTS = '••••'`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/members-mask.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DOTS,
  lastFourDigits,
  maskedAddress,
  maskedEmail,
  maskedPassport,
  maskedPhone,
} from '@/lib/members/mask';

describe('lastFourDigits', () => {
  it('keeps only digits, so punctuation cannot shorten the answer', () => {
    expect(lastFourDigits('(11) 98595-4985')).toBe('4985');
  });

  it('answers null under four digits, because a mask that reveals a two-digit number is not a mask', () => {
    expect(lastFourDigits('123')).toBeNull();
    expect(lastFourDigits(null)).toBeNull();
  });
});

describe('maskedPhone', () => {
  it('renders the four digits behind dots', () => {
    expect(maskedPhone('4985')).toBe(`${DOTS} 4985`);
  });

  it('renders bare dots when there are no four digits to show', () => {
    expect(maskedPhone(null)).toBe(DOTS);
  });
});

describe('maskedEmail', () => {
  it('keeps the first character and the suffix after the last dot', () => {
    expect(maskedEmail('joao@gmail.com')).toBe('j•••@•••.com');
  });

  it('masks whole anything it cannot take apart, rather than guessing', () => {
    expect(maskedEmail('not-an-address')).toBe(DOTS);
    expect(maskedEmail('@gmail.com')).toBe(DOTS);
    expect(maskedEmail('joao@localhost')).toBe(DOTS);
  });

  it('answers null for nothing, so the screen renders no row at all', () => {
    expect(maskedEmail(null)).toBeNull();
    expect(maskedEmail('   ')).toBeNull();
  });
});

describe('maskedPassport', () => {
  it('shows the last four characters', () => {
    expect(maskedPassport('FX1284821')).toBe(`${DOTS} 4821`);
  });

  it('masks whole under four characters', () => {
    expect(maskedPassport('X12')).toBe(DOTS);
  });
});

describe('maskedAddress', () => {
  it('is dots when any part is on file, because a street is one fact', () => {
    expect(maskedAddress({ line: 'Rua das Flores', number: null, complement: null })).toBe(DOTS);
    expect(maskedAddress({ line: null, number: '221', complement: null })).toBe(DOTS);
  });

  it('is null when nothing is on file, so the screen renders no row at all', () => {
    expect(maskedAddress({ line: null, number: null, complement: '  ' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/unit/members-mask.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/members/mask"`.

- [ ] **Step 3: Write the module**

Create `src/lib/members/mask.ts`:

```ts
/**
 * Block 30a. What an operator sees before they ask to see it.
 *
 * PURE, AND IN `lib` RATHER THAN BESIDE A SCREEN. `maskedPhone` lived in
 * `music/requests/request-status.tsx` from Block 22 until this block, and
 * `participations/participation-dialog.tsx` already reached across two feature
 * folders to import it — which is the shape that says a rule has outgrown the
 * screen that first needed it. Three screens render these now.
 *
 * NONE OF THIS IS A BOUNDARY, and it must never be mistaken for one. What a
 * caller may KNOW is decided in SQL — by what the list doors project, and by an
 * audited door that hands over a whole value on request. This module decides
 * only what an already-permitted value LOOKS like on screen. Masking a value the
 * page already carries would be a lock on a door standing in an open field;
 * `services/music.ts` says exactly that about the number Block 22 stopped
 * sending, and it is why the narrowing belongs in the door rather than here.
 */

/** Four of them, so a mask reads as a mask at any font size. */
export const DOTS = '••••';

/**
 * The last four digits of anything, or null under four.
 *
 * Digits only, because `normalize_phone` (0031) is digits only and a mask that
 * counted punctuation would show three digits for `(11) 985-95` and four for
 * the same number typed without the dash.
 *
 * NULL RATHER THAN WHATEVER IS THERE. A mask that reveals a two-digit number is
 * not a mask — `participation-dialog.tsx` stated this for phones in Block 24,
 * and it is the reason this returns null instead of padding.
 */
export function lastFourDigits(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length < 4 ? null : digits.slice(-4);
}

/** `•••• 4985`, or bare dots when there are no four digits to stand behind them. */
export function maskedPhone(last4: string | null): string {
  return last4 === null ? DOTS : `${DOTS} ${last4}`;
}

/**
 * `j•••@•••.com` — the first character and the suffix after the last dot.
 *
 * ANYTHING IT CANNOT TAKE APART IS MASKED WHOLE. An address with no `@`, an
 * empty local part, or a host with no dot are all masked entirely rather than
 * half-guessed: the point of showing the first letter and the TLD is that an
 * operator reading a support ticket can tell two listeners apart, and a partial
 * guess at a malformed value serves that badly while disclosing more.
 */
export function maskedEmail(email: string | null): string | null {
  const trimmed = email?.trim();
  if (!trimmed) return null;

  const at = trimmed.lastIndexOf('@');
  if (at < 1) return DOTS;

  const host = trimmed.slice(at + 1);
  const dot = host.lastIndexOf('.');
  if (dot < 1 || dot === host.length - 1) return DOTS;

  return `${trimmed[0]}•••@•••${host.slice(dot)}`;
}

/** Same rule as a phone, on characters rather than digits: a passport is not numeric. */
export function maskedPassport(passport: string | null): string | null {
  const trimmed = passport?.trim();
  if (!trimmed) return null;
  return trimmed.length < 4 ? DOTS : `${DOTS} ${trimmed.slice(-4)}`;
}

/**
 * Dots, or null.
 *
 * ONE FACT, NOT THREE. A street, a number and a flat identify a household
 * together and disclose it together, so the card shows one row for them and the
 * reveal asks for one value rather than three.
 */
export function maskedAddress(parts: {
  line: string | null;
  number: string | null;
  complement: string | null;
}): string | null {
  const anything = [parts.line, parts.number, parts.complement].some(
    (part) => (part ?? '').trim() !== '',
  );
  return anything ? DOTS : null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- tests/unit/members-mask.test.ts`
Expected: PASS, 11 assertions.

- [ ] **Step 5: Move the old `maskedPhone` off `request-status.tsx`**

In `src/app/(app)/music/requests/request-status.tsx`, delete the `maskedPhone` function and its comment block.

In `src/app/(app)/music/requests/requests-grid.tsx` and `src/app/(app)/music/requests/attend-dialog.tsx`, change the import:

```ts
// was: import { maskedPhone, PlayStatusBadge, ReadStatusBadge } from './request-status';
import { PlayStatusBadge, ReadStatusBadge } from './request-status';
import { maskedPhone } from '@/lib/members/mask';
```

In `src/app/(app)/participations/participation-dialog.tsx`, replace the cross-folder import and delete the file's own local `lastFourDigits` helper (at the bottom of the file, with its comment — the comment's argument moves into `mask.ts` and must not be left in two places):

```ts
import { lastFourDigits, maskedPhone } from '@/lib/members/mask';
```

`maskedPhone` now returns `string`, not `string | null`. At each call site, the surrounding `&&` guard on the last-4 value stays as it is — it decides whether the ROW renders, which is still the right question.

- [ ] **Step 6: Prove nothing broke**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/members/mask.ts tests/unit/members-mask.test.ts src/app/\(app\)/music/requests src/app/\(app\)/participations/participation-dialog.tsx
git commit -m "refactor(30a): the masking rules leave the screen that first needed them"
```

---

### Task 2: The reveal door

**Files:**
- Create: `supabase/migrations/0253_reveal_member_field.sql`, `supabase/tests/69_listener_reveal.test.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Produces: `public.reveal_member_field(p_member_id uuid, p_field text) returns text`. Legal `p_field`: `phone`, `email`, `passport`, `address`.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/69_listener_reveal.test.sql`:

```sql
begin;
select plan(8);

-- Block 30a. One listener's whole value, asked for one at a time, recorded
-- every time. Generalises reveal_request_phone (0190) from one request to one
-- listener; the assertions below are that file's, restated for the wider door.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000030f1', 'Org 30a');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000030c1', '00000000-0000-0000-0000-0000000030f1',
   'Station 30a', 'America/Sao_Paulo');

insert into public.members (id, organization_id, full_name, phone, email, passport,
                            address_line, address_number, address_complement)
values
  ('00000000-0000-0000-0000-0000000030d1', '00000000-0000-0000-0000-0000000030f1',
   'Ouvinte 30a', '11985954985', 'joao@gmail.com', 'FX1284821',
   'Rua das Flores', '221', 'ap 3');
-- Columns verified against 0031_members.sql:125 — (member_id, company_id,
-- organization_id, linked_at, linked_by), primary key on the first two. Both
-- composite FKs require the organization to match the member's and the
-- company's, which is why it is passed explicitly rather than defaulted.
insert into public.member_company_links (member_id, company_id, organization_id)
values ('00000000-0000-0000-0000-0000000030d1', '00000000-0000-0000-0000-0000000030c1',
        '00000000-0000-0000-0000-0000000030f1');

-- Two actors: one holding members.view at this Station, one holding nothing.
-- (Seed them with this file's usual role/grant idiom -- see 51_music_request_triage.test.sql
-- lines 1-60 for the exact shape, and reuse it verbatim rather than inventing one.)

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030a1", "role": "authenticated"}';

-- 1-4: each legal field comes back whole.
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'phone'),
  '11985954985', 'phone comes back whole');
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'email'),
  'joao@gmail.com', 'email comes back whole');
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'passport'),
  'FX1284821', 'passport comes back whole');
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'address'),
  'Rua das Flores, 221, ap 3', 'the three address parts come back as one fact');

-- 5: a field name this door does not know is refused rather than selected.
-- A door that reads a column named by its argument reads any column.
select throws_ok($$
  select public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'cpf_hash')
$$, '22023', null, 'an unknown field name is refused');

-- 6: four reveals so far, four audit rows. Read as the superuser, the same
-- reason 0190's own audit assertion resets the role first.
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d1'
      and action = 'reveal_member_field'),
  4, 'every reveal leaves a trace');

-- 7: an actor holding nothing at this Station is refused.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030a2", "role": "authenticated"}';
select throws_ok($$
  select public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'phone')
$$, '42501', null, 'members.view somewhere the listener is linked is required');

-- 8: an erased listener discloses nothing -- AND THE AUDIT ROW IS STILL
-- WRITTEN, because somebody asked and that is the fact being recorded.
reset role;
update public.members set anonymized_at = now(), phone = null
 where id = '00000000-0000-0000-0000-0000000030d1';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030a1", "role": "authenticated"}';
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'phone'),
  null, 'an erased listener discloses nothing');

select * from finish();
rollback;
```

> The two actor fixtures are deliberately not spelled out above: copy the role
> creation, `grant_role` and `member_company_links` idiom from
> `supabase/tests/51_music_request_triage.test.sql` verbatim. Inventing a second
> shape for the same setup is how two files come to disagree about what
> `members.view` means. Adjust `plan(8)` upward if the copied fixture adds
> assertions of its own.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — `function public.reveal_member_field(uuid, text) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0253_reveal_member_field.sql`:

```sql
-- supabase/migrations/0253_reveal_member_field.sql

-- Block 30a. One listener's whole telephone number, e-mail, passport or postal
-- address, one at a time, with an audit row for the asking.
--
-- THIS IS reveal_request_phone (0190) GENERALISED, and the generalisation is
-- the subject rather than the value: that door asks "may this caller read the
-- listener behind THIS REQUEST", and three screens now need "may this caller
-- read THIS LISTENER" with no request in hand. Every argument in 0190's header
-- holds here unchanged and is not restated; what IS restated below is the pair
-- of decisions this wider door has to make on its own -- which Station decides,
-- and which columns are namable.
--
-- IT EXISTS BECAUSE 0254 STOPS SENDING THE NUMBER TO THE BROWSER. Four digits
-- travel with the list; the rest is asked for. Without the narrowing this door
-- would be a lock on a door standing in an open field.

create function public.reveal_member_field(p_member_id uuid, p_field text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_value   text;
begin
  -- THE FIELD NAME IS CHECKED BEFORE ANYTHING ELSE, and it is checked against a
  -- closed list rather than interpolated. A door that selects a column named by
  -- its argument selects any column -- cpf_hash among them, which is the one
  -- value in this table that is hashed precisely so that nobody can read it.
  if p_field is null or p_field not in ('phone', 'email', 'passport', 'address') then
    raise exception 'unknown field: %', p_field using errcode = '22023';
  end if;

  -- WHICH STATION DECIDES. A listener belongs to an Organization and is LINKED
  -- to Stations (member_company_links, 0031), so there is no single company to
  -- ask about -- the question is whether the caller holds members.view at ANY
  -- Station this listener is linked to. That is the same reach
  -- members_select_reachable (0035) already grants for reading the row, so this
  -- door widens nobody: it discloses one column of a row the caller could
  -- already select.
  --
  -- The company it settles on is also what stamps the audit row, which is why
  -- it is selected rather than merely tested with `exists`.
  select l.organization_id, l.company_id
    into v_org, v_company
    from public.member_company_links l
   where l.member_id = p_member_id
     and public.has_permission('members.view', l.company_id)
   order by l.linked_at
   limit 1;

  if v_company is null then
    raise log 'reveal_member_field denied: actor=% member=% field=%', v_actor, p_member_id, p_field;
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  -- FOR SHARE, NOT A BARE READ, and 0190 argues this in full one door over:
  -- anonymize_member (0034) erases through a plain UPDATE, which takes no lock
  -- an unlocked reader is obliged to respect under READ COMMITTED, so a
  -- disclosure racing an erasure could read the row a moment before the scrub
  -- commits and hand a human the live value anyway -- seen once, unseeable
  -- after, at the exact instant the erasure existed to prevent it.
  --
  -- FOR SHARE rather than FOR UPDATE: it conflicts with FOR UPDATE and nothing
  -- weaker, so it serialises against the erasure and against nothing else. Two
  -- operators revealing the same listener in the same instant never queue.
  select case p_field
           when 'phone'    then m.phone
           when 'email'    then m.email
           when 'passport' then m.passport
           -- ONE FACT, NOT THREE. A street, a number and a flat identify a
           -- household together; src/lib/members/mask.ts masks them as one row
           -- for the same reason. concat_ws skips nulls but not empty strings,
           -- so each part is nullif'd first -- otherwise a blank complement
           -- renders as a trailing ", ".
           else concat_ws(', ',
                  nullif(btrim(coalesce(m.address_line, '')), ''),
                  nullif(btrim(coalesce(m.address_number, '')), ''),
                  nullif(btrim(coalesce(m.address_complement, '')), ''))
         end
    into v_value
    from public.members m
   where m.id = p_member_id and m.anonymized_at is null
   for share;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'reveal_member_field', 'members', p_member_id, v_org, v_company,
     jsonb_build_object('field', p_field));

  -- concat_ws returns '' rather than null when every part was null, and an
  -- empty string on screen is a revealed value that says nothing -- so the
  -- caller cannot tell "no address on file" from "revealed, and it is blank".
  return nullif(v_value, '');
end;
$$;

comment on function public.reveal_member_field(uuid, text) is
  'Returns one whole value -- phone, email, passport or the postal address as one string -- for one listener, and writes an audit row for the asking. Exists because 0254 stops sending the telephone number to the browser with the pickups and participations lists (Block 30a D1); four digits travel, and the rest is asked for. Gated on members.view at any Station the listener is linked to, which is the reach members_select_reachable (0035) already grants for the row itself, so this door discloses a column of a row the caller could already select rather than widening anybody. The field name is checked against a closed list, because a door that selects a column named by its argument selects any column. Null for a listener who has exercised erasure, and null for a field with nothing in it; the audit row is written either way.';

revoke execute on function public.reveal_member_field(uuid, text) from public;
grant execute on function public.reveal_member_field(uuid, text) to authenticated;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, including `69_listener_reveal`.

- [ ] **Step 5: Regenerate the types**

Run: `npm run db:types && npm run typecheck`
Expected: `reveal_member_field` appears in `database.types.ts`; typecheck green.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0253_reveal_member_field.sql supabase/tests/69_listener_reveal.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(30a): one listener value at a time, and an audit row for the asking"
```

---

### Task 3: The two lists stop carrying the number

This is the block's boundary change. Items 3 and 6's mask half are delivered here.

**Files:**
- Create: `supabase/migrations/0254_pickup_and_participation_phone_last4.sql`
- Modify: `src/services/pickups.ts`, `src/services/participations.ts`, `src/app/(app)/pickups/pickups-grid.tsx`, `src/app/(app)/participations/participations-grid.tsx`, `src/app/(app)/participations/participation-dialog.tsx`, `tests/isolation/pickups.test.ts`, `tests/isolation/participations.test.ts`, `scripts/verify-isolation-suite.mjs`

**Interfaces:**
- Produces: `PickupRow.memberPhoneLast4: string | null` (replaces `memberPhone`), `ParticipationSummary.listenerPhoneLast4: string | null` (replaces `listenerPhone`). Both doors' columns are renamed `member_phone_last4` / `listener_phone_last4`.

- [ ] **Step 1: Write the failing isolation cases**

Append to `tests/isolation/pickups.test.ts`, inside the existing `describe('list_pickups', …)`:

```ts
  /**
   * Block 30a D1. The whole number stopped travelling, and this is the
   * assertion that fails the day somebody "restores" the column.
   *
   * The pair matters more than either half: WITHHELD and MASKED are different
   * facts. A caller without members.view still gets null -- not four digits --
   * because 0095's Rule 2 is about whether they may know the listener at all,
   * and narrowing the projection must not quietly answer that question with
   * "a little".
   */
  it('sends four digits to members.view, and still nothing without it', async () => {
    const customer = await provisionCustomer('pickup-mask');
    const seeded = await seedPickupWinner(customer, 'masked');
    const owner = await signInAs(customer.email, customer.password);

    await admin
      .from('members')
      .update({ phone: '11985954985' })
      .eq('id', seeded.memberId);

    const { data: asOwner } = await owner.rpc('list_pickups', {
      p_company_id: customer.companyId,
    });
    const row = (asOwner ?? []).find((r) => r.winner_id === seeded.winnerId);
    expect(row?.member_phone_last4).toBe('4985');
    expect(JSON.stringify(asOwner)).not.toContain('11985954985');

    const stranger = await grantRoleWith(customer, 'pickup-mask-no-members', [
      'promotions.view',
    ]);
    const { data: asStranger } = await stranger.rpc('list_pickups', {
      p_company_id: customer.companyId,
    });
    const withheld = (asStranger ?? []).find((r) => r.winner_id === seeded.winnerId);
    expect(withheld).toBeDefined();
    expect(withheld?.member_phone_last4).toBeNull();
  });
```

Append the mirror case to `tests/isolation/participations.test.ts`, against `list_participations` and `listener_phone_last4`, reusing that file's own fixture helper rather than importing this one's.

> `grantRoleWith`'s exact signature is in `tests/isolation/harness.ts:338`. Read
> it before writing the call — the permission list shape is that helper's, not
> this plan's guess.

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:isolation`
Expected: FAIL — `member_phone_last4` is undefined; the whole number is present in the payload.

- [ ] **Step 3: Dump the live definitions**

Run the `scripts/dump-fn.mjs` snippet from the header for `list_pickups` and then for `list_participations`. Keep both outputs open. **The migration body is the dumped body with the projection changed and nothing else.**

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0254_pickup_and_participation_phone_last4.sql`. Its header, before the two `create or replace` statements:

```sql
-- supabase/migrations/0254_pickup_and_participation_phone_last4.sql

-- Block 30a D1. The pickups and participations lists stop returning a
-- listener's telephone number and return its last four digits, which is what
-- list_music_requests has returned since Block 22 (0191).
--
-- MASKING IN REACT WOULD NOT HAVE DONE THIS. The whole number would still be in
-- the HTML payload, in the browser's memory and in any error report the page
-- produces -- "a lock on a door standing in an open field", which is the
-- sentence services/music.ts already carries about the screen Block 22 fixed.
-- The whole number is now asked for one listener at a time through
-- reveal_member_field (0253), which records the asking.
--
-- RULE 2 OF EACH DOOR IS UNTOUCHED, and that is the half most easily lost: a
-- caller WITHOUT members.view still gets null, not four digits. Withheld and
-- masked are different facts -- one says "you may not know this person", the
-- other says "you may, and here is enough to recognise them" -- and the
-- narrowing must not answer the first question with "a little".
--
-- BOTH BODIES BELOW ARE THE LIVE DEFINITIONS (pg_get_functiondef), with the one
-- projection line changed. Re-deriving either from 0090 or 0095 would revert
-- every later repair silently, which has cost this project whole blocks.
--
-- total_count still comes from the same CTE the rows come from. The change is
-- to the projection only; a page and its count cannot narrow differently.
```

Then, in each dumped body, exactly two edits.

`list_pickups` — the `returns table (…)` column:

```sql
  -- was: member_phone   text,
  member_phone_last4 text,
```

and its projection line:

```sql
  -- was: case when v_names then f.phone else null end,
  case when v_names then public.member_phone_last4(f.phone) else null end,
```

`list_participations` — the same two edits against `listener_phone` / `f.phone`.

Add the shared helper at the top of the migration, above both functions:

```sql
-- The rule, in one place, so the two lists cannot drift from each other or from
-- src/lib/members/mask.ts. Digits only, because normalize_phone (0031) is
-- digits only; null under four, because a mask that reveals a two-digit number
-- is not a mask.
create or replace function public.member_phone_last4(p_phone text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when length(d) < 4 then null
    else right(d, 4)
  end
  from (select public.normalize_phone(p_phone) as d) s;
$$;

revoke execute on function public.member_phone_last4(text) from public;
grant execute on function public.member_phone_last4(text) to authenticated;
```

- [ ] **Step 5: Run the database gates**

Run: `npm run db:reset && npm run db:test`
Expected: PASS. The existing pgTAP for both lists asserts Rule 2 (null without `members.view`) and must still pass — if it asserted a whole number anywhere, fix the assertion to four digits and say so in the commit message.

- [ ] **Step 6: Follow the rename through TypeScript**

Run: `npm run db:types`

In `src/services/pickups.ts`: rename the `PickupRow.memberPhone` field to `memberPhoneLast4`, and line 151's mapping to `row.member_phone_last4`. Replace the field's comment with the one from `services/music.ts`'s `memberPhoneLast4` — it already states why the whole number is not there.

In `src/services/participations.ts`: the same for `listenerPhone` → `listenerPhoneLast4` and line 189.

In `src/app/(app)/pickups/pickups-grid.tsx:180-183`:

```tsx
                    {row.memberPhoneLast4 && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {maskedPhone(row.memberPhoneLast4)}
                      </span>
                    )}
```

with `import { maskedPhone } from '@/lib/members/mask';` at the top.

In `src/app/(app)/participations/participations-grid.tsx` and
`participation-dialog.tsx`: the same substitution. In the dialog, `lastFourDigits(entry.listenerPhone)` becomes `entry.listenerPhoneLast4` and the `lastFourDigits` import (already moved in Task 1) is dropped if nothing else uses it.

- [ ] **Step 7: Raise the isolation floors**

In `scripts/verify-isolation-suite.mjs`, bump `minTests` for
`tests/isolation/pickups.test.ts` (7 → 8) and
`tests/isolation/participations.test.ts` (29 → 30). The floor is what notices a
deleted case, and a case added without a floor bump is a case that can be
deleted for free.

- [ ] **Step 8: Run the whole gate, in order**

Run: `npm run typecheck && npm run lint && npm test && npm run db:reset && npm run db:test && npm run test:isolation`
Expected: all green. **This order matters** — `db:test` after `test:isolation` gives a red that is not code.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/0254_pickup_and_participation_phone_last4.sql src/services src/app/\(app\)/pickups src/app/\(app\)/participations tests/isolation scripts/verify-isolation-suite.mjs src/lib/supabase/database.types.ts
git commit -m "feat(30a): the pickups and participations lists stop carrying the number"
```

---

### Task 4: The card

**Files:**
- Create: `src/app/(app)/members/listener-card.ts`, `src/components/members/listener-card-dialog.tsx`
- Modify: `messages/en.json`, `messages/pt.json`, `messages/es.json`

**Interfaces:**
- Produces: `getListenerCardAction(memberId: string): Promise<ListenerCardResult>`, `revealListenerFieldAction(memberId: string, field: RevealableField): Promise<RevealResult>`, `type RevealableField = 'phone' | 'email' | 'passport' | 'address'`, and the component `<ListenerCardDialog memberId onClose />`.

- [ ] **Step 1: Write the Server Actions**

Create `src/app/(app)/members/listener-card.ts`:

```ts
'use server';

import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { requireAccessToken } from '@/lib/auth/session';
import { getMember } from '@/services/members';
import { revealMemberField } from '@/services/members';
import {
  lastFourDigits,
  maskedAddress,
  maskedEmail,
  maskedPassport,
} from '@/lib/members/mask';

/**
 * Block 30a. One listener, as three screens that only read may see them.
 *
 * MASKED HERE, NOT IN THE COMPONENT, and that is the whole point of the file:
 * what this returns is what reaches the browser. A component that received the
 * whole record and rendered dots over it would put every value in the HTML
 * payload, which is the failure 0254 exists to close one layer down.
 *
 * THE READ ITSELF IS RLS. getMember goes through the caller's own client, so
 * members_select_reachable (0035) decides which listeners exist for them -- the
 * same boundary the three calling screens already rely on for their own lists.
 * No new read door was needed, and adding one would have moved a tenancy
 * boundary from a policy into a function body.
 */

export type RevealableField = 'phone' | 'email' | 'passport' | 'address';

const revealSchema = z.object({
  memberId: z.string().uuid(),
  field: z.enum(['phone', 'email', 'passport', 'address']),
});

/** Everything the card shows. Nothing here is a whole sensitive value. */
export interface ListenerCard {
  id: string;
  fullName: string | null;
  phoneLast4: string | null;
  emailMasked: string | null;
  passportMasked: string | null;
  addressMasked: string | null;
  /** Already only the last digits in the column (0031) -- the CPF itself is a hash. */
  cpfLastDigits: string | null;
  birthDate: string | null;
  gender: string | null;
  city: string | null;
  state: string | null;
  neighbourhood: string | null;
  country: string | null;
  createdAt: string;
  anonymizedAt: string | null;
}

export type ListenerCardResult =
  | { status: 'ok'; card: ListenerCard }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

export async function getListenerCardAction(memberId: string): Promise<ListenerCardResult> {
  const parsed = z.string().uuid().safeParse(memberId);
  if (!parsed.success) return { status: 'not-found' };

  try {
    const token = await requireAccessToken();
    const detail = await getMember(parsed.data, token);
    if (!detail) return { status: 'not-found' };

    return {
      status: 'ok',
      card: {
        id: detail.id,
        fullName: detail.fullName,
        phoneLast4: lastFourDigits(detail.phone),
        emailMasked: maskedEmail(detail.email),
        passportMasked: maskedPassport(detail.passport),
        addressMasked: maskedAddress({
          line: detail.addressLine,
          number: detail.addressNumber,
          complement: detail.addressComplement,
        }),
        cpfLastDigits: detail.cpfLastDigits,
        birthDate: detail.birthDate,
        gender: detail.gender,
        city: detail.city,
        state: detail.state,
        neighbourhood: detail.neighbourhood,
        country: detail.country,
        createdAt: detail.createdAt,
        anonymizedAt: detail.anonymizedAt,
      },
    };
  } catch (cause) {
    logger.error({ err: cause, memberId }, 'could not read this listener card');
    const t = await getTranslations('members');
    return { status: 'error', message: t('couldNotReadThisListener') };
  }
}

export type RevealResult =
  | { status: 'ok'; value: string | null }
  | { status: 'error'; message: string };

export async function revealListenerFieldAction(
  memberId: string,
  field: RevealableField,
): Promise<RevealResult> {
  const parsed = revealSchema.safeParse({ memberId, field });
  if (!parsed.success) {
    const t = await getTranslations('members');
    return { status: 'error', message: t('couldNotRevealThisField') };
  }

  try {
    const token = await requireAccessToken();
    return {
      status: 'ok',
      value: await revealMemberField(parsed.data.memberId, parsed.data.field, token),
    };
  } catch (cause) {
    // NEVER LOG THE FIELD'S VALUE, and note that this branch cannot: the
    // service throws before returning. The member id and the field NAME are
    // logged; the value is the thing the audit row exists to account for, and a
    // log file honours no retention rule.
    logger.error({ err: cause, memberId, field }, 'could not reveal a listener field');
    const t = await getTranslations('members');
    return { status: 'error', message: t('couldNotRevealThisField') };
  }
}
```

`requireAccessToken` is **private** to `src/app/(app)/members/record.ts:44` and
is therefore copied rather than imported — exporting it from that file to reach
it here would widen a helper for one caller. It is four lines:

```ts
async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}
```

with `import { createUserClient } from '@/lib/supabase/user-client';` and
`import { redirect } from 'next/navigation';`.

- [ ] **Step 2: Add the service call**

In `src/services/members.ts`, beside the existing member reads:

```ts
/**
 * Block 30a. One whole value, and an audit row written by the door.
 *
 * Thin on purpose: every rule -- which Station decides, which field names are
 * legal, the FOR SHARE against a racing erasure -- is reveal_member_field's
 * (0253), and a second copy here would be a second thing to keep in step.
 */
export async function revealMemberField(
  memberId: string,
  field: 'phone' | 'email' | 'passport' | 'address',
  accessToken: string,
): Promise<string | null> {
  const { data, error } = await asCaller(accessToken).rpc('reveal_member_field', {
    p_member_id: memberId,
    p_field: field,
  });
  if (error) throw mapMemberError(error.code, error.message);
  return data ?? null;
}
```

`mapMemberError` is already defined in this same file at line 1210 and is
private to it — no import, no new mapper. `asCaller` is likewise this file's own.

- [ ] **Step 3: Write the dialog**

Create `src/components/members/listener-card-dialog.tsx`. It follows
`attend-dialog.tsx`'s reveal shape exactly, including the state that keeps
"not yet revealed" apart from "revealed, and there is nothing to reveal":

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DOTS, maskedPhone } from '@/lib/members/mask';
import { formatCalendarDate, formatDate } from '@/app/(app)/members/format';
import {
  getListenerCardAction,
  revealListenerFieldAction,
  type ListenerCard,
  type RevealableField,
} from '@/app/(app)/members/listener-card';

/**
 * Block 30a. One listener, read from a screen whose job is something else.
 *
 * READ-ONLY BY CONSTRUCTION. MemberRecordDialog stays the place a listener is
 * administered: it is reached from the screen whose whole purpose is that, by a
 * caller who already holds members.edit. This window is reached from Pickups,
 * Participations and Requests, where the operator is doing an errand about a
 * prize, an entry or a song and needs to know who they are talking to.
 *
 * EVERY SENSITIVE VALUE ARRIVES MASKED (listener-card.ts) and is revealed one
 * at a time, each reveal leaving an audit row. The screen therefore cannot
 * disclose what it was never sent, which is the property a React-side mask
 * would not have had.
 */

/** Which fields have been revealed, and what came back for each. */
type Revealed = Partial<Record<RevealableField, string | null>>;

export function ListenerCardDialog({
  memberId,
  onClose,
}: {
  memberId: string;
  onClose: () => void;
}) {
  // ONE NAMESPACE. Everything this window renders — including the gender
  // labels, which are `members` keys and not `vocab` ones — comes from
  // `members`, so there is no second `useTranslations` here.
  const t = useTranslations('members');
  const titleId = useId();

  const [card, setCard] = useState<ListenerCard | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Revealed>({});
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealing, startReveal] = useTransition();

  useEffect(() => {
    let current = true;
    setCard(null);
    setFailure(null);
    setRevealed({});
    void getListenerCardAction(memberId).then((result) => {
      // The answer to a listener the operator has already moved past must not
      // land -- the guard every read-on-open dialog in this product carries.
      if (!current) return;
      if (result.status === 'ok') setCard(result.card);
      else
        setFailure(
          result.status === 'not-found' ? t('noSuchListenerOrYouDo') : result.message,
        );
    });
    return () => {
      current = false;
    };
  }, [memberId, t]);

  function reveal(field: RevealableField) {
    // Cleared up front, not only on the next success: a field that reveals
    // must not keep showing the error from the attempt before it.
    setRevealError(null);
    startReveal(async () => {
      const result = await revealListenerFieldAction(memberId, field);
      if (result.status === 'ok') setRevealed((current) => ({ ...current, [field]: result.value }));
      else setRevealError(result.message);
    });
  }

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-xl">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('theListener')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {failure && <p className="text-sm text-destructive">{failure}</p>}
        {!card && !failure && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
        {card && (
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-3 text-sm">
            <Row label={t('name')} value={card.fullName ?? '—'} />

            <MaskedRow
              label={t('phone')}
              field="phone"
              masked={card.phoneLast4 === null ? null : maskedPhone(card.phoneLast4)}
              revealed={revealed}
              revealing={revealing}
              onReveal={reveal}
              showLabel={t('showTheNumber')}
              erasedLabel={t('thisListenerHasSinceExercisedTheir')}
            />
            <MaskedRow
              label={t('email')}
              field="email"
              masked={card.emailMasked}
              revealed={revealed}
              revealing={revealing}
              onReveal={reveal}
              showLabel={t('show')}
              erasedLabel={t('thisListenerHasSinceExercisedTheir')}
            />
            <MaskedRow
              label={t('passport')}
              field="passport"
              masked={card.passportMasked}
              revealed={revealed}
              revealing={revealing}
              onReveal={reveal}
              showLabel={t('show')}
              erasedLabel={t('thisListenerHasSinceExercisedTheir')}
            />
            <MaskedRow
              label={t('address')}
              field="address"
              masked={card.addressMasked}
              revealed={revealed}
              revealing={revealing}
              onReveal={reveal}
              showLabel={t('show')}
              erasedLabel={t('thisListenerHasSinceExercisedTheir')}
            />

            {/*
              NOT MASKED AND NOT REVEALABLE. The column holds only the last
              digits; the CPF itself is a hash (0031), so there is no whole
              value in this system to disclose.
            */}
            {card.cpfLastDigits && <Row label={t('cpf')} value={`${DOTS} ${card.cpfLastDigits}`} />}

            {card.birthDate && (
              <Row label={t('birthDate')} value={formatCalendarDate(card.birthDate)} />
            )}
            {/*
              The gender labels live under `members`, NOT under `vocab` — the
              namespace most enum labels in this product use. Verified:
              messages/en.json holds members.gender_M / _F / _N, and vocab holds
              no gender key at all. `GenderSelect` reads them the same way.
            */}
            {card.gender && <Row label={t('gender')} value={t(`gender_${card.gender}`)} />}
            <Row
              label={t('where')}
              value={[card.neighbourhood, card.city, card.state, card.country]
                .filter(Boolean)
                .join(', ') || '—'}
            />
            <Row label={t('registered')} value={formatDate(card.createdAt)} />
          </dl>
        )}
        {revealError && <p className="mt-3 text-sm text-destructive">{revealError}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/**
 * One masked field and its button.
 *
 * THE THREE STATES ARE KEPT APART, and the third is the one that is easy to
 * lose: `revealed[field]` being `undefined` means nobody has asked, while
 * `null` means somebody asked and there was nothing there -- a listener who
 * exercised erasure between the list read and this click. Folding them together
 * leaves the mask up and the button offered, so a second click spends another
 * audit row to learn the same nothing. attend-dialog.tsx carries this same
 * distinction as `phoneErased`, for the same reason.
 */
function MaskedRow({
  label,
  field,
  masked,
  revealed,
  revealing,
  onReveal,
  showLabel,
  erasedLabel,
}: {
  label: string;
  field: RevealableField;
  masked: string | null;
  revealed: Revealed;
  revealing: boolean;
  onReveal: (field: RevealableField) => void;
  showLabel: string;
  erasedLabel: string;
}) {
  // Nothing on file: the row does not render at all, rather than rendering
  // dots over an absence and offering a button that would reveal nothing.
  if (masked === null) return null;

  const asked = field in revealed;
  const value = revealed[field];

  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2">
        <span data-testid={`listener-card-${field}`}>
          {asked ? (value ?? erasedLabel) : masked}
        </span>
        {!asked && (
          <button
            type="button"
            onClick={() => onReveal(field)}
            disabled={revealing}
            className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`listener-card-reveal-${field}`}
          >
            {showLabel}
          </button>
        )}
      </dd>
    </>
  );
}
```

- [ ] **Step 4: Add the keys to all three catalogues**

In `messages/en.json`, `messages/pt.json` and `messages/es.json`, under the
**`members`** namespace. Every row below was checked against `messages/en.json`
before this plan was written — the "already there" list is not a guess.

**Add (absent from `members` today):**

| key | en | pt | es |
|---|---|---|---|
| `theListener` | The listener | O ouvinte | El oyente |
| `show` | Show | Mostrar | Mostrar |
| `where` | Where | Onde | Dónde |
| `email` | E-mail | E-mail | Correo electrónico |
| `cpf` | CPF | CPF | CPF |
| `showTheNumber` | Show the number | Mostrar o número | Mostrar el número |
| `thisListenerHasSinceExercisedTheir` | This listener has since exercised their right to erasure — this is no longer stored. | Este ouvinte exerceu depois o direito ao apagamento — isto não está mais armazenado. | Este oyente ejerció después su derecho de supresión — esto ya no está almacenado. |
| `couldNotReadThisListener` | This listener could not be read. | Não foi possível ler este ouvinte. | No fue posible leer este oyente. |
| `couldNotRevealThisField` | This field could not be revealed. | Não foi possível revelar este campo. | No fue posible revelar este campo. |
| `viewTheListener` | View the listener | Ver o ouvinte | Ver el oyente |

**Already in `members` — reuse, do not re-add:** `name`, `phone`, `passport`,
`address`, `birthDate`, `gender`, `gender_M`, `gender_F`, `gender_N`, `close`,
`loading`, `registered`, `noSuchListenerOrYouDo`.

> `showTheNumber` and `thisListenerHasSinceExercisedTheir` **do exist**, but
> under **`music`**, not `members` — they were written for `attend-dialog.tsx`.
> The `members` copies are new keys, and the erasure sentence is reworded because
> the original names the two fields that window shows ("their name and phone are
> no longer stored"), which is wrong under an e-mail or an address row.
>
> Adding a key that already exists in the same namespace is not an error the
> compiler catches — the later one silently wins. Check before adding.

- [ ] **Step 5: Prove it compiles and the catalogues agree**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green, including `catalogue.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/members/listener-card.ts src/components/members/listener-card-dialog.tsx src/services/members.ts messages
git commit -m "feat(30a): the listener card, masked on the server and revealed on request"
```

---

### Task 5: The three screens open it

Items 4, 7 and 9's View half.

**Files:**
- Modify: `src/app/(app)/pickups/pickups-grid.tsx`, `src/app/(app)/pickups/page.tsx`, `src/app/(app)/participations/participations-grid.tsx`, `src/app/(app)/music/requests/requests-grid.tsx`, `src/app/(app)/music/requests/page.tsx`

**Interfaces:**
- Consumes: `<ListenerCardDialog memberId onClose />` from Task 4; `PickupRow.memberId`, `ParticipationSummary.memberId`, `RequestSummary.memberId`, all of which the doors already return (verified: `services/pickups.ts:32`, `services/participations.ts:67`, `services/music.ts:1557`).

**Catalogue keys this task needs**, checked against `messages/en.json`:

| namespace | already there | add **in this task** |
|---|---|---|
| `pickups` | `actions`, `promotion`, `listener`, `prize` | `view`, `viewTheListener` |
| `participations` | `view`, `listener`, `viewTheEntryOf` | `viewTheListener` |
| `music` | `listener`, `actions` | `view`, `viewTheListener` |

**Task 5 owns `pickups.view` and `pickups.viewTheListener`, not Task 6.** Task 6
adds only `pickups.deliveryNotes` and `pickups.cancel`. Task 5 runs first and
its buttons need these keys; a note in an earlier draft said otherwise and was
wrong.

`viewTheListener` — en *View the listener* / pt *Ver o ouvinte* / es *Ver el oyente*.
`music.view` — en *View* / pt *Ver* / es *Ver*.

- [ ] **Step 1: Pickups**

In `pickups-grid.tsx`, add the state and the action button. The id is cleared
when the row leaves the page, which is the trap `participations-grid.tsx:89`
already documents — without it, clearing a filter brings the row back, the
derivation matches again, and a window the operator finished with reopens:

```tsx
  const [listenerId, setListenerId] = useState<string | null>(null);

  useEffect(() => {
    if (listenerId !== null && !grid.rows.some((row) => row.memberId === listenerId)) {
      setListenerId(null);
    }
  }, [grid.rows, listenerId]);
```

In the actions cell, before `<WinnerActions …>`:

```tsx
                    {canFindListeners && (
                      <Button
                        key="view-listener"
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setListenerId(row.memberId)}
                        aria-label={t('viewTheListener')}
                        data-testid="pickup-view-listener"
                      >
                        {t('view')}
                      </Button>
                    )}
```

and after the table:

```tsx
      {listenerId && (
        <ListenerCardDialog memberId={listenerId} onClose={() => setListenerId(null)} />
      )}
```

`canFindListeners` is `members.view`. `pickups/page.tsx` already resolves it for
the filter bar (`pickups-filters.tsx:58` names it) — thread the same boolean
down as a prop rather than resolving it a second time.

> **The `key` is not decoration.** This project has shipped the defect where two
> conditionally rendered `<Button>`s in one position let React reuse the DOM node
> and the survivor inherited `type="submit"`, recording participations on click.

- [ ] **Step 2: Participations**

The existing **View** is untouched: it opens `ParticipationDialog`, which is the
only screen in the product where a participation's quiz answers can be read.
Add a **second** button beside it, with its own distinct `key`:

```tsx
                    {canFindListeners && (
                      <Button
                        key="view-listener"
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setListenerId(entry.memberId)}
                        aria-label={t('viewTheListener')}
                        data-testid="participation-view-listener"
                      >
                        {t('listener')}
                      </Button>
                    )}
```

plus the same `listenerId` state, the same clearing effect, and the same dialog
mount. `participations/access.ts` already resolves `members.view` for this page.

- [ ] **Step 3: Requests**

Add the **View** button to `requests-grid.tsx`'s actions cell and the same three
pieces of state/effect/mount. `music/requests/page.tsx` already computes
`canFindListeners` for `attend-dialog.tsx`; reuse it.

- [ ] **Step 4: Prove it**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/pickups src/app/\(app\)/participations src/app/\(app\)/music/requests
git commit -m "feat(30a): Pickups, Participations and Requests open the listener card"
```

---

### Task 6: Hand over asks before it delivers

Item 5.

**Files:**
- Create: `src/app/(app)/pickups/hand-over-dialog.tsx`
- Modify: `src/app/(app)/pickups/pickups-grid.tsx`, `src/components/draws/winner-actions.tsx`, `messages/{en,pt,es}.json`

**Interfaces:**
- Consumes: `onWinnerAction(winnerId, 'deliver', note)` — the existing handler, unchanged; `deliver_prize(p_winner_id, p_note)` (0084) already takes the note. **No migration.**
- Produces: `WinnerPowers.handOver?: boolean` — when `false`, `WinnerActions` omits `deliver` from its generic strip.

- [ ] **Step 1: Let `WinnerActions` stand down on one screen**

In `src/components/draws/winner-actions.tsx`, `availableWinnerActions` already
takes a `powers` object and already honours `reopenDeadline: false` so a screen
with no date field can suppress a button it cannot serve. Add the same opt-out
for `deliver`:

```ts
    // Block 30a. Pickups delivers through its own window (hand-over-dialog.tsx),
    // which shows the promotion, the listener and the prize before it hands
    // anything over, and carries the receipt field this generic strip has no
    // room for. Draws still uses the strip -- the same courtesy
    // `reopenDeadline: false` already extends one line down.
    if (powers.deliver && powers.handOver !== false) actions.push('deliver');
```

with `handOver?: boolean` added to `WinnerPowers`.

- [ ] **Step 2: Relabel the destructive action in all three catalogues**

`actionWriteOff` becomes the label of the **new** confirm button, so the
existing destructive one is renamed. In `messages/{en,pt,es}.json`, under `draws`:

| key | en | pt | es |
|---|---|---|---|
| `actionWriteOff` *(existing, now the delivery confirm)* | Write off | Dar baixa | Dar de baja |
| `actionWriteOffAsLost` *(new; replaces the old use)* | Write off as lost | Baixa por perda | Baja por pérdida |

In `winner-actions.tsx`, `LABEL_KEYS.write_off` points at
`actionWriteOffAsLost`.

> **The `WinnerAction` value, the door and the audit action do not change.**
> `write_off` stays `write_off` everywhere in SQL and in `winners.status`
> history. This is a label. Renaming the enum would be a migration across
> historical rows for no behaviour.
>
> Two buttons reading *Dar baixa* on one screen — one delivering, one declaring
> the prize lost — is the shape of a mistake nobody can undo: `write_off` has no
> reversing door.

- [ ] **Step 3: Write the window**

Create `src/app/(app)/pickups/hand-over-dialog.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { maskedPhone } from '@/lib/members/mask';

/**
 * Block 30a, item 5. What is being handed over, before it is handed over.
 *
 * IT DELIVERS. The button reads "Dar baixa" because that is what an operator
 * says when a prize leaves the shelf -- the owner's ruling of 2026-08-19 -- and
 * the action it runs is `deliver`, not `write_off`. The destructive write-off
 * was relabelled "Baixa por perda" in the same change, because two buttons
 * reading the same words on one screen, one of which cannot be undone, is the
 * shape of a mistake nobody recovers from.
 *
 * THE NOTES FIELD IS NOT NEW. deliver_prize (0084) has taken `p_note` since
 * Block 6b and the generic confirm strip already collected it as "Recibo da
 * entrega". It moves here and gains room; a second column beside it would be
 * two places to look for one sentence.
 *
 * The listener's number is the four digits the list already carries. This
 * window deliberately offers NO reveal: an operator who needs to telephone
 * somebody opens the listener card, which records the asking.
 */
export function HandOverDialog({
  promotionName,
  listenerName,
  listenerPhoneLast4,
  prizeName,
  onConfirm,
  onClose,
}: {
  promotionName: string;
  listenerName: string | null;
  listenerPhoneLast4: string | null;
  prizeName: string;
  /** Resolves to an error message, or null when the prize was handed over. */
  onConfirm: (note: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useTranslations('pickups');
  const td = useTranslations('draws');
  const titleId = useId();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function confirm() {
    setFailure(null);
    start(async () => {
      const message = await onConfirm(note.trim());
      if (message) setFailure(message);
      else onClose();
    });
  }

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{td('actionHandOver')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted-foreground">{t('promotion')}</dt>
          <dd data-testid="hand-over-promotion">{promotionName}</dd>

          <dt className="text-muted-foreground">{t('listener')}</dt>
          <dd data-testid="hand-over-listener">
            {listenerName ?? '—'}
            {listenerPhoneLast4 && (
              <span className="ml-2 text-muted-foreground">
                {maskedPhone(listenerPhoneLast4)}
              </span>
            )}
          </dd>

          <dt className="text-muted-foreground">{t('prize')}</dt>
          <dd data-testid="hand-over-prize">{prizeName}</dd>
        </dl>

        <label className="mt-5 flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('deliveryNotes')}</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            data-testid="hand-over-note"
          />
        </label>

        {failure && <p className="mt-3 text-sm text-destructive">{failure}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button type="button" onClick={confirm} disabled={pending} data-testid="hand-over-confirm">
          {td('actionWriteOff')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
```

Add to the `pickups` namespace in all three catalogues:

| key | en | pt | es |
|---|---|---|---|
| `deliveryNotes` | Delivery notes | Recibo da entrega | Recibo de la entrega |
| `cancel` | Cancel | Cancelar | Cancelar |

**Already in `pickups` — reuse, do not re-add:** `promotion`, `listener`,
`prize`, and `view` / `viewTheListener` (Task 5 added those two). Checked
against `messages/en.json`: `cancel` is **not** there, despite being everywhere
else in the product.

- [ ] **Step 4: Mount it**

In `pickups-grid.tsx`, pass `winnerPowers={{ ...winnerPowers, reopenDeadline: false, handOver: false }}`
to `WinnerActions`, add a Hand over button on rows where `deliver` is legal
(ask `availableWinnerActions` with the **unmodified** powers, the way `canReopen`
already asks), and mount `HandOverDialog` with
`onConfirm={(note) => handleWinnerAction(row.winnerId, 'deliver', note)}` —
which already patches the row's status from the result.

- [ ] **Step 5: Prove it**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/pickups src/components/draws/winner-actions.tsx messages
git commit -m "feat(30a): Hand over shows what is being handed over, and the write-off stops sharing its name"
```

---

### Task 7: The journey, and the documents

**Files:**
- Create: `tests/e2e/listener-privacy.spec.ts`
- Modify: `docs/SECURITY.md`, `docs/PERMISSIONS.md`

**Interfaces:**
- Consumes: every `data-testid` introduced in Tasks 4–6.

- [ ] **Step 1: Write the journey**

Create `tests/e2e/listener-privacy.spec.ts`. One journey, following the suite's
existing sign-in and seeding helpers:

1. Sign in as an operator holding `promotions.view` **and** `members.view`.
2. Open `/pickups`. Assert a row's phone cell matches `/^•••• \d{4}$/` and that
   the page's HTML does **not** contain the seeded whole number — this is the
   assertion that catches a future "improvement" that re-widens the door.
3. Click `pickup-view-listener`. Assert `listener-card-phone` shows the mask,
   click `listener-card-reveal-phone`, assert the whole number appears and the
   button is gone. Close.
4. Click Hand over. Assert `hand-over-promotion`, `hand-over-listener` and
   `hand-over-prize` are populated, type into `hand-over-note`, click
   `hand-over-confirm`, and assert the row's status becomes delivered.
**Then, in the EXISTING spec — not in the new one:**

`tests/e2e/participation-record.spec.ts:215-217` already asserts
`participation-phone` reads exactly `•••• <last4>`, with a comment explaining
why it is an exact match rather than `toContainText`. That is the right home for
the missing case, beside the case it already covers. Add one: a listener with
**CPF digits and no telephone number** — the phone slot must read `—` and **not**
`••••`.

This is not decoration. That one expression changes three times in this branch —
twice in Task 1, once in Task 3 — and produced a defect on two of those three,
each invisible to every suite in the repository. There is no component testing
here to catch it (no testing-library, no jsdom, vitest `environment: 'node'`,
unit glob `tests/unit/**/*.test.ts`), and standing that infrastructure up for one
assertion would be a larger change than the block it serves. Playwright already
exists, already drives this screen, and already asserts this exact test id.

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- listener-privacy`
Expected: PASS.

> If it fails on a cold compile rather than on an assertion, that is the known
> first-run trap on this machine, not the code. And if a stale `next dev` is
> holding the port, kill the **server**, not the task wrapper.

- [ ] **Step 3: Write down what changed about the boundary**

In `docs/SECURITY.md` **§8 (LGPD)** — verified: §8 is LGPD, §9 is Rate limiting,
and the disclosure belongs beside erasure rather than beside the limiters. Add
`reveal_member_field` next to `reveal_request_phone`: what it discloses, that it
returns null for an erased listener while still writing the audit row, and that
the two list doors no longer carry the number at all.

Then add one line to **§9** recording that neither reveal door is rate-limited:
an operator holding `members.view` can enumerate one listener at a time, leaving
an audit row each time. That is the exposure Block 22 accepted, now on a wider
door, and it is written down rather than hidden.

In `docs/PERMISSIONS.md`, note that `members.view` now also governs the listener
card on Pickups, Participations and Requests, and that no new permission was
added.

- [ ] **Step 4: Run the whole gate, in order**

Run: `npm run typecheck && npm run lint && npm test && npm run db:reset && npm run db:test && npm run test:isolation && npm run test:e2e`
Expected: all green. **The order matters.**

- [ ] **Step 5: Commit and open the PR**

```bash
git add tests/e2e/listener-privacy.spec.ts docs/SECURITY.md docs/PERMISSIONS.md
git commit -m "test(30a): the journey from a masked list to an audited disclosure"
git push -u origin block-30a-listener-privacy
```

---

## What this plan does not do, on purpose

- **No rate limit on `reveal_member_field`.** Spec §8. Same exposure
  `reveal_request_phone` has carried since Block 22; making it a limiter is a
  decision about operators, not about this block.
- **No `members.reveal` permission.** The boundary stays `members.view`, which
  all three screens already compute.
- **`MemberRecordDialog` is untouched.** Its fields stay unmasked, because it is
  reached from the screen whose purpose is administering a listener.
