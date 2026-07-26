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

  it('redige os campos de uma sessão do Supabase Auth', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.info(
      {
        access_token: 'eyJhbGciOi.SEGREDO',
        refresh_token: 'rt-SEGREDO',
        accessToken: 'camelCase-SEGREDO',
        apiKey: 'ak-SEGREDO',
        senha: 'minha-senha',
        expires_in: 3600,
      },
      'sessão',
    );
    const [entry] = lines();
    expect(entry!.access_token).toBe('[REDACTED]');
    expect(entry!.refresh_token).toBe('[REDACTED]');
    expect(entry!.accessToken).toBe('[REDACTED]');
    expect(entry!.apiKey).toBe('[REDACTED]');
    expect(entry!.senha).toBe('[REDACTED]');
    expect(entry!.expires_in).toBe(3600);
    expect(JSON.stringify(entry)).not.toContain('SEGREDO');
    expect(JSON.stringify(entry)).not.toContain('minha-senha');
  });

  it('redige em profundidade arbitrária e ignorando capitalização', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.info(
      {
        session: {
          access_token: 'nivel-2-SEGREDO',
          user: { id: 'u1', cpf: '12345678900', Authorization: 'Bearer SEGREDO' },
        },
        req: { headers: { Authorization: 'Bearer SEGREDO' } },
        env: { SUPABASE_SERVICE_ROLE_KEY: 'srk-SEGREDO' },
        lista: [{ deep: { passport: 'AB123456' } }],
      },
      'aninhado',
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
    expect(JSON.stringify(entry)).not.toContain('SEGREDO');
    expect(JSON.stringify(entry)).not.toContain('AB123456');
  });

  it('preserva o serializer de Error do pino', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.error({ err: new Error('falhou feio') }, 'erro');
    const [entry] = lines();
    expect((entry!.err as Record<string, unknown>).message).toBe('falhou feio');
    expect((entry!.err as Record<string, unknown>).type).toBe('Error');
  });

  it('inclui correlationId via withCorrelation', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream).withCorrelation('req-123');
    log.info('oi');
    expect(lines()[0]!.correlationId).toBe('req-123');
  });
});
