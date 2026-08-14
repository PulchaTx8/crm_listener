import { describe, expect, it } from 'vitest';
import { embeddedSignupUrl, signupPopupFeatures } from '@/lib/integrations/whatsapp/embedded-signup';

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

/** What `window.open` is handed. Parsed back out so a test reads as numbers. */
function features(host: {
  width: number;
  height: number;
  left: number;
  top: number;
}): Record<string, number> {
  const parsed: Record<string, number> = {};
  for (const pair of signupPopupFeatures(host).split(',')) {
    const [key, value] = pair.split('=');
    if (key && value && /^\d+$/.test(value)) parsed[key] = Number(value);
  }
  return parsed;
}

describe('signupPopupFeatures', () => {
  /** A browser maximised on a 1920x1080 display. */
  const MAXIMISED = { width: 1920, height: 1080, left: 0, top: 0 };

  it('asks for a window rather than a tab', () => {
    // The whole point. Without this a browser is free to answer window.open
    // with a tab, which is the behaviour this function was written to replace.
    expect(signupPopupFeatures(MAXIMISED)).toContain('popup=yes');
  });

  it('centres the pairing window over the browser window', () => {
    expect(features(MAXIMISED)).toEqual({ width: 1100, height: 800, left: 410, top: 140 });
  });

  it('shrinks to fit a laptop instead of running off the bottom', () => {
    // 1366x768 is still one of the commonest resolutions in the field. A fixed
    // 800-tall window on it puts the wizard's own buttons past the bottom
    // edge, where no scrollbar reaches them.
    const laptop = features({ width: 1366, height: 768, left: 0, top: 0 });
    expect(laptop.width).toBe(1100);
    expect(laptop.height).toBe(691);
    expect(laptop.top).toBeGreaterThanOrEqual(0);
  });

  it('never asks for a window larger than the one it opens from', () => {
    for (const host of [
      { width: 800, height: 600, left: 0, top: 0 },
      { width: 1024, height: 768, left: 0, top: 0 },
      { width: 3840, height: 2160, left: 0, top: 0 },
    ]) {
      const f = features(host);
      expect(f.width!).toBeLessThanOrEqual(host.width);
      expect(f.height!).toBeLessThanOrEqual(host.height);
      expect(f.left!).toBeGreaterThanOrEqual(host.left);
      expect(f.top!).toBeGreaterThanOrEqual(host.top);
    }
  });

  it('opens on the monitor the browser is actually on', () => {
    // THE BUG THIS TEST EXISTS FOR. Centring on `width/2` alone ignores the
    // offset and puts the window on the primary display — which, to an
    // operator working on the second one, is indistinguishable from a button
    // that does nothing.
    const second = features({ width: 1920, height: 1080, left: 1920, top: 0 });
    expect(second.left).toBe(2330);
  });
});
