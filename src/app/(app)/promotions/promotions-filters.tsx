'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { RefreshButton } from '@/components/ui/refresh-button';
import type { PromotionSituation } from '@/lib/promotion-situation';
import { SITUATION_LABELS, SITUATION_ORDER } from './format';
import { hasActivePromotionFilters, promotionsHref } from './list-params';
import type { PromotionListState } from './list-params';
import { fromZonedDay, toZonedDate } from './zone';

const DEBOUNCE_MS = 350;
const ANY_SITUATION = '';

/**
 * These controls filter nothing themselves: they edit the URL, and the Server
 * Component asks Postgres a narrower question — the shape every list in this
 * codebase has used since Block 3b.
 *
 * Note there is no Situation SORT anywhere on this screen, only this filter.
 * Situation is computed from three columns, and a keyset cursor must compare
 * exactly the column it orders by; ordering by something computed pages
 * wrongly. Each option below maps to a predicate over those same three
 * columns, so the badge in the grid and the query behind it cannot disagree.
 */
export function PromotionsFilters({
  state,
  timeZone,
  canSeeArchived,
}: {
  state: PromotionListState;
  /** The Station's zone, so the day the operator picks is that Station's day. */
  timeZone: string;
  canSeeArchived: boolean;
}) {
  const t = useTranslations('promotions');
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');
  // Re-synced from the URL so browser back/forward leaves this input agreeing
  // with the list beside it; after this component's own edits the prop arrives
  // holding what was already typed, making the sync a no-op.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(next: Partial<PromotionListState>) {
    clearTimeout(timer.current);
    const typed: PromotionListState = { ...state, search: search.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal — the same cast the rest of this codebase uses.
    router.replace(promotionsHref({ ...typed, ...next }) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="promotions-filters">
      <label className="flex w-64 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('search')}</span>
        <Input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => navigate({}), DEBOUNCE_MS);
          }}
          placeholder={t('nameOrHashtag')}
          aria-label={t('searchPromotionsByNameOrHashtag')}
          data-testid="promotion-search-input"
        />
      </label>

      <label className="flex w-48 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('situation')}</span>
        <Select
          value={state.situation ?? ANY_SITUATION}
          onChange={(e) =>
            navigate({ situation: (e.target.value || undefined) as PromotionSituation | undefined })
          }
          data-testid="promotion-situation-filter"
        >
          <option value={ANY_SITUATION}>{t('anySituation')}</option>
          {SITUATION_ORDER.map((situation) => (
            <option key={situation} value={situation}>
              {SITUATION_LABELS[situation]}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex w-44 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('startingFrom')}</span>
        <Input
          type="date"
          value={toZonedDate(state.startsFrom, timeZone)}
          onChange={(e) => navigate({ startsFrom: fromZonedDay(e.target.value, timeZone, false) })}
          aria-label={t('showPromotionsStartingOnOrAfter')}
          data-testid="promotion-from-filter"
        />
      </label>

      <label className="flex w-44 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('startingUntil')}</span>
        <Input
          type="date"
          value={toZonedDate(state.startsTo, timeZone)}
          onChange={(e) => navigate({ startsTo: fromZonedDay(e.target.value, timeZone, true) })}
          aria-label={t('showPromotionsStartingOnOrBefore')}
          data-testid="promotion-to-filter"
        />
      </label>

      {/* Rendered only for the owner and the platform admin. For anybody else
          this control would do nothing at all: their reads never return an
          archived row, so ticking it would show the same list and read as a
          broken checkbox rather than as a permission they lack. */}
      {canSeeArchived && (
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={state.includeArchived}
            onChange={(e) => navigate({ includeArchived: e.target.checked })}
            data-testid="promotion-archived-filter"
            className="h-4 w-4 rounded border-input"
          />
          <span className="text-muted-foreground">{t('includeArchived')}</span>
        </label>
      )}

      {hasActivePromotionFilters(state) && (
        <Link
          href={
            promotionsHref({
              companyId: state.companyId,
              stationSearch: state.stationSearch,
              includeArchived: false,
              sort: state.sort,
              direction: state.direction,
            }) as Route
          }
          className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="promotion-clear-filters"
        >
          {t('clearFilters')}</Link>
      )}
      <RefreshButton />
    </div>
  );
}

// The date conversions live in ./zone, shared with the promotion form's own
// datetime fields: a second copy of a timezone rule is how two controls on one
// screen start disagreeing about which day a promotion starts.
