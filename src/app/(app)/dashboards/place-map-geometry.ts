/**
 * Block 28. The two decisions inside PlaceMap that are arithmetic rather than
 * browser, pulled out so they can be tested.
 *
 * The component itself cannot be: it needs a DOM, and this project installs no
 * jsdom — adding one to assert two formulas would be a dependency taken
 * sideways, the ruling 0137 already made about `unaccent`. What is worth proving
 * here is not that a div mounts; it is that a circle's size does not lie and
 * that a key reaches Google intact.
 */

const MAPS_JS = 'https://maps.googleapis.com/maps/api/js';

/** The smallest circle drawn, in metres — a place with one listener still has to be visible. */
const MIN_RADIUS_M = 400;
/** How much larger the busiest place gets. */
const SPAN_RADIUS_M = 2600;

/**
 * The radius, in metres, for a place holding `count` of a largest `largest`.
 *
 * THE SQUARE ROOT IS THE WHOLE POINT. A circle's area grows with the SQUARE of
 * its radius, so scaling the radius in proportion to the count makes a place
 * with ten times the listeners look a hundred times bigger. That is the single
 * most common way a proportional-symbol map lies, and it lies in the direction
 * that flatters whichever neighbourhood is already winning — which is exactly
 * the number a Station would spend money on.
 */
export function circleRadius(count: number, largest: number): number {
  // A largest of zero would be a map with no listeners on it, which the panel
  // refuses to render — but division by it here would produce NaN and a circle
  // Google silently drops, so the floor is cheaper than the debugging.
  const share = largest > 0 ? Math.max(0, count) / largest : 0;
  return MIN_RADIUS_M + SPAN_RADIUS_M * Math.sqrt(share);
}

/**
 * What to call a place — on the map's hover bubble and in the ranked tables
 * beneath it.
 *
 * ONE FUNCTION SO THE TWO CANNOT DRIFT. A neighbourhood titled one way on a
 * circle and another in the table under it reads as two different places, and
 * the whole point of the panel is that they are the same one.
 *
 * The folded key is the last resort rather than an empty string: 0214's
 * `member_place_key` is not pretty, but a bubble reading "12 listeners" over no
 * place at all leaves an operator unable to tell WHICH dot they are hovering —
 * which is the only question a hover answers. A blank counts as absent because a
 * geocoder answers both `null` and `''` for the same missing thing.
 */
export function placeName(place: {
  key: string;
  city: string | null;
  neighbourhood: string | null;
}): string {
  return place.neighbourhood?.trim() || place.city?.trim() || place.key;
}

/**
 * The global the Maps library calls once it is ready to be used.
 *
 * A GLOBAL BECAUSE GOOGLE'S CONTRACT SAYS SO — `callback` names a function on
 * `window`, and there is no version of this that takes a closure. Namespaced so
 * it cannot collide with anything else on the page.
 */
export const MAPS_READY_CALLBACK = '__pulchatxMapsReady';

/**
 * The script URL that loads the Maps library.
 *
 * `loading=async` AND `callback` TRAVEL TOGETHER, and separating them is what
 * broke the map in production on 2026-08-17. `loading=async` was added on its
 * own to silence a console warning, and it does more than that: it changes the
 * initialisation contract. Without it the bootstrap populates `google.maps`
 * before the script's own `load` event fires, so code that waits on `load` finds
 * the library there. WITH it, `load` fires first and `google.maps` is not
 * populated yet — so that same code concludes the library failed and says so.
 *
 * `callback` is the contract Google documents for the asynchronous form: it is
 * called when the library is genuinely usable. Whoever removes one of these two
 * must remove the other.
 *
 * The key is encoded rather than interpolated raw: a key carrying a stray
 * newline — which a pasted environment value does more often than anyone
 * expects — would otherwise end the URL early and be refused as a different key
 * entirely, with Google's own grey error card as the only clue.
 */
export function mapScriptUrl(apiKey: string): string {
  return `${MAPS_JS}?loading=async&callback=${MAPS_READY_CALLBACK}&key=${encodeURIComponent(apiKey)}`;
}
