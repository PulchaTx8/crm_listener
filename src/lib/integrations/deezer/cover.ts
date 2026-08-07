/**
 * The one place a cover hash becomes a URL (Block 13a, design D4).
 *
 * NOTHING IN THIS PRODUCT STORES A DEEZER URL. The database keeps `md5_image`
 * — the hash Deezer returns beside every album — and every size is built from
 * it here. Two things follow, and both were the point:
 *
 *   - A CDN host change is this constant plus the one in src/lib/security/
 *     csp.ts, rather than a migration over every row already written.
 *   - The column never holds a value that lands verbatim in `<img src>`, so it
 *     cannot become a vector by way of a bad write. The check constraint on
 *     albums.cover_md5 (0136) and the guard below say the same thing in the
 *     two places that can enforce it.
 */
const COVER_HOST = 'https://cdn-images.dzcdn.net/images/cover';

/**
 * Deezer's md5_image is a plain MD5 and nothing else. Anything that is not one
 * is refused rather than interpolated: this module is also fed by live search
 * results, which never passed through 0136's constraint.
 */
const HASH = /^[0-9a-f]{32}$/;

/** The sizes Deezer serves that this product asks for: a list thumb and a record thumb. */
export type CoverSize = 56 | 250 | 500;

export function coverUrl(
  md5: string | null | undefined,
  size: CoverSize,
): string | null {
  if (!md5 || !HASH.test(md5)) return null;
  return `${COVER_HOST}/${md5}/${size}x${size}-000000-80-0-0.jpg`;
}
