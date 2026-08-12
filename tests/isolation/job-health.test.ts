import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_DB_URL } from '../local-supabase';

/**
 * Block 11b. The stamping, CALLED.
 *
 * THE RULE BLOCK 11a PAID FOR: if a scheduled routine commits, write a test
 * that CALLS it. pgTAP cannot -- it wraps every file in a transaction it rolls
 * back, and a procedure that commits raises inside one, which is how the first
 * retention sweep shipped deleting nothing with 1375 green assertions.
 * PostgREST cannot either -- `supabase.rpc()` answers PGRST202 for a procedure.
 *
 * A direct Postgres connection can, and it is exactly what pg_cron uses.
 */
async function call(statement: string): Promise<void> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

describe('Block 11b — the scheduled routines report their own health', () => {
  let admin: SupabaseClient;

  beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { persistSession: false } },
    );
    // Backdated so a fresh stamp is unmistakably the routine's own work and not
    // the value 0132 seeded.
    await call(`update public.job_health set last_success_at = now() - interval '30 days'`);
  }, 60_000);

  it.each([
    ['call public.sweep_retention()', 'retention-sweep'],
    ['call public.run_pickup_deadline_sweep()', 'pickup-deadline-sweep'],
    ['call public.run_pickup_reminder_sweep()', 'pickup-reminder-sweep'],
    ['call public.run_expire_report_runs()', 'expire-report-runs'],
  ])('%s stamps %s', async (statement, job) => {
    // The call itself is the assertion no source-level test can make: a routine
    // that raises here is a routine that does nothing in production, nightly.
    await expect(call(statement), `${statement} raised`).resolves.toBeUndefined();

    const { data } = await admin
      .from('job_health')
      .select('last_success_at, last_started_at')
      .eq('job_name', job)
      .single();

    const success = Date.parse(data?.last_success_at ?? '');
    expect(success, `${job} recorded no success`).toBeGreaterThan(Date.now() - 120_000);
    expect(success, `${job} recorded a success before it started`).toBeGreaterThanOrEqual(
      Date.parse(data?.last_started_at ?? ''),
    );
  }, 60_000);

  it('the retention sweep records what it deleted, not just that it ran', async () => {
    // The complaint this block exists to answer: the counters went to a Postgres
    // log nobody reads, so a sweep failing for a month looked like one working.
    const { data } = await admin
      .from('job_health')
      .select('last_counters')
      .eq('job_name', 'retention-sweep')
      .single();

    const counters = (data?.last_counters ?? {}) as Record<string, number>;
    expect(Object.keys(counters).sort()).toEqual([
      'contact_requests',
      'outbox_messages',
      'rate_limit_counters',
      'storage_erasure_queue',
      'total',
      'webhook_events',
      'whatsapp_conversation_leases',
      'whatsapp_conversations',
      // Block 17a: 0161 extends sweep_retention with one more table -- see its
      // migration comment for why it reproduces this procedure's 0133 body
      // rather than its superseded 0131 one.
      // Block 19a, final review fix wave: 0183 extends it with a ninth --
      // widget_link_tokens -- and reproduces 0161's body for the identical
      // reason, extracted by script rather than reassembled from 0131.
      'widget_link_tokens',
      'widget_verifications',
    ]);
  }, 60_000);

  it('a routine that has just run is not reported as unhealthy', async () => {
    // The other half of check_job_health(): a check that reported everything
    // would satisfy every assertion above and be useless.
    const { data } = await admin.rpc('check_job_health');
    const quiet = (data ?? []).map((row: { job_name: string }) => row.job_name);
    expect(quiet).not.toContain('retention-sweep');
  }, 60_000);
});
