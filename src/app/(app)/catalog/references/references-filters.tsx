'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input } from '@/components/ui/input';
import { hasActiveReferenceFilters, referenceHref } from './list-params';
import type { ReferenceListState, ReferenceScreenCopy, ReferenceScreenKind } from './list-params';

/**
 * One filter — a name search — the same reasoning
 * music/artists/artists-filters.tsx gives for its own: a label or genre list
 * has nothing else to narrow by.
 *
 * UNLIKE ArtistsFilters, this is a plain `<form>` with an explicit submit
 * button (`references-search-submit`) rather than a debounced live search.
 * The e2e journey (tests/e2e/catalog-screens.spec.ts) drives it by typing and
 * clicking Search rather than waiting out a debounce timer, and a screen this
 * thin gains nothing from live search that a submit does not already give it.
 */
export function ReferencesFilters({
  kind,
  state,
  copy,
}: {
  kind: ReferenceScreenKind;
  state: ReferenceListState;
  copy: ReferenceScreenCopy;
}) {
  const t = useTranslations('music');
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');
  // Re-synced from the URL so browser back/forward leaves this input agreeing
  // with the list beside it; after this component's own edits the prop
  // arrives holding what was already typed, making the sync a no-op.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);

  function navigate(e: React.FormEvent) {
    e.preventDefault();
    const typed: ReferenceListState = { ...state, search: search.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal — the same cast the rest of this codebase uses.
    router.replace(referenceHref(kind, typed) as Route);
  }

  return (
    <form
      onSubmit={navigate}
      className="flex flex-wrap items-end gap-3"
      data-testid="references-filters"
    >
      <label className="flex w-64 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('search')}</span>
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={copy.searchPlaceholder}
          aria-label={copy.searchAriaLabel}
          data-testid="references-search"
        />
      </label>

      <button
        type="submit"
        className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        data-testid="references-search-submit"
      >
        {t('search')}
      </button>

      {hasActiveReferenceFilters(state) && (
        <Link
          href={
            referenceHref(kind, {
              companyId: state.companyId,
              stationSearch: state.stationSearch,
              direction: state.direction,
            }) as Route
          }
          className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="references-clear-filters"
        >
          {t('clearFilters')}
        </Link>
      )}
    </form>
  );
}
