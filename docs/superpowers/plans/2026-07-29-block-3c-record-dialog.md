# Block 3c — The record dialog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every list screen into grid + filters + a create button, with the record opening as a tabbed dialog over the list that never re-runs the list query.

**Architecture:** The Server Component still reads `searchParams` and runs the keyset query. A thin client host wraps the grid and owns three things — which record is open, which tab, and that record's data — plus local row patches. The open record is addressed by `?record=<id>&tab=<slug>`, written with the browser's history API so no server navigation happens. Forms move inside the dialog, keep their server actions, and stop revalidating the list route.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind, native `<dialog>`, `lucide-react`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-29-record-dialog-pattern-design.md`

## Global Constraints

- Everything in English: identifiers, comments, error messages, UI copy.
- Vocabulary: `organizations` (Organization), `companies` are **"Stations"**, `members` are **the audience**; internal panel users are never called Members in copy.
- **No migrations, no new RPCs, no policy changes.** This block is interface plus the reads the dialogs need.
- **Opening, switching tabs, saving and closing a record must never re-run a list query.** Actions called from the dialog return the saved record and do **not** `revalidatePath` the list route.
- Row position and filter membership are re-evaluated only on the next navigation.
- Hiding a control is courtesy, not the boundary: every RPC re-checks its power in the database.
- `src/components/ui/` convention: named `export const`, `React.forwardRef`, `cn()` from `@/lib/utils`, a `.displayName` on every component, no default export.
- Commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:isolation`, `npm run test:e2e`, `npx supabase db reset`, `npx supabase test db`, `npm run build`.
- Local e2e note: run the suite against a production build (`CI=1 npx playwright test --workers=2`); invitation acceptance is rate-limited at 10/hour/IP, so `npx supabase db reset` before a repeat run.

## Two things this project keeps getting wrong

1. **A comment that describes a mechanism the code does not have** has shipped nine times. Treat any comment explaining why something is safe, correct or impossible as a claim to verify against the code.
2. **A test that cannot fail.** Five have shipped, the most recent in Block 3b — a keyset case whose mutation was never reached by the fixture it ran against. Before reporting, re-read each assertion and ask what would have to break for it to go red.

## File structure

| File | Responsibility |
| --- | --- |
| `src/components/ui/dialog.tsx` | Native `<dialog>` wrapper: open/close, ESC, backdrop click, focus return. Presentation only. |
| `src/components/ui/dropdown-menu.tsx` | The row action menu: keyboard, `aria-expanded`, dismiss on outside click. |
| `src/lib/record-params.ts` | Pure. Encode/parse `?record=&tab=`; merge into an existing query string. |
| `tests/unit/record-params.test.ts` | Round-trip, unknown tab, absent record, hostile input. |
| `src/lib/row-patch.ts` | Pure. Apply save / archive / erase / create to a row array and a total. |
| `tests/unit/row-patch.test.ts` | One case per operation, plus "position never moves". |
| `src/hooks/use-record-dialog.ts` | Client. Open/close/tab state, `pushState`/`replaceState`, `popstate`. |
| `src/app/(app)/members/member-record-dialog.tsx` | The audience record: five tabs, the forms that already exist. |
| `src/app/(app)/members/members-grid.tsx` | Client. Owns rows + total, renders the table, the action column, the host. |
| `src/app/(app)/members/record.ts` | Server action: read one whole record (identity, links, consents, notes, blocks). |
| `src/app/(app)/members/actions.ts` | Gains `updateMemberAction`, `archiveMemberAction`; dialog actions stop revalidating the list. |
| `src/app/(app)/inventory/*` | Same three files for prizes, plus `updatePrizeAction` / `archivePrizeAction`. |
| `src/app/(app)/roles/*`, `src/app/(app)/team/*`, `src/app/(admin)/admin/customers/*` | Same three files each, using the actions those screens already have. |
| `tests/e2e/record-dialog.spec.ts` | The block's proof: the list is never re-queried. Plus focus, ESC, Back, and `?record=` for an unreachable listener. |

---

### Task 1: The dialog primitive

**Files:**
- Create: `src/components/ui/dialog.tsx`

**Interfaces:**
- Produces: `Dialog` (`{ open, onClose, labelledBy, children }`), `DialogHeader`, `DialogTitle`, `DialogBody`, `DialogFooter`.

Built on the native `<dialog>`: `showModal()` gives focus trapping, ESC, the inert backdrop and the top layer without a line of our own. Three behaviours are ours and only three — dismiss on backdrop click, restoring focus to the opener, and routing ESC through `onClose` so the caller can guard unsaved edits.

- [ ] **Step 1: Write the primitive**

```tsx
// src/components/ui/dialog.tsx
'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A modal built on the native <dialog>. showModal() is what supplies focus
 * trapping, the inert backdrop, the top layer and ESC — none of which is
 * reimplemented here, because a hand-rolled focus trap is the part of a dialog
 * that rots first.
 *
 * Three behaviours ARE ours:
 *   - dismissing on a backdrop click, which the element does not do by itself;
 *   - returning focus to whatever opened it (the browser only does this when
 *     the dialog is closed by its own form method=dialog);
 *   - routing ESC through onClose rather than letting it close directly, so a
 *     caller holding unsaved edits can ask before discarding them.
 */
export const Dialog = React.forwardRef<
  HTMLDialogElement,
  {
    open: boolean;
    onClose: () => void;
    /** id of the element naming this dialog, for aria-labelledby. */
    labelledBy: string;
    className?: string;
    children: React.ReactNode;
  }
>(({ open, onClose, labelledBy, className, children }, forwardedRef) => {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useImperativeHandle(forwardedRef, () => ref.current as HTMLDialogElement);

  // The element that had focus when the dialog opened. The browser restores
  // focus only for its own dismissal paths, and every path here is ours.
  const opener = React.useRef<Element | null>(null);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) {
      opener.current = document.activeElement;
      node.showModal();
    }
    if (!open && node.open) {
      node.close();
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        // ESC. Prevented so the caller decides — it may need to confirm first.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click that lands on the dialog element itself, rather than on any
        // of its children, is a click on the backdrop.
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'w-full max-w-3xl rounded-lg border bg-background p-0 text-foreground shadow-lg',
        'backdrop:bg-black/50',
        // Full-height sheet on a narrow viewport, centred box above it.
        'max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none',
        className,
      )}
    >
      {/* Rendered only while open so its content never lingers in the DOM,
          and so each opening starts from a fresh mount. */}
      {open ? <div className="flex max-h-[85dvh] flex-col max-sm:max-h-none max-sm:h-full">{children}</div> : null}
    </dialog>
  );
});
Dialog.displayName = 'Dialog';

export const DialogHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-start justify-between gap-4 border-b px-5 py-4', className)}
      {...props}
    />
  ),
);
DialogHeader.displayName = 'DialogHeader';

export const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2 ref={ref} className={cn('text-lg font-semibold', className)} {...props} />
  ),
);
DialogTitle.displayName = 'DialogTitle';

/** The scrolling region. The header and footer stay put while this moves. */
export const DialogBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex-1 overflow-y-auto px-5 py-4', className)} {...props} />
  ),
);
DialogBody.displayName = 'DialogBody';

export const DialogFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3', className)}
      {...props}
    />
  ),
);
DialogFooter.displayName = 'DialogFooter';
```

- [ ] **Step 2: Verify it compiles and lints**

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/dialog.tsx
git commit -m "feat(ui): add the dialog primitive"
```

---

### Task 2: The row action menu

**Files:**
- Create: `src/components/ui/dropdown-menu.tsx`

**Interfaces:**
- Produces: `DropdownMenu` (`{ trigger, label, children }`), `DropdownMenuItem` (`{ onSelect, destructive?, children }`), `DropdownMenuSeparator`.

- [ ] **Step 1: Write the primitive**

```tsx
// src/components/ui/dropdown-menu.tsx
'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A small menu for the grid's row actions. Not a general menu system: one
 * trigger, a flat list of items, keyboard and dismissal handled correctly.
 *
 * `label` names the trigger for assistive technology — an icon-only button
 * says nothing without it, which was a review finding when this project's
 * table primitive shipped.
 */
export function DropdownMenu({
  trigger,
  label,
  children,
}: {
  trigger: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const container = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((was) => !was)}
        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          // Closing on the item's own activation lives here rather than in each
          // item, so a caller cannot forget it.
          onClick={() => setOpen(false)}
          className="absolute right-0 z-20 mt-1 min-w-56 rounded-md border bg-background py-1 shadow-lg"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function DropdownMenuItem({
  onSelect,
  destructive,
  children,
}: {
  onSelect: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        'block w-full px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        destructive && 'text-destructive',
      )}
    >
      {children}
    </button>
  );
}

export function DropdownMenuSeparator() {
  return <div role="separator" className="my-1 border-t" />;
}
```

- [ ] **Step 2: Verify it compiles and lints**

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/dropdown-menu.tsx
git commit -m "feat(ui): add the row action menu"
```

---

### Task 3: The record's place in the URL

**Files:**
- Create: `src/lib/record-params.ts`
- Test: `tests/unit/record-params.test.ts`

**Interfaces:**
- Produces: `parseRecordParam(raw: Record<string, string | undefined>, tabs: readonly string[]): { recordId: string | null; tab: string | null }`; `withRecord(currentSearch: string, recordId: string | null, tab: string | null): string`.

This is the only module that knows how a record's address is spelled. Everything else passes it around.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/record-params.test.ts
import { describe, expect, it } from 'vitest';
import { parseRecordParam, withRecord } from '@/lib/record-params';

const TABS = ['data', 'stations', 'consents'] as const;

describe('parseRecordParam', () => {
  it('reads a record and its tab', () => {
    expect(parseRecordParam({ record: 'abc', tab: 'consents' }, TABS)).toEqual({
      recordId: 'abc',
      tab: 'consents',
    });
  });

  it('falls back to the first tab when the tab is unknown', () => {
    expect(parseRecordParam({ record: 'abc', tab: 'nope' }, TABS)).toEqual({
      recordId: 'abc',
      tab: 'data',
    });
  });

  // Every value here arrives from a URL, so every value is hostile. None of
  // these may throw, and none may open a record.
  it.each([
    [{}, 'absent'],
    [{ record: '' }, 'empty'],
    [{ tab: 'consents' }, 'a tab with no record'],
  ])('returns no record for %s (%s)', (raw) => {
    expect(parseRecordParam(raw, TABS).recordId).toBeNull();
  });
});

describe('withRecord', () => {
  it('adds the record to an existing query without disturbing it', () => {
    expect(withRecord('q=ana&sort=name', 'abc', 'data')).toBe('q=ana&sort=name&record=abc&tab=data');
  });

  it('replaces a record already there rather than appending a second', () => {
    expect(withRecord('q=ana&record=old&tab=notes', 'new', 'data')).toBe(
      'q=ana&record=new&tab=data',
    );
  });

  it('removes both keys when the record closes, leaving the list state alone', () => {
    expect(withRecord('q=ana&record=abc&tab=notes', null, null)).toBe('q=ana');
  });

  it('omits the tab when it is the default, so a plain open stays a short URL', () => {
    expect(withRecord('', 'abc', null)).toBe('record=abc');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/record-params.test.ts`
Expected: FAIL — cannot resolve `@/lib/record-params`.

- [ ] **Step 3: Implement**

```ts
// src/lib/record-params.ts

/**
 * The address of an open record: `?record=<id>&tab=<slug>` alongside whatever
 * the list already has in its query string.
 *
 * It is a query parameter rather than a path segment because the list state —
 * filters, sort, cursor — has to survive underneath it unchanged: the record
 * opens OVER the list, and the URL says so.
 */

export interface RecordParam {
  recordId: string | null;
  tab: string | null;
}

/**
 * Hostile input throughout: an unknown tab falls back to the first rather than
 * rendering nothing, and a tab with no record is not a record. Nothing throws —
 * a URL somebody has been typing into is not an error page.
 */
export function parseRecordParam(
  raw: Record<string, string | undefined>,
  tabs: readonly string[],
): RecordParam {
  const recordId = raw.record?.trim() || null;
  if (!recordId) return { recordId: null, tab: null };
  const requested = raw.tab?.trim();
  const tab = requested && tabs.includes(requested) ? requested : (tabs[0] ?? null);
  return { recordId, tab };
}

/**
 * Rewrites the query string for an open (or closed) record, leaving every other
 * parameter exactly where it was. `URLSearchParams.set` replaces rather than
 * appends, which is what keeps a second record from accumulating in the URL.
 */
export function withRecord(
  currentSearch: string,
  recordId: string | null,
  tab: string | null,
): string {
  const query = new URLSearchParams(currentSearch);
  if (recordId) {
    query.set('record', recordId);
    if (tab) query.set('tab', tab);
    else query.delete('tab');
  } else {
    query.delete('record');
    query.delete('tab');
  }
  return query.toString();
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/unit/record-params.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove one assertion bites**

Make `withRecord` use `query.append` instead of `query.set`, re-run, and confirm the "replaces a record already there" case goes red. Restore with `;` and not `&&` — the runner exits non-zero on exactly the failure you are causing, so `run && git checkout` silently skips the restore. Verify with `git diff`. Record the output in your report.

- [ ] **Step 6: Commit**

```bash
git add src/lib/record-params.ts tests/unit/record-params.test.ts
git commit -m "feat(lib): add the record address helper"
```

---

### Task 4: The row patch

**Files:**
- Create: `src/lib/row-patch.ts`
- Test: `tests/unit/row-patch.test.ts`

**Interfaces:**
- Produces: `type RowPatch<T> = { kind: 'save'; row: T } | { kind: 'remove'; id: string } | { kind: 'create'; row: T }`; `applyRowPatch<T extends { id: string }>(state: { rows: T[]; total: number | null }, patch: RowPatch<T>): { rows: T[]; total: number | null }`.

The whole reason the list is never re-queried. Pure, so the rule "a saved row never moves" is provable without a browser.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/row-patch.test.ts
import { describe, expect, it } from 'vitest';
import { applyRowPatch } from '@/lib/row-patch';

const rows = [
  { id: 'a', name: 'Ana' },
  { id: 'b', name: 'Bruno' },
  { id: 'c', name: 'Carla' },
];
const state = { rows, total: 3 };

describe('applyRowPatch', () => {
  // The rule the whole pattern rests on: the operator's place in the list is
  // worth more than the list being re-sorted under them.
  it('a saved row keeps its position even when the new value would sort elsewhere', () => {
    const next = applyRowPatch(state, { kind: 'save', row: { id: 'a', name: 'Zoe' } });
    expect(next.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(next.rows[0]).toEqual({ id: 'a', name: 'Zoe' });
    expect(next.total).toBe(3);
  });

  it('saving a row that is not on this page changes nothing', () => {
    const next = applyRowPatch(state, { kind: 'save', row: { id: 'zz', name: 'Ghost' } });
    expect(next.rows).toEqual(rows);
    expect(next.total).toBe(3);
  });

  it('removing takes the row out and drops the total by one', () => {
    const next = applyRowPatch(state, { kind: 'remove', id: 'b' });
    expect(next.rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(next.total).toBe(2);
  });

  it('creating puts the row on top and raises the total by one', () => {
    const next = applyRowPatch(state, { kind: 'create', row: { id: 'd', name: 'Diego' } });
    expect(next.rows.map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(next.total).toBe(4);
  });

  // The audience screen shows no total under the consent filter (Block 3b), and
  // "no total" must survive every patch rather than becoming a number.
  it('leaves a null total null', () => {
    const next = applyRowPatch({ rows, total: null }, { kind: 'remove', id: 'a' });
    expect(next.total).toBeNull();
  });

  it('never mutates the array it was given', () => {
    applyRowPatch(state, { kind: 'remove', id: 'a' });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/row-patch.test.ts`
Expected: FAIL — cannot resolve `@/lib/row-patch`.

- [ ] **Step 3: Implement**

```ts
// src/lib/row-patch.ts

/**
 * How a grid changes when a record is saved, archived or created — without
 * re-running the query behind it.
 *
 * The rule that makes this small: a saved row is updated IN PLACE and never
 * moves, and a created row goes to the top regardless of the active sort.
 * Position and filter membership are re-evaluated only when the operator next
 * navigates. Re-sorting here would slide rows around under somebody who is
 * halfway through editing forty of them, which is exactly the experience this
 * whole block exists to protect.
 */

export type RowPatch<T> =
  | { kind: 'save'; row: T }
  | { kind: 'remove'; id: string }
  | { kind: 'create'; row: T };

export interface RowState<T> {
  rows: T[];
  /** null means "not counted" — the audience screen under its consent filter. */
  total: number | null;
}

export function applyRowPatch<T extends { id: string }>(
  state: RowState<T>,
  patch: RowPatch<T>,
): RowState<T> {
  switch (patch.kind) {
    case 'save': {
      const index = state.rows.findIndex((row) => row.id === patch.row.id);
      // A record can be saved while its row is not on the page at all — opened
      // from a pasted link, for instance. There is nothing to patch and nothing
      // to correct: the count did not change either.
      if (index === -1) return state;
      const rows = [...state.rows];
      rows[index] = patch.row;
      return { rows, total: state.total };
    }
    case 'remove': {
      const rows = state.rows.filter((row) => row.id !== patch.id);
      if (rows.length === state.rows.length) return state;
      return { rows, total: state.total === null ? null : state.total - 1 };
    }
    case 'create':
      return {
        rows: [patch.row, ...state.rows],
        total: state.total === null ? null : state.total + 1,
      };
  }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/unit/row-patch.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the position rule bites**

Re-sort inside the `save` branch (append the row instead of replacing in place), re-run, and confirm the first case goes red. Restore with `;`, verify with `git diff`, record the output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/row-patch.ts tests/unit/row-patch.test.ts
git commit -m "feat(lib): add the grid row patch"
```

---

### Task 5: The record dialog hook

**Files:**
- Create: `src/hooks/use-record-dialog.ts`

**Interfaces:**
- Consumes: `parseRecordParam`, `withRecord` (Task 3).
- Produces: `useRecordDialog(tabs: readonly string[], initial: { recordId: string | null; tab: string | null }): { recordId, tab, open(id, tab?), setTab(tab), close() }`.

Where the no-re-list guarantee is actually implemented. `history.pushState` updates the URL **without** telling the Next router, so no server render is requested; `useRouter().push` would request one and re-run the list query.

- [ ] **Step 1: Write the hook**

```ts
// src/hooks/use-record-dialog.ts
'use client';

import { useCallback, useEffect, useState } from 'react';
import { parseRecordParam, withRecord } from '@/lib/record-params';

/**
 * Owns which record is open and which tab, and keeps the URL in step WITHOUT
 * a server round trip.
 *
 * This is the block's central mechanism, so it is worth being explicit about
 * why it is written with the raw history API. `useRouter().push('?record=x')`
 * would ask Next for a new render of this route — which re-runs the list's
 * keyset query, rebuilds the grid and loses the operator's place. The native
 * history API changes the address bar and nothing else, which is the entire
 * requirement: the record opens OVER a list that never moves.
 *
 * The cost of that choice is that `useSearchParams()` will not see these
 * writes, so nothing may read the open record from there — this hook's state
 * is the single source of truth while the page is mounted, and the parsed URL
 * is the source only on first render.
 */
export function useRecordDialog(
  tabs: readonly string[],
  initial: { recordId: string | null; tab: string | null },
) {
  const [recordId, setRecordId] = useState(initial.recordId);
  const [tab, setTabState] = useState(initial.tab ?? tabs[0] ?? null);

  // Back and Forward. The browser has already changed the URL by the time this
  // fires, so the URL is what the state is reconciled against.
  useEffect(() => {
    function onPopState() {
      const raw = Object.fromEntries(new URLSearchParams(window.location.search));
      const next = parseRecordParam(raw, tabs);
      setRecordId(next.recordId);
      setTabState(next.tab ?? tabs[0] ?? null);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [tabs]);

  const open = useCallback(
    (id: string, nextTab?: string) => {
      const chosen = nextTab && tabs.includes(nextTab) ? nextTab : (tabs[0] ?? null);
      setRecordId(id);
      setTabState(chosen);
      const search = withRecord(window.location.search.replace(/^\?/, ''), id, chosen);
      window.history.pushState(null, '', search ? `?${search}` : window.location.pathname);
    },
    [tabs],
  );

  // replaceState, not pushState: otherwise Back walks backwards through every
  // tab the operator visited instead of closing the record, which is what they
  // mean by Back while a dialog is open.
  const setTab = useCallback((nextTab: string) => {
    setTabState(nextTab);
    const current = new URLSearchParams(window.location.search);
    const id = current.get('record');
    if (!id) return;
    const search = withRecord(window.location.search.replace(/^\?/, ''), id, nextTab);
    window.history.replaceState(null, '', search ? `?${search}` : window.location.pathname);
  }, []);

  // history.back() rather than a pushState of the closed URL, so closing does
  // not leave a forward-stack entry that re-opens the record on Forward.
  const close = useCallback(() => {
    setRecordId(null);
    if (new URLSearchParams(window.location.search).has('record')) window.history.back();
  }, []);

  return { recordId, tab, open, setTab, close };
}
```

- [ ] **Step 2: Verify it compiles and lints**

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-record-dialog.ts
git commit -m "feat(ui): add the record dialog hook"
```

---

### Task 6: The audience record — the read

**Files:**
- Create: `src/app/(app)/members/record.ts`
- Modify: `src/services/members.ts`

**Interfaces:**
- Produces: `getMemberRecordAction(memberId: string): Promise<MemberRecordResult>` where `type MemberRecordResult = { status: 'ok'; record: MemberRecord } | { status: 'not-found' } | { status: 'error'; message: string }` and `MemberRecord = { detail: MemberDetail; stations: MemberStationRow[]; consents: MemberConsentRow[]; notes: MemberNoteRow[]; blocks: MemberBlockRow[] }`.

One round trip for the whole record, not one per tab. `src/app/(app)/members/[memberId]/page.tsx` already performs exactly these reads — read it first and reuse the service functions it calls rather than writing new ones.

**`status: 'not-found'` collapses two facts on purpose**: the record does not exist, and the record is not reachable by this caller. RLS decides which rows exist; this action must not let the screen tell those apart, or `?record=<id>` becomes an oracle for ids.

- [ ] **Step 1: Write the action**

Follow `actions.ts`'s existing shape: `'use server'`, `requireAccessToken()`, errors through `describeMembersReadError`. Return the union above — never throw to the client, because the dialog renders the failure in place while the list behind it stays usable.

- [ ] **Step 2: Verify it compiles**

Run: `npm run lint && npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/members/record.ts"
git commit -m "feat(members): read one whole listener record"
```

---

### Task 7: The audience record — the dialog

**Files:**
- Create: `src/app/(app)/members/member-record-dialog.tsx`
- Modify: `src/app/(app)/members/actions.ts`

**Interfaces:**
- Consumes: `Dialog` (Task 1), `useRecordDialog` (Task 5), `getMemberRecordAction` (Task 6), and the existing `ConsentForm`, `BlockForm`, `EraseMemberForm`, `LiftBlockButton`.
- Produces: `MemberRecordDialog` (`{ recordId, tab, onTab, onClose, onSaved, onRemoved }`).

Five tabs: **Data · Stations · Consents · Notes · Blocks**. The four after the first render the forms that already exist, unchanged in behaviour.

- [ ] **Step 1: Add the two actions that have no interface today**

`updateMemberAction` (calls `updateMember`, gated in the database on `members.edit` via `member_reachable`) and `archiveMemberAction` (calls `archiveMember`, gated on `members.archive`). Both follow the `useActionState` shape the other actions use, and both **return the saved record** so the grid can patch its row.

**Neither calls `revalidatePath` for `/members`.** Add the comment saying why at the call site — this is the rule the whole block rests on, and the next person's instinct will be to add it back.

- [ ] **Step 2: Build the dialog**

The Data tab submits every field, because `update_member` replaces the record wholesale rather than merging. `first_contact_at` and `first_contact_origin` are **never** rendered as editable: they are write-once evidence behind the owner's first-contact-consent position. An erased listener (`anonymizedAt` set) renders the Data tab **read-only** — `update_member` refuses it anyway, and offering a form that will be refused is a lie in the shape of a button.

- [ ] **Step 3: Guard unsaved edits on close**

ESC and a backdrop click both route through `onClose`. If the Data tab is dirty, confirm before discarding.

- [ ] **Step 4: Gates and commit**

```bash
npm run lint && npm run typecheck && npm run build
git add "src/app/(app)/members/member-record-dialog.tsx" "src/app/(app)/members/actions.ts"
git commit -m "feat(members): the listener record as a dialog"
```

---

### Task 8: The audience grid

**Files:**
- Create: `src/app/(app)/members/members-grid.tsx`
- Modify: `src/app/(app)/members/page.tsx`

**Interfaces:**
- Consumes: `applyRowPatch` (Task 4), `useRecordDialog` (Task 5), `MemberRecordDialog` (Task 7), `DropdownMenu` (Task 2), the `Table` family (Block 3b).
- Produces: `MembersGrid` (`{ initialRows, initialTotal, state, cursors, powers, initialRecord }`).

The client component that owns rows and total, renders the table Block 3b built, and hosts the dialog. `page.tsx` keeps every read it has — it hands the first page to this component instead of rendering the table itself.

- [ ] **Step 1: Move the table markup into the grid component**

Keep `data-testid="member-row"`, the blocked badge, `aria-sort` on the sortable headers and the footer's `PageControls` exactly as they are. Add the pinned action column:

```tsx
<TableCell className="sticky right-0 bg-background">
  <div className="flex items-center justify-end gap-1">
    {powers.edit && (
      <button
        type="button"
        aria-label={`Edit ${displayName(member)}`}
        onClick={() => open(member.id)}
        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Pencil className="size-4" aria-hidden="true" />
      </button>
    )}
    {(powers.block || powers.archive || powers.erase) && (
      <DropdownMenu
        label={`Actions for ${displayName(member)}`}
        trigger={<MoreVertical className="size-4" aria-hidden="true" />}
      >
        {powers.block && <DropdownMenuItem onSelect={() => open(member.id, 'blocks')}>Block listener…</DropdownMenuItem>}
        {powers.archive && <DropdownMenuItem onSelect={() => setArchiving(member)}>Archive listener…</DropdownMenuItem>}
        {(powers.block || powers.archive) && powers.erase && <DropdownMenuSeparator />}
        {powers.erase && (
          <DropdownMenuItem destructive onSelect={() => open(member.id, 'data')}>
            Erase personal data…
          </DropdownMenuItem>
        )}
      </DropdownMenu>
    )}
  </div>
</TableCell>
```

- [ ] **Step 2: The archive confirmation**

A second, small dialog carrying the copy the owner approved, verbatim:

> **Archive this listener?**
> {name} leaves every list in the app. **This cannot be undone here** — not by you, not by support. Only direct database access can restore it.
> To bar someone from draws without archiving, use Block instead.

On confirmation: call `archiveMemberAction`, then `applyRowPatch({kind: 'remove'})`. The sentence about it being irreversible is **true** — `members_select_reachable` (0035) hides an archived row from every read — so do not soften it.

- [ ] **Step 3: Resolve the powers server-side and pass them down**

`page.tsx` resolves `members.edit`, `members.block`, `members.archive`, `members.erase` and `members.create` once, and passes them as `powers`. Courtesy, not the boundary: say so in a comment, because every RPC re-checks.

- [ ] **Step 4: The create button**

Beside the filters, labelled **Register listener**, rendered only with `members.create`. It opens the dialog in create mode, which keeps the existing two-step flow — the duplicate check first, the form second. That check is what keeps one person from existing twice in an Organization; it is not a step to drop because the form moved into a dialog. On success: `applyRowPatch({kind: 'create'})`.

- [ ] **Step 5: Gates and commit**

```bash
npm run lint && npm run typecheck && npm run build
git add "src/app/(app)/members"
git commit -m "feat(members): grid actions, create button and the record host"
```

---

### Task 9: Retire the listener route

**Files:**
- Delete: `src/app/(app)/members/[memberId]/`
- Modify: every file linking to it.

- [ ] **Step 1: Find every link**

Run: `grep -rn "members/\[memberId\]\|/members/\${" src tests`
Expected: the grid's name cell, `register-member-form.tsx`'s "View listener" link, and `revalidatePath` calls in `actions.ts`.

- [ ] **Step 2: Repoint them**

The name cell opens the dialog. "View listener" opens the newly created record in the dialog. Any `revalidatePath('/members/[memberId]')` goes: the route it names no longer exists.

- [ ] **Step 3: Gates and commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A src
git commit -m "refactor(members): retire the listener detail route"
```

---

### Task 10: Inventory

**Files:**
- Create: `src/app/(app)/inventory/prize-record-dialog.tsx`, `src/app/(app)/inventory/inventory-grid.tsx`, `src/app/(app)/inventory/record.ts`
- Modify: `src/app/(app)/inventory/page.tsx`, `src/app/(app)/inventory/actions.ts`
- Delete: `src/app/(app)/inventory/[prizeId]/`

Two tabs: **Prize data** (`update_prize`, gated on `inventory.catalogue`) and **Stock movements** (the entry, exit, adjustment, reserve and release forms that already exist, plus the movement history). Row menu: **Archive prize** (`archive_prize`, also `inventory.catalogue`), with the same irreversibility copy — `prizes_select_inventory_view` (0029) hides an archived prize from every read, exactly as the members policy does.

`update_prize` and `archive_prize` have no interface today; both need actions, and neither may revalidate the list route. `getInventoryPermissions` (`station-access.ts`) already resolves `catalogue`/`entry`/`exit`/`adjust`/`reserve` — use it rather than a second permission read.

Two creation buttons beside the filters, not a menu: **Register prize** and **Register category**.

- [ ] **Step 1: The record read, mirroring Task 6** — reuse `getPrizeById` and `getPrizeMovements`; `not-found` collapses "gone" and "not yours".
- [ ] **Step 2: The dialog and the two new actions.**
- [ ] **Step 3: The grid, the action column, the two create buttons.**
- [ ] **Step 4: Delete `[prizeId]/` and repoint its links.**
- [ ] **Step 5: Gates and commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A src
git commit -m "feat(inventory): the prize record as a dialog"
```

---

### Task 11: Roles, Team and Customers

**Files:**
- Create, per screen: `*-record-dialog.tsx`, `*-grid.tsx`
- Modify, per screen: `page.tsx`, `actions.ts`

Each screen keeps the actions it already has; none gains an RPC.

| Screen | Tabs | Editable | Row menu | Power |
| --- | --- | --- | --- | --- |
| Roles | Role data · Powers | yes (`saveRoleAction`) | Delete role (`deleteRoleAction`) | `roles.manage`, via `has_org_permission` |
| Team | Person · Per-Station access | **no** | Remove Station access · Remove from Organization · Revoke invitation | `users.manage`, `users.invite` |
| Customers | Customer · Stations · Owner | **no** | Suspend · Reactivate | platform admin |

**Team and Customers have no editable data tab, and that is a finding rather than an omission:** no migration defines `update_company` or a rename, and a person's profile belongs to that person. Their records open for inspection and for the operations beside them. The pencil is therefore an "open" affordance on those two screens — same icon, same place, no save button on the first tab.

The tabs carry operations, not only data: Customers' Stations tab is where `add_company` lives and its Owner tab where the provisional password is reissued; Team's access tab is where `assign_company_role` and `removeCompanyAccessAction` live.

The Team screen keeps its `deleted_at` filter and `TEAM_SAFETY_BOUND` from Block 3b, and still gets no pagination.

- [ ] **Step 1: Roles.** Grid, dialog, create button labelled **Create role**.
- [ ] **Step 2: Team.** Grid, dialog, create button labelled **Invite**.
- [ ] **Step 3: Customers.** Grid, dialog, create button labelled **Provision customer**. Keep `data-testid="company-row"`.
- [ ] **Step 4: Gates and commit**

```bash
npm run lint && npm run typecheck && npm run build
git add -A src
git commit -m "feat(admin): roles, team and customers on the record dialog"
```

---

### Task 12: The proof

**Files:**
- Create: `tests/e2e/record-dialog.spec.ts`
- Modify: `tests/e2e/members-flow.spec.ts`, `tests/e2e/inventory-flow.spec.ts`

**This is the block's proof.** The promise is negative — opening, editing and closing does **not** re-run the list — and a negative is verified by counting, not by looking.

- [ ] **Step 1: Count the list renders**

```ts
// Requests that would re-render the list: a document navigation to the list
// route, or an RSC payload fetch for it (Next marks those with the RSC header
// and an _rsc query parameter). The record read and the save itself are POSTs
// to the server-action endpoint and are expected — they are not counted.
const listRenders: string[] = [];
page.on('request', (request) => {
  const url = new URL(request.url());
  if (!url.pathname.startsWith('/members')) return;
  const isRsc = url.searchParams.has('_rsc') || request.headers()['rsc'] === '1';
  if (request.resourceType() === 'document' || isRsc) listRenders.push(request.url());
});

// …open a record, switch two tabs, save the identity, close, open the next…

expect(listRenders).toEqual([]);
```

- [ ] **Step 2: The rest of the journey assertions**

Focus returns to the pencil on close. ESC closes. Back closes the dialog and leaves the list on screen. A saved row shows the new value **in its original position**.

- [ ] **Step 3: The security case**

`?record=<id>` for a listener at a Station the caller cannot reach: the list renders, and the dialog shows one message covering both "no such record" and "not yours" — no name, no phone, nothing. This replaces the assertion that today navigates to `/members/[memberId]` and expects a redirect; the guarantee is the same, the shape is new.

- [ ] **Step 4: Prove the proof bites**

Put `revalidatePath('/members')` back into `updateMemberAction`, run Step 1's test, and confirm it goes red. **Restore with `;`, never `&&`**, and verify with `git diff` before continuing. Record the output verbatim in the report. This is the regression somebody will introduce three blocks from now out of habit, and this test is the only thing that will catch it.

- [ ] **Step 5: Rewrite the existing journeys**

They navigate to `/members/[memberId]` and click through cards that no longer exist. Rewritten, not loosened: every assertion they make today is still made, through the dialog.

- [ ] **Step 6: Run and commit**

```bash
npx supabase db reset && CI=1 npx playwright test --workers=2
git add tests/e2e
git commit -m "test(record-dialog): prove the list is never re-queried"
```

---

### Task 13: Isolation coverage and the block report

- [ ] **Step 1: Isolation tests** in `tests/isolation/record.test.ts`, every case driven by a non-owner delegate: the whole-record read is RLS-narrowed (a delegate at another Station gets nothing back for a listener they cannot reach); `update_member` through the new action path; `archive_member` through it. None of the three has coverage today.

- [ ] **Step 2: Every gate at real defaults**, output captured verbatim: `npm run lint`, `npm run typecheck`, `npm test`, `npx supabase db reset`, `npx supabase test db`, `npm run test:isolation`, `npm run build`, and `CI=1 npx playwright test --workers=2`.

- [ ] **Step 3: Verify by hand what no test covers** — the dialog on a narrow viewport, and focus behaviour in a real screen reader. Record what you saw, not what you expect.

- [ ] **Step 4: Write `docs/block-3c-report.md`** following `docs/block-3b-report.md`. It must carry: the mutation output proving the no-re-list test bites; that Team and Customers have read-only data tabs and why; that archiving is irreversible from the app on both members and prizes; and which assertions were shown to fail under mutation.

- [ ] **Step 5: Commit.** Do not push and do not open a PR — that is the owner's decision.

---

## Self-review

**Spec coverage.** §3 architecture → Tasks 1–5, 8. §3.1 the revalidatePath rule → Task 7 Step 1, enforced by Task 12. §3.3 primitives → Tasks 1, 2. §4 the open record → Tasks 5, 7. §5 grid after each operation → Task 4 (pure) and Task 8 (wiring). §6.1 action column → Task 8 Step 1. §6.2 powers → Task 8 Step 3, Task 11's table. §6.3 archive copy → Task 8 Step 2, Task 10. §6.4 create buttons → Task 8 Step 4, Tasks 10, 11. §7 five screens → Tasks 7–11. §8 out of scope → nothing built. §9 errors → Task 6 (the union), Task 7 Step 3, Task 12 Step 3. §10 accessibility → Tasks 1, 2, 12 Step 2, 13 Step 3. §11 testing → Tasks 3–4 (unit), 12 (e2e), 13 (isolation). §12 done → Task 13.

**Placeholders.** The shared and pure pieces carry their real code. Tasks 7–11 carry their file lists, interfaces, the exact tabs, actions and power codes, and the rules that are not obvious from the spec — the wholesale replace, the write-once fields, the read-only data tabs, the two create buttons. The repetitive JSX of five dialogs is deliberately not transcribed: it is the same table and dialog primitives with different fields, and the value in the plan is the per-screen differences, which are stated.

**Type consistency.** `RowPatch`/`applyRowPatch` (Task 4) are used with the same signature in Tasks 8, 10, 11. `parseRecordParam`/`withRecord` (Task 3) feed `useRecordDialog` (Task 5) with the same shapes. `MemberRecordResult`'s three-way union (Task 6) is what Task 7 renders and Task 12 Step 3 asserts against.
