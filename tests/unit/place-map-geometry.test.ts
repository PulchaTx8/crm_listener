import { describe, expect, it } from 'vitest';
import {
  circleRadius,
  mapScriptUrl,
  placeName,
  MAPS_READY_CALLBACK,
} from '@/app/(app)/dashboards/place-map-geometry';

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

describe('placeName', () => {
  // What the hover bubble over a circle is titled, and what the ranked tables
  // already called the same place. One function so the two cannot drift: a
  // neighbourhood named one way on the map and another in the table under it
  // reads as two places.

  it('prefers the neighbourhood, which is the finest thing it knows', () => {
    expect(placeName({ key: 'br-sp-guarulhos-centro', city: 'Guarulhos', neighbourhood: 'Centro' })).toBe(
      'Centro',
    );
  });

  it('falls back to the city when the place was only resolved that far', () => {
    expect(placeName({ key: 'br-sp-guarulhos', city: 'Guarulhos', neighbourhood: null })).toBe(
      'Guarulhos',
    );
  });

  it('names the folded key rather than nothing when a place resolved to a country', () => {
    // 0214's member_place_key is not pretty, but a bubble reading "12 listeners"
    // over no place at all is worse: an operator cannot tell WHICH dot they are
    // hovering, which is the only question a hover answers.
    expect(placeName({ key: 'br', city: null, neighbourhood: null })).toBe('br');
  });

  it('treats a blank name as no name, because a geocoder answers both', () => {
    expect(placeName({ key: 'br-sp', city: '  ', neighbourhood: '' })).toBe('br-sp');
  });
});

describe('mapScriptUrl', () => {
  it('asks Google for the library with the key attached', () => {
    const url = mapScriptUrl('AIzaSyExample');
    expect(url.startsWith('https://maps.googleapis.com/maps/api/js?')).toBe(true);
    expect(url).toContain('key=AIzaSyExample');
  });

  it('carries loading=async AND the callback, because they are one contract', () => {
    // THE REGRESSION THIS FILE NOW HOLDS. `loading=async` was added on its own
    // to silence a console warning and it changed the initialisation contract:
    // without it the bootstrap populates `google.maps` before the script's own
    // `load` event fires; with it, `load` fires FIRST and the library is not
    // there yet. The loader still trusted `load`, found no library and told the
    // operator the map could not be loaded — on a correctly configured key.
    //
    // `callback` is the event that actually means ready. Whoever removes one of
    // these two must remove the other, and this assertion is what stops one
    // going without the other.
    const url = mapScriptUrl('k');
    expect(url).toContain('loading=async');
    expect(url).toContain(`callback=${MAPS_READY_CALLBACK}`);
  });

  it('names a callback that cannot collide with anything else on the page', () => {
    // Google's `callback` takes the NAME of a function on `window` — there is no
    // form of it that takes a closure — so the name is a global and has to look
    // like one.
    expect(MAPS_READY_CALLBACK).toMatch(/^__pulchatx/);
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
