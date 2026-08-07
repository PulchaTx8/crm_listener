/**
 * Block 14. The name an image is stored under, and the address it is read from.
 *
 * Pure, and deliberately NOT `server-only` like the rest of `lib/storage`: the
 * upload control in the browser shows the address it is about to replace, and a
 * second copy of this arithmetic is how the two would drift.
 */
export const ARTWORK_BUCKET = 'artwork';

export type ArtworkSlot = 'promotion-thumbs' | 'promotion-banners' | 'prize-photos';

/**
 * `<slot>/<company_id>/<record_id>`, and DELIBERATELY NO FILE EXTENSION.
 *
 * That absence is what makes "uploading again replaces the last one" structural
 * rather than hopeful: an operator who uploads a JPEG on Monday and a PNG on
 * Tuesday writes over the same object, because the key never mentions the
 * format. With an extension, replacing would mean deleting the old object and
 * writing a new one -- two steps, and the first can fail, which is exactly the
 * accumulation this block was asked to prevent.
 *
 * The consequence is load-bearing and lives in the services that call this:
 * every upload must set `contentType` explicitly, because Storage serves what
 * it was told and an extensionless object with no type is served as
 * `application/octet-stream`, which Meta refuses.
 *
 * The Station is the SECOND segment because may_write_artwork (0143) reads
 * `storage.foldername(name)[2]` and asks has_permission about it, deciding from
 * the path alone without joining anything.
 */
export function artworkKey(slot: ArtworkSlot, companyId: string, recordId: string): string {
  return `${slot}/${companyId}/${recordId}`;
}

/**
 * The public address, with a version stamp.
 *
 * The stamp is not decoration. A key derived from the record means a STABLE
 * URL, which means the browser and Supabase's CDN go on serving the picture
 * that was just replaced. Storing the address with `?v=<epoch ms>` changes the
 * column on every upload, so every screen -- and Meta's fetcher -- sees the new
 * image at once. A query string does not disturb that fetch.
 *
 * `origin` is passed in rather than read from the environment so this stays
 * pure and testable; the server-side callers read it from
 * getUserSupabaseConfig().
 */
export function artworkPublicUrl(origin: string, key: string, version: number): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${ARTWORK_BUCKET}/${key}?v=${version}`;
}
