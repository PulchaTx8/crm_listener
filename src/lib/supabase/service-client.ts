import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getServiceSupabaseConfig } from './config';

// SÓ para rotinas de sistema (webhook, cron, ETL, plataforma). Nunca em request de usuário. RLS é IGNORADA.
export function createServiceClient(): SupabaseClient {
  const { url, serviceRoleKey } = getServiceSupabaseConfig();
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
