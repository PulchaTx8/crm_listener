import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from './tests/local-supabase';

/**
 * Isolation tests need a live database. They create and delete real auth users
 * and sign them in for real, so they must never reach the hosted project.
 * Vitest does not copy `.env` into `process.env`, and `.env` names the hosted
 * project anyway, so the credentials are pinned to the local stack here.
 */
const url = process.env.SUPABASE_TEST_URL ?? LOCAL_SUPABASE_URL;

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
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.SUPABASE_TEST_ANON_KEY ?? LOCAL_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY:
        process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? LOCAL_SUPABASE_SERVICE_ROLE_KEY,
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
});
