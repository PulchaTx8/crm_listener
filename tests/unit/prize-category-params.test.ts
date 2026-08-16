import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIZE_CATEGORY_SORT,
  defaultDirectionFor,
  hasActivePrizeCategoryFilters,
  parsePrizeCategoryCursor,
  parsePrizeCategoryListState,
  prizeCategoryHref,
  prizeCategorySortHref,
  prizesInCategoryHref,
} from '@/app/(app)/inventory/categories/list-params';

/**
 * Block 26. The Categories screen's URL contract.
 *
 * Everything here is hostile input: these values arrive as query parameters, and
 * the Server Component that reads them, the filter bar that writes them and the
 * sort links that rewrite parts of them all have to agree about what they mean.
 */

const STATION = '11111111-1111-1111-1111-111111111111';
const CATEGORY = '22222222-2222-2222-2222-222222222222';

const base = () => parsePrizeCategoryListState({}, STATION);

describe('parsePrizeCategoryListState', () => {
  it('opens alphabetically, ascending', () => {
    expect(base()).toEqual({
      companyId: STATION,
      stationSearch: undefined,
      search: undefined,
      sort: 'name',
      direction: 'asc',
    });
    expect(DEFAULT_PRIZE_CATEGORY_SORT).toBe('name');
  });

  it('takes the only other sort it knows, newest first', () => {
    const state = parsePrizeCategoryListState({ sort: 'created' }, STATION);
    expect(state.sort).toBe('created');
    // Not merely the default direction: a list of when things were added is read
    // from the newest, and defaultDirectionFor is what says so.
    expect(state.direction).toBe('desc');
    expect(defaultDirectionFor('created')).toBe('desc');
  });

  it('falls back to the default sort rather than erroring on a nonsense one', () => {
    expect(parsePrizeCategoryListState({ sort: 'whatever' }, STATION).sort).toBe('name');
  });

  it('honours an explicit direction against the sort default', () => {
    expect(parsePrizeCategoryListState({ sort: 'name', dir: 'desc' }, STATION).direction).toBe('desc');
    expect(parsePrizeCategoryListState({ sort: 'created', dir: 'asc' }, STATION).direction).toBe('asc');
  });

  it('treats a blank search as no search at all', () => {
    expect(parsePrizeCategoryListState({ q: '   ' }, STATION).search).toBeUndefined();
    expect(parsePrizeCategoryListState({ q: '  camisetas ' }, STATION).search).toBe('camisetas');
  });

  it('ignores the companyId in the query, taking the one the page resolved', () => {
    // The page checks the requested Station against the ones the caller can
    // actually reach before calling this, so a tampered value never gets here.
    const state = parsePrizeCategoryListState({ companyId: 'not-a-station' }, STATION);
    expect(state.companyId).toBe(STATION);
  });
});

describe('parsePrizeCategoryCursor', () => {
  it('prefers walking back, so a Previous click cannot be read as a Next', () => {
    expect(parsePrizeCategoryCursor({ before: 'b', after: 'a' })).toEqual({
      side: 'before',
      value: 'b',
    });
  });

  it('is null when neither is present', () => {
    expect(parsePrizeCategoryCursor({})).toBeNull();
  });
});

describe('hasActivePrizeCategoryFilters', () => {
  it('is false for the opening view, true once a search narrows it', () => {
    expect(hasActivePrizeCategoryFilters(base())).toBe(false);
    expect(hasActivePrizeCategoryFilters({ ...base(), search: 'brindes' })).toBe(true);
  });

  it('does not count the Station, which is where the list looks rather than a filter over it', () => {
    expect(hasActivePrizeCategoryFilters({ ...base(), stationSearch: 'norte' })).toBe(false);
  });
});

describe('prizeCategoryHref', () => {
  it('writes only what differs from the opening view', () => {
    expect(prizeCategoryHref(base())).toBe(`/inventory/categories?companyId=${STATION}`);
  });

  it('carries the Station search, so a Station reachable only through it survives a click', () => {
    const href = prizeCategoryHref({ ...base(), stationSearch: 'norte' });
    expect(href).toContain('station=norte');
  });

  it('spells a non-default sort and direction, and nothing else', () => {
    const href = prizeCategoryHref({ ...base(), sort: 'created', direction: 'desc' });
    expect(href).toContain('sort=created');
    // `desc` IS the default for `created`, so writing it would be noise.
    expect(href).not.toContain('dir=');
  });

  it('drops the cursor when it is not given, which is how a filter change resets paging', () => {
    expect(prizeCategoryHref({ ...base(), search: 'x' })).not.toMatch(/after=|before=/);
    expect(prizeCategoryHref(base(), { side: 'after', value: 'CUR' })).toContain('after=CUR');
  });
});

describe('prizeCategorySortHref', () => {
  it('flips the column already sorted', () => {
    expect(prizeCategorySortHref(base(), 'name')).toContain('dir=desc');
  });

  it('starts another column from its own natural direction rather than inheriting one', () => {
    const href = prizeCategorySortHref(base(), 'created');
    expect(href).toContain('sort=created');
    expect(href).not.toContain('dir=');
  });
});

describe('prizesInCategoryHref', () => {
  it('sends the Prizes count to Stock, narrowed to that category', () => {
    const href = prizesInCategoryHref(base(), CATEGORY);
    expect(href).toBe(`/inventory?companyId=${STATION}&cat=${CATEGORY}`);
  });

  it('carries the Station search across, so the switcher does not collapse on the way', () => {
    expect(prizesInCategoryHref({ ...base(), stationSearch: 'norte' }, CATEGORY)).toContain(
      'station=norte',
    );
  });

  it('leaves this screen’s own search behind, which belongs to a different list', () => {
    expect(prizesInCategoryHref({ ...base(), search: 'camisetas' }, CATEGORY)).not.toContain('q=');
  });
});
