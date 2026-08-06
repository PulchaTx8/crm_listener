import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Block 11b, D6. Reading the health of the scheduled routines, and remembering
 * who has already been told.
 *
 * Here rather than in the route so the route holds no query and this holds no
 * HTTP: the decision of WHETHER to send is the part worth testing, and it is
 * `shouldAlert` alone.
 */

/** How long an unfixed routine waits before it is mentioned again. */
export const ALERT_REMINDER_MS = 24 * 60 * 60 * 1000;

export type UnhealthyJob = {
  job_name: string;
  last_success_at: string | null;
  last_started_at: string | null;
  last_counters: Record<string, unknown> | null;
  alerted_at: string | null;
};

export async function findUnhealthyJobs(client: SupabaseClient): Promise<UnhealthyJob[]> {
  const { data, error } = await client.rpc('check_job_health');
  if (error) throw new Error(`could not read job health: ${error.message}`);
  return (data ?? []) as UnhealthyJob[];
}

export async function markJobAlerted(client: SupabaseClient, jobName: string): Promise<void> {
  const { error } = await client
    .from('job_health')
    .update({ alerted_at: new Date().toISOString() })
    .eq('job_name', jobName);
  if (error) throw new Error(`could not stamp the alert for ${jobName}: ${error.message}`);
}

/**
 * True when this incident has not been reported yet, or was reported a day ago
 * and is still not fixed. `alerted_at` is cleared by job_succeeded (0132), so
 * recovery -- not a timer -- is what re-arms the first branch.
 */
export function shouldAlert(job: UnhealthyJob, now: number): boolean {
  if (!job.alerted_at) return true;
  return now - Date.parse(job.alerted_at) >= ALERT_REMINDER_MS;
}

/**
 * What the operator reads at 04:30. It names the routine, when it last worked,
 * and what that run counted -- "it is broken" without "and here is what working
 * looked like" starts every investigation from zero.
 */
export function describeUnhealthyJob(job: UnhealthyJob): { subject: string; text: string } {
  return {
    subject: `[CRM] the scheduled routine ${job.job_name} has gone quiet`,
    text: [
      `The scheduled routine ${job.job_name} has not reported a success for longer than it is allowed to.`,
      '',
      `Last success: ${job.last_success_at ?? 'never'}`,
      `Last start:   ${job.last_started_at ?? 'never'}`,
      `That run counted: ${job.last_counters ? JSON.stringify(job.last_counters) : 'nothing recorded'}`,
      '',
      'A start later than a success means it began and did not finish.',
      'Silence in both means it never ran at all. Either way the reason is in:',
      '',
      '  select * from cron.job_run_details order by start_time desc limit 20;',
      '',
      'This message repeats once a day until the routine reports a success.',
    ].join('\n'),
  };
}
