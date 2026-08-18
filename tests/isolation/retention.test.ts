import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_DB_URL } from '../local-supabase';
import {
  cleanupUsers,
  createMemberAs,
  provisionCustomer,
  type ProvisionedCustomer,
} from './harness';

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

/**
 * Inserts an unsubscribe_tokens row directly, already 31 days past its own
 * expiry -- one day inside 0233's own window (`expires_at < now() - interval
 * '30 days'`), not merely expired, so this case cannot pass on a boundary
 * rounding error.
 *
 * A DIRECT INSERT rather than issue_unsubscribe_token: this case is about the
 * sweep, not about minting, and the table's own three foreign keys
 * (organization_id, company_id, member_id) are the only thing a caller needs
 * to satisfy -- the same shape harness.ts's own seedIntegration/
 * seedApiCredential use for tables no client can reach through the API. The
 * hash only needs to satisfy the column's own CHECK (`^[0-9a-f]{64}$`, 0232);
 * nothing here ever spends it.
 */
async function seedExpiredUnsubscribeToken(params: {
  organizationId: string;
  companyId: string;
  memberId: string;
}): Promise<string> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    const hash = createHash('sha256').update(`retention-fixture-${params.memberId}`).digest('hex');
    const result = await client.query<{ id: string }>(
      `insert into public.unsubscribe_tokens
         (organization_id, company_id, member_id, token_hash, expires_at)
       values ($1, $2, $3, $4, now() - interval '31 days')
       returning id`,
      [params.organizationId, params.companyId, params.memberId, hash],
    );
    return result.rows[0]!.id;
  } finally {
    await client.end();
  }
}

/**
 * Whether a given unsubscribe_tokens row still exists, read the same way
 * callSweep calls -- a direct connection, since the table carries no
 * PostgREST grant a test client could read through instead.
 */
async function unsubscribeTokenExists(tokenId: string): Promise<boolean> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    const result = await client.query('select 1 from public.unsubscribe_tokens where id = $1', [
      tokenId,
    ]);
    return (result.rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}

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

/**
 * Block 29c, Task 10 fix round 1, F27. The gap the task brief named and the
 * first pass at this task left open: `24_retention.test.sql` can only assert
 * the procedure's SOURCE contains a delete from unsubscribe_tokens
 * (`pg_get_functiondef(...) like '%delete from public.unsubscribe_tokens%'`),
 * which a commented-out delete satisfies just as well -- pg_get_functiondef
 * returns source INCLUDING comments. job_health.test.ts's own counter-key
 * check has the identical weakness one level up: 0233 builds its
 * jsonb_build_object entry unconditionally, so the key's PRESENCE says
 * nothing about whether the delete beneath it ran. Only calling the sweep and
 * reading the row back proves it, which is this describe block's only job.
 */
describe('Block 29c, Task 10 fix round 1, F27 — the sweep actually deletes an expired unsubscribe token', () => {
  let customer: ProvisionedCustomer;
  let tokenId: string;

  beforeAll(async () => {
    // Built the same way every isolation file builds a Station and listener
    // (tests/isolation/harness.ts) -- not reached across from
    // consent.test.ts's own fixtures, which are scoped to that file's own
    // describe blocks and are not reachable from here regardless.
    customer = await provisionCustomer(`retention-unsub-${STAMP}`);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: `Retention Sweep Listener ${STAMP}`,
    });
    tokenId = await seedExpiredUnsubscribeToken({
      organizationId: customer.organizationId,
      companyId: customer.companyId,
      memberId,
    });
  }, 60_000);

  afterAll(async () => {
    await cleanupUsers();
  }, 60_000);

  it('removes an unconsumed token 30 days past its own expiry', async () => {
    await expect(callSweep(), 'sweep_retention raised').resolves.toBeUndefined();
    expect(await unsubscribeTokenExists(tokenId), 'the expired token survived the sweep').toBe(false);
  }, 60_000);
});
