import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Block 12a. That what the middleware writes actually leaves the middleware.
 *
 * A redirect is a NEW response object. Everything set on the one built at the
 * top -- the refreshed Supabase session, the locale sync -- is on a different
 * object, and copying it across is a line somebody has to remember to write.
 * Nothing else in the suite would notice its absence: the e2e journeys run in
 * English, so a dropped locale cookie changes no visible string, and the
 * session cookie survives on the next request anyway.
 */
const profile = {
  must_change_password: false,
  provisional_expires_at: null as string | null,
  locale: null as string | null,
};
let signedIn = true;

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: signedIn ? { id: 'u1' } : null } }),
      signOut: async () => ({}),
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: profile }) }) }),
    }),
  }),
}));

const { middleware } = await import('@/middleware');

function get(path: string, cookies: Record<string, string> = {}) {
  const request = new NextRequest(new URL(`http://localhost:3000${path}`));
  for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value);
  return request;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  signedIn = true;
  profile.must_change_password = false;
  profile.provisional_expires_at = null;
  profile.locale = null;
});

describe('the locale cookie the middleware writes', () => {
  it('survives the redirect to the password gate', async () => {
    // The case the comment above the sync names by name. Somebody behind the
    // gate is redirected on EVERY path but one, so losing the cookie here means
    // losing it for as long as the gate holds.
    profile.locale = 'pt';
    profile.must_change_password = true;

    const response = await middleware(get('/app'));

    expect(response.headers.get('location')).toContain('/change-password');
    expect(response.cookies.get('locale')?.value).toBe('pt');
  });

  it('survives the redirect back out of the gate', async () => {
    profile.locale = 'pt';

    const response = await middleware(get('/change-password'));

    expect(response.headers.get('location')).toContain('/app');
    expect(response.cookies.get('locale')?.value).toBe('pt');
  });

  it('survives the redirect an expired provisional password causes', async () => {
    profile.locale = 'pt';
    profile.must_change_password = true;
    profile.provisional_expires_at = new Date(Date.now() - 1000).toISOString();

    const response = await middleware(get('/app'));

    expect(response.headers.get('location')).toContain('error=expired');
    expect(response.cookies.get('locale')?.value).toBe('pt');
  });

  it('reaches the render that computed it, not just the one after', async () => {
    // src/i18n/request.ts reads the REQUEST's cookies. A response-only write
    // renders this page in the old language and corrects itself on the next
    // one, which reads as a flash of English on the screen after signing in.
    profile.locale = 'pt';
    const request = get('/app');

    await middleware(request);

    expect(request.cookies.get('locale')?.value).toBe('pt');
  });

  it('writes nothing when the browser already agrees', async () => {
    profile.locale = 'pt';

    const response = await middleware(get('/app', { locale: 'pt' }));

    expect(response.cookies.get('locale')).toBeUndefined();
  });

  it('leaves the cookie alone for somebody who never chose', async () => {
    const response = await middleware(get('/app', { locale: 'es' }));

    expect(response.cookies.get('locale')).toBeUndefined();
  });
});
