import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';

/**
 * The picture on the sign-in screen: where it is, and how a replacement of it
 * reaches a browser that is already holding the old one.
 *
 * Two halves on purpose. The address is pure arithmetic and is unit-tested;
 * the read that supplies its version stamp talks to Storage and is not.
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
 *
 * The consequence: the replacement really should be a PNG. Storage serves a
 * `.png` object as whatever content type it was uploaded with, so a JPEG stored
 * here still renders -- the extension is a label for a human, not a promise to
 * the browser -- but a bucket whose one file is called `login-hero.png` and
 * holds a JPEG is a small trap for the next person, so the seed script and the
 * documentation both say PNG.
 */
export const LOGIN_HERO_KEY = 'login-hero.png';

/**
 * The public address, with a version stamp. Same shape as artworkPublicUrl,
 * and `origin` is likewise passed in rather than read from the environment so
 * this stays pure and testable.
 *
 * THE STAMP IS THE WHOLE POINT OF THIS FILE. The key is a constant, so the
 * address never changes on its own, and Storage serves a public object with
 * whatever cache-control the UPLOADER chose. MEASURED against the local stack
 * rather than taken from the docs: an upload that names no cacheControl -- which
 * is what a dashboard drag-and-drop is -- comes back
 * `cache-control: max-age=3600`. So without the stamp, an operator who swaps
 * this picture goes on seeing the old one for up to an hour, with nothing on
 * screen to say why, and reasonably concludes the upload failed and does it
 * again.
 */
export function loginHeroPublicUrl(origin: string, version: number): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${BRANDING_BUCKET}/${LOGIN_HERO_KEY}?v=${version}`;
}

/**
 * The address to render, or null when there is nothing to render.
 *
 * NULL RATHER THAN A GUESS. Returning the bare address when the object is
 * missing would put a broken-image icon on the front door of the product, on
 * the one screen every customer sees; the panel simply omits the picture
 * instead. A brand-new database has an empty bucket until somebody uploads --
 * `npm run seed:branding` does it locally -- so this is the ordinary state on
 * day one, not an error.
 *
 * A PLAIN ANON CLIENT, not createUserClient(). The reader of this screen has no
 * session by definition, so there is no session to pass; and createUserClient
 * reads cookies(), which would make every page under the (auth) layout
 * request-dynamic for a value that has nothing to do with the request.
 *
 * NOT CACHED, deliberately. One small list call per sign-in page render is a
 * cost this product will never notice, and any cache long enough to be worth
 * having is long enough to reintroduce the exact staleness the version stamp
 * exists to remove.
 */
export async function getLoginHeroUrl(): Promise<string | null> {
  try {
    const { url, anonKey } = getUserSupabaseConfig();
    const supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // `list` rather than a HEAD on the object, because the object's own response
    // carries no updated_at we can read without downloading it. The search is a
    // substring match, so the result is filtered by name below rather than
    // trusted -- 'login-hero.png' is the only key this bucket is meant to hold,
    // but a stray upload named 'old-login-hero.png' would otherwise win.
    const { data, error } = await supabase.storage
      .from(BRANDING_BUCKET)
      .list('', { limit: 100, search: LOGIN_HERO_KEY });
    if (error) return null;

    const object = data?.find((entry) => entry.name === LOGIN_HERO_KEY);
    if (!object) return null;

    const stamp = Date.parse(object.updated_at ?? object.created_at ?? '');
    return loginHeroPublicUrl(url, Number.isNaN(stamp) ? 0 : stamp);
  } catch {
    // Storage being unreachable must not take the sign-in screen down with it.
    // Somebody in that situation probably cannot sign in either, but they
    // should meet the form and its error message rather than a 500.
    return null;
  }
}
