import { describe, expect, it } from 'vitest';
import { circleRadius, mapScriptUrl } from '@/app/(app)/dashboards/place-map-geometry';

describe('circleRadius', () => {
  it('scales by AREA, not by radius, so a busy place is not drawn as bigger than it is', () => {
    // THE ASSERTION THE WHOLE FUNCTION EXISTS FOR. Four times the listeners must
    // read as four times the ink — which means twice the radius, because a
    // circle's area grows with its square. Scaling the radius linearly instead
    // would draw that place with SIXTEEN times the area.
    const base = circleRadius(0, 16);
    const quarter = circleRadius(4, 16) - base;
    const full = circleRadius(16, 16) - base;
    expect(full / quarter).toBeCloseTo(2, 5);

    // Said again as areas, which is what an eye actually compares.
    const areaOf = (count: number) => Math.PI * (circleRadius(count, 16) - base) ** 2;
    expect(areaOf(16) / areaOf(4)).toBeCloseTo(4, 5);
  });

  it('gives a place with one listener a circle somebody can see', () => {
    // A dot of zero radius is a place that is on the map and invisible, which
    // reads as a place that is not there.
    expect(circleRadius(1, 10_000)).toBeGreaterThan(0);
  });

  it('keeps the busiest place bounded, so one neighbourhood cannot swallow the map', () => {
    expect(circleRadius(1_000_000, 1_000_000)).toBe(circleRadius(10, 10));
  });

  it('never answers NaN, whatever it is handed', () => {
    // A NaN radius is a circle Google drops in silence — the place vanishes from
    // the map with nothing anywhere to say why. `largest` is zero only on a map
    // the panel refuses to render, but the floor is cheaper than the debugging.
    for (const [count, largest] of [
      [0, 0],
      [5, 0],
      [-3, 10],
      [0, 10],
    ] as const) {
      expect(Number.isFinite(circleRadius(count, largest))).toBe(true);
    }
  });
});

describe('mapScriptUrl', () => {
  it('asks Google for the library with the key attached', () => {
    const url = mapScriptUrl('AIzaSyExample');
    expect(url.startsWith('https://maps.googleapis.com/maps/api/js?')).toBe(true);
    expect(url).toContain('key=AIzaSyExample');
  });

  it('carries loading=async, because its warning would sit above the error we send people to read', () => {
    expect(mapScriptUrl('k')).toContain('loading=async');
  });

  it('encodes a key that arrived with a stray newline instead of letting it end the URL', () => {
    // A pasted environment value keeps a trailing newline more often than anyone
    // expects. Raw, it would truncate the query string and Google would refuse a
    // key it never received — with its own grey card as the only clue. The panel
    // trims before it gets here; this is the second line of defence.
    const url = mapScriptUrl('AIzaSyExample\n');
    expect(url).not.toContain('\n');
    expect(url).toContain('AIzaSyExample%0A');
  });
});
