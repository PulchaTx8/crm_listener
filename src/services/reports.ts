import 'server-only';
import { createUserClient } from '@/lib/supabase/user-client';
import { createServiceClient } from '@/lib/supabase/service-client';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import {
  InternalError,
  NotFoundError,
  RateLimitError,
  UnauthenticatedError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import {
  REPORT_RUN_COLUMNS,
  reportRunSchema,
  type ReportRequest,
  type ReportRun,
} from '@/schemas/reports';
import { isPanelType } from '@/lib/reports/types';
import { REPORT_BUCKET } from '@/lib/reports/generate';
import {
  getAudienceDashboard,
  getMusicDashboard,
  getPromotionsDashboard,
} from '@/services/dashboards';
import type { PeriodSelection } from '@/app/(app)/dashboards/period';

/**
 * Block 8b. The caller side of the report engine.
 *
 * The error taxonomy is services/dashboards.ts's, unchanged: 42501 is a
 * refusal, 22023 is a bad request, and everything else is OURS -- labelling an
 * unexpected database fault a refusal would hide a real defect behind a
 * plausible message.
 */
function mapReportError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === '22023') return new ValidationError(message);
  return new InternalError(message);
}

/** Twenty reports an hour, per user. */
const REPORTS_PER_HOUR = 20;
const RATE_WINDOW_SECONDS = 3600;

/** How long a download link lives. Long enough to click, short enough to leak harmlessly. */
const SIGNED_URL_SECONDS = 60;

/**
 * An intersection, not an `extends`: ReportRequest is a discriminated union, and
 * an interface cannot extend one. The intersection keeps the discrimination
 * working, so `reportType: 'LISTENERS'` still narrows `filters` to that arm.
 */
export type RequestReportInput = ReportRequest & {
  organizationId: string;
  companyIds: string[];
};

/**
 * Queue a report.
 *
 * FOR A PANEL, THIS IS WHERE THE NUMBERS ARE CAPTURED, and it is the only place
 * in the block that touches 8a's aggregates. Design D2: they are SECURITY
 * INVOKER and granted to `authenticated` only, so the worker cannot call them
 * at all -- it would not merely be refused, it lacks EXECUTE. So the same call
 * the screen makes runs here, as the same user, and the worker renders what
 * comes back. That also closes the revocation window for panels at no cost: the
 * figures were computed while the caller was entitled to them.
 */
export async function requestReport(input: RequestReportInput): Promise<string> {
  const supabase = await createUserClient();

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new UnauthenticatedError('Sign in to request a report.');

  // Through the service client, because rate_limit_counters has RLS with no
  // policies and grants revoked from authenticated (0002). A report is the
  // cheapest way in this system to ask the database for a great deal of work.
  const limiter = new PostgresRateLimiter(createServiceClient());
  const verdict = await limiter.check(`report:${userId}`, REPORTS_PER_HOUR, RATE_WINDOW_SECONDS);
  if (!verdict.allowed) {
    throw new RateLimitError('Too many reports requested in the last hour. Try again shortly.');
  }

  const payload = isPanelType(input.reportType)
    ? await capturePanel(input)
    : null;

  const { data, error } = await supabase.rpc('request_report', {
    p_organization_id: input.organizationId,
    p_company_ids: input.companyIds,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_report_type: input.reportType as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_format: input.format as any,
    // Both are jsonb; the generated Json type does not admit an open object.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_filters: input.filters as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_payload: payload as any,
  });

  if (error) throw mapReportError(error.code, error.message);
  if (!data) throw new InternalError('request_report returned no id');
  return data as string;
}

async function capturePanel(input: RequestReportInput): Promise<unknown> {
  const filters = input.filters as { preset: string; from?: string | null; to?: string | null };
  const period: PeriodSelection = {
    preset: filters.preset as PeriodSelection['preset'],
    from: filters.from ?? null,
    to: filters.to ?? null,
  };

  switch (input.reportType) {
    case 'AUDIENCE_PANEL':
      return getAudienceDashboard(input.companyIds, period);
    case 'MUSIC_PANEL':
      return getMusicDashboard(input.companyIds, period);
    case 'PROMOTIONS_PANEL':
      return getPromotionsDashboard(input.companyIds, period);
    default:
      // Unreachable: isPanelType decided the branch. Throwing rather than
      // returning null keeps a future enum value from silently producing a
      // panel run with no payload, which 0122's CHECK would then refuse with a
      // constraint name.
      throw new InternalError(`no capture for panel type ${input.reportType}`);
  }
}

/**
 * The caller's own runs, newest first. RLS (0122) is what limits this to the
 * requester, the Organization's owner and the platform admin -- there is no
 * `eq('requested_by', ...)` here on purpose, because writing the rule twice is
 * how the two come to disagree.
 */
export async function listMyReportRuns(limit = 50): Promise<ReportRun[]> {
  const supabase = await createUserClient();

  const { data, error } = await supabase
    .from('report_runs')
    .select(REPORT_RUN_COLUMNS)
    .order('requested_at', { ascending: false })
    .limit(limit);

  if (error) throw mapReportError(error.code, error.message);
  return (data ?? []).map((row) => reportRunSchema.parse(row));
}

/**
 * A short-lived signed URL, minted at the moment of the click and never stored.
 *
 * The run is read through the USER client first, so report_runs' RLS answers
 * "may this caller see this run" before any URL is minted -- and the bucket
 * policy (0123) reaches the same row again, so a caller who defeated this layer
 * would still be refused by storage.
 *
 * Null means the file is gone: an expired run keeps its history row and loses
 * its storage_path (0128). The screen renders that as "expired", which is a
 * true and different thing from "failed".
 */
export async function signedUrlForRun(runId: string): Promise<string | null> {
  const supabase = await createUserClient();

  const { data: run, error } = await supabase
    .from('report_runs')
    .select('id, storage_path, status')
    .eq('id', runId)
    .maybeSingle();

  if (error) throw mapReportError(error.code, error.message);
  if (!run) throw new NotFoundError('That report does not exist, or is not yours to read.');
  if (run.status !== 'READY' || !run.storage_path) return null;

  const signed = await supabase.storage
    .from(REPORT_BUCKET)
    .createSignedUrl(run.storage_path, SIGNED_URL_SECONDS);

  if (signed.error) throw new InternalError(signed.error.message);
  return signed.data?.signedUrl ?? null;
}
