import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from './config';

// Client por-requisição com o JWT/sessão do usuário → RLS é aplicada de fato (D4).
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
          // Chamado de um Server Component: ignorável se o middleware renova a sessão.
          // (padrão recomendado por @supabase/ssr)
        }
      },
    },
  });
}
