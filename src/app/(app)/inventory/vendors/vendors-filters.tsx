'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { hasActiveVendorFilters, vendorHref } from './list-params';
import type { VendorListState } from './list-params';

const DEBOUNCE_MS = 350;
const ALL_CITIES = '';

/**
 * Block 24, item 7. The same shape ShowsFilters and InventoryFilters have: these
 * controls filter nothing themselves, they edit the URL, and the Server
 * Component asks Postgres a narrower question.
 *
 * THERE IS NO "SHOW ARCHIVED" BOX, and that is `0198`'s select policy rather
 * than a gap: it filters `deleted_at is null`, so an archived vendor is
 * unreadable through RLS for every caller and no filter here could bring one
 * back. The catalogue and inventory screens ship without one for the same
 * reason — `0099` records what that costs and why it is still right.
 */
export function VendorsFilters({
  state,
  cities,
}: {
  state: VendorListState;
  /** Every city this Station's suppliers are in, read whole so paging cannot change what the filter offers. */
  cities: string[];
}) {
  const t = useTranslations('vendors');
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');
  /**
   * The city, held here as well as in the URL. Bound straight to `state`, a
   * select reverts under the operator's hand while the navigation is in flight —
   * React re-asserts the old prop, and what they see is a control that refuses
   * to be changed. ShowsFilters carries the same note; Playwright measured it
   * there.
   */
  const [city, setCity] = useState(state.city ?? ALL_CITIES);

  // Re-synced from the URL so browser back/forward leaves these controls
  // agreeing with the list beside them; after this component's own edits the
  // props arrive holding what was already chosen, making the sync a no-op.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);
  useEffect(() => setCity(state.city ?? ALL_CITIES), [state.city]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(next: Partial<VendorListState>) {
    clearTimeout(timer.current);
    const typed: VendorListState = { ...state, search: search.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a route
    // literal — the same cast the rest of this codebase uses.
    router.replace(vendorHref({ ...typed, ...next }) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="vendors-filters">
      <label className="flex w-72 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('search')}</span>
        <Input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => navigate({}), DEBOUNCE_MS);
          }}
          placeholder={t('nameDocumentOrContact')}
          aria-label={t('searchVendors')}
          data-testid="vendors-search"
        />
      </label>

      {/* Offered only when there is something to choose between. A select with
          one option is a control that cannot narrow anything. */}
      {cities.length > 1 && (
        <label className="flex w-56 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('city')}</span>
          <Select
            value={city}
            onChange={(e) => {
              const chosen = e.target.value;
              setCity(chosen);
              navigate({ city: chosen || undefined });
            }}
            data-testid="vendors-city-filter"
          >
            <option value={ALL_CITIES}>{t('allCities')}</option>
            {cities.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </label>
      )}

      {hasActiveVendorFilters(state) && (
        <Link
          href={
            vendorHref({
              companyId: state.companyId,
              stationSearch: state.stationSearch,
              sort: state.sort,
              direction: state.direction,
            }) as Route
          }
          className="mb-1 rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="vendors-clear-filters"
        >
          {t('clearFilters')}
        </Link>
      )}
    </div>
  );
}
