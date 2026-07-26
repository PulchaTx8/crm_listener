import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '@/lib/logger';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => chunks.join('').trim().split('\n').map((l) => JSON.parse(l)) };
}

describe('logger', () => {
  it('redige campos sensíveis', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.info({ password: 'segredo', cpf: '12345678900', ok: 1 }, 'evento');
    const [entry] = lines();
    expect(entry!.password).toBe('[REDACTED]');
    expect(entry!.cpf).toBe('[REDACTED]');
    expect(entry!.ok).toBe(1);
  });

  it('inclui correlationId via withCorrelation', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream).withCorrelation('req-123');
    log.info('oi');
    expect(lines()[0]!.correlationId).toBe('req-123');
  });
});
