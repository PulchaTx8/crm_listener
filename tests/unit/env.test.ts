import { describe, it, expect } from 'vitest';
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
