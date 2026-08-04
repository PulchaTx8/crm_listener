import { MUSIC_MERGE_KINDS } from '@/schemas/music';
import type { MusicMergeKind } from '@/schemas/music';

/**
 * The Maintenance screen's URL contract, on the shape of ../songs/list-params.ts.
 *
 * Narrower than every other list contract in this codebase: list_merge_candidates
 * (0108) takes no cursor at all, only p_limit, so there is no cursor type and no
 * href builder here — a candidate list is one capped page, not something to page
 * through. `kind` chooses which of the five short lists is being deduplicated and
 * `search` narrows it; nothing else belongs in this screen's query.
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
