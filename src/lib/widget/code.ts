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
 * What a rate-limit counter is keyed by, instead of the thing itself.
 *
 * `rate_limit_counters.key` is an ordinary column in an ordinary table: it is
 * read by anybody with database access, it is in every backup, and
 * `sweep_retention` keeps a row for thirty days after its window closes. A
 * telephone number or an IP address written into it verbatim is personal data
 * held in a place with no consent behind it and no screen that shows it -- and
 * a telephone number in particular has its own thirty-day rule (0161) that a
 * counter row does not honour.
 *
 * SHA-256 TRUNCATED TO 32 HEX CHARACTERS, which is `hashIpAddress`
 * (src/services/contact-requests.ts) exactly -- both anonymous limiters this
 * product already had hash their subject before keying on it, and
 * docs/SECURITY.md Sec.9 states it as the rule rather than as those two
 * functions' habit. Copied rather than imported: contact-requests.ts is a
 * service module that pulls in the SMTP mailer and a Supabase client, and
 * importing it into a widget server action to reach one four-line digest would
 * drag both into a route an anonymous visitor reaches.
 *
 * 128 bits is not a credential-strength bound and does not need to be: a
 * collision costs two callers a shared bucket, which is stricter than either
 * deserved rather than a way through. What it has to be is STABLE -- the same
 * caller must land in the same bucket every time, which is why this is a plain
 * digest and not a salted or keyed one.
 *
 * NORMALISE BEFORE HASHING, always: a digest of '+55 11 99999-8888' and a
 * digest of '5511999998888' are two unrelated strings, so hashing first would
 * hand one person two budgets. Callers do the normalising because what counts
 * as the same subject differs per kind -- see `phoneKey` in the widget's
 * actions.
 */
export function hashLimitSubject(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
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
