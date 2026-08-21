import 'server-only';
import { createUserClient } from '@/lib/supabase/user-client';
import { InternalError, UnauthorizedError, ValidationError } from '@/lib/errors';
import {
  audienceGeographySchema,
  musicGeographySchema,
  promotionsGeographySchema,
} from '@/schemas/geography';
import type { AudienceGeography, MusicGeography, PromotionsGeography } from '@/schemas/geography';
import type { PeriodSelection } from '@/app/(app)/dashboards/period';

/**
 * Block 28. The two geography aggregates, read the way services/dashboards.ts
 * reads its three — same error taxonomy, same `?? undefined` on the period, same
 * `schema.parse` rather than an `as` cast.
 *
 * SEPARATE FROM services/dashboards.ts rather than folded into it, and the
 * reason is what the panel does with a failure: a geography read that throws
 * must cost the map and nothing else. The three dashboard reads are what the
 * page cannot render without; this one is a panel below them, and a Station
 * whose geocoding is misconfigured should still see its cards.
 */
function mapGeographyError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === '22023') return new ValidationError(message);
  return new InternalError(message);
}

function periodArgs(companyIds: string[], period: PeriodSelection) {
  return {
    p_company_ids: companyIds,
    p_preset: period.preset,
    p_from: period.from ?? undefined,
    p_to: period.to ?? undefined,
  };
}

export async function getAudienceGeography(
  companyIds: string[],
  period: PeriodSelection,
): Promise<AudienceGeography> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc(
    'get_audience_geography',
    periodArgs(companyIds, period),
  );
  if (error) throw mapGeographyError(error.code, error.message);
  return audienceGeographySchema.parse(data);
}

export async function getMusicGeography(
  companyIds: string[],
  period: PeriodSelection,
): Promise<MusicGeography> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc('get_music_geography', periodArgs(companyIds, period));
  if (error) throw mapGeographyError(error.code, error.message);
  return musicGeographySchema.parse(data);
}

/**
 * Block 30e, item 19. Where the entries of the period came from.
 *
 * The same shape as its two siblings, and the same `schema.parse`. What differs
 * is that a REFUSAL is not the only way this one can come back without places:
 * `withheld` names the permission when it does, and the panel renders that
 * rather than an empty map (0270's header, design D12).
 */
export async function getPromotionsGeography(
  companyIds: string[],
  period: PeriodSelection,
): Promise<PromotionsGeography> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc(
    'get_promotions_geography',
    periodArgs(companyIds, period),
  );
  if (error) throw mapGeographyError(error.code, error.message);
  return promotionsGeographySchema.parse(data);
}
