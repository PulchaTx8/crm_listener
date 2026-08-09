import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { hashToken, parseBearer } from '@/lib/api/credentials';

describe('parseBearer', () => {
  it('reads the token out of a well-formed header', () => {
    expect(parseBearer('Bearer ptx_abc123')).toBe('ptx_abc123');
  });

  it('accepts the scheme in any case, because RFC 7235 says it is case-insensitive', () => {
    expect(parseBearer('bearer ptx_abc123')).toBe('ptx_abc123');
  });

  it('refuses a missing header', () => {
    expect(parseBearer(null)).toBeNull();
  });

  it('refuses another scheme rather than treating its value as a token', () => {
    expect(parseBearer('Basic ptx_abc123')).toBeNull();
  });

  it('refuses an empty token', () => {
    expect(parseBearer('Bearer   ')).toBeNull();
  });
});

describe('hashToken', () => {
  it('is lowercase hex sha-256, which is the shape the column CHECK accepts', () => {
    const token = 'ptx_whatever';
    expect(hashToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
    // api_credentials_hash_shape (0148) refuses anything else.
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
