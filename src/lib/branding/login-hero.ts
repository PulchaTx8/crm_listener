import 'server-only';
import { getUserSupabaseConfig } from '@/lib/supabase/config';

/**
 * The picture on the sign-in screen: where it is, and how a replacement of it
 * reaches a browser that is already holding the old one.
 *
 * Two halves on purpose. The address is pure arithmetic and is unit-tested;
 * the request that supplies its version stamp talks to Storage and is not.
 */
export const BRANDING_BUCKET = 'branding';

/**
 * ONE FIXED KEY, and an extension, which is the opposite of what
 * lib/storage/artwork-keys.ts does and for the opposite reason.
 *
 * Artwork keys are uuids with no extension: uuids so the bucket cannot be
 * walked, extensionless so a JPEG uploaded on Tuesday replaces Monday's PNG.
 * Neither applies here. This object's whole purpose is to sit at an address the
 * sign-in page can build without asking anything first -- there is no record to
 * derive a key from -- and the operator replacing it is standing in the
 * dashboard's file browser, where a name ending in `.png` is how they recognise
 * the thing they came to replace.
 */
export const LOGIN_HERO_KEY = 'login-hero.png';

/**
 * The public address, optionally carrying a version stamp.
 *
 * `origin` is passed in rather than read from the environment so this stays
 * pure and testable; the caller below reads it from getUserSupabaseConfig().
 *
 * A NULL VERSION STILL PRODUCES AN ADDRESS, and that is the whole shape of this
 * module's second attempt -- see getLoginHeroUrl. The stamp is a cache
 * optimisation; the picture is the feature. Making the feature conditional on
 * the optimisation is what took the image off the screen the first time.
 */
export function loginHeroPublicUrl(origin: string, version: string | null): string {
  const base = origin.replace(/\/+$/, '');
  const address = `${base}/storage/v1/object/public/${BRANDING_BUCKET}/${LOGIN_HERO_KEY}`;
  return version ? `${address}?v=${encodeURIComponent(version)}` : address;
}

/**
 * What to hang on the URL so that replacing the object changes the address.
 *
 * ETag first: Storage derives it from the bytes, so it changes on every
 * replacement and on nothing else. Last-Modified is the fallback, reduced to
 * epoch milliseconds. Quotes are stripped -- an ETag is delivered wrapped in
 * them and they would have to be percent-encoded into the query for nothing.
 *
 * Exported for the unit test: this is the half of the logic that has rules,
 * and the fetch around it is the half that does not.
 */
export function versionStampFrom(headers: Headers): string | null {
  const etag = headers.get('etag')?.replace(/"/g, '').trim();
  if (etag) return etag;

  const modified = headers.get('last-modified');
  if (modified) {
    const parsed = Date.parse(modified);
    if (!Number.isNaN(parsed)) return String(parsed);
  }

  return null;
}

/**
 * The address to render, or null when there is nothing to render.
 *
 * THIS ASKS THE PUBLIC ENDPOINT AND NOTHING ELSE, and the previous version's
 * failure is the reason.
 *
 * It used to call `storage.list()` to read the object's `updated_at`. That goes
 * through `storage.objects`, which is subject to RLS, so it needed a policy
 * admitting `anon` -- and when that policy was absent, `list()` returned an
 * empty array, this function returned null, and THE PICTURE DID NOT APPEAR AT
 * ALL. Which is what happened on the hosted project: the bucket was created by
 * hand in the dashboard, the object uploaded, and the migration carrying the
 * policy had not been run. A missing cache optimisation had removed the
 * feature.
 *
 * A HEAD on `/object/public/` consults no policy -- that is what `public = true`
 * on the bucket means -- so it needs no RLS, no key, and no migration to have
 * run. MEASURED against the hosted project: an existing object answers 200 with
 * `ETag` and `Last-Modified`; a key that does not exist answers 400. So one
 * request settles both questions this function has to answer.
 *
 * It also fails OPEN in a way the old one could not: if the response arrives
 * without either header, the address is still returned, just unstamped. The
 * picture shows; a replacement may take up to Storage's hour to reach a browser
 * that already had one. That is the right way round.
 *
 * NOT CACHED, and `cache: 'no-store'` is explicit: Next would otherwise be free
 * to reuse this response, which is the same staleness the stamp exists to
 * remove. One HEAD per sign-in page render is a cost this product will never
 * notice.
 */
export async function getLoginHeroUrl(): Promise<string | null> {
  let origin: string;
  try {
    origin = getUserSupabaseConfig().url;
  } catch {
    return null;
  }

  const address = loginHeroPublicUrl(origin, null);

  try {
    const probe = await fetch(address, {
      method: 'HEAD',
      cache: 'no-store',
      // A CEILING ON THE SIGN-IN SCREEN, because this request BLOCKS its
      // render. Storage normally answers in tens of milliseconds; what this
      // guards against is the case where it answers in none at all, which
      // without a deadline would hang the one page every customer has to reach
      // before they can do anything. Two seconds is far outside the normal
      // range and far inside anybody's patience.
      //
      // Timing out lands in the catch below and yields a screen with no
      // picture, which is the right way to lose this: the form is what the
      // person came for.
      signal: AbortSignal.timeout(2000),
    });
    // 400 rather than 404 is what Storage answers for a missing key, measured;
    // treating the whole error range the same way means neither has to be
    // guessed at.
    if (!probe.ok) return null;
    return loginHeroPublicUrl(origin, versionStampFrom(probe.headers));
  } catch {
    // Storage being unreachable must not take the sign-in screen down with it.
    // Somebody in that situation probably cannot sign in either, but they
    // should meet the form and its error message rather than a 500.
    return null;
  }
}
