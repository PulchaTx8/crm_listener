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
  it('redacts sensitive fields', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.info({ password: 'secret', cpf: '12345678900', ok: 1 }, 'event');
    const [entry] = lines();
    expect(entry!.password).toBe('[REDACTED]');
    expect(entry!.cpf).toBe('[REDACTED]');
    expect(entry!.ok).toBe(1);
  });

  // The `senha` key is intentionally still exercised: `src/lib/logger.ts` keeps
  // the Portuguese field names because the legacy database being migrated uses
  // them. Dropping this case would let that redaction regress unnoticed.
  it('redacts the fields of a Supabase Auth session', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.info(
      {
        access_token: 'eyJhbGciOi.SENTINEL',
        refresh_token: 'rt-SENTINEL',
        accessToken: 'camelCase-SENTINEL',
        apiKey: 'ak-SENTINEL',
        senha: 'my-password',
        expires_in: 3600,
      },
      'session',
    );
    const [entry] = lines();
    expect(entry!.access_token).toBe('[REDACTED]');
    expect(entry!.refresh_token).toBe('[REDACTED]');
    expect(entry!.accessToken).toBe('[REDACTED]');
    expect(entry!.apiKey).toBe('[REDACTED]');
    expect(entry!.senha).toBe('[REDACTED]');
    expect(entry!.expires_in).toBe(3600);
    expect(JSON.stringify(entry)).not.toContain('SENTINEL');
    expect(JSON.stringify(entry)).not.toContain('my-password');
  });

  it('redacts at arbitrary depth and ignoring capitalization', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.info(
      {
        session: {
          access_token: 'level-2-SENTINEL',
          user: { id: 'u1', cpf: '12345678900', Authorization: 'Bearer SENTINEL' },
        },
        req: { headers: { Authorization: 'Bearer SENTINEL' } },
        env: { SUPABASE_SERVICE_ROLE_KEY: 'srk-SENTINEL' },
        list: [{ deep: { passport: 'AB123456' } }],
      },
      'nested',
    );
    const [entry] = lines();
    const session = entry!.session as Record<string, unknown>;
    const user = session.user as Record<string, unknown>;
    expect(session.access_token).toBe('[REDACTED]');
    expect(user.cpf).toBe('[REDACTED]');
    expect(user.Authorization).toBe('[REDACTED]');
    expect(user.id).toBe('u1');
    expect(
      ((entry!.req as Record<string, unknown>).headers as Record<string, unknown>)!.Authorization,
    ).toBe('[REDACTED]');
    expect((entry!.env as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY).toBe('[REDACTED]');
    expect(JSON.stringify(entry)).not.toContain('SENTINEL');
    expect(JSON.stringify(entry)).not.toContain('AB123456');
  });

  it("preserves pino's Error serializer", () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.error({ err: new Error('failed badly') }, 'error');
    const [entry] = lines();
    expect((entry!.err as Record<string, unknown>).message).toBe('failed badly');
    expect((entry!.err as Record<string, unknown>).type).toBe('Error');
  });

  it('includes correlationId via withCorrelation', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream).withCorrelation('req-123');
    log.info('hi');
    expect(lines()[0]!.correlationId).toBe('req-123');
  });
});
