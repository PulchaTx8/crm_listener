import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { InternalError, NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors';
import type { BroadcastBand } from '@/lib/frequency';
import { describeArtworkRejection } from '@/lib/security/artwork';
import { readImageDimensions } from '@/lib/security/image-dimensions';
import { ARTWORK_BUCKET, artworkKey, artworkPublicUrl } from '@/lib/storage/artwork-keys';
import { normaliseTaxId } from '@/lib/tax-id';
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

/**
 * A Station's record as every screen in the console reads it.
 *
 * DECLARED HERE AND NOWHERE ELSE. `station-form.tsx` aliases its own
 * `StationProfile` to this rather than restating the twenty-four fields, so the
 * shape the form renders and the shape a save reads back cannot drift apart --
 * which is the failure mode a second, hand-kept copy of this list would have.
 * A type-only import carries nothing across the client boundary, so the
 * `server-only` guard at the top of this file stays intact.
 */
export interface CompanyProfileRecord {
  addressLine: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  neighbourhood: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2 (0213). It qualifies every geocode for this Station's listeners and decides where its map opens. */
  country: string | null;
  broadcastBand: BroadcastBand | null;
  frequencyKhz: number | null;
  latitude: number | null;
  longitude: number | null;
  thumbUrl: string | null;
  // Block 16.
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  youtubeUrl: string | null;
  tagline: string | null;
  description: string | null;
  legalName: string | null;
  taxId: string | null;
  municipalRegistration: string | null;
  fiscalEmail: string | null;
}

/**
 * One Station's record, read back after it was written.
 *
 * WHY A READ RATHER THAN ECHOING WHAT WAS POSTED: the database is not storing
 * what the form sent. `update_company_profile` trims every text field to null,
 * `withScheme` above puts a scheme on four addresses, `normaliseTaxId` reduces
 * a punctuated document to fourteen digits, and `khzFromInput` turns 98.5 into
 * 98500. A screen redrawn from the submission would show the operator values
 * the database does not hold, and they would differ again on the next
 * navigation -- which is the same class of lie as showing stale ones.
 *
 * THE SELECT IS ONE LITERAL STRING, the constraint page.tsx's own select
 * carries and for the same reason: a concatenation collapses PostgREST's row
 * type to GenericStringError, which typechecks and returns nothing usable. That
 * is why these column names appear here as well as there; the MAPPING below is
 * what the two would otherwise have had to keep in step by hand, and a column
 * that joins this record has to join both literals.
 */
export async function readCompanyProfile(
  companyId: string,
  accessToken: string,
): Promise<CompanyProfileRecord> {
  const { data, error } = await asCaller(accessToken)
    .from('companies')
    // prettier-ignore
    .select('address_line, address_number, address_complement, neighbourhood, city, state, postal_code, country, broadcast_band, frequency_khz, latitude, longitude, thumb_url, contact_email, contact_phone, website_url, instagram_url, facebook_url, youtube_url, tagline, description, legal_name, tax_id, municipal_registration, fiscal_email')
    .eq('id', companyId)
    .single();

  if (error) throw mapProfileError(error.code, error.message);

  return {
    addressLine: data.address_line,
    addressNumber: data.address_number,
    addressComplement: data.address_complement,
    neighbourhood: data.neighbourhood,
    city: data.city,
    state: data.state,
    postalCode: data.postal_code,
    country: data.country,
    broadcastBand: data.broadcast_band,
    frequencyKhz: data.frequency_khz,
    latitude: data.latitude,
    longitude: data.longitude,
    thumbUrl: data.thumb_url,
    contactEmail: data.contact_email,
    contactPhone: data.contact_phone,
    websiteUrl: data.website_url,
    instagramUrl: data.instagram_url,
    facebookUrl: data.facebook_url,
    youtubeUrl: data.youtube_url,
    tagline: data.tagline,
    description: data.description,
    legalName: data.legal_name,
    taxId: data.tax_id,
    municipalRegistration: data.municipal_registration,
    fiscalEmail: data.fiscal_email,
  };
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
  /** ISO 3166-1 alpha-2. update_company_profile RAISES 22023 for a value country_alpha2 cannot resolve, so this must be a code the select offered — see src/lib/countries.ts. */
  country: string | null;
  broadcastBand: 'FM' | 'AM' | 'WEB' | null;
  frequencyKhz: number | null;
  latitude: number | null;
  longitude: number | null;
  // Block 16. How the radio is reached, how it describes itself, and who it is
  // on a document. The last four are the Station's OWN invoicing identity and
  // are independent of its group's billing_entity, which says who emits an
  // invoice and never who has a legal identity (D7).
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  youtubeUrl: string | null;
  tagline: string | null;
  description: string | null;
  legalName: string | null;
  taxId: string | null;
  municipalRegistration: string | null;
  fiscalEmail: string | null;
}

/**
 * A typed address, with the scheme the column insists on.
 *
 * companies_website_shape and its three siblings (0155) refuse anything that is
 * not http(s), because these four land in an href on the Station's card — a
 * scheme-less value there is a relative link and a `javascript:` one is worse.
 * An operator types `instagram.com/radio`, so the scheme is added here rather
 * than the save being refused: the division of labour tax_id already uses, where
 * the application normalises and the database asserts.
 */
function withScheme(typed: string | null): string | null {
  const trimmed = typed?.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
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
    p_country: input.country ?? undefined,
    p_broadcast_band: input.broadcastBand ?? undefined,
    p_frequency_khz: input.frequencyKhz ?? undefined,
    p_latitude: input.latitude ?? undefined,
    p_longitude: input.longitude ?? undefined,
    p_contact_email: input.contactEmail ?? undefined,
    p_contact_phone: input.contactPhone ?? undefined,
    p_website_url: withScheme(input.websiteUrl) ?? undefined,
    p_instagram_url: withScheme(input.instagramUrl) ?? undefined,
    p_facebook_url: withScheme(input.facebookUrl) ?? undefined,
    p_youtube_url: withScheme(input.youtubeUrl) ?? undefined,
    p_tagline: input.tagline ?? undefined,
    p_description: input.description ?? undefined,
    p_legal_name: input.legalName ?? undefined,
    // Fourteen bare digits or nothing: normaliseTaxId returns null for anything
    // else, so a half-typed number is stored as absent rather than as a stub no
    // invoice can be raised against.
    p_tax_id: normaliseTaxId(input.taxId) ?? undefined,
    p_municipal_registration: input.municipalRegistration ?? undefined,
    p_fiscal_email: input.fiscalEmail ?? undefined,
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
