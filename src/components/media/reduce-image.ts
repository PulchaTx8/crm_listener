import { ARTWORK_MAX_PIXELS } from '@/lib/security/artwork';

/**
 * A picked photograph, made small enough to be a thumbnail.
 *
 * ONLY for the `thumb` kind. A banner is never rewritten: it is promotional
 * artwork somebody drew at a size they chose, and silently re-encoding it would
 * be this system deciding it knows better. A 32-pixel identifier has no such
 * claim on anybody, and the operator who picks a phone photograph for one
 * should not have to open an image editor first.
 *
 * Exports JPEG regardless of what came in, and renames to `.jpg` to match.
 * `toBlob('image/png')` on a photograph produces a file several times larger
 * than the original for no visible gain at 32 pixels, and a filename that
 * disagrees with the bytes is the confusion this whole block avoids by keying
 * without an extension.
 */
export async function reduceToThumb(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const ceiling = ARTWORK_MAX_PIXELS.thumb;
  const longest = Math.max(bitmap.width, bitmap.height);
  // Never scaled UP. A picture already smaller than the ceiling is re-encoded
  // at its own size rather than stretched, which would cost bytes to lose
  // detail.
  const scale = longest > ceiling ? ceiling / longest : 1;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not prepare the picture.');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.85),
  );
  if (!blob) throw new Error('This browser could not prepare the picture.');

  const base = file.name.replace(/\.[^.]+$/, '') || 'image';
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
}
