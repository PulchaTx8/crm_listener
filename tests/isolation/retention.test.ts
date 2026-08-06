import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_DB_URL } from '../local-supabase';

/**
 * Block 11a. The retention sweep, CALLED.
 *
 * WHY THIS FILE EXISTS, and it is not a formality. `24_retention.test.sql`
 * asserts the procedure's SOURCE — the periods, the tables it must never name,
 * the absence of `security definer`. It cannot execute it: the sweep COMMITS,
 * and pgTAP runs every file inside a transaction it rolls back.
 *
 * So the first version of `sweep_retention` shipped with an `exception` handler
 * per table, and deleted NOTHING. A PL/pgSQL block with an `exception` clause
 * opens a subtransaction, and a COMMIT inside one raises `cannot commit while a
 * subtransaction is active` — every table, every night, logging a warning
 * nobody reads. **The pgTAP suite was green the whole time.**
 *
 * It was found by calling the thing. This file calls it on every run.
 *
 * IT CALLS THROUGH A DIRECT POSTGRES CONNECTION, not through PostgREST, and
 * that is forced rather than chosen: `sweep_retention` is a PROCEDURE, and
 * PostgREST exposes functions — `supabase.rpc('sweep_retention')` answers
 * PGRST202, "could not find the function". `pg_cron` issues `CALL` over a plain
 * connection, which is exactly what this does, so the test exercises the same
 * path production does.
 */
async function callSweep(): Promise<void> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    await client.query('call public.sweep_retention()');
  } finally {
    await client.end();
  }
}
const STAMP = Date.now();

describe('Block 11a — the retention sweep actually deletes', () => {
  let admin: SupabaseClient;
  const oldEmail = `retention-old-${STAMP}@example.test`;
  const freshEmail = `retention-fresh-${STAMP}@example.test`;

  beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { persistSession: false } },
    );

    // One row past its period and one inside it, in the same table, so the
    // assertion is about the BOUNDARY rather than about the delete running.
    const { error } = await admin.from('contact_requests').insert([
      {
        name: 'Old visitor',
        email: oldEmail,
        message: 'past the retention period',
        created_at: new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString(),
      },
      {
        name: 'Fresh visitor',
        email: freshEmail,
        message: 'inside the retention period',
        created_at: new Date().toISOString(),
      },
    ]);
    if (error) throw new Error(`could not seed contact_requests: ${error.message}`);
  }, 60_000);

  afterAll(async () => {
    await admin.from('contact_requests').delete().eq('email', freshEmail);
  }, 60_000);

  it('runs without raising, and removes what is past its period', async () => {
    // The call itself is the assertion the source-level tests cannot make. A
    // sweep that raises here is a sweep that deletes nothing in production --
    // which is precisely what the first version did.
    await expect(callSweep(), 'sweep_retention raised').resolves.toBeUndefined();

    const { data: gone } = await admin
      .from('contact_requests')
      .select('email')
      .eq('email', oldEmail);
    expect(gone ?? [], 'the row past its period survived the sweep').toHaveLength(0);
  }, 60_000);

  it('leaves a row inside its period alone', async () => {
    // The other half. A sweep that deleted everything would satisfy the
    // assertion above and be catastrophic.
    const { data: kept } = await admin
      .from('contact_requests')
      .select('email')
      .eq('email', freshEmail);
    expect(kept ?? [], 'the row inside its period was deleted').toHaveLength(1);
  }, 60_000);

  it('is idempotent — a second sweep changes nothing and still does not raise', async () => {
    // pg_cron runs this nightly for ever. A sweep that only works on a database
    // with something to delete is a sweep that fails on the first quiet night.
    await expect(callSweep(), 'a second sweep raised').resolves.toBeUndefined();

    const { data: kept } = await admin
      .from('contact_requests')
      .select('email')
      .eq('email', freshEmail);
    expect(kept ?? []).toHaveLength(1);
  }, 60_000);
});
