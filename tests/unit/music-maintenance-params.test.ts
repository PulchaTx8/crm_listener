import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAINTENANCE_KIND,
  parseMaintenanceParams,
} from '@/app/(app)/music/maintenance/list-params';

const COMPANY = '00000000-0000-0000-0000-0000000000c1';

describe('parseMaintenanceParams', () => {
  it('defaults to SONG — where duplicates are found most often', () => {
    expect(parseMaintenanceParams({}, COMPANY).kind).toBe('SONG');
    expect(DEFAULT_MAINTENANCE_KIND).toBe('SONG');
  });

  it('reads every real kind off the URL', () => {
    for (const kind of ['SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW']) {
      expect(parseMaintenanceParams({ kind }, COMPANY).kind).toBe(kind);
    }
  });

  // Hostile input, the same contract parseRecordParam (src/lib/record-params.ts)
  // carries for its own: a hand-edited or stale `kind` falls back to the
  // default rather than throwing or being cast through unchecked.
  it('falls back to the default kind for an unrecognised value, rather than throwing', () => {
    expect(parseMaintenanceParams({ kind: 'NOT_A_REAL_KIND' }, COMPANY).kind).toBe(
      DEFAULT_MAINTENANCE_KIND,
    );
  });

  it('trims blank filters to undefined rather than keeping empty strings', () => {
    const state = parseMaintenanceParams({ station: '  ', q: '   ' }, COMPANY);
    expect(state.stationSearch).toBeUndefined();
    expect(state.search).toBeUndefined();
  });

  it('reads the Station search and the listener/name search', () => {
    const state = parseMaintenanceParams({ station: 'radio', q: 'elis' }, COMPANY);
    expect(state.stationSearch).toBe('radio');
    expect(state.search).toBe('elis');
  });

  it('carries the resolved companyId, not a value read off the URL', () => {
    expect(parseMaintenanceParams({ companyId: 'ignored' }, COMPANY).companyId).toBe(COMPANY);
  });
});
