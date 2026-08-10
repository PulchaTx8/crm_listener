import { NextResponse, type NextRequest } from 'next/server';
import { createUserClient } from '@/lib/supabase/user-client';

/** A relative Location, for the reason src/app/auth/signout/route.ts gives at
 * length: an origin taken from the request names the container's internal
 * address behind this deployment's proxy, and the browser goes nowhere. */
const to = (path: string) => new NextResponse(null, { status: 307, headers: { Location: path } });

/**
 * Supabase sends the user here with a one-time code after they click the
 * reset link. Exchanging it establishes the session; the middleware then
 * routes them onward.
 *
 * Until 2026-08-10 every arm below built `${request.nextUrl.origin}${path}`,
 * which on the deployment resolved to `https://0.0.0.0:3000` -- so password
 * reset by e-mail did not merely misbehave, it ended nowhere at all, on the
 * success path as much as the failures.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/change-password';

  if (!code) return to('/login?error=1');

  const supabase = await createUserClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return to('/login?error=1');

  // `next` arrives on a URL the user can edit, so only same-origin relative
  // paths are honoured — otherwise this is an open redirect. The check matters
  // MORE now that the Location is relative, not less: `//evil.test` is
  // protocol-relative and a browser resolves it as another site entirely, so
  // "starts with a slash" alone would be a hole rather than a guard.
  const destination = next.startsWith('/') && !next.startsWith('//') ? next : '/change-password';
  return to(destination);
}
