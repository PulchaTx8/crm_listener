import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs the RAW request body with the App Secret and sends the digest in
 * `X-Hub-Signature-256`. The caller must pass the bytes it actually received —
 * a body that was parsed and re-serialised has different whitespace and key
 * order, so its HMAC will not match, and the usual response to that failure is
 * to switch the check off. `tests/unit/whatsapp-signature.test.ts` asserts the
 * failure so it is a caught mistake rather than a mysterious one.
 *
 * Returns false for every malformed input instead of throwing: this runs on an
 * unauthenticated route, and an exception there is a different status code and
 * a stack trace in a log.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(header.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }

  // timingSafeEqual throws on a length mismatch, which would leak the length
  // through an exception rather than a comparison.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
