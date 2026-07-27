import { NextResponse, type NextRequest } from 'next/server';
import { createUserClient } from '@/lib/supabase/user-client';

export async function POST(request: NextRequest) {
  const supabase = await createUserClient();
  await supabase.auth.signOut();
  // 303 so the browser follows with GET rather than re-POSTing.
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}
