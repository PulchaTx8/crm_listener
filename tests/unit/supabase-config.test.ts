import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('supabase config', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SKIP_ENV_VALIDATION = '1';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  });

  it('user config uses url + anon key', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    const { getUserSupabaseConfig } = await import('@/lib/supabase/config');
    expect(getUserSupabaseConfig()).toEqual({ url: 'https://abc.supabase.co', anonKey: 'anon' });
  });

  it('service config throws without a service role', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { getServiceSupabaseConfig } = await import('@/lib/supabase/config');
    expect(() => getServiceSupabaseConfig()).toThrow(/service role/i);
  });
});
