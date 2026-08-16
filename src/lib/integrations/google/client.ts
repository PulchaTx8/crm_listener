import {
  GeocodeUnavailableError,
  type GeocodeResult,
  type GeocodeTransport,
  type PlacePrecision,
} from './transport';

/**
 * GOOGLE ANSWERS FAILURES WITH HTTP 200.
 *
 * `ZERO_RESULTS`, `OVER_QUERY_LIMIT`, `REQUEST_DENIED` and `INVALID_REQUEST` all
 * come back as a 200 carrying a `status` field, so `response.ok` is true for a
 * request that found nothing and for one that was refused outright. This is the
 * same trap Deezer set in Block 13a — deezer/client.ts records the measurement
 * that found it — and it was checked here before this file was written rather
 * than assumed to be different.
 *
 * So THE BODY IS INSPECTED BEFORE THE STATUS. The HTTP status is never consulted
 * at all: the one case it could describe on its own — an error page with no JSON
 * in it — already arrives here as a `.json()` throw.
 */

const BASE = 'https://maps.googleapis.com/maps/api/geocode/json';

/**
 * Google's own type vocabulary, narrowed to the four levels this product
 * distinguishes. Ordered most specific first and read off the top result's
 * `types` array — NOT off `location_type`, which answers a different question
 * (how the coordinate was derived: rooftop, interpolated, approximate).
 *
 * `neighborhood` is Google's American spelling; the column, the schema and every
 * other line in this codebase say `neighbourhood`. This map is the one place the
 * two are allowed to meet.
 */
const PRECISION_BY_TYPE: [string, PlacePrecision][] = [
  ['neighborhood', 'neighbourhood'],
  ['sublocality', 'neighbourhood'],
  ['locality', 'city'],
  ['administrative_area_level_2', 'city'],
  ['administrative_area_level_1', 'region'],
  ['country', 'country'],
];

function precisionFrom(types: unknown): PlacePrecision {
  const list = Array.isArray(types) ? types.map(String) : [];
  for (const [googleType, precision] of PRECISION_BY_TYPE) {
    if (list.includes(googleType)) return precision;
  }
  // Anything else Google can name — a postal code, a route, a point of
  // interest — is more specific than a city and is filed as such. `country` as
  // a default would understate every unrecognised answer, which is the
  // direction that puts a dot in the wrong place rather than a vaguer one.
  return 'city';
}

export function createGeocodeClient(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): GeocodeTransport {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async lookup(query: string): Promise<GeocodeResult | null> {
      const address = query.trim();
      // Asked about nothing, answer nothing — and spend no request doing it.
      // The queue can hold a row whose parts were all blank, and a request for
      // an empty address costs quota and returns ZERO_RESULTS anyway.
      if (!address) return null;

      const url = `${BASE}?address=${encodeURIComponent(address)}&key=${encodeURIComponent(options.apiKey)}`;

      let body: unknown;
      try {
        const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
        body = await response.json();
      } catch (cause) {
        // A refused connection, a DNS failure, a timeout — and a body that is
        // not JSON, which `.json()` throws on. All of them mean the same thing
        // to the drain: could not be reached, stop and try the next tick.
        throw new GeocodeUnavailableError(`geocoding request failed: ${String(cause)}`);
      }

      const status = readStatus(body);
      // ZERO_RESULTS is the ONLY status that is not an error. Every other
      // non-OK value — OVER_QUERY_LIMIT, REQUEST_DENIED, INVALID_REQUEST,
      // UNKNOWN_ERROR — means the question was not answered, and the drain must
      // stop rather than record a verdict it did not get. Listing them would be
      // a list to keep in step with Google's; refusing everything that is not
      // one of the two known answers needs no maintenance and fails safe when
      // they add a fifth.
      if (status === 'ZERO_RESULTS') return null;
      if (status !== 'OK') {
        throw new GeocodeUnavailableError(`geocoding answered ${status ?? 'an unreadable body'}`);
      }

      const top = readTopResult(body);
      if (!top) {
        // `OK` with nothing usable under it. Neither null nor a coordinate is
        // honest here: null would file a real place as unknown forever, and a
        // fabricated 0,0 would put a listener in the Gulf of Guinea.
        throw new GeocodeUnavailableError('geocoding answered OK with no usable result');
      }

      return top;
    },
  };
}

function readStatus(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('status' in body)) return null;
  const { status } = body as { status: unknown };
  return typeof status === 'string' ? status : null;
}

function readTopResult(body: unknown): GeocodeResult | null {
  if (typeof body !== 'object' || body === null || !('results' in body)) return null;
  const { results } = body as { results: unknown };
  if (!Array.isArray(results) || results.length === 0) return null;

  const first = results[0] as { geometry?: { location?: { lat?: unknown; lng?: unknown } }; types?: unknown };
  const lat = first?.geometry?.location?.lat;
  const lng = first?.geometry?.location?.lng;
  // `Number.isFinite` and not `typeof === 'number'`: NaN is a number, and a NaN
  // latitude would pass a type check and fail the column's own bounds later,
  // somewhere with no context.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    latitude: lat as number,
    longitude: lng as number,
    precision: precisionFrom(first.types),
  };
}
