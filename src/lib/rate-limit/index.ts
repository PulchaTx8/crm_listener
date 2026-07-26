import type { SupabaseClient } from '@supabase/supabase-js';

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: Date };

// Chamadas a cada N `check()` disparam a varredura de buckets expirados do
// InMemoryRateLimiter (custo O(n) amortizado sobre N chamadas, em vez de
// O(n) a cada chamada ou vazamento indefinido de memória).
export const RATE_LIMIT_SWEEP_INTERVAL = 128;

export interface RateLimiter {
  /**
   * Contrato: uma chamada bloqueada ainda consome orçamento da janela atual,
   * até um ponto de saturação de `limit + 1` (o contador não cresce sem
   * limite) — e nunca estende `resetAt`; o fim da janela é fixado na
   * primeira chamada que a abre.
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

  /** Exposto só para inspeção em teste da varredura; não é uma API de eviction. */
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
    if (bucket.count <= limit) bucket.count += 1; // satura em limit + 1
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
 * Implementação Postgres via RPC `rate_limit_hit` (ver
 * `supabase/migrations/0002_rate_limit.sql`). A tabela `rate_limit_counters`
 * tem RLS habilitada e sem policies, com grants revogados de `anon` e
 * `authenticated` — só um client `service_role` consegue gravar/ler os
 * contadores. Por isso este construtor DEVE receber um client criado por
 * `createServiceClient()` (`@/lib/supabase/service-client`, D4); nunca um
 * client de usuário.
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
    if (!row) throw new Error('rate_limit_hit não retornou linha');
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      resetAt: new Date(row.reset_at),
    };
  }
}
