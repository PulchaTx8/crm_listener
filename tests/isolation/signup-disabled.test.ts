import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * PulchatX is sold by subscription and provisioning is the only way in. Omitting
 * a signup page stops nobody — the Auth API accepts signUp from any origin while
 * the setting is on. This test fails if it is ever turned back on.
 */
describe('public signup', () => {
  it('is refused by the Auth API', async () => {
    const anon = createClient(url, anonKey);
    const { data, error } = await anon.auth.signUp({
      email: `intruder-${Date.now()}@example.com`,
      password: 'a-perfectly-valid-password',
    });

    expect(error).not.toBeNull();
    expect(data.user).toBeNull();
  });
});
