import { Music } from 'lucide-react';
import { coverUrl } from '@/lib/integrations/deezer/cover';

const PIXELS = { sm: 32, md: 48, lg: 64 } as const;

/** Which of Deezer's rendered sizes to ask for. Asking for 250 to draw 32 pixels wastes the operator's bandwidth on every row of a fifty-row grid — the same reasoning SongThumb (music/songs/song-fields.tsx) gives for its own. */
function sourceSize(px: number): 56 | 250 {
  return px <= 56 ? 56 : 250;
}

/**
 * The album's picture, from whichever source has one.
 *
 * Block 20c, D4. TWO SOURCES AND AN ORDER: `thumbUrl` is what an operator
 * uploaded and wins; `coverMd5` is Deezer's, which an album registered from
 * there already carries; neither means an empty frame rather than a broken
 * image. Nothing merges them in the database — they are facts from two
 * different places, and this component is the only thing with an opinion about
 * which to show.
 *
 * NOT a widening of SongThumb (music/songs/song-fields.tsx). That one answers
 * "draw this Deezer cover" and is used on five screens; teaching it a second
 * source would make it mean two things, and every existing caller would carry
 * a prop it never sets.
 */
export function AlbumThumb({
  thumbUrl,
  coverMd5,
  size = 'sm',
  className,
}: {
  thumbUrl: string | null;
  coverMd5: string | null;
  size?: keyof typeof PIXELS;
  className?: string;
}) {
  const px = PIXELS[size];
  // D4's order: the operator's own upload wins, Deezer's cover is the
  // fallback. thumbUrl is already the exact address to draw — it names one
  // stored object, not a size family the way coverUrl's argument does — so it
  // is used as-is and coverUrl is only reached when there is no upload.
  const url = thumbUrl ?? coverUrl(coverMd5, sourceSize(px));

  if (!url) {
    return (
      <span
        aria-hidden="true"
        data-testid="album-thumb-empty"
        className={`flex shrink-0 items-center justify-center rounded bg-muted text-muted-foreground ${className ?? ''}`}
        style={{ width: px, height: px }}
      >
        <Music className="size-4" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- deliberate; see the component comment and SongThumb's identical one.
    <img
      src={url}
      alt=""
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      data-testid="album-thumb"
      // next.config.mjs already sends strict-origin-when-cross-origin for the
      // whole app; this says the same thing louder for a CDN outside it — and
      // for the artwork bucket, which is a different origin than the app's own
      // whenever they are not on the same host.
      referrerPolicy="no-referrer"
      className={`shrink-0 rounded bg-muted object-cover ${className ?? ''}`}
    />
  );
}
