'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PrizeCategoryOption } from '@/services/inventory';

/**
 * Block 26. ONE list of categories for the whole Stock screen, held in the
 * browser so that a category registered inside the Register Prize dialog is
 * offered by the filter bar beside it without a reload.
 *
 * The obvious alternative is `router.refresh()`, and it is the one thing this
 * screen must not do: refreshing re-renders the route, which re-runs the prize
 * list's keyset query and rebuilds the grid from page one under whoever was
 * reading it. That rule is why `inventory/actions.ts` carries no
 * `revalidatePath` either, and why every write here patches a row instead.
 *
 * A context rather than a wrapper component threading props: the filter bar and
 * the grid are siblings under the page, and the only thing they share is this
 * list. Passing it down would mean re-declaring the grid's ten props on a
 * component whose whole job is one array.
 *
 * The provider is seeded from the server's own read and re-seeded whenever a
 * navigation hands down a new one — the same moment `InventoryGrid` re-seeds its
 * rows, and the moment the server list has caught up with anything added here.
 */
interface CategoryList {
  categories: PrizeCategoryOption[];
  /** Adds a just-registered category, in the name order the server read uses. */
  add: (category: PrizeCategoryOption) => void;
}

const CategoryListContext = createContext<CategoryList | null>(null);

export function CategoryListProvider({
  initial,
  children,
}: {
  initial: PrizeCategoryOption[];
  children: ReactNode;
}) {
  const [categories, setCategories] = useState(initial);

  useEffect(() => setCategories(initial), [initial]);

  const value = useMemo<CategoryList>(
    () => ({
      categories,
      add: (category) =>
        setCategories((current) =>
          // Guarded against a double-add: a second click while the first write is
          // in flight would otherwise put two options with the same key in the
          // select, which React renders and warns about.
          current.some((existing) => existing.id === category.id)
            ? current
            : [...current, category].sort((a, b) => a.name.localeCompare(b.name)),
        ),
    }),
    [categories],
  );

  return <CategoryListContext.Provider value={value}>{children}</CategoryListContext.Provider>;
}

/**
 * Throws rather than returning an empty list for a component rendered outside the
 * provider: a picker that silently offers nothing looks exactly like a Station
 * with no categories, which is the failure that would ship unnoticed.
 */
export function useCategoryList(): CategoryList {
  const value = useContext(CategoryListContext);
  if (!value) throw new Error('useCategoryList must be used inside CategoryListProvider');
  return value;
}
