import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseEnv, parseLooseEnv } from '@/lib/env';

const valid = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
} as NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('accepts a valid environment', () => {
    const env = parseEnv(valid);
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co');
  });

  it('throws when a required variable is missing', () => {
    const { SUPABASE_SERVICE_ROLE_KEY: _omit, ...rest } = valid;
    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('throws when the supabase URL is invalid', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' })).toThrow();
  });

  it('treats an empty value as missing, not as invalid', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_SUPABASE_URL: '' })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
  });
});

// The Dockerfile declares NEXT_PUBLIC_* as build args and exports them
// unconditionally, so an image built without them arrives here with empty
// strings rather than absent keys. Treating those as garbage rather than as
// absence is what broke `docker build`: page-data collection imports env.ts.
describe('parseLooseEnv', () => {
  it('tolerates empty build args the way it tolerates absent ones', () => {
    const parsed = parseLooseEnv({
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: '',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
    } as NodeJS.ProcessEnv);

    expect(parsed.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
    expect(parsed.NODE_ENV).toBe('production');
  });

  it('still rejects a value that is present and malformed', () => {
    expect(() =>
      parseLooseEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'not-a-url',
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

// The module is imported by `src/instrumentation.ts`, so the module-level throw
// is what keeps the server from starting. These tests pin that contract.
// `vitest.config.ts` sets SKIP_ENV_VALIDATION=1 globally — each case overrides
// process.env and restores it afterwards.
describe('validation at module import', () => {
  const snapshot = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  });

  it('throws when importing the module with an invalid environment', async () => {
    vi.resetModules();
    delete process.env.SKIP_ENV_VALIDATION;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

    await expect(import('@/lib/env')).rejects.toThrow(/Invalid environment configuration/);
  });

  it('does not throw when importing with a valid environment', async () => {
    vi.resetModules();
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

    const mod = await import('@/lib/env');
    expect(mod.env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co');
  });

  it('under SKIP_ENV_VALIDATION tolerates absence and applies the NODE_ENV default', async () => {
    vi.resetModules();
    process.env.SKIP_ENV_VALIDATION = '1';
    // NODE_ENV is readonly in @types/node — a direct `delete` does not compile.
    Reflect.deleteProperty(process.env, 'NODE_ENV');
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const mod = await import('@/lib/env');
    expect(mod.env.NODE_ENV).toBe('development');
    expect(mod.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });
});
