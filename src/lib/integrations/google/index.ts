import 'server-only';
import { createGeocodeClient } from './client';
import { FakeGeocodeTransport, GEOCODE_FIXTURES } from './fake';
import type { GeocodeTransport } from './transport';

/**
 * Which transport the application uses, decided once — deezer/index.ts's shape,
 * with one difference that matters.
 *
 * `GOOGLE_FAKE=1` selects the fixture transport, opt-IN, so an unset variable is
 * always the real client and no deployment can silently serve fixtures.
 *
 * The difference from Deezer: this can also answer NULL. Deezer needs no
 * credential, so it always has a transport to return; geocoding needs a key, and
 * a deployment without one is a real, supported product state (design D6) rather
 * than a misconfiguration. Null means "the maps are off" and the drain skips its
 * whole batch without touching a row — which is why the caller must handle it
 * rather than this function throwing or, worse, quietly returning the fake.
 */
export function geocodeTransport(): GeocodeTransport | null {
  if (process.env.GOOGLE_FAKE === '1') return new FakeGeocodeTransport(GEOCODE_FIXTURES);

  const apiKey = process.env.GOOGLE_GEOCODING_KEY;
  if (!apiKey) return null;

  return createGeocodeClient({ apiKey });
}
