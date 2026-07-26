import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getServiceSupabaseConfig } from './config';

// ONLY for system routines (webhook, cron, ETL, platform). Never in a user request. RLS is BYPASSED.
export function createServiceClient(): SupabaseClient {
  const { url, serviceRoleKey } = getServiceSupabaseConfig();
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
