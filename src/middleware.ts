import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { Database } from '@/lib/supabase/database.types';

/**
 * Routes reachable without a session. Everything else redirects to /login.
 * `/auth/callback` must be here: someone arriving from a password-reset e-mail
 * has no session yet, and bouncing them would leave the code unexchanged.
 */
const PUBLIC_PATHS = ['/', '/contato', '/login', '/forgot-password', '/auth/callback', '/api/health'];

const CHANGE_PASSWORD_PATH = '/change-password';
const SIGN_OUT_PATH = '/auth/signout';
const MEMBER_HOME = '/app';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Refreshing the session here is what makes the cookie-write guard in
  // user-client.ts safe: Server Components cannot write cookies, so without
  // this the refreshed session would be silently discarded.
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (!user) {
    if (PUBLIC_PATHS.includes(path)) return response;
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Signing out must work even from behind the gate, or a user who cannot
  // change their password has no way out of the loop.
  if (path === SIGN_OUT_PATH) return response;

  const { data: profile } = await supabase
    .from('profiles')
    .select('must_change_password, provisional_expires_at')
    .eq('id', user.id)
    .single();

  // A provisional password travels outside the system and is treated as
  // compromised, so it dies of old age (spec §6). Checked here rather than at
  // sign-in because an already-open session must lose access too — Supabase
  // Auth knows nothing about this column, so nothing else would stop it.
  const expiresAt = profile?.provisional_expires_at;
  if (profile?.must_change_password && expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL('/login?error=expired', request.url));
  }

  // The gate has no holes: while the flag is set, every path other than the
  // change screen itself redirects to it.
  if (profile?.must_change_password && path !== CHANGE_PASSWORD_PATH) {
    return NextResponse.redirect(new URL(CHANGE_PASSWORD_PATH, request.url));
  }

  // And once it is clear, the change screen has nothing left to do. Everyone
  // lands on the member home; platform admins reach the console from there,
  // which keeps an is_platform_admin() round trip off every single request.
  if (!profile?.must_change_password && path === CHANGE_PASSWORD_PATH) {
    return NextResponse.redirect(new URL(MEMBER_HOME, request.url));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
