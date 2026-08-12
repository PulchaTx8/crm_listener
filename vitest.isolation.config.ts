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
    // Already vitest 2's default — stated so a vitest upgrade cannot move it
    // without somebody deciding to. This is a PIN, and it is NOT the answer to
    // the `Worker exited unexpectedly` crash that drops a whole file from this
    // suite: that crash was already happening under `forks`, so switching to it
    // would have been a fix in name only. Nor were the two harness helpers that
    // used to spawn the Supabase CLI from inside the worker — they were rewritten
    // (see superuserStatement in tests/isolation/harness.ts) and the crash
    // carried on unchanged: measured at six crashes in fifteen full runs, about
    // two in five, on six different files with no repeats, four of which never
    // called either helper. The crash is open; what is closed is that it can pass
    // unnoticed, by scripts/verify-isolation-suite.mjs. The next thing to try here is
    // `poolOptions: { forks: { singleFork: true } }`, which would reuse one child
    // for every file and remove the per-file teardown the crash now lands in.
    pool: 'forks',
    // These tests create and delete real users; parallel files would race on
    // the shared database.
    fileParallelism: false,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.SUPABASE_TEST_ANON_KEY ?? LOCAL_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY:
        process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? LOCAL_SUPABASE_SERVICE_ROLE_KEY,
      // Block 19a. `sendServiceLink` (src/services/whatsapp-link.ts) refuses
      // to mint or send a link without this — the same deployment-fault
      // guard `triggerTick` (the webhook route) already applies to itself —
      // and this suite drives that path for real, through `runTick`, in
      // tests/isolation/whatsapp.test.ts and whatsapp-link-load.test.ts.
      // Fixed, not secret: it never leaves this process, and nothing here
      // resolves it over HTTP.
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
});
