import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMetaSignature } from '@/lib/integrations/whatsapp/signature';

const SECRET = 'test-app-secret';
const sign = (body: string) =>
  `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

describe('verifyMetaSignature', () => {
  const raw = '{"object":"whatsapp_business_account","entry":[]}';

  it('accepts a signature over the exact bytes received', () => {
    expect(verifyMetaSignature(raw, sign(raw), SECRET)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(verifyMetaSignature(raw, null, SECRET)).toBe(false);
  });

  // This does NOT prove the prefix check is load-bearing: with the prefix
  // absent, the implementation still slices off the first 7 characters
  // (assuming they were `sha256=`), so a bare 64-character digest is cut down
  // to 57 characters, decodes to 28 bytes, and is rejected by the length
  // guard before comparison is ever reached. See the "forged prefix" case
  // below for the assertion that actually pins the prefix check.
  it('rejects a bare digest with no prefix (caught by the length guard after the slice, not by the prefix check itself)', () => {
    expect(verifyMetaSignature(raw, sign(raw).slice(7), SECRET)).toBe(false);
  });

  // This is the assertion that makes the prefix check load-bearing. Take the
  // correct digest and prepend 7 characters that are not `sha256=`. Without
  // the prefix check, `header.slice(7)` still strips exactly 7 characters --
  // it recovers the genuine 64-character digest, which decodes to 32 bytes
  // and passes `timingSafeEqual`. So a header that never declared its
  // algorithm would be accepted. With the prefix check in place, this is
  // rejected before the slice ever runs. Delete the prefix check and this is
  // the only case in the suite that fails.
  it('rejects a correct digest behind a header that does not declare sha256=', () => {
    const forged = `0000000${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
    expect(verifyMetaSignature(raw, forged, SECRET)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    const other = `sha256=${createHmac('sha256', 'wrong').update(raw).digest('hex')}`;
    expect(verifyMetaSignature(raw, other, SECRET)).toBe(false);
  });

  // The trap this whole module exists for. Verifying a re-serialised parsed
  // body is how this check silently stops working: key order and whitespace
  // change, the HMAC no longer matches what Meta signed, and the usual "fix" is
  // to disable the check.
  it('rejects a body that was parsed and re-serialised', () => {
    const reserialised = JSON.stringify(JSON.parse(raw));
    const spaced = '{"object": "whatsapp_business_account", "entry": []}';
    expect(spaced).not.toBe(reserialised);
    expect(verifyMetaSignature(reserialised, sign(spaced), SECRET)).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    expect(verifyMetaSignature(raw, 'sha256=abc', SECRET)).toBe(false);
  });
});
