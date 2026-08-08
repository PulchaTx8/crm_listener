import { Gift, Megaphone } from 'lucide-react';

const PIXELS = { sm: 32, md: 48 } as const;

const ICONS = { promotion: Megaphone, prize: Gift } as const;

/**
 * A record's picture, or an honest gap.
 *
 * The shape SongThumb established in Block 13a, and a SEPARATE component rather
 * than a widening of it: that one speaks Deezer's cover hash and builds a CDN
 * address from it, this one is handed a URL. Folding them together would mean a
 * component taking two mutually exclusive props and a comment explaining which
 * callers may pass which.
 *
 * A PLAIN <img>, NOT next/image, for SongThumb's reasons: the optimiser would
 * proxy an origin this product already serves, need `remotePatterns` kept in
 * step with the CSP, and buy nothing for a 32-pixel square already stored small.
 *
 * `alt=""` is correct and not an oversight. Every caller renders the record's
 * name immediately beside this, and a screen reader announcing "Picture of X"
 * before reading "X" is noise. The fallback is `aria-hidden` for the same
 * reason.
 */
export function ImageThumb({
  url,
  icon,
  size = 'sm',
  className,
}: {
  url: string | null;
  icon: keyof typeof ICONS;
  size?: keyof typeof PIXELS;
  className?: string;
}) {
  const px = PIXELS[size];

  if (!url) {
    const Icon = ICONS[icon];
    return (
      <span
        aria-hidden="true"
        data-testid="image-thumb-empty"
        className={`flex shrink-0 items-center justify-center rounded bg-muted text-muted-foreground ${className ?? ''}`}
        style={{ width: px, height: px }}
      >
        <Icon className="size-4" />
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
      data-testid="image-thumb"
      className={`shrink-0 rounded bg-muted object-cover ${className ?? ''}`}
    />
  );
}
