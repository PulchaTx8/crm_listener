import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import { geocodeTransport } from '@/lib/integrations/google';
import { GeocodeUnavailableError } from '@/lib/integrations/google/transport';
import type { GeocodeTransport } from '@/lib/integrations/google/transport';
import { placeQuery } from '@/lib/places/normalise';
import { logger } from '@/lib/logger';

export interface GeocodeDrainResult {
  resolved: number;
  failed: number;
  /**
   * Claimed but not asked about — either the whole batch, because no key is
   * configured, or a single row whose four parts were all blank. Kept separate
   * from `failed` so "the maps are off" never reads as "geocoding is broken" in
   * a tick's counters.
   */
  skipped: number;
}

/**
 * How many places one tick will pay for. pg_cron fires every ten seconds, so
 * this is a rate as much as a batch size: 25 per tick clears a Station's first
 * import in a few minutes and cannot run away.
 */
const BATCH = 25;

/**
 * The worker's fourth drain: turn queued places into coordinates.
 *
 * Called beside drainReportRuns in its own try/catch, for the reason that file
 * states twice — a listener waiting on a WhatsApp reply must not wait because a
 * third party's geocoder is slow, and a drain that throws must not lose the
 * counters of the three above it.
 *
 * IT STOPS THE WHOLE BATCH ON A QUOTA OR NETWORK REFUSAL rather than marking the
 * remaining rows failed. That is the entire reason GeocodeUnavailableError
 * exists separately from a null answer: a null means Google does not know this
 * place, which is a verdict; an error means we never got one, and recording a
 * verdict we did not get would mark a hundred real places unknown because the
 * key ran out at row three — and they would never be retried, because they would
 * look decided.
 */
export async function drainGeocodeQueue(
  supabase: SupabaseClient<Database>,
  options: {
    /**
     * The transport to drain with. OMITTED means "resolve it from the
     * environment", which is what the worker does; `null` means "there is
     * none", which is the state every deployment without a key is in.
     *
     * INJECTABLE BECAUSE THE RULE BELOW IS OTHERWISE UNPROVABLE. The single most
     * consequential behaviour in this file is that a quota refusal STOPS the
     * batch instead of marking the rest of it unknown — and `geocodeTransport()`
     * can only produce the real client or the fixture, neither of which can be
     * made to refuse. A seam whose whole purpose is testability that no test can
     * reach is a seam in name only.
     *
     * `!== undefined` rather than `??` on purpose: `null` is a meaningful value
     * here and `??` would treat it as "not supplied" and go to the environment.
     */
    transport?: GeocodeTransport | null;
  } = {},
): Promise<GeocodeDrainResult> {
  const transport = options.transport !== undefined ? options.transport : geocodeTransport();

  // FILL THE QUEUE BEFORE DRAINING IT. Nothing else in this system writes to
  // geocoded_places: a listener is registered, a conversation fills in a city,
  // and no trigger fires. A sweep rather than a trigger is 0214's own decision
  // — see enqueue_missing_places — and this is where it runs. Without this
  // call the queue is permanently empty and every map is blank with nothing
  // wrong anywhere.
  //
  // Unconditional, and before the transport check below: registering that a
  // place NEEDS a coordinate costs nothing and is worth doing even when no key
  // is configured, so that the day a key arrives the backlog is already there.
  const { error: enqueueError } = await supabase.rpc('enqueue_missing_places', { p_limit: 100 });
  // Logged, not thrown: a sweep that failed must not stop the drain from
  // finishing places already queued.
  if (enqueueError) {
    logger.error({ err: enqueueError }, 'could not enqueue missing places');
  }

  // CHECKED BEFORE THE CLAIM, and this was the other way round until it was
  // measured. Claiming first let the counters report the backlog through
  // `skipped` — which reads well — but `claim_places_to_geocode` is an UPDATE
  // that increments `attempts`, so on a deployment with no key (which is every
  // deployment until somebody buys one) it rewrote the same rows every ten
  // seconds, forever, and drove `attempts` up without bound on places nothing
  // had ever tried to geocode. The backlog is still reported, by a count that
  // takes no locks and writes nothing.
  if (!transport) {
    const { count, error: countError } = await supabase
      .from('geocoded_places')
      .select('id', { count: 'exact', head: true })
      .is('resolved_at', null);
    if (countError) {
      logger.error({ err: countError }, 'could not count the geocoding backlog');
    }
    return { resolved: 0, failed: 0, skipped: count ?? 0 };
  }

  const { data: claimed, error: claimError } = await supabase.rpc('claim_places_to_geocode', {
    p_limit: BATCH,
  });
  if (claimError) throw new Error(`could not claim places to geocode: ${claimError.message}`);

  const places = claimed ?? [];
  if (places.length === 0) return { resolved: 0, failed: 0, skipped: 0 };

  let resolved = 0;
  let failed = 0;
  let skipped = 0;

  for (const place of places) {
    const query = placeQuery({
      country: place.country,
      state: place.state,
      city: place.city,
      neighbourhood: place.neighbourhood,
    });

    // A row whose four parts were all blank. It cannot be asked about and will
    // never resolve, so it is recorded as failed-and-done rather than left to be
    // reclaimed every tick forever.
    if (!query) {
      await record(supabase, place.id, null, 'no place to look up');
      skipped += 1;
      continue;
    }

    let result;
    try {
      result = await transport.lookup(query);
    } catch (cause) {
      if (cause instanceof GeocodeUnavailableError) {
        // STOP. The rows behind this one keep their unresolved state and are
        // reclaimed next tick; only `attempts` moved, which is what makes a
        // repeatedly-refused batch visible.
        logger.warn(
          { err: cause, remaining: places.length - resolved - failed - skipped },
          'geocoding stopped early: the provider is unavailable',
        );
        break;
      }
      throw cause;
    }

    if (result) {
      await record(supabase, place.id, result, null);
      resolved += 1;
    } else {
      // Google answered and does not know this place. A verdict, recorded once.
      await record(supabase, place.id, null, 'no result');
      failed += 1;
    }
  }

  return { resolved, failed, skipped };
}

async function record(
  supabase: SupabaseClient<Database>,
  id: string,
  result: { latitude: number; longitude: number; precision: string } | null,
  reason: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('record_place_geocode', {
    p_id: id,
    p_latitude: result?.latitude,
    p_longitude: result?.longitude,
    p_precision: result?.precision,
    p_failure_reason: reason ?? undefined,
  });
  // Logged and swallowed rather than thrown: one row that could not be written
  // back must not discard the coordinates already paid for in this batch. The
  // row stays claimable and is retried.
  if (error) logger.error({ err: error, placeId: id }, 'could not record a place geocode');
}
