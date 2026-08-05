'use server';

import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import { requestReport, signedUrlForRun } from '@/services/reports';
import { reportRequestSchema } from '@/schemas/reports';
import { createUserClient } from '@/lib/supabase/user-client';
import { ValidationError } from '@/lib/errors';

/**
 * Block 8b. The two things the screens ask for.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Set by downloadReport when the run is READY. */
  url?: string;
}

/**
 * Queue a report from whichever screen the operator was already filtering.
 *
 * The filters arrive as JSON rather than as form fields, because they are the
 * filters ALREADY on the screen -- re-expressing them as inputs would ask the
 * operator to state the question a second time, in a different vocabulary, and
 * the two would drift.
 */
export async function requestReportAction(formData: FormData): Promise<ActionResult> {
  const companyIds = String(formData.get('companyIds') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (companyIds.length === 0) {
    return { ok: false, error: 'Pick at least one Station before exporting.' };
  }

  let parsedFilters: unknown;
  try {
    parsedFilters = JSON.parse(String(formData.get('filters') ?? '{}'));
  } catch {
    return { ok: false, error: 'The filters on this screen could not be read.' };
  }

  const parsed = reportRequestSchema.safeParse({
    reportType: formData.get('reportType'),
    format: formData.get('format'),
    filters: parsedFilters,
  });

  if (!parsed.success) {
    // The first issue, in the operator's terms. A Zod tree here would be a wall
    // of text about a dialog with two controls.
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That report cannot be requested.' };
  }

  // Derived here, never sent by the client. 0127 checks that every named
  // Station belongs to the named Organization, so a tampered value would be
  // refused -- but the cleaner answer is not to accept one: the Station ids
  // are already the thing the caller must be entitled to, and the Organization
  // follows from them. The read goes through the user client, so RLS is what
  // resolves it: an id the caller cannot see resolves to nothing.
  let organizationId: string;
  try {
    organizationId = await organizationOf(companyIds);
  } catch (cause) {
    if (cause instanceof AppError) return { ok: false, error: cause.message };
    logger.error({ err: cause }, 'could not resolve the organization for a report request');
    return { ok: false, error: 'The report could not be queued. Try again.' };
  }

  try {
    await requestReport({ ...parsed.data, organizationId, companyIds });
  } catch (cause) {
    if (cause instanceof AppError) return { ok: false, error: cause.message };
    logger.error({ err: cause }, 'requestReportAction failed');
    return { ok: false, error: 'The report could not be queued. Try again.' };
  }

  revalidatePath('/reports');
  return { ok: true };
}

/**
 * The one Organization every named Station belongs to.
 *
 * Refusing a MIXED set rather than picking the first is the point. Nothing in
 * this product lets one person hold Stations in two Organizations, so a mixed
 * set is either a bug upstream or a tampered form -- and silently filing the
 * run under one of the two would produce a history row whose organization_id
 * contradicts its own company_ids, which no later reader could make sense of.
 */
async function organizationOf(companyIds: string[]): Promise<string> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('companies')
    .select('organization_id')
    .in('id', companyIds);

  if (error) throw new ValidationError('Those Stations could not be read.');

  const organizations = new Set((data ?? []).map((row) => row.organization_id));
  if (organizations.size !== 1 || (data ?? []).length !== companyIds.length) {
    throw new ValidationError('Those Stations are not all yours to export together.');
  }
  return [...organizations][0] as string;
}

/**
 * Mint the download URL at the moment of the click.
 *
 * NEVER stored and never rendered into the page: a signed URL in the HTML would
 * outlive the session in a browser cache, in a screenshot, and in whatever
 * copies the page. Sixty seconds, minted on demand.
 */
export async function downloadReportAction(runId: string): Promise<ActionResult> {
  try {
    const url = await signedUrlForRun(runId);
    if (!url) {
      return {
        ok: false,
        // The distinction matters to the operator: an expired report was
        // generated successfully and its file has since been erased, which is
        // a different thing from one that failed.
        error: 'That report has expired. Its file was erased after seven days — request it again.',
      };
    }
    return { ok: true, url };
  } catch (cause) {
    if (cause instanceof AppError) return { ok: false, error: cause.message };
    logger.error({ err: cause }, 'downloadReportAction failed');
    return { ok: false, error: 'The download link could not be created.' };
  }
}
