/**
 * The seam the master spec means by a "decoupled" integration layer: a module
 * boundary, not a network hop — the same shape deezer/transport.ts and
 * whatsapp/transport.ts use, and for the same reason. It is what lets CI prove
 * the whole block with no network anywhere near it.
 */

/**
 * How precisely Google answered — the difference between "this is the
 * neighbourhood" and "this is roughly the city".
 *
 * It is stored and it is shown, because a dot placed at a city's centroid and a
 * dot placed on an actual neighbourhood look identical on a map and mean very
 * different things. Mapped from Google's `types` array on the top result, not
 * from `location_type`: the latter says how the coordinate was derived
 * (rooftop, interpolated) and this asks what was found.
 */
export type PlacePrecision = 'neighbourhood' | 'city' | 'region' | 'country';

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  precision: PlacePrecision;
}

export interface GeocodeTransport {
  /**
   * The coordinate for a one-line address, or `null` when there is genuinely no
   * answer.
   *
   * NULL IS NOT AN ERROR and the distinction is the whole contract. A place
   * Google does not know is a fact about the place — the drain records it as
   * failed-and-done and moves on. A quota refusal or a network failure THROWS,
   * so the drain stops rather than marking a hundred real places as unknown
   * because the key ran out at row three.
   */
  lookup(query: string): Promise<GeocodeResult | null>;
}

/**
 * Thrown for anything that means "ask again later" rather than "no such place".
 * The drain catches it, stops the batch, and leaves the rows unclaimed.
 */
export class GeocodeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocodeUnavailableError';
  }
}
