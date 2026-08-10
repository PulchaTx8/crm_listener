import { NextResponse } from 'next/server';
import { createUserClient } from '@/lib/supabase/user-client';

/**
 * A RELATIVE Location, and it takes no request at all -- which is the point.
 *
 * `NextResponse.redirect(new URL('/login', request.url))` was here, and it is
 * the obvious way to write this. It is also broken behind a reverse proxy: the
 * proxy forwards its own internal Host, so the origin Next derives from the
 * request is the address the container listens on. Measured on the deployment,
 * 2026-08-10 -- `https://pulchatx.com/auth/callback` answered
 * `Location: https://0.0.0.0:3000/login?error=1`.
 *
 * The browser cannot resolve that, so the navigation never happened, while the
 * Set-Cookie clearing the session on the very same response did. The owner saw
 * a button that logged them out and left them sitting on the screen they were
 * already on, with no way to tell they had been signed out.
 *
 * RFC 7231 §7.1.2 has the browser resolve a relative Location against the
 * request URL, so this is right without the app ever being told its own public
 * address -- nothing to configure, and nothing to drift when the deployment
 * moves. `NextResponse.redirect()` cannot express it (it throws on anything
 * that is not absolute), hence the plain response with the header set by hand.
 *
 * THE SESSION COOKIES STILL RIDE ON THIS RESPONSE: signOut() writes them
 * through the next/headers cookie store, which Next applies to whatever the
 * handler returns, and tests/e2e/signout.spec.ts drives the real button to
 * prove it -- because a redirect that works while the session survives would be
 * a worse bug than the one this replaces.
 *
 * 303 so the browser follows with GET rather than re-POSTing.
 */
export async function POST() {
  const supabase = await createUserClient();
  await supabase.auth.signOut();
  return new NextResponse(null, { status: 303, headers: { Location: '/login' } });
}
