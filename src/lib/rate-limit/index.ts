import type { SupabaseClient } from '@supabase/supabase-js';

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: Date };

// Every N `check()` calls triggers the InMemoryRateLimiter sweep of expired
// buckets (O(n) cost amortized over N calls, instead of O(n) on every call or
// unbounded memory growth).
export const RATE_LIMIT_SWEEP_INTERVAL = 128;

export interface RateLimiter {
  /**
   * Contract: a blocked call still consumes budget from the current window, up
   * to a saturation point of `limit + 1` (the counter does not grow without
   * bound) — and never extends `resetAt`; the end of the window is fixed by the
   * first call that opens it.
   */
  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, Bucket>();
  private checksSinceSweep = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Exposed only to inspect the sweep in tests; this is not an eviction API. */
  get bucketCount(): number {
    return this.buckets.size;
  }

  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const t = this.now();
    this.sweepExpired(t);
    const existing = this.buckets.get(key);
    let bucket = existing;
    if (!bucket || t >= bucket.resetAt) {
      bucket = { count: 0, resetAt: t + windowSeconds * 1000 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count <= limit) bucket.count += 1; // saturates at limit + 1
    const allowed = bucket.count <= limit;
    return {
      allowed,
      remaining: Math.max(limit - bucket.count, 0),
      resetAt: new Date(bucket.resetAt),
    };
  }

  private sweepExpired(t: number): void {
    this.checksSinceSweep += 1;
    if (this.checksSinceSweep < RATE_LIMIT_SWEEP_INTERVAL) return;
    this.checksSinceSweep = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= t) this.buckets.delete(key);
    }
  }
}

type RateLimitHitRow = { allowed: boolean; remaining: number; reset_at: string };

/**
 * Postgres implementation via the `rate_limit_hit` RPC (see
 * `supabase/migrations/0002_rate_limit.sql`). The `rate_limit_counters` table
 * has RLS enabled and no policies, with grants revoked from `anon` and
 * `authenticated` — only a `service_role` client can write/read the counters.
 * That is why this constructor MUST be given a client created by
 * `createServiceClient()` (`@/lib/supabase/service-client`, D4); never a user
 * client.
 */
export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly client: SupabaseClient) {}
  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const { data, error } = await this.client.rpc('rate_limit_hit', {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) throw error;
    const rows: RateLimitHitRow[] | RateLimitHitRow | null = data;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error('rate_limit_hit returned no row');
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      resetAt: new Date(row.reset_at),
    };
  }
}
