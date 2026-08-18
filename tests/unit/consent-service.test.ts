import { describe, expect, it } from 'vitest';
import { newUnsubscribeToken, unsubscribeTokenHash } from '@/services/consent';

describe('the unsubscribe token', () => {
  it('hashes to the shape the column constrains', () => {
    // unsubscribe_tokens.token_hash carries check (token_hash ~ '^[0-9a-f]{64}$').
    // A hash of a different width or case would be refused by the database at
    // insert time -- on a send, in production, for every recipient at once.
    expect(unsubscribeTokenHash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic, because the link is hashed twice — minting and spending', () => {
    expect(unsubscribeTokenHash('same')).toBe(unsubscribeTokenHash('same'));
  });

  it('mints a raw token that is not the hash', () => {
    // The raw value goes in the URL and the hash goes in the table. Returning
    // the same string for both would put the stored secret in every e-mail.
    const { raw, hash } = newUnsubscribeToken();
    expect(raw).not.toBe(hash);
    expect(unsubscribeTokenHash(raw)).toBe(hash);
  });

  it('mints a different token every time', () => {
    const a = newUnsubscribeToken().raw;
    const b = newUnsubscribeToken().raw;
    expect(a).not.toBe(b);
  });
});
