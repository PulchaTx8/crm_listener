import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { InternalError, NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { describeArtworkRejection } from '@/lib/security/artwork';
import { readImageDimensions } from '@/lib/security/image-dimensions';
import { ARTWORK_BUCKET, artworkKey, artworkPublicUrl } from '@/lib/storage/artwork-keys';
import type { Database } from '@/lib/supabase/database.types';

/**
 * The Station's own record, and its picture.
 *
 * TWO WRITERS, NOT ONE, and the split is the database's rather than this file's:
 * update_company_profile replaces every field it takes on every call, so a
 * picture on that list would be cleared by the next ordinary save. 0144 and 0145
 * document the same defect and answer it the same way.
 */

function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function mapProfileError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '22023' || code === '23514') return new ValidationError(message);
  return new InternalError(message);
}

export interface CompanyProfileInput {
  companyId: string;
  addressLine: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  neighbourhood: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  broadcastBand: 'FM' | 'AM' | 'WEB' | null;
  frequencyKhz: number | null;
  latitude: number | null;
  longitude: number | null;
}

export async function updateCompanyProfile(
  input: CompanyProfileInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_company_profile', {
    p_company_id: input.companyId,
    p_address_line: input.addressLine ?? undefined,
    p_address_number: input.addressNumber ?? undefined,
    p_address_complement: input.addressComplement ?? undefined,
    p_neighbourhood: input.neighbourhood ?? undefined,
    p_city: input.city ?? undefined,
    p_state: input.state ?? undefined,
    p_postal_code: input.postalCode ?? undefined,
    p_broadcast_band: input.broadcastBand ?? undefined,
    p_frequency_khz: input.frequencyKhz ?? undefined,
    p_latitude: input.latitude ?? undefined,
    p_longitude: input.longitude ?? undefined,
  });
  if (error) throw mapProfileError(error.code, error.message);
}

/**
 * Uploads the picture and records its address, in that order.
 *
 * The file is validated HERE as well as in the browser control, because the
 * browser half runs on a machine this product does not control -- the same
 * division setPrizePhoto states. The bucket refuses the type and the size again
 * whatever either of them decides (0143).
 */
export async function setCompanyThumb(
  input: { companyId: string; file: File },
  accessToken: string,
): Promise<string> {
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const rejection = describeArtworkRejection(
    'thumb',
    { type: input.file.type, size: input.file.size },
    readImageDimensions(bytes),
  );
  // Here as well as in the browser control, and as well as in the bucket (0143):
  // so the failure is a sentence rather than a Storage error, so the pixel
  // ceiling -- which no bucket can express -- is enforced where a client cannot
  // reach it, and so nothing is uploaded first. uploadPrizePhoto says the same.
  if (rejection) throw new ValidationError(rejection);

  // `<slot>/<company_id>/thumb` -- the record segment is a constant because a
  // Station has exactly one picture, and company_id must stay the SECOND
  // segment for may_write_artwork to read it out of the path.
  const key = artworkKey('station-thumbs', input.companyId, 'thumb');

  const uploaded = await asCaller(accessToken)
    .storage.from(ARTWORK_BUCKET)
    .upload(key, input.file, {
      // NOT optional: the key carries no extension, so an object uploaded with
      // no content type is served back as application/octet-stream.
      contentType: input.file.type,
      // The whole point of a key derived from the record. Without this the
      // SECOND upload for a Station fails instead of replacing the first.
      upsert: true,
    });
  if (uploaded.error) {
    throw new InternalError(`Could not upload the picture: ${uploaded.error.message}`);
  }

  // The version stamp is not decoration: the key is stable, so without it the
  // browser and Supabase's CDN go on serving the picture that was just replaced.
  const url = artworkPublicUrl(getUserSupabaseConfig().url, key, Date.now());

  const { error } = await asCaller(accessToken).rpc('set_company_thumb', {
    p_company_id: input.companyId,
    p_url: url,
  });
  if (error) throw mapProfileError(error.code, error.message);
  return url;
}

/**
 * Clears the column and queues the object, in one transaction (0153).
 *
 * NOTHING HERE DELETES ANYTHING: the bucket has no delete policy for
 * `authenticated`, deliberately, and the worker drains the queue through
 * service_role. `p_url` is OMITTED rather than sent as null -- 0153 gives it
 * `default null` precisely so clearing needs no cast.
 */
export async function clearCompanyThumb(
  companyId: string,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('set_company_thumb', {
    p_company_id: companyId,
  });
  if (error) throw mapProfileError(error.code, error.message);
}
