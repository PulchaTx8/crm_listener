import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stationSwitchHref } from '@/lib/station-switch';

describe('stationSwitchHref', () => {
  it('carries the Station search alongside the Company so the next render can still see it', () => {
    expect(stationSwitchHref('/inventory', 'c-1', 'radio norte')).toEqual({
      pathname: '/inventory',
      query: { companyId: 'c-1', station: 'radio norte' },
    });
  });

  // The defect this whole module exists to prevent: a switcher link carrying
  // `companyId` alone. The next render calls listCompanyAccess with no search,
  // gets the capped alphabetical fifty back, fails to find the clicked Station
  // in it, and falls through to the page's own `?? first` — landing the
  // operator on a DIFFERENT Station with nothing on screen saying so.
  it('is the whole address, not just the Company', () => {
    expect(stationSwitchHref('/pickups', 'c-1', 'norte').query.station).toBe('norte');
  });

  // Absent, not present-and-empty: `?station=` would round-trip through the
  // page as a search for the empty string, which `params.station?.trim() ||
  // undefined` does collapse back to undefined today — but only because of
  // that `||`. Asserting the key's absence keeps this module honest on its
  // own rather than leaning on every caller's parser.
  it('omits the Station search entirely when there is none', () => {
    const href = stationSwitchHref('/promotions', 'c-1', undefined);
    expect(href.query).toEqual({ companyId: 'c-1' });
    expect('station' in href.query).toBe(false);
  });

  it('treats a blank search as no search', () => {
    expect('station' in stationSwitchHref('/promotions', 'c-1', '   ').query).toBe(false);
  });
});

/**
 * A source-shape test, on the precedent tests/unit/record-params.test.ts set
 * for the same class of rule: a fact about eight files that no single call can
 * observe.
 *
 * Everything above passes over a codebase where five of the eight switchers
 * never call this function — which is exactly the state Block 7a shipped and
 * named in docs/block-7a-report.md §7. The unit tests prove the helper is
 * right; only this proves it is USED. Written against the graph rather than a
 * list of eight paths so the ninth screen is covered the day it is written.
 */
describe('every screen with a Company switcher', () => {
  const APP_ROOT = fileURLToPath(new URL('../../src/app', import.meta.url));

  function pageFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return pageFiles(full);
      return entry === 'page.tsx' ? [full] : [];
    });
  }

  const switchers = pageFiles(APP_ROOT)
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => source.includes('viewable.map((company)'));

  // A floor rather than an exact count: adding a screen must not fail this
  // line, but a discovery that silently finds nothing must.
  it('is found by this guard', () => {
    expect(switchers.length).toBeGreaterThanOrEqual(8);
  });

  for (const { file, source } of switchers) {
    const screen = file.replace(/.*[\\/]src[\\/]/, 'src/').replace(/\\/g, '/');

    // Block 8a's three dashboard screens are the ninth, tenth and eleventh
    // switchers this guard was written to catch the day they were written
    // (this describe block's own header) — and they DON'T call
    // stationSwitchHref. They carry a period (preset/from/to) alongside the
    // Company, which stationSwitchHref's own query type deliberately has no
    // room for (`{ companyId: string; station?: string }`, station-switch.ts).
    // `app/(app)/dashboards/period.ts`'s own header explains the second
    // helper this forced: `withStationSearch`, built for the exact same
    // Server-Component/client-control/unit-test triangle, appending the same
    // `station` term the same way — carried by `periodHref`'s query instead
    // of stationSwitchHref's. Accepting either here is what keeps this guard
    // honest about its real rule ("some screen-search-carrying mechanism is
    // used", not "this one specific function is called") without weakening it
    // for the other eight screens, none of which import withStationSearch at
    // all.
    it(`${screen} builds the switcher link through stationSwitchHref (or, for a screen that also carries a period, period.ts's withStationSearch)`, () => {
      expect(source).toMatch(/stationSwitchHref\(|withStationSearch\(/);
    });

    // Belt and braces: a screen could call the helper for one link and still
    // hand-roll a second one beside it. `companyId:` appearing in an object
    // literal is how all eight spelled it before this module existed.
    it(`${screen} spells no switcher query by hand`, () => {
      expect(source).not.toMatch(/query:\s*\{[^}]*companyId/);
    });
  }
});
