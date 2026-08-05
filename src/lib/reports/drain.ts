import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import { generateReportRun, type ClaimedRun } from './generate';

type ServiceClient = SupabaseClient<Database>;

export interface ReportDrainResult {
  requeued: number;
  claimed: number;
  ready: number;
  failed: number;
}

/**
 * Block 8b. The tick's third drain, beside the WhatsApp outbox and the storage
 * erasure queue.
 *
 * ONE RUN PER TICK. The tick's first duty is the outbox -- a listener waiting on
 * a reply -- and a forty-thousand-row workbook must not hold it for the ten
 * seconds until the next firing. A queue of reports drains one every ten
 * seconds, which is fast enough for a thing an operator is watching a spinner
 * for and slow enough never to matter to anything else.
 *
 * The stall requeue runs FIRST, and cheaply: a run left RUNNING by a container
 * that died would otherwise never be reclaimed, because the claim only ever
 * looks at QUEUED rows.
 */
export async function drainReportRuns(supabase: ServiceClient): Promise<ReportDrainResult> {
  const result: ReportDrainResult = { requeued: 0, claimed: 0, ready: 0, failed: 0 };

  const requeue = await supabase.rpc('requeue_stalled_report_runs');
  if (requeue.error) throw new Error(`requeue failed: ${requeue.error.message}`);
  result.requeued = requeue.data ?? 0;

  const claim = await supabase.rpc('claim_report_run');
  if (claim.error) throw new Error(`claim failed: ${claim.error.message}`);

  const rows = (claim.data ?? []) as unknown as ClaimedRun[];
  const run = rows[0];
  if (!run) return result;

  result.claimed = 1;

  try {
    const generated = await generateReportRun(supabase, run);
    const finish = await supabase.rpc('finish_report_run', {
      p_run_id: run.id,
      p_storage_path: generated.storagePath,
      p_row_count: generated.rowCount,
      p_byte_size: generated.byteSize,
      p_withheld: generated.withheld,
    });
    if (finish.error) throw new Error(`finish failed: ${finish.error.message}`);
    result.ready = 1;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unknown error';
    // fail_report_run decides between "back to the queue" and "give up", so
    // this does not need to know how many attempts are left. A failure to
    // RECORD the failure is rethrown: a run stuck RUNNING with nothing written
    // is the one state the stall sweep exists to clean up, and swallowing this
    // would hide why it keeps happening.
    const failed = await supabase.rpc('fail_report_run', {
      p_run_id: run.id,
      p_error: message,
    });
    if (failed.error) {
      throw new Error(`report ${run.id} failed (${message}); recording it also failed: ${failed.error.message}`);
    }
    result.failed = 1;
  }

  return result;
}
