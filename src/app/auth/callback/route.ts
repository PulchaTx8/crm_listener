import { NextResponse, type NextRequest } from 'next/server';
import { createUserClient } from '@/lib/supabase/user-client';

/**
 * Supabase sends the user here with a one-time code after they click the
 * reset link. Exchanging it establishes the session; the middleware then
 * routes them onward.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/change-password';

  if (!code) return NextResponse.redirect(`${origin}/login?error=1`);

  const supabase = await createUserClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/login?error=1`);

  // `next` arrives on a URL the user can edit, so only same-origin relative
  // paths are honoured — otherwise this is an open redirect.
  const destination = next.startsWith('/') && !next.startsWith('//') ? next : '/change-password';
  return NextResponse.redirect(`${origin}${destination}`);
}
