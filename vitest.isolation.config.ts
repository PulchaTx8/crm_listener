import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Isolation tests need a live database. They create and delete real auth users
 * and sign them in for real, so they must never reach the hosted project.
 *
 * Vitest does not copy `.env` into `process.env`, and `.env` points at the
 * hosted project anyway — so the credentials are pinned here instead. These are
 * the fixed keys every local `supabase start` generates from the default JWT
 * secret in `config.toml`; they are not secrets and they authenticate against
 * nothing but a developer's own machine.
 */
const LOCAL_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const url = process.env.SUPABASE_TEST_URL ?? LOCAL_URL;

// A typo in SUPABASE_TEST_URL should not be able to wipe customer accounts.
// Refuse anything that is not loopback unless someone says so out loud.
const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(url);
if (!isLoopback && process.env.ALLOW_REMOTE_ISOLATION_TESTS !== '1') {
  throw new Error(
    `Refusing to run isolation tests against ${url}. These tests create and delete ` +
      'real users. Point SUPABASE_TEST_URL at a local stack, or set ' +
      'ALLOW_REMOTE_ISOLATION_TESTS=1 if you genuinely mean to target a remote one.',
  );
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/isolation/**/*.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // These tests create and delete real users; parallel files would race on
    // the shared database.
    fileParallelism: false,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.SUPABASE_TEST_ANON_KEY ?? LOCAL_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY:
        process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? LOCAL_SERVICE_ROLE_KEY,
    },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
