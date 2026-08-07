/**
 * Block 14. What a promotion's or a prize's picture may be.
 *
 * MUST agree with `supabase/migrations/0143_artwork_bucket.sql`, which is the
 * real barrier, and with `supabase/tests/29_artwork_bucket.test.sql`, which
 * asserts the bucket half so the two cannot drift apart unnoticed. This file
 * exists so the operator reads a sentence instead of a raw Storage error.
 *
 * THE TWO KINDS ARE NOT THE SAME PICTURE. A `thumb` identifies a record inside
 * this system and is never sent anywhere; a `banner` is fetched by Meta and
 * shown to listeners. They share a bucket and nothing else.
 *
 * NO MAGIC-BYTE SNIFFING BEYOND THE SIZE, deliberately, for the reason
 * uploads.ts gives about receipts: what makes a stored object dangerous is the
 * Content-Type it is SERVED with, and that now comes from the closed list
 * below. The dimensions ARE read from the bytes, because no bucket can express
 * a pixel ceiling and a lying file would otherwise be measured by nothing.
 */
import type { ImageDimensions } from './image-dimensions';

export type ArtworkKind = 'thumb' | 'banner';

/** Meta's, for an image message. The bucket enforces it (0143). */
export const ARTWORK_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Meta's list, and the whole of it: an image message is JPEG or PNG. WebP and
 * HEIC are deliberately absent -- HEIC is what an iPhone hands over, and
 * accepting it here would move the failure to the moment of sending, where
 * nothing points back at this field.
 */
const ARTWORK_TYPES = ['image/jpeg', 'image/png'] as const;

/** For the file picker. Convenience, not a defence: it filters a dialog. */
export const ARTWORK_ACCEPT = ARTWORK_TYPES.join(',');

/**
 * OURS, NOT META'S. The Cloud API publishes no pixel limit for an image
 * message; the 1.91:1 / 1125x600 figure that circulates belongs to template and
 * carousel media. This ceiling exists to stop a forty-megapixel phone
 * photograph being pushed through a message header, and to keep a list of fifty
 * rows from downloading fifty full-size pictures. Anything asserting Meta
 * requires it would be false.
 */
export const ARTWORK_MAX_PIXELS: Record<ArtworkKind, number> = {
  thumb: 512,
  banner: 1920,
};

export function isArtworkType(mime: string): boolean {
  return (ARTWORK_TYPES as readonly string[]).includes(mime);
}

/** The reason to refuse, in a sentence, or null when the picture is fine. */
export function describeArtworkRejection(
  kind: ArtworkKind,
  file: { type: string; size: number },
  dimensions: ImageDimensions | null,
): string | null {
  if (file.size > ARTWORK_MAX_BYTES) {
    const megabytes = Math.round(file.size / (1024 * 1024));
    return `That file is ${megabytes} MB. An image may be at most 5 MB.`;
  }
  if (!isArtworkType(file.type)) {
    return 'An image must be a JPEG or a PNG. WhatsApp accepts nothing else, so an iPhone photograph saved as HEIC has to be exported first.';
  }
  if (!dimensions) {
    // Refused rather than stored unmeasured: a file calling itself a JPEG whose
    // bytes no reader recognises is not one, and Meta would fetch something it
    // cannot render.
    return 'That image could not be read. Save it again as a JPEG or a PNG.';
  }
  // The LONGEST side, not the width. A portrait photograph is exactly what a
  // width-only check waves through, and it is the commonest thing a phone
  // produces.
  const ceiling = ARTWORK_MAX_PIXELS[kind];
  const longest = Math.max(dimensions.width, dimensions.height);
  if (longest > ceiling) {
    const noun = kind === 'thumb' ? 'A thumbnail' : 'A banner';
    return `That image is ${dimensions.width}×${dimensions.height} pixels. ${noun} may be at most ${ceiling} pixels on its longest side.`;
  }
  return null;
}
