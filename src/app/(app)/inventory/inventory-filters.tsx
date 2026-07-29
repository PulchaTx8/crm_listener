'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { UNCATEGORISED_FILTER } from '@/schemas/inventory';
import type { PrizeCategorySummary } from '@/services/inventory';
import { hasActiveInventoryFilters, inventoryHref } from './list-params';
import type { InventoryListState } from './list-params';

const DEBOUNCE_MS = 350;
const ALL_CATEGORIES = '';

/**
 * Replaces InventoryBrowser, which filtered an already-fetched list in a
 * `useMemo` — the reason the screen loaded every prize in the Station and
 * stopped opening at ten thousand. These controls filter nothing themselves:
 * they edit the URL, and the Server Component asks Postgres a narrower
 * question.
 */
export function InventoryFilters({
  state,
  categories,
}: {
  state: InventoryListState;
  categories: PrizeCategorySummary[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');
  // Re-synced from the URL so browser back/forward leaves this input agreeing
  // with the list beside it; after this component's own edits the prop
  // arrives holding what was already typed, making the sync a no-op.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(next: Partial<InventoryListState>) {
    clearTimeout(timer.current);
    const typed: InventoryListState = { ...state, search: search.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal — the same cast the rest of this codebase uses.
    router.replace(inventoryHref({ ...typed, ...next }) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="inventory-filters">
      <label className="flex w-64 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Search</span>
        <Input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => navigate({}), DEBOUNCE_MS);
          }}
          placeholder="Name or code"
          aria-label="Search prizes by name or code"
          data-testid="prize-search-input"
        />
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Category</span>
        <Select
          value={state.categoryId ?? ALL_CATEGORIES}
          onChange={(e) => navigate({ categoryId: e.target.value || undefined })}
          data-testid="prize-category-filter"
        >
          <option value={ALL_CATEGORIES}>All categories</option>
          <option value={UNCATEGORISED_FILTER}>Uncategorised</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </label>

      {hasActiveInventoryFilters(state) && (
        <Link
          href={
            inventoryHref({
              companyId: state.companyId,
              stationSearch: state.stationSearch,
              sort: state.sort,
              direction: state.direction,
            }) as Route
          }
          className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="prize-clear-filters"
        >
          Clear filters
        </Link>
      )}
    </div>
  );
}
