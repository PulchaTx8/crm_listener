import { describe, expect, it } from 'vitest';
import { embeddedSignupUrl } from '@/lib/integrations/whatsapp/embedded-signup';

describe('embeddedSignupUrl', () => {
  it('hands back the configured flow', () => {
    expect(
      embeddedSignupUrl('https://business.facebook.com/messaging/whatsapp/onboard/?app_id=123'),
    ).toBe('https://business.facebook.com/messaging/whatsapp/onboard/?app_id=123');
  });

  it('says "not configured" when the variable was never set', () => {
    expect(embeddedSignupUrl(undefined)).toBeNull();
  });

  it('treats an empty value as never set, not as configured-as-nothing', () => {
    // Docker turns an ARG with no value into `ENV NAME=`, which is the shape a
    // deployment that forgot this variable actually arrives in. src/lib/env.ts
    // strips those before parsing; this is the second door.
    expect(embeddedSignupUrl('')).toBeNull();
    expect(embeddedSignupUrl('   ')).toBeNull();
  });

  it('tolerates the whitespace a pasted value carries', () => {
    expect(embeddedSignupUrl('  https://business.facebook.com/x  ')).toBe(
      'https://business.facebook.com/x',
    );
  });

  it('REFUSES a javascript: value rather than putting it in an href', () => {
    // The reason this module exists instead of a `?? null` at the call site.
    // `z.string().url()` is `new URL()`, which accepts every scheme there is,
    // so the env schema alone would let a mistyped or hostile value reach the
    // anchor's href and run in the operator's session on click.
    expect(embeddedSignupUrl('javascript:alert(1)')).toBeNull();
  });

  it('refuses plain http, which Meta never serves this flow over', () => {
    expect(embeddedSignupUrl('http://business.facebook.com/onboard')).toBeNull();
  });

  it('refuses a value that is not an address at all', () => {
    expect(embeddedSignupUrl('business.facebook.com/onboard')).toBeNull();
  });
});
