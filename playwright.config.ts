import { defineConfig } from '@playwright/test';
import { LOCAL_SUPABASE_ENV } from './tests/local-supabase';
import { WHATSAPP_TEST_ENV } from './tests/whatsapp-test-env';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://localhost:3000',
    // Block 12b. Pinned, because the resolution order ends at Accept-Language
    // and Chromium sends whatever the MACHINE is set to. Unpinned, this suite
    // asserts roughly a hundred English strings and renders in Portuguese on
    // any developer machine set to pt-BR — a failure that reproduces for one
    // person and nobody else. The language-switching journey overrides it.
    locale: 'en-US',
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
  // SERIAL LOCALLY, PARALLEL IN CI, and the split is the same one `command`
  // below already makes for the same underlying reason.
  //
  // CI builds for production, where every route is compiled before the first
  // request. Locally the server is `next dev`, which compiles each route the
  // first time it is asked for — and Playwright's default worker count sends a
  // dozen journeys at it at once, all of them landing on an uncompiled /app.
  // Every one then fails its 5-second `toHaveURL` and reports as sitting on
  // /login, which reads as a broken sign-in and is a cold compiler.
  //
  // Measured: a full local run failed 24 of 48 with that signature, and every
  // failing spec passed on its own; the same suite at --workers=1 passed 48 of
  // 48. Three wrong hypotheses were paid for before the worker count was
  // noticed, which is why this is a setting with a comment rather than a note
  // in somebody's head.
  workers: isCI ? undefined : 1,
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
    // Playwright pipes the server's stderr into the log and DISCARDS its
    // stdout. pino writes to stdout. So every server-side exception this suite
    // provokes — the ones a Server Component catches and turns into "Could not
    // load X. Refresh the page and try again." — reaches CI as that sentence in
    // a page snapshot and nothing else.
    //
    // Paid for once, on PR #72: one journey failed on a promotions list that
    // rendered its load-error state, and the cause was unrecoverable from the
    // run. It took rebuilding CI's configuration locally, four full suite runs
    // and a read of the Kong container's own log to learn the answer — a single
    // PostgREST request lost to a 502, one of thirty-seven across six days on
    // unrelated endpoints. One line here would have printed it.
    //
    // The cost is about seven expected `level:50` lines per run, from the
    // refusals several specs deliberately provoke. That is a fair price for
    // every unexpected one arriving with its own cause attached.
    stdout: 'pipe',
    // The server points at the local stack, not at whatever `.env` holds:
    // `.env` names the hosted project and the middleware calls Supabase on
    // every request, so without this the suite would exercise production.
    // These reach `next build` too, which is what inlines NEXT_PUBLIC_* into
    // the client bundle.
    //
    // WHATSAPP_TEST_ENV supplies WHATSAPP_APP_SECRET and WORKER_TICK_SECRET.
    // Without them the webhook and worker routes both refuse to serve (503,
    // "not configured" — src/app/api/webhooks/whatsapp/route.ts and
    // src/app/api/worker/tick/route.ts), which would make
    // whatsapp-boundary.spec.ts's signed-POST and worker-tick cases fail for
    // a reason that has nothing to do with what they test. Fixed values, not
    // secrets: tests/whatsapp-test-env.ts is the one place both this server
    // and the spec that signs requests against it read them from, so the two
    // can never disagree about what they are.
    // WIDGET_SESSION_SECRET is Block 17a's, and without it the widget refuses
    // every submission with `unavailable` before it reaches the database —
    // src/app/(widget)/w/[publicKey]/actions.ts treats an absent secret as a
    // deployment fault, the same shape /api/worker/tick uses, because a code
    // that can never be exchanged for a session is the Station's money spent on
    // nothing. Nothing else in this repository sets it: it is absent from .env
    // and from .env.example, so before this line tests/e2e/widget.spec.ts could
    // only ever have watched the widget refuse itself.
    //
    // Inline rather than in tests/whatsapp-test-env.ts's shape, because only the
    // server needs this one — the spec drives the real form and never mints a
    // token, so there is no second reader for the two to disagree about. Fixed,
    // not secret, and comfortably over the min(32) src/lib/env.ts requires even
    // on the loose branch SKIP_ENV_VALIDATION selects (the literal below is 40
    // characters): a shorter value would stop the server booting rather than
    // being quietly ignored, which is a confusing way for a suite to fail.
    //
    // DEEZER_FAKE keeps the Deezer tab off api.deezer.com. Without it the
    // suite would spend the platform's shared per-IP rate limit on every CI
    // run, need a third party to be up to go green, and assert against a
    // catalogue that can change under it. Opt-in by design: an unset value
    // is the real client, so no deployment can silently serve fixtures.
    env: {
      SKIP_ENV_VALIDATION: '1',
      DEEZER_FAKE: '1',
      WIDGET_SESSION_SECRET: 'e2e-widget-session-secret-not-a-real-one',
      // Block 19a. `sendServiceLink` (src/services/whatsapp-link.ts) refuses to
      // mint or send a link without this, and tests/e2e/whatsapp-entry.spec.ts
      // is the one spec that drives the worker down that path. Matches
      // `baseURL` above: the link it builds has to resolve inside this same
      // server for the spec to open it.
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
      ...LOCAL_SUPABASE_ENV,
      ...WHATSAPP_TEST_ENV,
    },
  },
});
