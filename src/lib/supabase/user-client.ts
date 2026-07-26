import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from './config';

// Per-request client carrying the user's JWT/session → RLS is genuinely enforced (D4).
export async function createUserClient(): Promise<SupabaseClient> {
  const { url, anonKey } = getUserSupabaseConfig();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet: { name: string; value: string; options: CookieOptions }[]) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: ignorable if the middleware refreshes
          // the session. (pattern recommended by @supabase/ssr)
        }
      },
    },
  });
}
