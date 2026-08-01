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

  it('rejects a header without the sha256= prefix', () => {
    expect(verifyMetaSignature(raw, sign(raw).slice(7), SECRET)).toBe(false);
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
