/**
 * How many listeners the manual entry form's picker offers at once.
 *
 * Pure, and deliberately NOT in services/participations.ts, on exactly the
 * reasoning src/lib/linkable-prizes.ts carries for its own number: that module
 * is `server-only` and the form is a client component, which needs this figure
 * to say "showing the first twenty" truthfully. A value imported across that
 * line is a build error rather than a subtle one — @/lib/participation-status
 * exists for the same reason and states it at length.
 *
 * One number in one place rather than a copy in the sentence and another in the
 * query, which is how a screen comes to announce a cut at a figure the read no
 * longer makes. searchStationListeners asks for `PAGE_SIZE + 1` and spends that
 * extra row on `hasMore`: a Station whose search matches exactly twenty
 * listeners returns twenty and must not be told about a truncation that did not
 * happen.
 */
export const STATION_LISTENER_PAGE_SIZE = 20;
