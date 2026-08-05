import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StationPeriodNote } from '@/app/(app)/dashboards/station-period-note';
import type { Station } from '@/schemas/dashboards';

/**
 * The re-review named this gap directly: pgTAP and the isolation suite prove
 * the PAYLOAD carries each Station's own resolved `from`/`to` (D5 as amended
 * 2026-08-05); nothing proved the COMPONENT reads them and renders the right
 * branch. That branch is the whole reason D5's per-Station resolution exists
 * — a page that always printed the timezone sentence would be asserting a
 * uniformity a preset does not provide, which is exactly the bug the
 * whole-branch review's Important A1 found and this component was written to
 * fix (see station-period-note.tsx's own header).
 *
 * `renderToStaticMarkup` rather than a DOM render: vitest.config.ts runs unit
 * tests in the `node` environment with no DOM (the same reasoning
 * run-draw-dialog.test.ts gives for testing a pure function instead), but
 * `StationPeriodNote` takes no client-only hooks and nothing here needs an
 * event to fire — a static HTML string is enough to assert which branch fired
 * and what it named, without adding jsdom or a testing-library dependency for
 * one component.
 */

function station(overrides: Partial<Station> = {}): Station {
  return {
    id: '11111111-0000-0000-0000-000000000001',
    name: 'Station A',
    timezone: 'America/Sao_Paulo',
    from: '2026-08-01',
    to: '2026-09-01',
    ...overrides,
  };
}

describe('StationPeriodNote', () => {
  it('renders the mixed-period branch when the Stations resolved different windows, and names them', () => {
    const stations: Station[] = [
      station({ id: 'a', name: 'Station A', timezone: 'America/Sao_Paulo', from: '2026-08-01', to: '2026-09-01' }),
      // A different resolved window (a different calendar month), same shape
      // a preset produces at the turn of a month for two Stations far enough
      // apart in timezone (D5 as amended) — regardless of what timezone each
      // one is actually in, which is deliberately NOT what this branch keys
      // on.
      station({ id: 'b', name: 'Station B', timezone: 'America/New_York', from: '2026-07-01', to: '2026-08-01' }),
    ];

    const html = renderToStaticMarkup(createElement(StationPeriodNote, { stations }));

    expect(html).toContain('data-testid="mixed-period-note"');
    expect(html).not.toContain('data-testid="mixed-timezone-note"');
    expect(html).toContain('Station A');
    expect(html).toContain('Station B');
  });

  it('renders the mixed-timezone branch when the Stations share a window but not a timezone', () => {
    const stations: Station[] = [
      station({ id: 'a', name: 'Station A', timezone: 'America/Sao_Paulo', from: '2026-08-01', to: '2026-09-01' }),
      // Same resolved window as Station A -- a custom range, where D5 has
      // every Station convert the same literal dates at its own clock -- but
      // a different timezone.
      station({ id: 'b', name: 'Station B', timezone: 'America/New_York', from: '2026-08-01', to: '2026-09-01' }),
    ];

    const html = renderToStaticMarkup(createElement(StationPeriodNote, { stations }));

    expect(html).toContain('data-testid="mixed-timezone-note"');
    expect(html).not.toContain('data-testid="mixed-period-note"');
  });

  it('renders nothing when the Stations share both a window and a timezone', () => {
    const stations: Station[] = [
      station({ id: 'a', name: 'Station A' }),
      station({ id: 'b', name: 'Station B' }),
    ];

    const html = renderToStaticMarkup(createElement(StationPeriodNote, { stations }));

    expect(html).toBe('');
  });

  it('renders nothing for a single Station, which can never disagree with itself', () => {
    const html = renderToStaticMarkup(createElement(StationPeriodNote, { stations: [station()] }));

    expect(html).toBe('');
  });
});
