/**
 * The address of a Station switch: `?companyId=<id>` and, when the operator
 * reached the current screen through the Station search box, the `?station=`
 * term that got them there.
 *
 * This is the only module that knows how a switcher link is spelled. Eight
 * screens render that switcher and every one of them used to spell it inline —
 * which is how five of them ended up spelling it WRONG.
 *
 * The defect, recorded in docs/block-7a-report.md §7 and cured here: a link
 * carrying `companyId` alone drops the Station search. On the next render the
 * page calls listCompanyAccess with no search term, gets back the capped
 * alphabetical fifty (COMPANY_SCAN_CAP, station-access.ts), and a Station
 * reachable ONLY through the search box is not in that list — so the page's own
 * `viewable.find((c) => c.id === params.companyId) ?? first` falls through to
 * `first` and renders a DIFFERENT Station's data, with nothing on screen saying
 * the Station changed. Silent, and identical on all five screens that had it.
 *
 * A shared function rather than the same three lines copied into five more
 * files: eight copies of one idea is the drift this codebase already warns
 * about in station-access.ts's own comment (two spellings of one shape that
 * disagree the next time either is fixed), and this defect IS that warning
 * coming true — Block 3b added the search, Block 7a fixed three switchers for
 * it, and five stayed on the old spelling for four blocks without anyone
 * noticing. It is also what makes the rule testable: a Server Component's JSX
 * is not reachable from vitest, but a pure function is.
 */

/**
 * A Next `UrlObject` narrow enough to say what a switcher link may contain —
 * a Company, and optionally a Station search. Nothing else belongs in a
 * switcher's query, and typing it loosely would let a caller quietly add to it.
 */
export interface StationSwitchHref {
  pathname: string;
  query: { companyId: string; station?: string };
}

/**
 * `station` is omitted rather than set to undefined or to '': the term is the
 * Station list's filter on the next render, and an empty one is not the same
 * request as an absent one. Trimmed here as well as at the parser, so the
 * absence holds even if a caller hands over whitespace it read from somewhere
 * else.
 */
export function stationSwitchHref(
  pathname: string,
  companyId: string,
  stationSearch: string | undefined,
): StationSwitchHref {
  const term = stationSearch?.trim();
  return {
    pathname,
    query: term ? { companyId, station: term } : { companyId },
  };
}
