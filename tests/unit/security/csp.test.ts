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
      "connect-src 'self' https://abcdefghijklm.supabase.co wss://abcdefghijklm.supabase.co",
    );
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
