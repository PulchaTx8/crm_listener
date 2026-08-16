import { describe, expect, it } from 'vitest';
import { createGeocodeClient } from '@/lib/integrations/google/client';
import { GeocodeUnavailableError } from '@/lib/integrations/google/transport';

/**
 * Block 28. The transport, against the four answers Google actually gives.
 *
 * GOOGLE REPORTS FAILURES WITH HTTP 200, exactly as Deezer does (Block 13a,
 * deezer/client.ts records that at length). `ZERO_RESULTS`, `OVER_QUERY_LIMIT`
 * and `REQUEST_DENIED` all arrive as a 200 with a `status` field in the body, so
 * code that branches on `response.ok` reads every one of them as a success and
 * carries an empty `results: []` forward as though it were a coordinate. Each
 * case below exists because that mistake has a different consequence.
 */
function respondWith(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const OK_BODY = {
  status: 'OK',
  results: [
    {
      geometry: { location: { lat: -2.5307, lng: -44.3068 } },
      types: ['neighborhood', 'political'],
    },
  ],
};

describe('the Google geocoding client', () => {
  it('reads a coordinate and its precision off a well-formed answer', async () => {
    const client = createGeocodeClient({ apiKey: 'k', fetchImpl: respondWith(OK_BODY) });
    const result = await client.lookup('Cohab, Sao Luis, MA, BR');
    expect(result).toEqual({ latitude: -2.5307, longitude: -44.3068, precision: 'neighbourhood' });
  });

  it('maps Google s own type vocabulary onto ours, including its American spelling', async () => {
    // Google says `neighborhood`; this product says `neighbourhood` everywhere
    // including the column name. The mapping is the only place the two spellings
    // are allowed to meet.
    const city = {
      status: 'OK',
      results: [{ geometry: { location: { lat: 1, lng: 2 } }, types: ['locality', 'political'] }],
    };
    const client = createGeocodeClient({ apiKey: 'k', fetchImpl: respondWith(city) });
    expect((await client.lookup('Sao Luis'))?.precision).toBe('city');
  });

  it('answers null for ZERO_RESULTS, because the place is real and Google simply does not know it', async () => {
    // NOT an error. A place nobody can geocode is a fact to record once, not a
    // reason to stop the batch — the drain marks it failed-and-done and moves
    // on to the next one.
    const client = createGeocodeClient({
      apiKey: 'k',
      fetchImpl: respondWith({ status: 'ZERO_RESULTS', results: [] }),
    });
    expect(await client.lookup('Nowhere at all')).toBeNull();
  });

  it('throws on OVER_QUERY_LIMIT, so the drain stops instead of burning the quota', async () => {
    // The opposite decision from ZERO_RESULTS above, and the reason the two are
    // told apart at all: treating a quota refusal as "no such place" would walk
    // the whole queue marking every real place unknown, and the rows would never
    // be retried because they would look decided.
    const client = createGeocodeClient({
      apiKey: 'k',
      fetchImpl: respondWith({ status: 'OVER_QUERY_LIMIT', error_message: 'quota' }),
    });
    await expect(client.lookup('Sao Luis')).rejects.toBeInstanceOf(GeocodeUnavailableError);
  });

  it('throws on REQUEST_DENIED, which is a misconfigured key and not a missing place', async () => {
    const client = createGeocodeClient({
      apiKey: 'k',
      fetchImpl: respondWith({ status: 'REQUEST_DENIED', error_message: 'referer blocked' }),
    });
    await expect(client.lookup('Sao Luis')).rejects.toBeInstanceOf(GeocodeUnavailableError);
  });

  it('throws on a malformed body rather than inventing a coordinate', async () => {
    // `status: 'OK'` with results that carry no geometry. Answering null here
    // would file a real place as unknown forever; answering 0,0 would put a
    // listener in the Gulf of Guinea.
    const client = createGeocodeClient({
      apiKey: 'k',
      fetchImpl: respondWith({ status: 'OK', results: [{ types: ['locality'] }] }),
    });
    await expect(client.lookup('Sao Luis')).rejects.toBeInstanceOf(GeocodeUnavailableError);
  });

  it('throws when the body is not JSON at all', async () => {
    const html = (async () =>
      new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch;
    const client = createGeocodeClient({ apiKey: 'k', fetchImpl: html });
    await expect(client.lookup('Sao Luis')).rejects.toBeInstanceOf(GeocodeUnavailableError);
  });

  it('refuses to ask about nothing, without spending a request on it', async () => {
    let called = 0;
    const counting = (async () => {
      called += 1;
      return new Response(JSON.stringify(OK_BODY), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createGeocodeClient({ apiKey: 'k', fetchImpl: counting });
    expect(await client.lookup('   ')).toBeNull();
    expect(called).toBe(0);
  });

  it('sends the key and the query, and asks for nothing else', async () => {
    let seen = '';
    const capturing = (async (url: string) => {
      seen = String(url);
      return new Response(JSON.stringify(OK_BODY), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createGeocodeClient({ apiKey: 'secret-key', fetchImpl: capturing });
    await client.lookup('Cohab, São Luís');
    expect(seen).toContain('key=secret-key');
    // Encoded, not raw: an address carries commas, spaces and accents, and a
    // query string assembled by hand is how one of them ends the URL early.
    expect(seen).toContain(encodeURIComponent('Cohab, São Luís'));
  });
});
