import { MUSIC_MERGE_KINDS } from '@/schemas/music';
import type { MusicMergeKind } from '@/schemas/music';

/**
 * The Maintenance screen's URL contract, on the shape of ../songs/list-params.ts.
 *
 * Narrower than every other list contract in this codebase in one respect:
 * list_merge_candidates (0108) takes no cursor at all, only p_limit, so there is
 * no cursor type here — a candidate list is one capped page, not something to
 * page through. `kind` chooses which of the five short lists is being
 * deduplicated and `search` narrows it; nothing else belongs in this screen's
 * query.
 *
 * `maintenanceHref` below is Task 9's own addition to what Task 6 shipped: the
 * five kind tabs and the search box both rewrite this address, and a hand-rolled
 * query string at either call site is exactly the defect
 * docs/block-7a-report.md records against the Catalog screen's own tabs — a
 * link built field-by-field that drops one it forgot to repeat. One builder
 * that spreads the whole state, on the shape songHref/requestHref already use
 * for their own screens, is what a single caller cannot get wrong by omission.
 */

export interface MaintenanceSearchParams {
  companyId?: string;
  station?: string;
  kind?: string;
  q?: string;
}

export interface MaintenanceState {
  companyId: string;
  /** Carried by every link on the screen — see src/lib/station-switch.ts for what dropping it costs. */
  stationSearch?: string;
  kind: MusicMergeKind;
  search?: string;
}

/** The task brief's default for this contract; MUSIC_MERGE_KINDS[0]. */
export const DEFAULT_MAINTENANCE_KIND: MusicMergeKind = 'SONG';

/**
 * `companyId` is resolved by the page against the Stations the caller can
 * actually reach before it gets here, so this only carries it — a tampered
 * value falls back to the caller's first Station there, as it always has.
 *
 * `kind` is validated against MUSIC_MERGE_KINDS rather than cast: a tampered
 * or stale query value falls back to the default rather than throwing, the
 * same contract parseRecordParam (src/lib/record-params.ts) documents for
 * hostile URL input — a URL somebody has been typing into is not an error page.
 */
export function parseMaintenanceParams(
  raw: MaintenanceSearchParams,
  companyId: string,
): MaintenanceState {
  const requested = raw.kind?.trim();
  const kind =
    MUSIC_MERGE_KINDS.find((k) => k === requested) ?? DEFAULT_MAINTENANCE_KIND;

  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    kind,
    search: raw.q?.trim() || undefined,
  };
}

/**
 * Builds this screen's own address from state — the writer half of the
 * contract parseMaintenanceParams reads, on the shape songHref/requestHref
 * both use. Every link on this screen (the five kind tabs, the search box)
 * passes a full state object built by spreading the current one and
 * overriding only what changed, never assembled field-by-field at the call
 * site — see this file's own top comment for the defect that guards against.
 *
 * `kind` is omitted from the query when it is the default, the same
 * convention songHref uses for `sort`: a bookmarked or shared link for the
 * common case stays short.
 */
export function maintenanceHref(state: MaintenanceState): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.kind !== DEFAULT_MAINTENANCE_KIND) query.set('kind', state.kind);
  if (state.search) query.set('q', state.search);
  return `/music/maintenance?${query.toString()}`;
}
