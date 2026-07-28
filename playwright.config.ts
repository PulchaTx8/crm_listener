import { defineConfig } from '@playwright/test';
import { LOCAL_SUPABASE_ENV } from './tests/local-supabase';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://localhost:3000',
    // Any failure leaves a trace. `on-first-retry` would be dead config here:
    // retries stay at 0 deliberately — a journey that passes on the second
    // attempt is a journey that failed — so a first retry never happens and
    // the trace would never be written.
    trace: 'retain-on-failure',
  },
  // Without an html reporter Playwright writes no playwright-report/, so CI's
  // "upload the report on failure" step had nothing to upload and every failed
  // run had to be diagnosed by reading the diff and guessing.
  reporter: isCI ? [['dot'], ['html', { open: 'never' }]] : 'list',
  webServer: {
    // A production build in CI, the dev server locally.
    //
    // `next dev` compiles each route on its first request. CI never reuses a
    // server (see reuseExistingServer), so that compilation lands inside the
    // first test to visit a route, counted against its 30s budget —
    // inventory-flow.spec.ts is the only spec that reaches /inventory and
    // /inventory/[prizeId], and it is also the longest journey in the suite,
    // so it paid for both. It timed out on two of three runs, including one
    // commit that changed nothing but a markdown file.
    command: isCI ? 'npm run build && npm run start' : 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !isCI,
    // The default is 60s, which a Next build does not fit into.
    timeout: isCI ? 180_000 : 60_000,
    // The server points at the local stack, not at whatever `.env` holds:
    // `.env` names the hosted project and the middleware calls Supabase on
    // every request, so without this the suite would exercise production.
    // These reach `next build` too, which is what inlines NEXT_PUBLIC_* into
    // the client bundle.
    env: { SKIP_ENV_VALIDATION: '1', ...LOCAL_SUPABASE_ENV },
  },
});
