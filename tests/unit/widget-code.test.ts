import { describe, expect, it } from 'vitest';
import { generateCode, generatePublicKey, hashCode } from '@/lib/widget/code';

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
