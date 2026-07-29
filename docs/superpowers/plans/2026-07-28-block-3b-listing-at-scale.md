# Block 3b — Listing at scale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the audience, inventory and admin screens keyset pagination, server-side filters and sorting, and replace the audience list's per-row block-state N+1 with a single bulk predicate.

**Architecture:** Filters, sort and cursor travel in the URL. A Server Component reads `searchParams`, calls the service, and the service builds the query with the keyset condition, returning rows, the next cursor and the filtered total. Querying stays in TypeScript through RLS; exactly one new `SECURITY DEFINER` function goes into the database, because the N+1 it replaces cannot be fixed from the client.

**Tech Stack:** PostgreSQL 15 (Supabase), PL/pgSQL, Next.js 15 App Router, TypeScript, Tailwind, `class-variance-authority`, Vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-28-block-3b-listing-at-scale-design.md`

## Global Constraints

- Everything in English: identifiers, comments, error messages, UI copy.
- Vocabulary: `organizations` (Organization), `companies` are **"Stations"** in prose and UI, `members` are **the audience** — internal panel users are `company_memberships` and are never called Members in copy.
- **Keyset pagination only.** No `OFFSET`, no `.range()`, no page numbers. Previous/Next.
- **Every keyset ordering carries `id` as a tiebreak.** An ordering without it skips or repeats rows when values tie.
- **Age filters convert to a `birth_date` range in the query.** Computing an age per row in `WHERE` defeats every index.
- **Sorting by name must order by the same expression the index uses.** `members_name_idx` is on `(organization_id, lower(full_name))`.
- Exact filtered total on the audience and inventory screens; **no total** on the two admin screens.
- `USING (true)` is forbidden. Every new `SECURITY DEFINER` function re-checks its caller in its own body and, on denial, uses `RAISE LOG` then `RAISE EXCEPTION`.
- Migrations numbered sequentially from `0036`.
- Commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:isolation`, `npm run test:e2e`, `npx supabase db reset`, `npx supabase test db`, `npm run build`.

## Two things this project keeps getting wrong

1. **A comment that describes a mechanism the code does not have** shipped eight times, six of them in Block 3. The worst are comments *justifying a decision* — written from the reasoning that produced the choice, so they read as conclusions and nobody re-checks them. Treat any comment explaining why something is safe, correct or impossible as a claim to verify against the code.
2. **A test that cannot fail.** Four have shipped. Before reporting, re-read each assertion and ask what would have to break for it to go red.

## File structure

| File | Responsibility |
| --- | --- |
| `src/lib/keyset.ts` | Encode/decode a cursor; build the PostgREST keyset condition. Pure, no I/O. |
| `tests/unit/keyset.test.ts` | Round-trip, tie-break and null-boundary cases. |
| `src/components/ui/table.tsx` | Presentation only: header with sort indicator, body, footer with total and Previous/Next. |
| `supabase/migrations/0036_member_blocked_bulk.sql` | `members_blocked_bulk(uuid[], uuid)`, replacing the per-row RPC. |
| `src/services/members.ts` | `listOrganizationMembers` rewritten for keyset, filters, total, bulk block. |
| `src/app/(app)/members/page.tsx` | Reads the new `searchParams`; renders the table. |
| `src/app/(app)/members/members-filters.tsx` | Client component: filter form that writes to the URL. |
| `src/services/inventory.ts` | `listPrizesPage`, `getPrizeById`. |
| `src/app/(app)/inventory/page.tsx`, `inventory-browser.tsx` | Server-side filtering; the client filter is deleted. |
| `src/app/(app)/inventory/[prizeId]/page.tsx` | Sequential scan replaced by a direct lookup. |
| `src/app/(app)/inventory/station-access.ts` | `listCompanyAccess` gains search; the 50-cap dead end goes. |
| `src/app/(admin)/admin/customers/page.tsx` | Paging and search. |
| `src/app/(app)/team/page.tsx` | `deleted_at` filter and a safety bound. |
| `tests/isolation/listing.test.ts` | The tie-break traversal proof and the bulk predicate's boundary. |

---

### Task 1: The keyset cursor helper

**Files:**
- Create: `src/lib/keyset.ts`
- Test: `tests/unit/keyset.test.ts`

**Interfaces:**
- Produces: `type SortDirection = 'asc' | 'desc'`; `interface Cursor { value: string | null; id: string }`; `encodeCursor(c: Cursor): string`; `decodeCursor(raw: string | undefined | null): Cursor | null`; `keysetFilter(column: string, direction: SortDirection, cursor: Cursor, nullsLast: boolean): string`.

This is the only file that knows how a cursor is encoded. Everything else passes it around opaquely.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/keyset.test.ts
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, keysetFilter } from '@/lib/keyset';

describe('cursor encoding', () => {
  it('round-trips a value and its tiebreak id', () => {
    const c = { value: '2026-07-28T12:00:00.000Z', id: 'aaaaaaaa-0000-0000-0000-000000000001' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('round-trips a null value, which is how the null region is entered', () => {
    const c = { value: null, id: 'aaaaaaaa-0000-0000-0000-000000000002' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  // Every one of these arrives from a URL, which is hostile input. None may throw:
  // an unreadable cursor means "start from the beginning", never a 500.
  it.each([
    [undefined, 'absent'],
    [null, 'null'],
    ['', 'empty'],
    ['not-base64!!', 'not base64'],
    [Buffer.from('{"nope":1}').toString('base64url'), 'wrong shape'],
    [Buffer.from('[]').toString('base64url'), 'not an object'],
    [Buffer.from('{"value":"a","id":123}').toString('base64url'), 'id not a string'],
  ])('returns null for a %s cursor (%s)', (raw) => {
    expect(decodeCursor(raw as string | undefined)).toBeNull();
  });
});

describe('keysetFilter', () => {
  const cur = { value: 'M', id: 'bbbbbbbb-0000-0000-0000-000000000001' };

  it('ascending: strictly greater, or equal with a greater id', () => {
    expect(keysetFilter('full_name', 'asc', cur, false)).toBe(
      'full_name.gt."M",and(full_name.eq."M",id.gt."bbbbbbbb-0000-0000-0000-000000000001")',
    );
  });

  it('descending: strictly less, or equal with a lesser id', () => {
    expect(keysetFilter('created_at', 'desc', cur, false)).toBe(
      'created_at.lt."M",and(created_at.eq."M",id.lt."bbbbbbbb-0000-0000-0000-000000000001")',
    );
  });

  // The bug this exists to prevent: a comparison against NULL is never true, so
  // whichever region the cursor is in, the arm crossing into the other region
  // must be added by hand or everything on the far side is unreachable — and
  // silently, because the pages still load and the count still looks right.
  //
  // Cover all four combinations. An earlier draft of this plan gated the
  // crossing arm on `direction === 'asc'` and treated the null region as always
  // terminal; both were wrong, and neither was caught because only the two
  // ascending-nulls-last cases were tested.
  it('non-null region, nulls last, ascending: adds the null arm', () => {
    expect(keysetFilter('full_name', 'asc', cur, true)).toBe(
      'full_name.gt."M",and(full_name.eq."M",id.gt."bbbbbbbb-0000-0000-0000-000000000001"),full_name.is.null',
    );
  });

  it('non-null region, nulls last, descending: adds the null arm too', () => {
    expect(keysetFilter('full_name', 'desc', cur, true)).toBe(
      'full_name.lt."M",and(full_name.eq."M",id.lt."bbbbbbbb-0000-0000-0000-000000000001"),full_name.is.null',
    );
  });

  it('non-null region, nulls first: the nulls are already behind us', () => {
    expect(keysetFilter('full_name', 'asc', cur, false)).toBe(
      'full_name.gt."M",and(full_name.eq."M",id.gt."bbbbbbbb-0000-0000-0000-000000000001")',
    );
  });

  const nullCur = { value: null, id: 'cccccccc-0000-0000-0000-000000000001' };

  it('null region, nulls last: terminal, so the id alone orders what remains', () => {
    expect(keysetFilter('full_name', 'asc', nullCur, true)).toBe(
      'and(full_name.is.null,id.gt."cccccccc-0000-0000-0000-000000000001")',
    );
  });

  it('null region, nulls first: non-null rows still follow and must be reachable', () => {
    expect(keysetFilter('full_name', 'asc', nullCur, false)).toBe(
      'and(full_name.is.null,id.gt."cccccccc-0000-0000-0000-000000000001"),full_name.not.is.null',
    );
  });

  it('null region, nulls first, descending: same crossing arm', () => {
    expect(keysetFilter('full_name', 'desc', nullCur, false)).toBe(
      'and(full_name.is.null,id.lt."cccccccc-0000-0000-0000-000000000001"),full_name.not.is.null',
    );
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/keyset.test.ts`
Expected: FAIL — cannot resolve `@/lib/keyset`.

- [ ] **Step 3: Implement**

```ts
// src/lib/keyset.ts

/**
 * Keyset (cursor) pagination. Unlike OFFSET, the cost does not grow with depth:
 * the database seeks straight to the cursor's position in the index instead of
 * counting and discarding every row before it.
 *
 * The price is that you cannot jump to page 37 — only forward and back — which
 * is why this product's list footers show Previous/Next rather than page numbers.
 */

export type SortDirection = 'asc' | 'desc';

export interface Cursor {
  /** The sort column's value on the last row of the page just shown. */
  value: string | null;
  /** That row's id. The tiebreak — without it, rows with equal values are skipped or repeated. */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ value: cursor.value, id: cursor.id })).toString('base64url');
}

/** Returns null for anything unreadable. A bad cursor means "start over", never an error page. */
export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const { value, id } = parsed as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) return null;
    if (value !== null && typeof value !== 'string') return null;
    return { value, id };
  } catch {
    return null;
  }
}

/** PostgREST needs values quoted so a comma or parenthesis inside one cannot end the clause. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Builds the `.or(...)` argument that resumes after `cursor`.
 *
 * `nullsLast` must match the ordering actually applied to the query, and it is
 * independent of direction: Postgres defaults ASC to NULLS LAST and DESC to
 * NULLS FIRST, so a caller who wants nulls last on a descending sort has to ask
 * for it explicitly.
 *
 * Comparisons against NULL are never true, so whichever region the cursor is
 * in, the arm that crosses into the other region has to be added by hand or
 * everything on the far side is unreachable — silently, since the pages still
 * load and the count still looks right. The rule is symmetric:
 *
 *   - in the non-null region, add `col.is.null` when nulls sort last;
 *   - in the null region, add `col.not.is.null` when nulls sort first.
 */
export function keysetFilter(
  column: string,
  direction: SortDirection,
  cursor: Cursor,
  nullsLast: boolean,
): string {
  const op = direction === 'asc' ? 'gt' : 'lt';
  const id = quote(cursor.id);

  if (cursor.value === null) {
    const arms = [`and(${column}.is.null,id.${op}.${id})`];
    // Nulls first means the null region is NOT terminal: non-null rows follow
    // it, and without this arm paging stops dead once the nulls run out.
    if (!nullsLast) arms.push(`${column}.not.is.null`);
    return arms.join(',');
  }

  const value = quote(cursor.value);
  const arms = [`${column}.${op}.${value}`, `and(${column}.eq.${value},id.${op}.${id})`];
  // Nulls last means the null region follows every non-null row, in either
  // direction — `col.gt.V` and `col.lt.V` are both false for a NULL.
  if (nullsLast) arms.push(`${column}.is.null`);

  return arms.join(',');
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/unit/keyset.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Prove the tiebreak test bites**

Delete the `and(...)` arm from `keysetFilter`'s `arms` array, re-run, confirm the two tie-break tests go red, then restore it. **Restore with `;` and not `&&`** — the runner exits non-zero on exactly the failure you are causing, so `run && git checkout` silently skips the restore. Verify with `git diff` before continuing. Record the output in your report.

- [ ] **Step 6: Commit**

```bash
git add src/lib/keyset.ts tests/unit/keyset.test.ts
git commit -m "feat(lib): add the keyset cursor helper"
```

---

### Task 2: The table primitive

**Files:**
- Create: `src/components/ui/table.tsx`

**Interfaces:**
- Produces: `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`, `TableFooter` — and `SortLink`, `PageControls`.

`src/components/ui/` holds exactly three files (`button.tsx`, `card.tsx`, `input.tsx`) and no table. The only `<table>` in `src/` is hand-rolled inside `inventory/reconciliation-panel.tsx`.

**Match the existing convention exactly**: named `export const`, `React.forwardRef`, `cn(...)` from `@/lib/utils`, a `.displayName` on every component, no default export, no `'use client'`.

> **Superseded — read the shipped file, not the listing below.** Task 2's review found two
> accessibility defects in this plan's own code: `SortLink` conveyed sort state only through
> an `aria-hidden` glyph, so screen readers got nothing; and the disabled Previous/Next
> rendered as unfocusable `<span>`s styled to look exactly like the enabled controls. Both
> were fixed in `52f01e4` — a visually-hidden state label, `<button type="button" disabled>`
> for the disabled state, the app's own focus-ring token throughout, and a documented
> warning that `TableFooter` is a `div` and must not be nested inside `Table`.
> **Tasks 4–6 import from `@/components/ui/table` and must set `aria-sort` on the
> `TableHead` of any sortable column — the component forwards it but does not set it.**

- [ ] **Step 1: Write the primitive**

```tsx
// src/components/ui/table.tsx
import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    // The wrapper, not the page body, is what scrolls when the columns are wider
    // than the viewport.
    <div className="w-full overflow-x-auto">
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  ),
);
Table.displayName = 'Table';

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
));
TableBody.displayName = 'TableBody';

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn('border-b transition-colors hover:bg-accent/40', className)}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-10 px-3 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-3 py-3 align-middle', className)} {...props} />
));
TableCell.displayName = 'TableCell';

export const TableFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border-t px-3 py-3 text-sm',
        className,
      )}
      {...props}
    />
  ),
);
TableFooter.displayName = 'TableFooter';

/** A column header that toggles the sort by rewriting the URL. */
export function SortLink({
  href,
  active,
  direction,
  children,
}: {
  href: string;
  active: boolean;
  direction: 'asc' | 'desc';
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {children}
      <span aria-hidden="true" className={cn('text-[0.65rem]', active ? '' : 'opacity-30')}>
        {active && direction === 'desc' ? '▼' : '▲'}
      </span>
    </Link>
  );
}

/**
 * Previous/Next, never page numbers: keyset pagination can move one page in
 * either direction at constant cost, but cannot jump to an arbitrary page.
 *
 * `total` is omitted on the platform-wide admin screens, where counting is not
 * cheap and nobody is asking "how many".
 */
export function PageControls({
  total,
  label,
  previousHref,
  nextHref,
}: {
  total?: number | null;
  label: string;
  previousHref: string | null;
  nextHref: string | null;
}) {
  return (
    <TableFooter>
      <span className="text-muted-foreground" data-testid="page-total">
        {typeof total === 'number' ? `${total.toLocaleString('en-GB')} ${label}` : label}
      </span>
      <span className="flex items-center gap-2">
        {previousHref ? (
          <Link
            href={previousHref}
            data-testid="page-previous"
            className="rounded-md border px-3 py-1.5 hover:bg-accent/40"
          >
            Previous
          </Link>
        ) : (
          <span className="rounded-md border px-3 py-1.5 opacity-40">Previous</span>
        )}
        {nextHref ? (
          <Link
            href={nextHref}
            data-testid="page-next"
            className="rounded-md border px-3 py-1.5 hover:bg-accent/40"
          >
            Next
          </Link>
        ) : (
          <span className="rounded-md border px-3 py-1.5 opacity-40">Next</span>
        )}
      </span>
    </TableFooter>
  );
}
```

- [ ] **Step 2: Verify it compiles and lints**

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/table.tsx
git commit -m "feat(ui): add the table primitive"
```

---

### Task 3: The bulk block predicate

**Files:**
- Create: `supabase/migrations/0036_member_blocked_bulk.sql`
- Modify: `supabase/tests/02_permissions.test.sql`

**Interfaces:**
- Produces: `public.members_blocked_bulk(p_member_ids uuid[], p_company_id uuid) returns table (member_id uuid, blocked boolean)`.

**This is the highest-risk item in the block** (spec §13.2). It replaces up to 50 calls of `is_member_blocked` per page load — each of which re-runs a full permission subtree because it is `SECURITY DEFINER` — with one call. The same guarantee must hold in bulk form, and it must not become a way to ask about listeners outside the caller's reach.

Read `supabase/migrations/0032_member_lifecycle_tables.sql:184-220` first. `is_member_blocked` stays exactly as it is; this function sits beside it.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0036_member_blocked_bulk.sql

-- The set-at-a-time form of is_member_blocked (0032).
--
-- The audience list asks the same question for every listener on the page, at
-- the same Station. Asked one row at a time it costs up to fifty round trips,
-- and — because is_member_blocked is SECURITY DEFINER and re-checks its caller
-- on every invocation — it recomputes the identical permission subtree
-- (a permissions lookup, has_company_access, and a
-- company_memberships-roles-role_permissions join) fifty times for one Station.
--
-- The caller guard is checked ONCE here, for the single Station every row in
-- the batch is asked about, and it is the same three arms 0032 uses, for the
-- same reason: has_permission alone refuses the platform admin and the owner
-- for a suspended or archived Station, which is the regression the Block 3
-- whole-branch review caught.
--
-- Returning a row per input id, rather than only the blocked ones, is
-- deliberate: the caller can then map without deciding what a missing id means.
create or replace function public.members_blocked_bulk(
  p_member_ids uuid[],
  p_company_id uuid
)
returns table (member_id uuid, blocked boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not (
    public.is_platform_admin()
    or exists (
      select 1 from public.companies c
      where c.id = p_company_id and public.is_owner(c.organization_id)
    )
    or public.has_permission('members.view', p_company_id)
  ) then
    raise log 'members_blocked_bulk denied: actor=% company=% batch=%',
      auth.uid(), p_company_id, coalesce(array_length(p_member_ids, 1), 0);
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  return query
  select
    m.id,
    exists (
      select 1
      from public.member_blocks b
      where b.member_id = m.id
        and (b.company_id is null or b.company_id = p_company_id)
        and b.lifted_at is null
        and b.starts_at <= now()
        and (b.ends_at is null or b.ends_at > now())
    )
  from unnest(p_member_ids) as m(id);
end;
$$;

comment on function public.members_blocked_bulk(uuid[], uuid) is
  'Whether an active block bars each listed Member at p_company_id right now, derived at read time from starts_at/ends_at/lifted_at. The set-at-a-time form of is_member_blocked (0032): same three-arm caller guard, checked once for the one Station the whole batch concerns, instead of once per row.';

revoke execute on function public.members_blocked_bulk(uuid[], uuid) from public;
grant execute on function public.members_blocked_bulk(uuid[], uuid) to authenticated;

-- The indexes the audience list's sorting and filtering need. Neither column
-- has one today (verified against 0031_members.sql).
--
-- members_name_idx already exists, but on (organization_id, lower(full_name)) —
-- so sorting by name must order by the SAME expression or the index is ignored
-- silently, which looks like nothing at all until the table is large.
create index members_created_at_idx
  on public.members (organization_id, created_at, id)
  where deleted_at is null;

-- The age filter is a birth_date range, never a per-row age computation: an
-- expression in the WHERE clause cannot use this index.
create index members_birth_date_idx
  on public.members (organization_id, birth_date)
  where deleted_at is null;
```

- [ ] **Step 2: Assert the grant grid**

Append to `supabase/tests/02_permissions.test.sql`, immediately before `select * from finish();`. **The plan count is currently `plan(184)` at line 2 — raise it by the number of assertions you add, counted from the resolved file rather than by arithmetic.** A count too high fails loudly; one too low silently ignores every assertion past it.

```sql
-- Block 3b: the bulk block predicate is reachable by authenticated and by nobody else.
select is(
  (select count(*)::int from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'members_blocked_bulk'),
  1,
  'members_blocked_bulk exists'
);
select is(
  (select p.prosecdef from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'members_blocked_bulk'),
  true,
  'members_blocked_bulk is security definer, so its own caller guard is what protects it'
);
select ok(
  has_function_privilege('authenticated', 'public.members_blocked_bulk(uuid[], uuid)', 'execute'),
  'authenticated may execute members_blocked_bulk'
);
select ok(
  not has_function_privilege('anon', 'public.members_blocked_bulk(uuid[], uuid)', 'execute'),
  'anon may not execute members_blocked_bulk'
);
```

- [ ] **Step 3: Run the database suite**

Run: `npx supabase db reset && npx supabase test db`
Expected: PASS with the new count. If the runner reports a different number than your `plan()`, fix the plan — never adjust assertions to match a number.

- [ ] **Step 4: Prove the guard bites, live**

In `psql` against the local stack, inside a transaction you roll back: set `role authenticated` with a `request.jwt.claims` for a user holding nothing at some Station, call `members_blocked_bulk` for that Station, and confirm it raises `42501`. Then repeat as a user who does hold `members.view` there and confirm it returns a row per input id. Record both outputs verbatim in your report.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0036_member_blocked_bulk.sql supabase/tests/02_permissions.test.sql
git commit -m "feat(db): add the bulk block predicate"
```

---

### Task 4: The audience list

**Files:**
- Modify: `src/services/members.ts`
- Modify: `src/app/(app)/members/page.tsx`
- Create: `src/app/(app)/members/members-filters.tsx`

**Interfaces:**
- Consumes: `decodeCursor`, `encodeCursor`, `keysetFilter` (Task 1); `Table`…`PageControls` (Task 2); `members_blocked_bulk` (Task 3).
- Produces: `listOrganizationMembers(params: MemberListParams, accessToken: string): Promise<MemberListPage>`.

The current implementation is at `src/services/members.ts:342-443`. Read it before changing it — the search's `.or()` construction, `quoteForOrFilter` (`:288`) and `escapeLikePattern` (`:309`) are all correct and stay.

**Columns:** Name · Phone · E-mail · CPF (last 3) · Age · City · Registered · Block state.
**Filters:** age range, block state, rules consent, registration period.
**Sort:** name, registered.
**City is a column, not a filter** — spec §7. Do not add a city filter; the free-text column it would read is slated for removal and would count wrongly in the meantime.

- [ ] **Step 1: Replace the parameter and return types**

```ts
export interface MemberListParams {
  organizationId: string;
  search?: string;
  sort: 'name' | 'created';
  direction: SortDirection;
  cursor: Cursor | null;
  ageMin?: number;
  ageMax?: number;
  blocked?: boolean;
  hasRulesConsent?: boolean;
  registeredFrom?: string; // ISO date
  registeredTo?: string;   // ISO date
  companyId: string;       // the Station the block state is asked about
}

export interface MemberListRow {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  cpfLastDigits: string | null;
  birthDate: string | null;
  city: string | null;
  anonymizedAt: string | null;
  createdAt: string;
  blocked: boolean;
}

export interface MemberListPage {
  rows: MemberListRow[];
  nextCursor: string | null;
  total: number; // always exact — see Step 3
}
```

- [ ] **Step 2: Build the query**

Keep `asCaller(accessToken)` (`:35`) — the audience service uses an access token, unlike `src/services/inventory.ts`, which uses `createUserClient()`. Do not unify them in this task.

```ts
const PAGE_SIZE = 50;

export async function listOrganizationMembers(
  params: MemberListParams,
  accessToken: string,
): Promise<MemberListPage> {
  const supabase = asCaller(accessToken);
  const column = params.sort === 'name' ? 'full_name' : 'created_at';
  const nullsLast = params.sort === 'name'; // full_name is nullable; created_at is not

  const base = () => {
    let q = supabase
      .from('members')
      .select('id, full_name, phone, email, cpf_last_digits, birth_date, city, anonymized_at, created_at')
      .eq('organization_id', params.organizationId)
      .is('deleted_at', null);

    // The age filter is expressed as a birth_date range. Computing an age per
    // row in the WHERE clause would defeat members_birth_date_idx and turn this
    // into a full scan.
    if (params.ageMax !== undefined) {
      q = q.gte('birth_date', isoDateYearsAgo(params.ageMax + 1));
    }
    if (params.ageMin !== undefined) {
      q = q.lte('birth_date', isoDateYearsAgo(params.ageMin));
    }
    if (params.registeredFrom) q = q.gte('created_at', params.registeredFrom);
    if (params.registeredTo) q = q.lte('created_at', params.registeredTo);

    const term = params.search?.trim().slice(0, MEMBER_SEARCH_MAX_LENGTH);
    if (term) {
      const wildcard = quoteForOrFilter(`%${escapeLikePattern(term)}%`);
      const clauses = [
        `full_name.ilike.${wildcard}`,
        `phone.ilike.${wildcard}`,
        `email.ilike.${wildcard}`,
      ];
      const digits = term.replace(/[^0-9]/g, '');
      if (digits) {
        clauses.push(`cpf_last_digits.ilike.${quoteForOrFilter(`%${digits}%`)}`);
        clauses.push(`phone_normalized.ilike.${quoteForOrFilter(`%${digits}%`)}`);
      }
      q = q.or(clauses.join(','));
    }
    return q;
  };

  let query = base().order(column, { ascending: params.direction === 'asc', nullsFirst: false });
  if (params.cursor) {
    query = query.or(keysetFilter(column, params.direction, params.cursor, nullsLast));
  }
  query = query.order('id', { ascending: params.direction === 'asc' });

  const { data, error } = await query.limit(PAGE_SIZE + 1);
  if (error) throw mapMemberError(error.code, error.message);

  const all = data ?? [];
  const hasMore = all.length > PAGE_SIZE;
  const page = hasMore ? all.slice(0, PAGE_SIZE) : all;
  // …total, consent filter and block state below
}
```

- [ ] **Step 3: The total**

```ts
  // Always exact. An earlier draft used PostgREST's 'estimated' count for
  // free-text searches and hid it above a ceiling — but below that ceiling it
  // would have rendered a planner estimate in a footer that reads as a fact,
  // on a screen whose whole purpose is answering "how many". A wrong number
  // presented as a right one is worse than a slower query.
  //
  // At this product's real scale — 30-60k members per Organization, and every
  // query cut to one Organization by RLS before it touches disk — an exact
  // count costs tens of milliseconds even through ILIKE. Revisit only with a
  // measurement, never with an estimate wearing a total's clothes.
  const { count, error: countError } = await base().select('id', {
    count: 'exact',
    head: true,
  });
  if (countError) throw mapMemberError(countError.code, countError.message);
  const total: number = count ?? 0;
```

- [ ] **Step 4: The block state, in one call**

```ts
  const ids = page.map((r) => r.id);
  const blockedById = new Map<string, boolean>();
  if (ids.length > 0) {
    const { data: flags, error: blockError } = await supabase.rpc('members_blocked_bulk', {
      p_member_ids: ids,
      p_company_id: params.companyId,
    });
    if (blockError) throw mapMemberError(blockError.code, blockError.message);
    for (const row of flags ?? []) blockedById.set(row.member_id, row.blocked);
  }
```

Delete `mapWithConcurrency` (`:186-201`), `BLOCK_CHECK_CONCURRENCY` (`:260`) and the fan-out at `:423-429` **only if nothing else uses them** — `listMemberStations` (`:648`) calls `checkMemberBlocked` under its own `Promise.all` at `:678-680`. Check before deleting, and say in your report what you found.

- [ ] **Step 5: The consent filter**

`member_consents` is append-only: a withdrawal is a new row. "Has rules consent" therefore means *the most recent `rules` row for this Member is `granted = true`*, not "a granted row exists". Implement it as a filter on the id set:

```ts
  // Append-only means a withdrawal is a NEW row (0032), so the question is what
  // the LATEST rules row says — not whether a granted one exists. A member who
  // consented and then withdrew has both.
```

Fetch the latest `rules` row per member for the page's ids and filter in TypeScript. Do not filter this in the paginated query: doing so would make the keyset condition and the consent join interact, and a cursor is only correct over a stable ordering of a stable set.

**Report this explicitly**: filtering after the page is fetched means a page can return fewer than 50 rows when the consent filter is active. That is a real limitation and the copy must not claim otherwise.

- [ ] **Step 6: The page and the filter form**

`page.tsx` reads `searchParams` for `q`, `sort`, `dir`, `cursor`, `ageMin`, `ageMax`, `blocked`, `consent`, `from`, `to`. Render with the Task 2 primitive. `members-filters.tsx` is a client component that writes those values back into the URL; keep `data-testid="member-row"` on the row so the existing e2e journey still resolves it.

Age is computed for display from `birthDate`; 50 rows makes that free.

- [ ] **Step 7: Run the gates and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add src/services/members.ts "src/app/(app)/members"
git commit -m "feat(members): keyset paging, filters and sorting on the audience"
```

---

### Task 5: The inventory list and the prize lookup

**Files:**
- Modify: `src/services/inventory.ts`
- Modify: `src/app/(app)/inventory/page.tsx`, `src/app/(app)/inventory/inventory-browser.tsx`
- Modify: `src/app/(app)/inventory/[prizeId]/page.tsx`

**Interfaces:**
- Produces: `listPrizesPage(params: PrizeListParams): Promise<PrizeListPage>`; `getPrizeById(prizeId: string): Promise<{ companyId: string; prize: PrizeSummary } | null>`.

`listPrizes` (`src/services/inventory.ts:110`) has **no `.limit()`** and the whole result is shipped to the browser, where `inventory-browser.tsx:35-48` filters it in a `useMemo`. At 10,000 prizes the screen does not open.

**Note the different client**: inventory uses `await createUserClient()`, not `asCaller(accessToken)`. Keep it.

- [ ] **Step 1: Add the paged read**

Mirror Task 4's shape: `PrizeListParams { companyId, search?, categoryId?, includeArchived?, sort: 'name' | 'created', direction, cursor }` returning `{ rows: PrizeSummary[]; nextCursor: string | null; total: number }`. Sort by `name` (nullable? check the column — `prizes.name` is `not null`, so `nullsLast` is false) with `id` as the tiebreak.

The balances read at `:130-136` stays, now `.in('prize_id', pageIds)` over the page rather than every prize.

- [ ] **Step 2: Delete the client-side filter**

`inventory-browser.tsx`'s `useMemo` goes. The search box and category select become URL-writing controls, the same shape as `members-filters.tsx`. Keep `data-testid="prize-row"`.

- [ ] **Step 3: Replace the sequential scan**

`[prizeId]/page.tsx:57-70` loops `listPrizes` over every viewable Company to find one prize — at 2,000 prizes per Company that is a 100,000-row scan to open one card. Replace with a direct read:

```ts
export async function getPrizeById(prizeId: string) {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('prizes')
    .select('id, name, category_id, internal_code, description, allows_return_to_stock, company_id')
    .eq('id', prizeId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw mapInventoryError(error.code, error.message);
  return data ? { companyId: data.company_id, prize: toPrizeSummary(data) } : null;
}
```

RLS already scopes `prizes` to the Stations the caller can reach (`0029`), so a prize at an unreachable Station comes back as `null` — the same outcome the loop produced, without the scan. **The `NotFound` component's `capped` caveat at `:282-287` becomes false once the scan is gone: remove it**, because a comment or copy describing a mechanism that no longer exists is this project's most expensive defect class.

- [ ] **Step 4: Gates and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add src/services/inventory.ts "src/app/(app)/inventory"
git commit -m "feat(inventory): server-side filtering, paging, and a direct prize lookup"
```

---

### Task 6: The two admin screens

**Files:**
- Modify: `src/app/(admin)/admin/customers/page.tsx`
- Modify: `src/app/(app)/inventory/station-access.ts`

Both are platform-wide with no Organization cut, so §3's per-tenant arithmetic does not apply. **Neither gets a total** — Previous/Next only.

- [ ] **Step 1: Page the customers console**

The query at `:24-33` has no limit and no `deleted_at` filter. Add keyset paging on `(created_at desc, id desc)`, a name search, and the `deleted_at` filter. Keep `data-testid="company-row"`.

- [ ] **Step 2: Replace the 50-Station cap with search**

`listCompanyAccess` (`station-access.ts:86-141`) reads `.limit(COMPANY_SCAN_CAP + 1)` and reports `capped`, which has no next page: for a platform admin it truncates to the alphabetically-first 50 with no route to the 51st.

Add an optional `search?: string` parameter that filters by name server-side, and keep the cap as a bound on one page. Its three consumers — `inventory/page.tsx:84-89`, `inventory/[prizeId]/page.tsx:79`, `members/page.tsx:114` — must all keep compiling; update the copy at each so it stops describing a dead end.

**Check whether the `capped` copy is still true at each site after the change.** `inventory/[prizeId]/page.tsx`'s use disappears entirely with Task 5.

- [ ] **Step 3: Gates and commit**

```bash
npm run lint && npm run typecheck && npm run build
git add "src/app/(admin)/admin/customers/page.tsx" "src/app/(app)/inventory/station-access.ts"
git commit -m "feat(admin): page the customers console and search stations"
```

---

### Task 7: The Team screen's two corrections

**Files:**
- Modify: `src/app/(app)/team/page.tsx`

**This task deliberately adds no pagination.** At 30 users and 3 Companies per Organization the screen is fine; the nested controls come to roughly 90 blocks, not thousands. It gets the two defects the survey found, and nothing else.

- [ ] **Step 1: Add the `deleted_at` filter and a bound**

The query at `:23-26`:

```tsx
  const { data: memberships, error: membershipsError } = await supabase
    .from('organization_memberships')
    .select('id, user_id, role, organization_id')
    .order('created_at', { ascending: true });
```

It filters no `deleted_at`, unlike `members/page.tsx:39-45` and `roles/page.tsx:30`, and has no limit. Add `.is('deleted_at', null)` and `.limit(TEAM_SAFETY_BOUND)` with `const TEAM_SAFETY_BOUND = 500;` and a comment saying it is a safety net rather than paging, and why paging is not warranted here.

**Confirm `organization_memberships` actually has a `deleted_at` column before filtering on it.** If it does not, say so in your report and add only the bound.

- [ ] **Step 2: Gates and commit**

```bash
npm run lint && npm run typecheck && npm run build
git add "src/app/(app)/team/page.tsx"
git commit -m "fix(team): filter archived memberships and bound the query"
```

---

### Task 8: The traversal proof

**Files:**
- Create: `tests/isolation/listing.test.ts`

**Interfaces:**
- Consumes: `provisionCustomer`, `grantRoleWith`, `signInAs`, `createMemberAs`, `cleanupUsers` from `tests/isolation/harness.ts`.

**This is the block's proof.** The bug it exists to catch is skipped or repeated rows when sort values tie — invisible, because pages load and the count looks right while somebody vanishes from the middle.

Follow the shape of `tests/isolation/members.test.ts`: `afterAll(cleanupUsers)` at the top, labels from `Date.now()`, **every case driven by a non-owner delegate**.

- [ ] **Step 1: The tie-break traversal**

Seed **more than one page** of listeners where many share an identical `full_name` — the value that ties. Page through from the first cursor to exhaustion, collecting ids. Assert the collected set equals the seeded set **exactly**: same size, no duplicates, nothing missing.

```ts
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await fetchPage(cursor);
      seen.push(...page.rows.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);        // no repeats
    expect(new Set(seen)).toEqual(new Set(seededIds));   // no gaps
```

- [ ] **Step 2: The null-name region**

Seed listeners with **no name at all** alongside named ones, sort by name, and traverse. Without the `full_name.is.null` arm from Task 1, every unnamed listener is unreachable. Assert they all appear.

- [ ] **Step 3: The bulk predicate's boundary**

A delegate holding `members.view` at Station A only must be refused (`42501`) when calling `members_blocked_bulk` for Station B, **while holding a live membership in B under a role granting nothing** — otherwise the refusal comes from the access gate rather than permission resolution, one layer above the one it names. `grantRoleWith(customer, label, [], [stationB])` builds that subject.

- [ ] **Step 4: Prove the tests bite**

Run three mutations, each reverted, each recorded:
1. Remove the `id` tiebreak from the ordering in `listOrganizationMembers` → Step 1 must fail.
2. Remove the `full_name.is.null` arm from `keysetFilter` → Step 2 must fail.
3. Remove the caller guard from `members_blocked_bulk` → Step 3 must fail.

**Restore with `;`, never `&&`** — the runner exits non-zero on the failure the mutation causes, so `run && git checkout` skips the restore and the next mutation stacks on the last. Verify each restore with `git diff` before the next one.

- [ ] **Step 5: Run and commit**

```bash
npm run test:isolation
git add tests/isolation/listing.test.ts
git commit -m "test(listing): prove keyset traversal loses nobody"
```

---

### Task 9: Verification and the block report

- [ ] Every gate at real defaults, output captured verbatim: `npm run lint`, `npm run typecheck`, `npm test`, `npx supabase db reset`, `npx supabase test db`, `npm run test:isolation`, `npm run build`, `npm run test:e2e`.

- [ ] Confirm the existing e2e journeys still pass. `tests/e2e/members-flow.spec.ts` resolves `data-testid="member-row"`, and `tests/e2e/inventory-flow.spec.ts` resolves `data-testid="prize-row"` — both must survive the table rewrite.

- [ ] **Verify the N+1 is actually gone**, rather than assuming: count the round trips for one unsearched `/members` load before and after. The baseline is roughly 107.

- [ ] Write `docs/block-3b-report.md` following `docs/block-3-report.md`. It must carry:
  - that the city column shows free-text data the geography block will discard, and that nothing on screen says so (spec §13.1);
  - that the consent filter is applied after the page is fetched, so a page can return fewer than 50 rows;
  - the before/after round-trip count;
  - which assertions in Task 8 were shown to fail under mutation, with the output.

- [ ] Commit. **Do not push and do not open a PR** — that is the owner's decision.

---

## Self-review

**Spec coverage.** §4 architecture → Tasks 1, 4. §5 three shared pieces → Tasks 1, 2, 3; the indexes §5 names had no task at all on the first pass and are now in Task 3 Step 1 (`members_created_at_idx`, `members_birth_date_idx`). §6 five screens → Tasks 4, 5, 6, 7. §7 city as column → Task 4. §8 export cut → nothing to build, correctly absent. §9 errors → Task 1 Step 3 (`decodeCursor` returns null) and Task 4. §10 testing → Task 8. §11 done → Task 9. §12 out of scope → nothing built. §13 risks → Task 3 and Task 9's report.

**Placeholders.** None: every code step carries real code, every command is runnable.

**Type consistency.** `Cursor`, `SortDirection`, `keysetFilter` are used in Tasks 1, 4, 5 with the same signatures. `MemberListRow` gains `birthDate` and `city`; `MemberListPage` replaces the old `{ members, capped }`, so `page.tsx`'s destructuring at `:86-93` must change with it — noted in Task 4 Step 6.
