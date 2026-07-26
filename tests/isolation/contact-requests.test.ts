import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { submitContactRequest, hashIpAddress } from '@/services/contact-requests';
import { RateLimitError } from '@/lib/errors';
import { admin } from './harness';

/**
 * The contact form is the only unauthenticated write in the system, which makes
 * it the abuse surface. Block 0 built the rate limiter and unit-tested it in
 * isolation; what is unproven until here is the wiring — that this endpoint
 * actually consults it, against the real table, with the real limits.
 */
const MAX_PER_WINDOW = 5;

function input(n: number) {
  return {
    name: `Visitor ${n}`,
    email: `visitor-${n}@example.test`,
    message: 'Please tell me about PulchatX.',
  };
}

describe('contact request intake', () => {
  it('accepts up to the limit and refuses the next one from the same IP', async () => {
    // Unique per run so repeated runs do not inherit a spent window.
    const ip = `203.0.113.${Math.floor(Date.now() % 200) + 1}-${Date.now()}`;

    for (let n = 1; n <= MAX_PER_WINDOW; n += 1) {
      await expect(submitContactRequest(input(n), ip)).resolves.toBeUndefined();
    }

    await expect(submitContactRequest(input(MAX_PER_WINDOW + 1), ip)).rejects.toBeInstanceOf(
      RateLimitError,
    );

    const { data } = await admin
      .from('contact_requests')
      .select('id, ip_hash')
      .eq('ip_hash', hashIpAddress(ip));

    // The refused one was never stored.
    expect((data ?? []).length).toBe(MAX_PER_WINDOW);
  });

  it('stores a hash, never the raw address', async () => {
    const ip = `198.51.100.${Date.now() % 250}`;
    await submitContactRequest(input(99), ip);

    const { data } = await admin
      .from('contact_requests')
      .select('ip_hash')
      .eq('ip_hash', hashIpAddress(ip))
      .limit(1)
      .single();

    expect(data?.ip_hash).not.toContain(ip);
    expect(data?.ip_hash).toBe(hashIpAddress(ip));
  });

  it('lets anon submit but never read back', async () => {
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const { error: insertError } = await anon
      .from('contact_requests')
      .insert({ name: 'Stranger', email: 'stranger@example.test' });
    expect(insertError).toBeNull();

    const { data, error } = await anon.from('contact_requests').select('id, email');
    expect(error ?? data?.length === 0).toBeTruthy();
  });
});
