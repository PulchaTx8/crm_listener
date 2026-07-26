import { describe, it, expect } from 'vitest';
import { InMemoryRateLimiter, RATE_LIMIT_SWEEP_INTERVAL } from '@/lib/rate-limit';

describe('InMemoryRateLimiter', () => {
  it('permite até o limite e bloqueia depois, dentro da janela', async () => {
    let t = 1_000_000;
    const rl = new InMemoryRateLimiter(() => t);
    expect((await rl.check('k', 2, 60)).allowed).toBe(true);
    expect((await rl.check('k', 2, 60)).allowed).toBe(true);
    const third = await rl.check('k', 2, 60);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it('reseta após a janela', async () => {
    let t = 1_000_000;
    const rl = new InMemoryRateLimiter(() => t);
    await rl.check('k', 1, 60);
    expect((await rl.check('k', 1, 60)).allowed).toBe(false);
    t += 61_000;
    expect((await rl.check('k', 1, 60)).allowed).toBe(true);
  });

  it('satura em limit + 1: uma chamada bloqueada com limite baixo não impede uma chamada seguinte, na mesma janela, com limite maior', async () => {
    const t = 1_000_000;
    const rl = new InMemoryRateLimiter(() => t);
    await rl.check('k2', 2, 60);
    await rl.check('k2', 2, 60);
    const blocked = await rl.check('k2', 2, 60); // satura o contador em limit + 1 = 3
    expect(blocked.allowed).toBe(false);

    const higher = await rl.check('k2', 5, 60);
    expect(higher.allowed).toBe(true);
    expect(higher.remaining).toBe(1);
  });

  it('varre buckets expirados periodicamente, liberando memória sem escanear tudo a cada chamada', async () => {
    let t = 1_000_000;
    const rl = new InMemoryRateLimiter(() => t);
    for (let i = 0; i < 200; i++) {
      await rl.check(`key-${i}`, 1, 60);
    }
    expect(rl.bucketCount).toBe(200);

    t += 61_000; // expira todos os buckets criados acima
    for (let i = 0; i < RATE_LIMIT_SWEEP_INTERVAL; i++) {
      await rl.check('sweep-trigger', 1, 60);
    }
    expect(rl.bucketCount).toBeLessThan(200);
  });
});
