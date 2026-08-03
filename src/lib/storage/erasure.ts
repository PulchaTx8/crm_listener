import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';

/**
 * The half of an erasure that SQL cannot do.
 *
 * anonymize_member (0087) clears the reference and queues the object in the
 * same transaction; deleting the bytes needs the storage API, because removing
 * a row from storage.objects takes the metadata and leaves the file behind.
 * Until this runs, the promise is recorded and not kept.
 */

/** One tick's worth, so a large backlog cannot hold the worker tick open. */
const BATCH = 50;

export interface ErasureDrainResult {
  deleted: number;
  failed: number;
}

export async function drainStorageErasures(
  client: SupabaseClient<Database>,
): Promise<ErasureDrainResult> {
  const { data, error } = await client
    .from('storage_erasure_queue')
    .select('id, bucket, path, attempts')
    .is('processed_at', null)
    .order('enqueued_at')
    .limit(BATCH);

  if (error) throw new Error(`could not read the erasure queue: ${error.message}`);

  let deleted = 0;
  let failed = 0;

  for (const row of data ?? []) {
    const removal = await client.storage.from(row.bucket).remove([row.path]);

    if (removal.error) {
      failed += 1;
      // The row stays queued, with what went wrong on it, and is tried again on
      // the next tick. There is deliberately NO give-up threshold: an erasure
      // that quietly stopped trying is the one failure this whole mechanism
      // exists to prevent, and a queue that empties itself by forgetting is
      // indistinguishable from one that worked.
      await client
        .from('storage_erasure_queue')
        .update({ attempts: row.attempts + 1, last_error: removal.error.message })
        .eq('id', row.id);
      continue;
    }

    deleted += 1;
    await client
      .from('storage_erasure_queue')
      .update({ processed_at: new Date().toISOString(), last_error: null })
      .eq('id', row.id);
  }

  return { deleted, failed };
}
