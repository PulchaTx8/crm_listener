/**
 * Block 11b, D7-D9. What a delivery receipt may be.
 *
 * MUST agree with `supabase/migrations/0134_bucket_limits.sql`, which is the
 * real barrier: this file exists so the operator reads a sentence instead of a
 * raw Storage error, and `supabase/tests/26_bucket_limits.test.sql` asserts the
 * bucket half so the two cannot drift apart unnoticed.
 *
 * NO MAGIC-BYTE SNIFFING, deliberately. What makes a stored object dangerous is
 * the Content-Type it is SERVED with, not the bytes inside it: HTML stored as
 * image/jpeg is inert in a browser. Since the stored type now comes from the
 * closed list below, a lying file is junk rather than script -- and reading
 * every file's header would cost code and tests to buy nothing.
 */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

const RECEIPT_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};

/** For the file picker. Convenience, not a defence: it filters a dialog. */
export const RECEIPT_ACCEPT = Object.keys(RECEIPT_TYPES).join(',');

/**
 * D8. The stored extension comes from the validated type, never from the
 * client's filename -- which is a string that would otherwise go straight into
 * a storage key. Deriving it here ends the whole class of question without
 * anybody having to reason about which strange filename does what.
 */
export function receiptExtension(mime: string): string | null {
  return RECEIPT_TYPES[mime] ?? null;
}

/** The reason to refuse, in a sentence, or null when the file is fine. */
export function describeReceiptRejection(file: { type: string; size: number }): string | null {
  if (file.size > RECEIPT_MAX_BYTES) {
    const megabytes = Math.round(file.size / (1024 * 1024));
    return `That file is ${megabytes} MB. A receipt may be at most 10 MB.`;
  }
  if (!receiptExtension(file.type)) {
    return 'A receipt must be an image (JPEG, PNG, WebP or HEIC) or a PDF.';
  }
  return null;
}
