import { describe, it, expect } from 'vitest';
import { InMemoryRateLimiter } from '@/lib/rate-limit';

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
});
