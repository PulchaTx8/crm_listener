'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { SHOW_KINDS } from '@/schemas/shows';
import type { ShowKind } from '@/services/shows';
import { hasActiveShowFilters, showHref } from './list-params';
import type { ShowListState } from './list-params';

const DEBOUNCE_MS = 350;
const ALL_KINDS = '';

/**
 * Block 18. The same shape SongsFilters and InventoryFilters have: these
 * controls filter nothing themselves, they edit the URL, and the Server
 * Component asks Postgres a narrower question.
 *
 * It replaced a GET form with a Filter button. The button was not the problem —
 * a form posting to /shows loses every parameter it does not carry as a hidden
 * input, which is how a sort or a Station selection quietly disappears the first
 * time somebody types in the search box. `showHref` builds the whole address
 * from the state, so nothing can be dropped by omission.
 */
export function ShowsFilters({ state }: { state: ShowListState }) {
  const t = useTranslations('shows');
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');
  /**
   * The tick, held here as well as in the URL. Bound straight to `state`, the
   * box snaps back the moment it is clicked and stays back until the server
   * render lands — React re-asserts the old prop while the navigation is in
   * flight, so what the operator sees is a checkbox that refuses to be ticked.
   * Playwright measured exactly that: "clicking the checkbox did not change its
   * state".
   */
  const [includeEnded, setIncludeEnded] = useState(state.includeEnded);
  /** The kind, for the same reason: a select bound to the server's answer reverts under the operator's hand while the navigation is in flight. */
  const [kind, setKind] = useState<ShowKind | ''>(state.kind ?? ALL_KINDS);

  // Re-synced from the URL so browser back/forward leaves these controls
  // agreeing with the list beside them; after this component's own edits the
  // props arrive holding what was already chosen, making the sync a no-op.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);
  useEffect(() => setIncludeEnded(state.includeEnded), [state.includeEnded]);
  useEffect(() => setKind(state.kind ?? ALL_KINDS), [state.kind]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(next: Partial<ShowListState>) {
    clearTimeout(timer.current);
    const typed: ShowListState = { ...state, search: search.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a route
    // literal — the same cast the rest of this codebase uses.
    router.replace(showHref({ ...typed, ...next }) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="shows-filters">
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
          placeholder={t('theProgrammeName')}
          aria-label={t('searchProgrammesByName')}
          data-testid="shows-search"
        />
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('kind')}</span>
        <Select
          value={kind}
          onChange={(e) => {
            const chosen = (e.target.value || '') as ShowKind | '';
            setKind(chosen);
            navigate({ kind: chosen || undefined });
          }}
          data-testid="shows-kind-filter"
        >
          <option value={ALL_KINDS}>{t('allKinds')}</option>
          {SHOW_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`kind_${kind}`)}
            </option>
          ))}
        </Select>
      </label>

      {/* D8: an ended programme is archived rather than deleted, so it is hidden
          and reachable rather than gone. */}
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input
          type="checkbox"
          checked={includeEnded}
          onChange={(e) => {
            setIncludeEnded(e.target.checked);
            navigate({ includeEnded: e.target.checked });
          }}
          className="h-4 w-4 rounded border-input"
          data-testid="shows-include-ended"
        />
        <span>{t('showEndedProgrammes')}</span>
      </label>

      {hasActiveShowFilters(state) && (
        <Link
          href={
            showHref({
              companyId: state.companyId,
              stationSearch: state.stationSearch,
              includeEnded: false,
              sort: state.sort,
              direction: state.direction,
            }) as Route
          }
          className="mb-1 rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="shows-clear-filters"
        >
          {t('clearFilters')}
        </Link>
      )}
    </div>
  );
}
