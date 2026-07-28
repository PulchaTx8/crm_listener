'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Input, Select } from '@/components/ui/input';
import type { PrizeCategorySummary, PrizeSummary } from '@/services/inventory';
import { BalanceStats } from './balance-stats';
import { physicalTotal } from './format';

const ALL_CATEGORIES = 'all';
const UNCATEGORISED = 'uncategorised';

/**
 * The only client boundary this screen needs: search and the category filter
 * both act on data already loaded by the Server Component page, so filtering
 * happens against that in-memory list rather than a round trip. Everything
 * that does not need interactivity — the page header, the Station switcher,
 * the data fetch itself — stays server-rendered in page.tsx.
 */
export function InventoryBrowser({
  prizes,
  categories,
}: {
  prizes: PrizeSummary[];
  categories: PrizeCategorySummary[];
}) {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_CATEGORIES);

  const categoryNameById = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return prizes.filter((prize) => {
      if (categoryFilter === UNCATEGORISED) {
        if (prize.categoryId !== null) return false;
      } else if (categoryFilter !== ALL_CATEGORIES && prize.categoryId !== categoryFilter) {
        return false;
      }
      if (!term) return true;
      const nameMatch = prize.name.toLowerCase().includes(term);
      const codeMatch = prize.internalCode?.toLowerCase().includes(term) ?? false;
      return nameMatch || codeMatch;
    });
  }, [prizes, search, categoryFilter]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or code"
          aria-label="Search prizes by name or code"
          className="h-10 w-64"
        />
        <Select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filter by category"
          className="h-10 w-56"
        >
          <option value={ALL_CATEGORIES}>All categories</option>
          <option value={UNCATEGORISED}>Uncategorised</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </div>

      {prizes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No prizes are registered in this Station yet.
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No prize matches this search and filter.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((prize) => (
            <Link
              key={prize.id}
              href={`/inventory/${prize.id}`}
              data-testid="prize-row"
              className="flex flex-col gap-3 rounded-lg border p-4 transition-colors hover:bg-accent/40"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{prize.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {categoryNameById.get(prize.categoryId ?? '') ?? 'Uncategorised'}
                    {prize.internalCode ? ` · ${prize.internalCode}` : ''}
                  </span>
                </div>
                <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  {physicalTotal(prize.balance)} in stock
                </span>
              </div>

              <BalanceStats balance={prize.balance} compact />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
