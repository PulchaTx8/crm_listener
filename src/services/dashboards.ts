import 'server-only';
import { createUserClient } from '@/lib/supabase/user-client';
import { InternalError, UnauthorizedError, ValidationError } from '@/lib/errors';
import {
  audienceDashboardSchema,
  musicDashboardSchema,
  promotionsDashboardSchema,
} from '@/schemas/dashboards';
import type {
  AudienceDashboard,
  MusicDashboard,
  PromotionsDashboard,
} from '@/schemas/dashboards';
import type { PeriodSelection } from '@/app/(app)/dashboards/period';

/**
 * The taxonomy 0118–0120 raise, identical across all three RPCs (same
 * permission loop, same station CTE, same two doors): `42501` for a
 * permission the caller does not hold in every named Station (and, for a
 * consolidated call, `reports.consolidated` in every one — D3), `22023` for
 * an empty Station list or, in principle, an invalid period — though
 * `parsePeriod` (`app/(app)/dashboards/period.ts`) refuses an unknown preset,
 * an impossible date and a range that does not open before it closes, all
 * before a request is ever sent, so a 22023 that reaches here almost always
 * means the Station list, not the period.
 *
 * "Almost always" is doing real work in that sentence, and used to be doing
 * more than it could carry (whole-branch review, Important B3): `parsePeriod`
 * compared `from > to` while 0117 refuses `p_to <= p_from`, so an operator who
 * picked one date in both inputs sailed through this layer and got a
 * ValidationError back. Both bounds now agree.
 *
 * Nothing here ever constructs a `BusinessRuleError`, a `ConflictError` or a
 * `NotFoundError`: these three functions are read-only aggregates with no
 * row to conflict over and no id to fail to find. Anything other than the
 * two codes above is ours, not the caller's — labelling an unexpected
 * database fault a refusal would hide a real defect behind a plausible
 * message, the same reasoning `services/templates.ts`'s own
 * `mapTemplateError` gives.
 */
function mapDashboardError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === '22023') return new ValidationError(message);
  return new InternalError(message);
}

/** The one argument shape all three RPCs share. */
function periodArgs(companyIds: string[], period: PeriodSelection) {
  return {
    p_company_ids: companyIds,
    p_preset: period.preset,
    // `?? undefined`, not `?? null`: the generated Args type takes an
    // optional string, and omitting the key lets Postgres fall back to the
    // function's own `default null` rather than this layer asserting one.
    p_from: period.from ?? undefined,
    p_to: period.to ?? undefined,
  };
}

/**
 * The Audience dashboard for one Station or a consolidated set, both windows
 * in one call. `schema.parse(data)` — never an `as` cast — is what makes the
 * return type true: the RPC's `jsonb` arrives as `unknown`, and this is the
 * one place that checks it actually has the shape claimed.
 */
export async function getAudienceDashboard(
  companyIds: string[],
  period: PeriodSelection,
): Promise<AudienceDashboard> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc(
    'get_audience_dashboard',
    periodArgs(companyIds, period),
  );
  if (error) throw mapDashboardError(error.code, error.message);
  return audienceDashboardSchema.parse(data);
}

export async function getMusicDashboard(
  companyIds: string[],
  period: PeriodSelection,
): Promise<MusicDashboard> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc(
    'get_music_dashboard',
    periodArgs(companyIds, period),
  );
  if (error) throw mapDashboardError(error.code, error.message);
  return musicDashboardSchema.parse(data);
}

export async function getPromotionsDashboard(
  companyIds: string[],
  period: PeriodSelection,
): Promise<PromotionsDashboard> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc(
    'get_promotions_dashboard',
    periodArgs(companyIds, period),
  );
  if (error) throw mapDashboardError(error.code, error.message);
  return promotionsDashboardSchema.parse(data);
}
