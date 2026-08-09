import { describe, expect, it } from 'vitest';
import { generateCode, generatePublicKey, hashCode, hashLimitSubject } from '@/lib/widget/code';

describe('generateCode', () => {
  // 500 draws, every one checked against the full six-digit shape -- not a
  // handful sampled and eyeballed. `String(randomInt(0, 999999))` passes an
  // eyeballed check most of the time and only fails on the ~11% of draws
  // below 100000, so the assertion has to run inside the loop, on every draw,
  // rather than once on a value pulled out after the fact.
  it('is exactly six digits, leading zeros included, on every draw', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('hashCode', () => {
  it('matches a known SHA-256 vector', () => {
    // sha256("123456"), reproduced with:
    //   node -e "console.log(require('crypto').createHash('sha256').update('123456').digest('hex'))"
    expect(hashCode('123456')).toBe(
      '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
    );
  });
});

describe('hashLimitSubject', () => {
  // The three properties a rate-limit key has to have, and they pull against
  // each other: it must not contain the subject, it must be the SAME for the
  // same subject every time, and it must be DIFFERENT for a different one.
  // Drop the second and every request opens its own bucket, so the ceiling
  // stops existing while every test that only checks "the number is absent"
  // keeps passing. tests/unit/contact-requests.test.ts asserts the same three
  // for hashIpAddress, which this mirrors character for character.
  it('does not carry the value it was given', () => {
    expect(hashLimitSubject('5511999998888')).not.toContain('5511999998888');
    expect(hashLimitSubject('203.0.113.7')).not.toContain('203.0.113.7');
  });

  it('is stable, which is what makes it a bucket at all', () => {
    expect(hashLimitSubject('5511999998888')).toBe(hashLimitSubject('5511999998888'));
  });

  it('separates two subjects', () => {
    expect(hashLimitSubject('5511999998888')).not.toBe(hashLimitSubject('5511999998887'));
  });

  // 32 hex characters, the width `hashIpAddress` already writes into
  // contact_requests.ip_hash. Asserted rather than assumed because a key that
  // silently grew to 64 would still work and would still be a different bucket
  // from every counter row written before the change.
  it('is 32 lowercase hex characters', () => {
    expect(hashLimitSubject('5511999998888')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('generatePublicKey', () => {
  // Same discipline as generateCode: the CHECK in 0159 is exact
  // (`^pw_[A-Za-z0-9_-]{22}$`), so the test asserts the shape of every draw
  // instead of trusting that 16 random bytes always base64url-encode to 22
  // characters.
  it('satisfies the widget_installations public_key CHECK on every draw', () => {
    for (let i = 0; i < 500; i++) {
      expect(generatePublicKey()).toMatch(/^pw_[A-Za-z0-9_-]{22}$/);
    }
  });
});
