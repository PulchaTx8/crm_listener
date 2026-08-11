import { headers } from 'next/headers';
import { logger } from '@/lib/logger';
import type { PostgresRateLimiter } from '@/lib/rate-limit';
import { hashLimitSubject } from '@/lib/widget/code';

/**
 * The ceilings a widget door cannot enforce for itself, because the database
 * has no idea what an IP address is (0161's own comment says so).
 *
 * MOVED HERE BY BLOCK 17b, out of `(widget)/w/[publicKey]/actions.ts`. That
 * file carries `'use server'` and may therefore export nothing but async
 * functions, so a second set of actions could not borrow these. See
 * `door-answer.ts` for the same reasoning at more length.
 */

export type Limit = { limit: number; windowSeconds: number };

/**
 * One bucket: what the counter is keyed by, and what a log line is allowed to
 * say about it.
 *
 * THE TWO ARE SEPARATE FIELDS ON PURPOSE, and the digest in `ipKey` does not
 * make it redundant. A digest is still a stable per-person identifier: two log
 * lines carrying the same one say "the same caller". What an operator needs is
 * WHICH LIMIT refused, which the label answers on its own, so the key never
 * travels into a log even hashed.
 */
export type Bucket = Limit & { key: string; label: string };

/** The caller's address, or 'unknown' when nothing forwarded one. */
export async function callerIp(): Promise<string> {
  const headerList = await headers();
  return headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

/**
 * An address, as something a counter row may hold.
 *
 * No normalisation step, unlike a telephone number: an address arrives from
 * `x-forwarded-for` already in one canonical spelling per caller, so there is
 * nothing to fold together first. 'unknown' hashes like any other value, so
 * that shared bucket keeps working exactly as it did.
 *
 * WHY IT IS HASHED AT ALL: `rate_limit_counters.key` is a plain column, kept
 * for thirty days after its window closes and present in every backup.
 * docs/SECURITY.md §9 states it as the rule, and both of this product's other
 * anonymous limiters already follow it.
 */
export function ipKey(ip: string): string {
  return hashLimitSubject(ip);
}

/**
 * The label of the bucket that refused, or null when every one allowed. Stops
 * at the first refusal, so a refused request does not spend the budget of the
 * limits after it.
 *
 * IT LOGS, AND THAT IS WHY IT RETURNS A LABEL RATHER THAN A BOOLEAN. A refusal
 * here was once the only outcome in the whole flow that produced nothing at all
 * — and the most important one to see: a Station ceiling hit means either a
 * script is billing this customer or real listeners are being turned away
 * during a promotion somebody just read out on air, and neither is discoverable
 * from an empty log. `warn` rather than `error` because a refused limit is the
 * system working.
 */
export async function withinLimits(
  limiter: PostgresRateLimiter,
  publicKey: string,
  buckets: readonly Bucket[],
): Promise<string | null> {
  for (const bucket of buckets) {
    try {
      const { allowed } = await limiter.check(bucket.key, bucket.limit, bucket.windowSeconds);
      if (!allowed) {
        logger.warn({ publicKey, bucket: bucket.label }, 'widget: a limit refused a request');
        return bucket.label;
      }
    } catch (cause) {
      // A LIMITER THAT CANNOT ANSWER REFUSES. The tempting branch is to let the
      // request through "so an outage in the counters does not break the
      // widget" — which turns the one hour when nobody is watching into the one
      // hour with no ceiling on the Station's Meta bill. Failing closed costs a
      // visitor a retry; failing open costs money nobody sees until the invoice.
      //
      // The BUCKET, never the key: this line fires during an outage, which is
      // precisely when logs are being read, copied into a ticket and shipped to
      // whoever is on call.
      logger.error(
        { err: cause, publicKey, bucket: bucket.label },
        'widget: the rate limiter could not answer',
      );
      return bucket.label;
    }
  }
  return null;
}
