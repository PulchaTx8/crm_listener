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
  if (from > to) return DEFAULT_SELECTION;

  return { preset: 'custom', from, to };
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
