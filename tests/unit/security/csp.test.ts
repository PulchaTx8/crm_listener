import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, CSP_NONCE_HEADER } from '@/lib/security/csp';

const SUPABASE = 'https://abcdefghijklm.supabase.co';
const policy = (isDev = false) => buildContentSecurityPolicy('n0nc3', SUPABASE, isDev);

function directive(name: string, isDev = false): string {
  const found = policy(isDev)
    .split('; ')
    .find((d) => d === name || d.startsWith(`${name} `));
  return found ?? '';
}

describe('the content security policy', () => {
  it('names the header Next reads the nonce from', () => {
    expect(CSP_NONCE_HEADER).toBe('x-nonce');
  });

  it('carries the nonce and strict-dynamic on script-src', () => {
    expect(directive('script-src')).toBe("script-src 'self' 'nonce-n0nc3' 'strict-dynamic'");
  });

  it('never allows inline script', () => {
    // The whole point of the nonce. A future edit that "fixes" a broken screen
    // by adding this keyword silently removes the policy's only real teeth.
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
  });

  it('reaches Supabase over both http and websocket', () => {
    // supabase-js talks to the project from the browser. Without this every
    // client-side query dies and it looks like a broken product, not a policy.
    expect(directive('connect-src')).toBe(
      "connect-src 'self' https://abcdefghijklm.supabase.co wss://abcdefghijklm.supabase.co " +
        'https://maps.googleapis.com https://maps.gstatic.com',
    );
  });

  it('admits the Deezer cover CDN as an image source', () => {
    // Block 13a. Every album cover in this product is served from here; the
    // URL is built in src/lib/integrations/deezer/cover.ts, which is the only
    // other place that knows this host. The two must agree.
    expect(directive('img-src')).toBe(
      "img-src 'self' data: blob: https://abcdefghijklm.supabase.co https://cdn-images.dzcdn.net " +
        'https://maps.googleapis.com https://maps.gstatic.com',
    );
  });

  it('admits Google Maps to img-src and connect-src, and NOT to script-src', () => {
    // Block 28, and the negative half is the point. script-src carries
    // 'strict-dynamic', and a browser that understands that keyword ignores
    // host allowlists in that directive ENTIRELY — so adding Google there
    // would be a line that reads as protection and does nothing at all, while
    // making the next reader believe the map is allowed BECAUSE of it. What
    // actually loads the library is the nonce.
    for (const source of ['https://maps.googleapis.com', 'https://maps.gstatic.com']) {
      expect(directive('img-src')).toContain(source);
      expect(directive('connect-src')).toContain(source);
      expect(directive('script-src')).not.toContain(source);
    }
  });

  it('admits Deezer preview audio through a media-src of its own', () => {
    // A NEW DIRECTIVE in Block 13a, and the reason it must exist: without
    // media-src, audio falls back to default-src 'self' and every 30-second
    // preview is blocked with nothing on screen to say why.
    //
    // The wildcard is deliberate. Deezer's preview host has moved between
    // `cdns-preview-N.dzcdn.net` and `cdnt-preview.dzcdn.net` over time, and a
    // literal host would break the search tab on a day nobody deployed
    // anything.
    expect(directive('media-src')).toBe("media-src 'self' https://*.dzcdn.net");
  });

  it('allows inline style deliberately', () => {
    // In CSP this keyword also covers the style ATTRIBUTE, which React emits for
    // every style={{...}} prop -- the Block 8a charts are made of them.
    expect(directive('style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });

  it('shuts the doors that need no nonce', () => {
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
    expect(directive('form-action')).toBe("form-action 'self'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(policy()).toContain('upgrade-insecure-requests');
  });

  it('permits eval in development only', () => {
    // `next dev` compiles with eval-based source maps and React Refresh, and
    // playwright.config.ts runs the dev server locally. Without this the local
    // run blocks every framework script and NOTHING hydrates -- with the
    // violations landing in the browser console, where the Block 11a run could
    // not see them.
    expect(directive('script-src', true)).toContain("'unsafe-eval'");
    expect(directive('script-src', false)).not.toContain("'unsafe-eval'");
  });

  it('refuses a supabase url it cannot parse rather than emitting a broken directive', () => {
    // The alternative is a connect-src carrying the string "undefined", which
    // fails in the browser of whoever deployed it rather than here.
    expect(() => buildContentSecurityPolicy('n', 'not-a-url', false)).toThrow();
  });
});
