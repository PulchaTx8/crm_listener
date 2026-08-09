import 'server-only';
import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * A six-digit verification code, as a decimal STRING with any leading zeros
 * intact.
 *
 * NOT `String(randomInt(0, 999999))`. `randomInt` draws uniformly across the
 * whole range, so about a tenth of draws land below 100000 and stringify to
 * five digits, and a hundredth land below 10000 and stringify to four --
 * '000123' would silently never come out of that path. Nothing throws when
 * that happens; the SMS just carries a code narrower than the six boxes the
 * widget renders for it, and a listener occasionally cannot type a match.
 * `padStart` keeps every draw exactly six characters, which is also what
 * `hashCode` below and 0161's CHECK on the stored hash both assume.
 */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * SHA-256, lowercase hex -- the same contract as `hashToken`
 * (src/lib/api/credentials.ts), for the same reason: `widget_verifications
 * .code_hash` (0161) mirrors `api_credentials.token_hash` (0148), and the raw
 * code must never reach the database, not even as an RPC argument -- an
 * argument passed to an RPC lands in query logs and in backups, which is
 * exactly the exposure hashing here is meant to avoid.
 */
export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * `pw_` + 16 random bytes, base64url.
 *
 * 16 bytes is 128 bits, and Node's base64url encoding of 16 bytes is always
 * exactly 22 characters with no `=` padding -- the precise width
 * `widget_installations_key_shape` (0159, `^pw_[A-Za-z0-9_-]{22}$`) requires,
 * not an approximation of it. The test asserts the shape on every draw rather
 * than trusting this arithmetic once.
 *
 * NOT a secret (0159's own column comment says so in writing): it travels in
 * the `src` of a public `<iframe>`. It only needs to be unguessable enough to
 * not collide, which 128 random bits already is by a wide margin -- this is
 * not sized as a credential.
 */
export function generatePublicKey(): string {
  return `pw_${randomBytes(16).toString('base64url')}`;
}
