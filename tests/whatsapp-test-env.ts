/**
 * Fixed WhatsApp/worker secrets for the app the Playwright suite starts,
 * analogous to tests/local-supabase.ts: not real secrets, just a shared fixed
 * value so the webServer (which sets these as its process environment) and
 * the spec that signs requests against it (which needs the same value to
 * compute a matching HMAC) can never disagree about what it is.
 *
 * Neither is a production secret and neither authenticates against anything
 * but a Playwright-started `next build && next start` on a developer's own
 * machine or in CI — pinned here rather than read from `.env`, which names
 * the hosted project and must never be exercised by this suite.
 */
export const WHATSAPP_APP_SECRET_FOR_TESTS = 'e2e-whatsapp-app-secret';
export const WORKER_TICK_SECRET_FOR_TESTS = 'e2e-worker-tick-secret';

export const WHATSAPP_TEST_ENV = {
  WHATSAPP_APP_SECRET: WHATSAPP_APP_SECRET_FOR_TESTS,
  WORKER_TICK_SECRET: WORKER_TICK_SECRET_FOR_TESTS,
} as const;
