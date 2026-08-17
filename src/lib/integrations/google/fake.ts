import type { GeocodeResult, GeocodeTransport } from './transport';

/**
 * The fixture transport, selected by `GOOGLE_FAKE=1`.
 *
 * It exists for the end-to-end and isolation suites and for nothing else. A
 * Playwright journey that reached maps.googleapis.com would spend real quota on
 * every CI run, depend on a third party being up to go green, and bill the
 * account for a test — three ways for a suite to fail while the code is
 * correct.
 *
 * OPT-IN, never a fallback. WhatsApp's transport falls back to its fake when the
 * access token is missing, because there a missing token means "not
 * configured"; here a missing key means the maps are off (design D6) and the
 * panel says so, which is a real product state a fallback would hide. So an
 * unset variable is the real client and no deployment can end up serving
 * fixtures by accident.
 */
export class FakeGeocodeTransport implements GeocodeTransport {
  /** Every query this fake was asked, in order — what a test asserts against. */
  readonly asked: string[] = [];

  constructor(private readonly fixtures: Record<string, GeocodeResult>) {}

  async lookup(query: string): Promise<GeocodeResult | null> {
    const address = query.trim();
    if (!address) return null;
    this.asked.push(address);
    // Matched case-insensitively on the whole one-line address, because that is
    // what `placeQuery` builds and what the real client sends. An unknown
    // address answers null — the same "Google does not know this place" the real
    // one gives, so the drain's failed-and-done path is exercised too rather
    // than only its happy one.
    const found = Object.entries(this.fixtures).find(
      ([key]) => key.toLowerCase() === address.toLowerCase(),
    );
    return found ? found[1] : null;
  }
}

/**
 * Two real places in one Station's city and one in another, which is what the
 * geography journey needs: a map with more than one dot, and a second Station to
 * prove the aggregate does not reach into it.
 *
 * The coordinates are real. A made-up pair would still render, but a reviewer
 * checking the map against a real one is the cheapest test this block has.
 */
export const GEOCODE_FIXTURES: Record<string, GeocodeResult> = {
  'Cohab, São Luís, MA, BR': { latitude: -2.5307, longitude: -44.3068, precision: 'neighbourhood' },
  'Centro, São Luís, MA, BR': { latitude: -2.5297, longitude: -44.3028, precision: 'neighbourhood' },
  'São Luís, MA, BR': { latitude: -2.5297, longitude: -44.3028, precision: 'city' },
  'Centro, Santos, SP, BR': { latitude: -23.9608, longitude: -46.3336, precision: 'neighbourhood' },
  'Santos, SP, BR': { latitude: -23.9608, longitude: -46.3336, precision: 'city' },
};
