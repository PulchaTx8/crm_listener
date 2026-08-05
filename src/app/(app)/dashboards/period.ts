/**
 * The three dashboards' URL contract for a period, on the shape
 * `list-params.ts` uses everywhere else in this codebase — but pure,
 * unlike those: no import beyond types, so it needs no stub in
 * `vitest.config.ts` the way `server-only` does, and a Server Component,
 * a client control and a unit test can all call the same function.
 *
 * A period is `preset` plus, for `custom` only, a `from`/`to` pair — the
 * exact shape `resolve_dashboard_period` (0117) takes, and the reason this
 * exists at all: 0117 raises `22023` for an unknown preset or a reversed
 * range, which is the right refusal for a caller that already validated its
 * own input, and the wrong one for a URL somebody hand-edited. Catching both
 * here means a typo in an address bar renders `current_month` instead of an
 * error page.
 */

export type PeriodPreset = 'current_month' | 'previous_month' | 'current_year' | 'custom';

export interface PeriodSelection {
  preset: PeriodPreset;
  /** Set only when preset is 'custom' — null for every calendar preset, never a stale leftover value. */
  from: string | null;
  to: string | null;
}

const PERIOD_PRESETS: readonly PeriodPreset[] = [
  'current_month',
  'previous_month',
  'current_year',
  'custom',
];

const DEFAULT_SELECTION: PeriodSelection = { preset: 'current_month', from: null, to: null };

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date is accepted only if it is both well-formed AND real. `Date.parse`
 * (and the `Date` constructor) accept `2026-02-31` and roll it forward to
 * 3 March 2026 rather than refusing it — silently answering a different
 * question than the one the URL asked. Round-tripping the parsed instant
 * back through `toISOString` and comparing the leading ten characters
 * against the original string is what catches that: a real date round-trips
 * to itself, and an impossible one lands somewhere else.
 */
function isRealDate(value: string): boolean {
  if (!DATE_SHAPE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * Reads `preset`/`from`/`to` off a search-params object, falling back to
 * `current_month` for anything this cannot make sense of — an unknown
 * preset, a custom range missing either bound, a bound that is not a real
 * calendar date, or a range that ends before it starts. The fallback is
 * deliberately silent rather than an error page: a bookmarked or hand-edited
 * URL is not a fault, and the screen re-renders with a period that is at
 * least valid instead of nothing at all.
 */
export function parsePeriod(params: {
  preset?: string;
  from?: string;
  to?: string;
}): PeriodSelection {
  const preset = PERIOD_PRESETS.find((candidate) => candidate === params.preset);
  if (!preset) return DEFAULT_SELECTION;
  if (preset !== 'custom') return { preset, from: null, to: null };

  const { from, to } = params;
  if (!from || !to) return DEFAULT_SELECTION;
  if (!isRealDate(from) || !isRealDate(to)) return DEFAULT_SELECTION;
  // `>=`, not `>`. `to` is EXCLUSIVE, so `from === to` is a period of zero
  // length, and 0117:91 refuses it with 22023 (`p_to <= p_from`) exactly as it
  // refuses a reversed one. Under `>` this parser passed it through, the RPC
  // threw, and the operator got the whole page replaced by "That period is not
  // valid." — for a URL this file's own contract says it will silently repair.
  // The two comments claiming a 22023 can only come from a caller who bypassed
  // this (errors.ts and services/dashboards.ts) were false for precisely this
  // input; both now say so.
  if (from >= to) return DEFAULT_SELECTION;

  return { preset: 'custom', from, to };
}

/**
 * The two halves of the one conversion `period-control.tsx` needs, and the
 * reason this contract has an inside and an outside.
 *
 * Every bound in this block is half-open: `to` is EXCLUSIVE, which is what
 * 0040, `situationOf()` and `resolve_dashboard_period` all agree a period
 * means. A date input is not that. An operator asked for August types
 * `2026-08-01` and `2026-08-31`, and under a raw exclusive bound loses the
 * 31st from every figure on the page without one word on screen saying so —
 * the failure is silent, plausible, and off by exactly one day.
 *
 * So the CONTROL speaks the operator's language (an inclusive last day) and
 * converts at the edge, rather than the URL or the RPC changing meaning. The
 * round trip has to be stable and is: `resolved.to` 2026-09-01 seeds the input
 * as 2026-08-31, submitting sends 2026-09-01 back, and the next render seeds
 * 2026-08-31 again. Nothing drifts by a day in either direction.
 *
 * Both return the input unchanged if it is not a real calendar date, so a
 * hand-edited URL still reaches `parsePeriod`'s own repair rather than being
 * turned into a different wrong date here.
 */
function shiftDays(date: string, days: number): string {
  if (!isRealDate(date)) return date;
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** An exclusive `to` (what the URL and the RPC carry) as the last day it includes. */
export function inclusiveEnd(exclusiveTo: string): string {
  return shiftDays(exclusiveTo, -1);
}

/** An inclusive last day (what a person types) as the exclusive `to` everything else uses. */
export function exclusiveEnd(inclusiveTo: string): string {
  return shiftDays(inclusiveTo, 1);
}

/**
 * The writer half of the contract `parsePeriod` reads, on the shape
 * `maintenanceHref`/`inventoryHref` use for their own screens: every link
 * that changes the period (the four preset buttons, the two date inputs)
 * passes the full current selection plus the Station(s) already chosen,
 * never a single field patched onto whatever query string happens to be
 * on screen — the drift `station-switch.ts`'s own header describes for a
 * switcher link applies here too, one screen sooner.
 *
 * `current_month` is the default and is omitted from the query, the same
 * convention every other list contract in this codebase follows, so the
 * common case keeps a short, shareable address.
 *
 * A repeated `companyId` key carries every Station a consolidated view
 * named — `URLSearchParams.getAll('companyId')` reads it back, and a single
 * Station keeps the same one-`companyId` shape `station-switch.ts` already
 * uses everywhere else.
 */
export function periodHref(base: string, selection: PeriodSelection, companyIds: string[]): string {
  const query = new URLSearchParams();
  for (const companyId of companyIds) query.append('companyId', companyId);
  if (selection.preset !== DEFAULT_SELECTION.preset) query.set('preset', selection.preset);
  if (selection.preset === 'custom' && selection.from && selection.to) {
    query.set('from', selection.from);
    query.set('to', selection.to);
  }
  return `${base}?${query.toString()}`;
}

/**
 * Every link the three dashboard pages render — the four period presets, the
 * consolidated toggle, and each per-Station switch pill — changes the
 * Company or the period, exactly the class of link `../../lib/station-switch.ts`'s
 * own header says this codebase already got wrong five times over: a link
 * that drops the Station search term is indistinguishable, on the next
 * render, from one that was never searched at all. `listCompanyAccess` then
 * re-runs with no term, the capped alphabetical fifty stands in for it, and a
 * Station reachable only through the search box silently falls out of
 * `viewable` — so a page's own "stale companyId falls back to the first
 * Station" rule (necessary for a genuinely stale id) fires for the WRONG
 * reason and renders a different Station with nothing on screen saying so.
 *
 * `periodHref` above cannot carry `station` itself without widening a
 * contract Task 7 already shipped and tested; this sits beside it instead,
 * still free of any import beyond types, so the same Server Component/client
 * control/unit-test triangle this file's own header describes can all reach
 * it. A plain string append rather than a re-parse through URLSearchParams:
 * every caller here always supplies at least one companyId, so periodHref's
 * own query string is never empty and already carries a `?`.
 */
export function withStationSearch(href: string, stationSearch: string | undefined): string {
  return stationSearch ? `${href}&station=${encodeURIComponent(stationSearch)}` : href;
}
