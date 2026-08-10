import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * That the two auth route handlers send the browser somewhere it can reach.
 *
 * MEASURED IN PRODUCTION, 2026-08-10, and this is the whole reason the file
 * exists: `https://pulchatx.com/auth/callback` answered
 *
 *     307  Location: https://0.0.0.0:3000/login?error=1
 *
 * The proxy in front of the app forwards its own internal Host, so the origin
 * Next derives from the request is the address the container listens on, not
 * the one the visitor typed. Every absolute redirect built from the request --
 * `new URL(path, request.url)`, `${request.nextUrl.origin}${path}` -- therefore
 * names a host no browser can resolve, and the navigation simply does not
 * happen. The owner reported it as "the sign-out button logs me out but leaves
 * me on the same screen", which is exactly that: the response clearing the
 * session arrives, and the redirect that came with it goes nowhere.
 *
 * The middleware is not affected -- measured relative (`Location: /login`) on
 * the same deployment -- which is why signing in has always worked and only
 * these two handlers were broken.
 *
 * A RELATIVE Location is the fix and the thing these tests pin. RFC 7231 §7.1.2
 * has the browser resolve it against the request URL, so it is correct without
 * the app being told what its public address is -- nothing to configure, and
 * nothing that can drift when the deployment moves.
 *
 * The requests below therefore carry the WRONG host on purpose. A test built on
 * `http://localhost:3000` passes against the broken code, which is precisely how
 * this survived to production.
 */
let exchangeError: { message: string } | null = null;

vi.mock('@/lib/supabase/user-client', () => ({
  createUserClient: async () => ({
    auth: {
      signOut: async () => ({}),
      exchangeCodeForSession: async () => ({ error: exchangeError }),
    },
  }),
}));

const { POST: signOut } = await import('@/app/auth/signout/route');
const { GET: callback } = await import('@/app/auth/callback/route');

/** The address the container answers on, which is what the proxy forwards. */
const INTERNAL = 'https://0.0.0.0:3000';

beforeEach(() => {
  exchangeError = null;
});

describe('the sign-out route', () => {
  it('sends the browser to /login without naming a host', async () => {
    const response = await signOut();

    expect(response.headers.get('location')).toBe('/login');
  });

  it('answers 303 so the browser follows with GET rather than re-POSTing', async () => {
    const response = await signOut();

    expect(response.status).toBe(303);
  });
});

describe('the auth callback route', () => {
  it('sends a visitor arriving with no code to /login, without naming a host', async () => {
    const response = await callback(new NextRequest(new URL(`${INTERNAL}/auth/callback`)));

    expect(response.headers.get('location')).toBe('/login?error=1');
  });

  it('sends a failed exchange to /login, without naming a host', async () => {
    exchangeError = { message: 'expired' };

    const response = await callback(new NextRequest(new URL(`${INTERNAL}/auth/callback?code=x`)));

    expect(response.headers.get('location')).toBe('/login?error=1');
  });

  it('sends a good code onward, without naming a host', async () => {
    const response = await callback(new NextRequest(new URL(`${INTERNAL}/auth/callback?code=x`)));

    expect(response.headers.get('location')).toBe('/change-password');
  });

  it('honours a same-origin `next`', async () => {
    const url = `${INTERNAL}/auth/callback?code=x&next=/app`;

    const response = await callback(new NextRequest(new URL(url)));

    expect(response.headers.get('location')).toBe('/app');
  });

  /**
   * The open-redirect guard, which a relative Location makes MORE important
   * rather than less: `//evil.test` is protocol-relative, so a browser resolves
   * it as a different site entirely, and it would sail past a check that only
   * asked whether the value starts with a slash.
   */
  it.each(['//evil.test', 'https://evil.test', 'http://evil.test/x', 'evil.test'])(
    'refuses `next=%s` and falls back to the password screen',
    async (next) => {
      const url = `${INTERNAL}/auth/callback?code=x&next=${encodeURIComponent(next)}`;

      const response = await callback(new NextRequest(new URL(url)));

      expect(response.headers.get('location')).toBe('/change-password');
    },
  );
});
