/**
 * Credentials for the local Supabase stack, shared by every test runner.
 *
 * These are the fixed keys `supabase start` derives from the default JWT secret
 * in `supabase/config.toml`. They are not secrets — they authenticate against
 * nothing but a developer's own machine — and they are pinned here so that no
 * test suite can inherit `.env`, which names the hosted project.
 */
export const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

/**
 * Postgres itself, as its superuser, outside the API entirely. `supabase start`
 * publishes this on 54322 with the fixed credentials in `supabase/config.toml`.
 *
 * Used by the two harness helpers that have to write a table no role — not even
 * service_role — holds a grant on; see corruptBalanceDirectly for why that state
 * has to be reachable at all. Nothing else may use it: a test that can reach
 * this connection can also bypass every policy the suite exists to prove.
 */
export const LOCAL_SUPABASE_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export const LOCAL_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

export const LOCAL_SUPABASE_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

export const LOCAL_SUPABASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: LOCAL_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: LOCAL_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} as const;
