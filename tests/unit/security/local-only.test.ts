import { describe, expect, it } from 'vitest';
import { assertLocalSupabase } from '@/lib/security/local-only';

describe('the local-only guard', () => {
  it.each(['http://127.0.0.1:54321', 'http://localhost:54321', 'http://127.0.0.1:54321/'])(
    'allows %s',
    (url) => {
      expect(() => assertLocalSupabase(url)).not.toThrow();
    },
  );

  it('refuses a hosted project by name', () => {
    // The whole point. A demo Station inside a customer's database is damage
    // nobody undoes, and the seed is the one script that writes invented data.
    expect(() => assertLocalSupabase('https://djbkdyesubkedxjwcohq.supabase.co')).toThrow(/local/i);
  });

  it('refuses an unset url rather than guessing', () => {
    expect(() => assertLocalSupabase(undefined)).toThrow();
  });

  it('is not fooled by a hosted host that merely mentions localhost', () => {
    // Substring matching would pass this, and it is a hostname somebody can buy.
    expect(() => assertLocalSupabase('https://localhost.evil.example')).toThrow();
  });
});
