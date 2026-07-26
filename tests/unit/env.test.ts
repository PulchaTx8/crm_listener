import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseEnv } from '@/lib/env';

const valid = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
} as NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('aceita ambiente válido', () => {
    const env = parseEnv(valid);
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co');
  });

  it('lança quando falta variável obrigatória', () => {
    const { SUPABASE_SERVICE_ROLE_KEY: _omit, ...rest } = valid;
    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('lança quando a URL do supabase é inválida', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' })).toThrow();
  });
});

// O módulo é importado por `src/instrumentation.ts`, então o throw no topo do
// módulo é o que impede o servidor de subir. Estes testes travam esse contrato.
// `vitest.config.ts` define SKIP_ENV_VALIDATION=1 globalmente — cada caso
// sobrescreve o process.env e restaura depois.
describe('validação no import do módulo', () => {
  const snapshot = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  });

  it('lança ao importar o módulo com ambiente inválido', async () => {
    vi.resetModules();
    delete process.env.SKIP_ENV_VALIDATION;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

    await expect(import('@/lib/env')).rejects.toThrow(/Configuração de ambiente inválida/);
  });

  it('não lança ao importar com ambiente válido', async () => {
    vi.resetModules();
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

    const mod = await import('@/lib/env');
    expect(mod.env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co');
  });

  it('sob SKIP_ENV_VALIDATION tolera ausência e aplica o default de NODE_ENV', async () => {
    vi.resetModules();
    process.env.SKIP_ENV_VALIDATION = '1';
    // NODE_ENV é readonly no @types/node — `delete` direto não compila.
    Reflect.deleteProperty(process.env, 'NODE_ENV');
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const mod = await import('@/lib/env');
    expect(mod.env.NODE_ENV).toBe('development');
    expect(mod.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });
});
