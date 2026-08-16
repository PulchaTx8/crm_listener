'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input } from '@/components/ui/input';
import { hasActivePrizeCategoryFilters, prizeCategoryHref } from './list-params';
import type { PrizeCategoryListState } from './list-params';

const DEBOUNCE_MS = 350;

/**
 * Block 26. The same shape VendorsFilters and InventoryFilters have: this control
 * filters nothing itself, it edits the URL, and the Server Component asks
 * Postgres a narrower question.
 *
 * ONE BOX, because a category is a name. The Station switcher above it is the
 * screen's other axis and belongs to the page, not to this bar.
 *
 * THERE IS NO "SHOW ARCHIVED" BOX, and that is `0029`'s select policy rather than
 * a gap: it filters `deleted_at is null`, so an archived category is unreadable
 * through RLS for every caller and no filter here could bring one back.
 */
export function CategoriesFilters({ state }: { state: PrizeCategoryListState }) {
  const t = useTranslations('prizeCategories');
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');

  // Re-synced from the URL so browser back/forward leaves this input agreeing
  // with the list beside it; after this component's own edits the prop arrives
  // holding what was already typed, making the sync a no-op.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /**
   * THE TERM IS AN ARGUMENT, NOT A CLOSURE READ — the correction Block 24 made
   * for the vendors bar, kept here rather than re-inherited. Scheduling
   * `setTimeout(() => navigate({}), DEBOUNCE_MS)` from inside `onChange` captures
   * the `navigate` of the render it was created in, whose `search` still holds the
   * value from BEFORE the keystroke that scheduled it — so the address is always
   * one keystroke behind, and a test that fills the box in one event narrows
   * nothing at all. `vendors-filters.tsx` carries the full account.
   */
  function navigate(next: Partial<PrizeCategoryListState>, term: string = search) {
    clearTimeout(timer.current);
    const typed: PrizeCategoryListState = { ...state, search: term.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a route
    // literal — the same cast the rest of this codebase uses.
    router.replace(prizeCategoryHref({ ...typed, ...next }) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="categories-filters">
      <label className="flex w-72 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('search')}</span>
        <Input
          type="search"
          value={search}
          onChange={(e) => {
            const typed = e.target.value;
            setSearch(typed);
            clearTimeout(timer.current);
            // `typed`, not the state that is about to hold it: see navigate's own
            // comment for what reading the closure costs.
            timer.current = setTimeout(() => navigate({}, typed), DEBOUNCE_MS);
          }}
          placeholder={t('categoryName')}
          aria-label={t('searchCategories')}
          data-testid="categories-search"
        />
      </label>

      {hasActivePrizeCategoryFilters(state) && (
        <Link
          href={
            prizeCategoryHref({
              companyId: state.companyId,
              stationSearch: state.stationSearch,
              sort: state.sort,
              direction: state.direction,
            }) as Route
          }
          className="mb-1 rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="categories-clear-filters"
        >
          {t('clearFilters')}
        </Link>
      )}
    </div>
  );
}
