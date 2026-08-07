import { Music } from 'lucide-react';
import { coverUrl } from '@/lib/integrations/deezer/cover';

const PIXELS = { sm: 32, md: 48, lg: 64 } as const;

/** Which of Deezer's rendered sizes to ask for. Asking for 250 to draw 32 pixels wastes the operator's bandwidth on every row of a fifty-row grid. */
function sourceSize(px: number): 56 | 250 {
  return px <= 56 ? 56 : 250;
}

/**
 * The album cover, or an honest gap.
 *
 * Used by every screen that names a song, so that "some songs have covers"
 * reads as a property of the catalogue -- which it is, permanently: songs
 * typed by hand coexist with songs registered from Deezer, and neither is
 * going away -- rather than as a screen that failed to load.
 *
 * A PLAIN <img>, NOT next/image. The optimizer would proxy a CDN this product
 * does not own, need `remotePatterns` configuration kept in step with the CSP
 * and with cover.ts, and buy nothing for a 32-pixel square that is already
 * served at exactly the size asked for.
 *
 * `alt=""` is correct and not an oversight. Every caller renders the song's
 * title immediately beside this, and a screen reader announcing "Cover of X"
 * before reading "X" is noise. The fallback is `aria-hidden` for the same
 * reason.
 */
export function SongThumb({
  coverMd5,
  size = 'sm',
  className,
}: {
  coverMd5: string | null;
  size?: keyof typeof PIXELS;
  className?: string;
}) {
  const px = PIXELS[size];
  const url = coverUrl(coverMd5, sourceSize(px));

  if (!url) {
    return (
      <span
        aria-hidden="true"
        data-testid="song-thumb-empty"
        className={`flex shrink-0 items-center justify-center rounded bg-muted text-muted-foreground ${className ?? ''}`}
        style={{ width: px, height: px }}
      >
        <Music className="size-4" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- deliberate; see the component comment.
    <img
      src={url}
      alt=""
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      data-testid="song-thumb"
      // next.config.mjs already sends strict-origin-when-cross-origin for the
      // whole app; this says the same thing louder for a CDN outside it.
      referrerPolicy="no-referrer"
      className={`shrink-0 rounded bg-muted object-cover ${className ?? ''}`}
    />
  );
}
