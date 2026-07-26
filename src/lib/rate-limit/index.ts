import type { SupabaseClient } from '@supabase/supabase-js';

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: Date };

export interface RateLimiter {
  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const t = this.now();
    const existing = this.buckets.get(key);
    let bucket = existing;
    if (!bucket || t >= bucket.resetAt) {
      bucket = { count: 0, resetAt: t + windowSeconds * 1000 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) {
      return { allowed: false, remaining: 0, resetAt: new Date(bucket.resetAt) };
    }
    bucket.count += 1;
    return { allowed: true, remaining: limit - bucket.count, resetAt: new Date(bucket.resetAt) };
  }
}

export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly client: SupabaseClient) {}
  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const { data, error } = await this.client.rpc('rate_limit_hit', {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return { allowed: row.allowed, remaining: row.remaining, resetAt: new Date(row.reset_at) };
  }
}
