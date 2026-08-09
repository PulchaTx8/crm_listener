import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { hashToken, parseBearer } from '@/lib/api/credentials';
import { generateApiKey } from '@/services/api-credentials';

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

describe('generateApiKey', () => {
  it('mints a prefixed secret whose prefix and hash line up with it', () => {
    const key = generateApiKey();
    // 32 bytes of base64url is 43 characters, and none of them need escaping in
    // a header or a shell.
    expect(key.secret).toMatch(/^ptx_[A-Za-z0-9_-]{43}$/);
    expect(key.prefix).toBe(key.secret.slice(0, 12));
    // The two CHECK constraints in 0148 accept exactly these shapes.
    expect(key.prefix).toMatch(/^ptx_[A-Za-z0-9_-]{8}$/);
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.hash).toBe(hashToken(key.secret));
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateApiKey().secret));
    expect(seen.size).toBe(50);
  });
});
