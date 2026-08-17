import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_SERVICE_ROLE_KEY, LOCAL_SUPABASE_URL } from '../local-supabase';
import type { Database } from '@/lib/supabase/database.types';
import { drainGeocodeQueue } from '@/services/places';
import { GeocodeUnavailableError } from '@/lib/integrations/google/transport';
import type { GeocodeResult, GeocodeTransport } from '@/lib/integrations/google/transport';
import { addCompany, cleanupUsers, createMemberAs, provisionCustomer, signInAs } from './harness';

afterAll(cleanupUsers);

/**
 * Block 28. The worker's fourth drain, against a live database.
 *
 * IT LIVES HERE AND NOT IN tests/unit BECAUSE THE QUEUE IS THE SUBJECT. Every
 * interesting thing this function does is a consequence of what it wrote, or did
 * not write, to `geocoded_places` — `resolved_at` set, `failed_at` set, or the
 * row left untouched for the next tick. A mocked supabase client would let each
 * of those be asserted against a call log rather than against a row, which is
 * the same shape of test that passes while the column stays null.
 *
 * `service_role`, deliberately and unusually for this directory: the drain IS
 * the worker, there is no user to check, and 0214 grants its three doors to that
 * role alone. What the other files here prove about RLS is not what this one is
 * about.
 */
const service = createClient<Database>(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const COORDINATE: GeocodeResult = {
  latitude: -2.5307,
  longitude: -44.3068,
  precision: 'neighbourhood',
};

/** A transport a test writes the script for. The one thing `geocodeTransport()` cannot produce. */
function scripted(answer: (query: string, nth: number) => GeocodeResult | null): GeocodeTransport {
  let nth = 0;
  return {
    async lookup(query: string) {
      nth += 1;
      return answer(query, nth);
    },
  };
}

/**
 * A Station with `count` listeners, each in a neighbourhood of their own, so
 * each becomes a distinct place. Returns the Station's id.
 */
async function seedPlaces(label: string, count: number): Promise<string> {
  const customer = await provisionCustomer(label);
  const companyId = await addCompany(customer, `Station ${label}`);
  const owner = await signInAs(customer.email, customer.password);

  for (let i = 1; i <= count; i += 1) {
    const memberId = await createMemberAs(customer, companyId, { fullName: `L${i} ${label}` });
    const { error } = await owner.rpc('update_member', {
      p_member_id: memberId,
      p_full_name: `L${i} ${label}`,
      p_city: `City ${label}`,
      p_state: 'MA',
      p_neighbourhood: `N${i} ${label}`,
      p_country: 'BR',
    });
    if (error) throw new Error(`update_member failed: ${error.message}`);
  }
  return companyId;
}

/** The queue rows for one Station's places, by the label baked into their names. */
async function placesFor(label: string) {
  const { data, error } = await service
    .from('geocoded_places')
    .select('place_key, resolved_at, failed_at, failure_reason, attempts, latitude')
    .like('city', `City ${label}`);
  if (error) throw new Error(`could not read places: ${error.message}`);
  return data ?? [];
}

describe('drainGeocodeQueue', () => {
  it('writes a coordinate for a place the provider knows', async () => {
    const label = `drain-ok-${Date.now()}`;
    await seedPlaces(label, 2);

    const result = await drainGeocodeQueue(service, {
      transport: scripted(() => COORDINATE),
    });

    expect(result.resolved).toBeGreaterThanOrEqual(2);
    expect(result.failed).toBe(0);

    const rows = await placesFor(label);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.resolved_at).not.toBeNull();
      // EXACTLY ONE OF THE TWO. record_place_geocode stamps them from the same
      // condition, so a row cannot be both resolved and failed — a state the
      // claim door would read as still queued and the aggregates as done.
      expect(row.failed_at).toBeNull();
      expect(Number(row.latitude)).toBeCloseTo(COORDINATE.latitude, 4);
    }
  });

  it('records a place the provider does not know as failed, once, rather than retrying it forever', async () => {
    const label = `drain-unknown-${Date.now()}`;
    await seedPlaces(label, 1);

    // null, NOT a throw: ZERO_RESULTS means the place is real and Google does
    // not know it. That is a verdict about the place, and a verdict is worth
    // recording once.
    const first = await drainGeocodeQueue(service, { transport: scripted(() => null) });
    expect(first.failed).toBeGreaterThanOrEqual(1);

    const rows = await placesFor(label);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.failed_at).not.toBeNull();
    expect(rows[0]!.resolved_at).toBeNull();
    expect(rows[0]!.failure_reason).toBe('no result');

    // AND IT IS NOT ASKED AGAIN on the next tick. claim_places_to_geocode holds
    // a failed row back for seven days, because ZERO_RESULTS today is
    // ZERO_RESULTS tomorrow unless somebody corrects the spelling behind it.
    let askedAgain = false;
    await drainGeocodeQueue(service, {
      transport: scripted((query) => {
        if (query.includes(label)) askedAgain = true;
        return null;
      }),
    });
    expect(askedAgain).toBe(false);
  });

  it('STOPS THE BATCH on a quota refusal instead of marking the rest unknown', async () => {
    // THE MOST CONSEQUENTIAL RULE IN THIS FILE. A refusal means we never got an
    // answer, and recording a verdict we did not get would mark every remaining
    // place unknown because the key ran out at row three — and they would never
    // be retried, because a failed row looks decided for seven days.
    const label = `drain-quota-${Date.now()}`;
    await seedPlaces(label, 4);

    const result = await drainGeocodeQueue(service, {
      transport: scripted((_query, nth) => {
        if (nth === 1) return COORDINATE;
        throw new GeocodeUnavailableError('OVER_QUERY_LIMIT');
      }),
    });

    // The one that answered before the refusal is kept — work already paid for
    // is not thrown away.
    expect(result.resolved).toBe(1);
    // And nothing is recorded as failed, which is the whole point.
    expect(result.failed).toBe(0);

    const rows = await placesFor(label);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.resolved_at !== null)).toHaveLength(1);
    expect(rows.filter((row) => row.failed_at !== null)).toHaveLength(0);

    // The three it never asked about are still claimable, so the next tick
    // finishes them.
    const second = await drainGeocodeQueue(service, { transport: scripted(() => COORDINATE) });
    expect(second.resolved).toBeGreaterThanOrEqual(3);
    expect((await placesFor(label)).filter((row) => row.resolved_at !== null)).toHaveLength(4);
  });

  it('claims nothing when there is no transport, and reports the backlog instead', async () => {
    const label = `drain-nokey-${Date.now()}`;
    await seedPlaces(label, 2);

    // Fill the queue without draining it.
    await drainGeocodeQueue(service, { transport: null });
    const before = await placesFor(label);
    expect(before).toHaveLength(2);

    const result = await drainGeocodeQueue(service, { transport: null });
    // The backlog is reported rather than hidden behind a zero that reads like
    // an empty queue.
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(result.resolved).toBe(0);

    // AND NOTHING WAS WRITTEN. `attempts` is the tell: the drain used to claim
    // before checking for a transport, which rewrote every queued row on every
    // tick of every deployment without a key — forever, since that is the state
    // a deployment is in until somebody buys one.
    const after = await placesFor(label);
    for (const row of after) {
      expect(row.attempts).toBe(0);
      expect(row.resolved_at).toBeNull();
      expect(row.failed_at).toBeNull();
    }
  });

  it('asks for a place the way the cache stored it, most specific part first', async () => {
    const label = `drain-query-${Date.now()}`;
    await seedPlaces(label, 1);

    const asked: string[] = [];
    await drainGeocodeQueue(service, {
      transport: scripted((query) => {
        asked.push(query);
        return COORDINATE;
      }),
    });

    // The one-line address `placeQuery` builds, from the RAW parts rather than
    // the folded key: Google reads accents and mixed case perfectly well, and
    // the fold exists to make two spellings one cache entry, not to make the
    // question worse.
    const mine = asked.find((query) => query.includes(label));
    expect(mine).toBe(`N1 ${label}, City ${label}, MA, BR`);
  });
});
