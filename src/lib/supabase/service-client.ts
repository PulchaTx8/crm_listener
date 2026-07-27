import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getServiceSupabaseConfig } from './config';
import type { Database } from './database.types';

// ONLY for system routines (webhook, cron, ETL, platform). Never in a user request. RLS is BYPASSED.
export function createServiceClient(): SupabaseClient<Database> {
  const { url, serviceRoleKey } = getServiceSupabaseConfig();
  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
