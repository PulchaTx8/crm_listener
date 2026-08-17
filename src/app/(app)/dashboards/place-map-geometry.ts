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
 * The script URL that loads the Maps library.
 *
 * `loading=async` is Google's own current recommendation; without it the library
 * logs a performance warning, and that warning sits directly above the real
 * error in the console an operator is sent to read when a key is refused.
 *
 * The key is encoded rather than interpolated raw: a key carrying a stray
 * newline — which a pasted environment value does more often than anyone
 * expects — would otherwise end the URL early and be refused as a different key
 * entirely, with Google's own grey error card as the only clue.
 */
export function mapScriptUrl(apiKey: string): string {
  return `${MAPS_JS}?loading=async&key=${encodeURIComponent(apiKey)}`;
}
