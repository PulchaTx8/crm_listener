# Block 11b — CSP, Alerting and Uploads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Content-Security-Policy that Block 11a withdrew, make the five scheduled routines report their own health by e-mail, and close the upload path that accepts anything the browser claims.

**Architecture:** The CSP is minted per request in `src/middleware.ts` from a pure builder in `src/lib/security/csp.ts`; the nonce reaches the renderer through the **request** `Content-Security-Policy` header, re-snapshotted after every Supabase cookie write. Health is one row per routine in `job_health`, stamped by the routines themselves, read hourly by a pg_cron job that posts to `/api/worker/health-alert` exactly as `0064` posts to the worker tick. Uploads are bounded at `storage.buckets`, which no client can go around.

**Tech Stack:** Next 15 App Router (middleware on the Edge runtime), Supabase/Postgres with pg_cron + pg_net, Vitest, pgTAP, Playwright, nodemailer.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-06-block-11b-csp-alerting-uploads-design.md`. Decisions are cited as D1–D10.
- **Branch:** `block-11b`, already created from `main` at `32adc73`. The PR's base is `main`, and its body says where it branched from.
- **Migrations:** `0132`, `0133`, `0134`. Nothing else. **A migration is never edited after it is pushed to the hosted project** — Supabase records by version number, so an edit after the push never arrives.
- **Language:** all code, comments, tests, documents and commit messages in English.
- **No `exception` handler in any routine that commits.** A `begin … exception … end` block opens a subtransaction and `commit` inside one raises `cannot commit while a subtransaction is active`. This is what shipped the 11a sweep deleting nothing.
- **`npm run db:test` needs a freshly reset database.** After an e2e or isolation run, `15_music_rpcs` fails with "more than one row returned by a subquery" — that is not a regression. Run `npm run db:reset` first.
- **The Playwright pass count is read as a number**, never as an impression of the console.

---

## File Structure

**Created:**
- `src/lib/security/csp.ts` — the pure policy builder and the nonce header name. No Next imports, so it is unit-testable.
- `src/lib/security/uploads.ts` — the receipt allow-list, the size cap, and the MIME→extension map.
- `src/app/api/worker/health-alert/route.ts` — what pg_cron posts to hourly.
- `src/services/job-health.ts` — reading unhealthy routines and stamping `alerted_at`, so the route holds no query.
- `supabase/migrations/0132_job_health.sql`, `0133_job_health_stamps.sql`, `0134_bucket_limits.sql`
- `supabase/tests/25_job_health.test.sql`, `supabase/tests/26_bucket_limits.test.sql`
- `tests/e2e/csp.spec.ts` — the nonce probe and the violation fixture.
- `tests/isolation/job-health.test.ts` — the routines called over a direct connection.
- `tests/unit/security/csp.test.ts`, `tests/unit/security/uploads.test.ts`, `tests/unit/health-alert-route.test.ts`

**Modified:**
- `src/middleware.ts` — mint the nonce, forward it, set the response header.
- `src/lib/env.ts` — `ALERT_EMAIL`, optional.
- `src/app/api/worker/tick/route.ts` — stamp `whatsapp-worker-tick`.
- `src/services/winners.ts` — validate before uploading, derive the extension from the MIME type.
- `src/app/(app)/promotions/[id]/draws/actions.ts` — reject with a readable message.
- `src/components/draws/draw-detail.tsx` — `accept` on the file input.
- `src/app/(app)/participations/import-form.tsx` — cap the CSV before reading it.
- `.env.example`, `docs/block-11b-runbook.md` (new), `docs/block-11b-report.md` (new).

---

## Task 1: The policy builder

**Files:**
- Create: `src/lib/security/csp.ts`
- Test: `tests/unit/security/csp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CSP_NONCE_HEADER: 'x-nonce'`, and
  `buildContentSecurityPolicy(nonce: string, supabaseUrl: string, isDev: boolean): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/security/csp.test.ts
import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, CSP_NONCE_HEADER } from '@/lib/security/csp';

const SUPABASE = 'https://abcdefghijklm.supabase.co';
const policy = (isDev = false) => buildContentSecurityPolicy('n0nc3', SUPABASE, isDev);

function directive(name: string, isDev = false): string {
  const found = policy(isDev)
    .split('; ')
    .find((d) => d === name || d.startsWith(`${name} `));
  return found ?? '';
}

describe('the content security policy', () => {
  it('names the header Next reads the nonce from', () => {
    expect(CSP_NONCE_HEADER).toBe('x-nonce');
  });

  it('carries the nonce and strict-dynamic on script-src', () => {
    expect(directive('script-src')).toBe("script-src 'self' 'nonce-n0nc3' 'strict-dynamic'");
  });

  it('never allows inline script', () => {
    // The whole point of the nonce. A future edit that "fixes" a broken screen
    // by adding this keyword silently removes the policy's only real teeth.
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
  });

  it('reaches Supabase over both http and websocket', () => {
    // supabase-js talks to the project from the browser. Without this every
    // client-side query dies and it looks like a broken product, not a policy.
    expect(directive('connect-src')).toBe(
      "connect-src 'self' https://abcdefghijklm.supabase.co wss://abcdefghijklm.supabase.co",
    );
  });

  it('allows inline style deliberately', () => {
    // In CSP this keyword also covers the style ATTRIBUTE, which React emits for
    // every style={{...}} prop -- the Block 8a charts are made of them.
    expect(directive('style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });

  it('shuts the doors that need no nonce', () => {
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
    expect(directive('form-action')).toBe("form-action 'self'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(policy()).toContain('upgrade-insecure-requests');
  });

  it('permits eval in development only', () => {
    // `next dev` compiles with eval-based source maps and React Refresh. Without
    // this the local Playwright run blocks every framework script and NOTHING
    // hydrates -- with the violations landing in the browser console, where the
    // 11a run could not see them.
    expect(directive('script-src', true)).toContain("'unsafe-eval'");
    expect(directive('script-src', false)).not.toContain("'unsafe-eval'");
  });

  it('refuses a supabase url it cannot parse rather than emitting a broken directive', () => {
    expect(() => buildContentSecurityPolicy('n', 'not-a-url', false)).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/security/csp.test.ts`
Expected: FAIL — `Cannot find module '@/lib/security/csp'`.

- [ ] **Step 3: Write the builder**

```ts
// src/lib/security/csp.ts

/**
 * Block 11b. The policy Block 11a implemented, tested and withdrew.
 *
 * A pure function on purpose: the middleware that uses it cannot be unit-tested
 * without a Next request, and a policy nobody can assert is a policy that decays
 * one "temporary" keyword at a time.
 */
export const CSP_NONCE_HEADER = 'x-nonce';

export function buildContentSecurityPolicy(
  nonce: string,
  supabaseUrl: string,
  isDev: boolean,
): string {
  // Throws on a URL it cannot parse, deliberately. The alternative is a
  // connect-src carrying the string "undefined", which fails at runtime in the
  // browser of whoever deployed it rather than here.
  const origin = new URL(supabaseUrl).origin;
  const socket = origin.replace(/^http/, 'ws');

  return [
    "default-src 'self'",
    // 'strict-dynamic' lets a script that Next itself loaded load its own
    // chunks. Without it every hashed bundle filename would have to be listed.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${origin}`,
    "font-src 'self' data:",
    `connect-src 'self' ${origin} ${socket}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Agrees with X-Frame-Options: DENY in next.config.mjs (Block 11a). A
    // permissive value beside a strict one is the shape of an accident.
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/security/csp.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/security/csp.ts tests/unit/security/csp.test.ts
git commit -m "feat(security): the content security policy, as a function that can be asserted"
```

---

## Task 2: The probe — prove the nonce reaches the rendered HTML

This is D1, and it comes before the policy is enforced anywhere. Block 11a wrote
the policy first and spent three measured attempts guessing. The deliverable is a
Playwright test that reads the delivered HTML and fails if a single `<script>`
tag is missing the nonce — the probe becomes a permanent test.

**Files:**
- Modify: `src/middleware.ts`
- Create: `tests/e2e/csp.spec.ts`

**Interfaces:**
- Consumes: `buildContentSecurityPolicy`, `CSP_NONCE_HEADER` from Task 1.
- Produces: a `Content-Security-Policy` response header on every matched route, and the same value on the forwarded **request** headers.

- [ ] **Step 1: Write the failing test**

```ts
// tests/e2e/csp.spec.ts
import { test, expect } from '@playwright/test';

/**
 * Block 11b, D1. THE PROBE.
 *
 * Block 11a shipped a nonce CSP and got `11 passed, 23 failed` with no error
 * message anywhere: journeys timed out clicking things that did nothing,
 * because no client component had hydrated. The cause could not be seen from
 * the outside, so this test looks at the one artefact that settles it -- the
 * HTML actually delivered -- and names the failure instead of timing out.
 */
test('every script tag in the delivered HTML carries the nonce', async ({ request }) => {
  const response = await request.get('/login');
  expect(response.status()).toBe(200);

  const header = response.headers()['content-security-policy'];
  expect(header, 'the response carries a CSP at all').toBeTruthy();
  const nonce = /'nonce-([^']+)'/.exec(header)?.[1];
  expect(nonce, 'the CSP carries a nonce').toBeTruthy();

  const html = await response.text();
  const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  expect(tags.length, 'the page delivered any script at all').toBeGreaterThan(0);

  const unstamped = tags.filter((attrs) => !attrs.includes(`nonce="${nonce}"`));
  expect(
    unstamped,
    `script tags without the nonce -- the renderer never received it:\n${unstamped.join('\n')}`,
  ).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx playwright test tests/e2e/csp.spec.ts`
Expected: FAIL — "the response carries a CSP at all", because nothing sets one yet.

- [ ] **Step 3: Mint and forward the nonce in the middleware**

The two edits that matter are the **request** header (which is what Next reads
to stamp its inline bootstrap scripts — `x-nonce` is only for a Server Component
to read) and re-snapshotting those headers inside Supabase's `setAll`.

In `src/middleware.ts`, add the imports and replace the opening of `middleware`:

```ts
import { buildContentSecurityPolicy, CSP_NONCE_HEADER } from '@/lib/security/csp';
```

```ts
export async function middleware(request: NextRequest) {
  // btoa, not Buffer: this file runs on the Edge runtime.
  const nonce = btoa(crypto.randomUUID());
  const policy = buildContentSecurityPolicy(
    nonce,
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NODE_ENV !== 'production',
  );

  /**
   * Snapshotted FRESH on every call, and that is the whole fix.
   *
   * Supabase's setAll below writes cookies onto `request` and then rebuilds the
   * response. A Headers object captured once would carry the cookie header from
   * before that write, and -- worse -- a rebuild that passes bare `request`
   * throws these headers away entirely, which is how Block 11a's nonce never
   * reached the renderer.
   */
  const forwarded = () => {
    const headers = new Headers(request.headers);
    headers.set(CSP_NONCE_HEADER, nonce);
    // THIS header, on the REQUEST, is what makes Next stamp the nonce onto its
    // own inline scripts. Setting only the response header renders a page whose
    // bootstrap is blocked by the very policy the response announces.
    headers.set('Content-Security-Policy', policy);
    return headers;
  };

  const nextWithCsp = () => {
    const built = NextResponse.next({ request: { headers: forwarded() } });
    built.headers.set('Content-Security-Policy', policy);
    return built;
  };

  const redirectWithCsp = (url: URL) => {
    const built = NextResponse.redirect(url);
    built.headers.set('Content-Security-Policy', policy);
    return built;
  };

  let response = nextWithCsp();
```

Then, inside the `cookies.setAll` callback, replace `response = NextResponse.next({ request });` with `response = nextWithCsp();`, and replace each of the four `NextResponse.redirect(...)` returns with `redirectWithCsp(...)`:

```ts
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = nextWithCsp();
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
```

```ts
    return redirectWithCsp(new URL('/login', request.url));
```
```ts
    return redirectWithCsp(new URL('/login?error=expired', request.url));
```
```ts
    return redirectWithCsp(new URL(CHANGE_PASSWORD_PATH, request.url));
```
```ts
    return redirectWithCsp(new URL(MEMBER_HOME, request.url));
```

- [ ] **Step 4: Run the probe again**

Run: `npx playwright test tests/e2e/csp.spec.ts`

**If it PASSES**, the nonce reaches the renderer locally. Go to Step 5.

**If it FAILS naming unstamped script tags**, the second candidate cause of D1 is
live: the route was statically prerendered, so there was no request nonce at
render time. Confirm it and fix it:

```bash
npm run build
```

Read the route table `next build` prints. `○ (Static)` on `/login`, `/` or
`/contato` is the confirmation. For each such route, add to its `page.tsx`:

```ts
// Block 11b, D1. A prerendered page has no request nonce at render time, so its
// inline bootstrap scripts ship unstamped and the CSP blocks them -- the whole
// screen fails to hydrate with no error in the test output. Rendering three
// public pages per request is the entire cost of the policy being real.
export const dynamic = 'force-dynamic';
```

Then run the probe again. It must pass before Step 5.

- [ ] **Step 5: Commit**

```bash
git add src/middleware.ts tests/e2e/csp.spec.ts
git commit -m "feat(security): mint the nonce in the middleware, and prove it reaches the HTML

The request Content-Security-Policy header is what Next reads to stamp its own
inline bootstrap scripts; x-nonce only lets a Server Component read it. The
headers are re-snapshotted inside Supabase's setAll, because a rebuild that
passes a bare request throws them away -- which is how Block 11a's nonce never
arrived."
```

---

## Task 3: The violation fixture, and the whole suite as the gate

**Files:**
- Create: `tests/e2e/csp-violations.ts`
- Modify: `tests/e2e/csp.spec.ts`, `tests/e2e/dashboards.spec.ts`

**Interfaces:**
- Consumes: the enforced policy from Task 2.
- Produces: `collectCspViolations(page: Page): Promise<string[]>` — an array that fills itself as the page runs.

- [ ] **Step 1: Write the collector**

```ts
// tests/e2e/csp-violations.ts
import type { Page } from '@playwright/test';

/**
 * Block 11b, D3. The listener Block 11a did not have.
 *
 * That run produced no error message at all in the Playwright output, because
 * the violations were raised in the BROWSER and nothing there was listening.
 * The returned array fills as the page runs; assert on it at the end of a
 * journey.
 */
export async function collectCspViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('__cspViolation', (entry: string) => {
    violations.push(entry);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { __cspViolation: (entry: string) => void }).__cspViolation(
        `${event.violatedDirective} blocked ${event.blockedURI || 'an inline resource'}`,
      );
    });
  });
  return violations;
}
```

- [ ] **Step 2: Use it on the public pages**

Append to `tests/e2e/csp.spec.ts`:

```ts
import { collectCspViolations } from './csp-violations';

test.describe('the policy does not block the pages nobody has signed into yet', () => {
  for (const path of ['/', '/contato', '/login']) {
    test(`${path} raises no policy violation`, async ({ page }) => {
      const violations = await collectCspViolations(page);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(violations, `CSP violations on ${path}:\n${violations.join('\n')}`).toEqual([]);
    });
  }
});
```

- [ ] **Step 3: Use it on a signed-in journey with charts**

The heaviest hydration in this product is a dashboard, and `dashboards.spec.ts`
already builds an owner, signs in through the real screen and renders charts —
so the coverage costs three lines there rather than eighty lines of new fixture.

In `tests/e2e/dashboards.spec.ts`, add the import:

```ts
import { collectCspViolations } from './csp-violations';
```

In the test that signs in at line ~327 (`await page.goto('/login')` followed by
`getByPlaceholder('E-mail')`), add as its **first** statement, before that
`goto`:

```ts
  // Block 11b, D3. Inline style attributes are what a careless style-src kills,
  // and this is the screen made of them.
  const cspViolations = await collectCspViolations(page);
```

and as its **last** statement:

```ts
  expect(cspViolations, `CSP violations:\n${cspViolations.join('\n')}`).toEqual([]);
```

- [ ] **Step 4: Run both**

Run: `npx playwright test tests/e2e/csp.spec.ts tests/e2e/dashboards.spec.ts`
Expected: PASS, or a named list of violations. **A violation here is the
information Block 11a never got — read it and fix the directive it names.**

- [ ] **Step 5: Run the whole suite and read the pass count as a number**

Run: `npx playwright test --workers=1`
Expected: **42 passed** (38 before this block, plus the nonce probe and the three
public-page cases). Any other number is a failure, whatever the console looks
like.

- [ ] **Step 6: If the count is short, apply D4 rather than withdrawing again**

Only if Step 5 cannot be made green by fixing directives. Change the middleware
to send the nonce-free directives enforcing and `script-src` in report-only:

```ts
    built.headers.set('Content-Security-Policy', policyWithoutScriptSrc);
    built.headers.set('Content-Security-Policy-Report-Only', policy);
```

with a `buildContentSecurityPolicy` sibling that omits `script-src`, its own unit
test, and a comment naming the directive that could not be made to work. Then
re-run Step 5 and record the outcome in the runbook of Task 12.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/csp-violations.ts tests/e2e/csp.spec.ts tests/e2e/dashboards.spec.ts src/middleware.ts src/lib/security/csp.ts
git commit -m "test(security): fail the suite on any CSP violation, in the browser where they happen"
```

---

## Task 4: `job_health` — the table and the check

**Files:**
- Create: `supabase/migrations/0132_job_health.sql`, `supabase/tests/25_job_health.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.job_health`, `public.job_started(text)`, `public.job_succeeded(text, jsonb)`, `public.check_job_health()` returning `(job_name text, last_success_at timestamptz, last_started_at timestamptz, last_counters jsonb, alerted_at timestamptz)`.

- [ ] **Step 1: Write the failing pgTAP test**

```sql
-- supabase/tests/25_job_health.test.sql
begin;
select plan(11);

-- Block 11b, D5. One row per scheduled routine, and failure detected by silence.

select has_table('public', 'job_health', 'job_health exists');

select ok(
  (select relrowsecurity from pg_class where relname = 'job_health'),
  'job_health has row level security enabled');

select is(
  (select count(*)::int from pg_policies where tablename = 'job_health'),
  0,
  'job_health has no policies -- it is operations data and nothing in the product reads it');

select is(
  (select count(*)::int from public.job_health),
  5,
  'the five routines that exist today are seeded');

-- Seeded HEALTHY. Seeded with a null last_success_at, every row would be past
-- its max_silence the moment the migration lands and the first health check
-- would send five e-mails about routines that never had a chance to run.
select ok(
  not exists (select 1 from public.job_health where last_success_at is null),
  'every seeded row starts with a last_success_at');

select ok(
  exists (select 1 from public.job_health
           where job_name = 'whatsapp-worker-tick' and max_silence = interval '15 minutes'),
  'the tick tolerates fifteen minutes of silence');

select ok(
  not exists (select 1 from public.job_health where job_name = 'job-health-check'),
  'the checker has no row of its own -- it cannot report its own silence');

-- The functions.
select has_function('public', 'job_started', array['text'], 'job_started exists');
select has_function('public', 'job_succeeded', array['text', 'jsonb'], 'job_succeeded exists');

-- check_job_health finds nothing when everything is fresh...
select is(
  (select count(*)::int from public.check_job_health()),
  0,
  'nothing is unhealthy on a freshly seeded database');

-- ...and finds the one routine that went quiet.
update public.job_health
   set last_success_at = now() - interval '48 hours'
 where job_name = 'retention-sweep';

select is(
  (select string_agg(job_name, ',') from public.check_job_health()),
  'retention-sweep',
  'a routine past its max_silence is reported, and only that one');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — relation `public.job_health` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0132_job_health.sql
--
-- Block 11b, D5. Five scheduled routines run in this installation and none of
-- them tells anybody anything. The retention sweep of Block 11a spent its whole
-- first version deleting zero rows every night while its counters went to a
-- Postgres log no human has ever read.
--
-- ONE ROW PER ROUTINE, NOT ONE ROW PER RUN. The tick fires every ten seconds;
-- an append-only history would add some 8,600 rows a day and would itself have
-- to be swept by the sweep it monitors.
--
-- NO `exception` HANDLER ANYWHERE IN THIS BLOCK. A begin/exception block opens
-- a subtransaction and `commit` inside one raises `cannot commit while a
-- subtransaction is active` -- which is exactly how 11a's sweep shipped
-- deleting nothing with a green pgTAP suite. So failure is not caught: it is
-- detected by SILENCE, which needs no handler at all.
create table public.job_health (
  job_name             text primary key,
  last_started_at      timestamptz,
  last_success_at      timestamptz,
  last_counters        jsonb,
  -- Counted by the health check when it observes a routine still quiet, not by
  -- the routine itself -- nothing in a failed run gets to write anything.
  consecutive_failures integer not null default 0,
  -- When the operator was told. Cleared by the next success, which is what
  -- makes this one e-mail per incident rather than one per hour.
  alerted_at           timestamptz,
  max_silence          interval not null
);

comment on table public.job_health is
  'Block 11b. One row per pg_cron routine: when it last started, when it last succeeded, what it counted, and how long it may stay quiet before someone is e-mailed. Read hourly by check_job_health() through /api/worker/health-alert.';

-- Operations data. Nothing in the product reads it, so it gets RLS and no
-- policies: authenticated sees nothing, and the routines run as the owner while
-- the app reads it with the service key.
alter table public.job_health enable row level security;

-- Seeded as HEALTHY, deliberately. With a null last_success_at every row would
-- be past its window the moment this lands, and the first health check would
-- mail five failures about routines that had not yet had a chance to run.
insert into public.job_health (job_name, max_silence, last_success_at) values
  ('whatsapp-worker-tick',  interval '15 minutes', now()),
  ('pickup-deadline-sweep', interval '3 hours',    now()),
  ('pickup-reminder-sweep', interval '3 hours',    now()),
  ('expire-report-runs',    interval '26 hours',   now()),
  ('retention-sweep',       interval '26 hours',   now())
on conflict (job_name) do nothing;

-- Functions rather than inline updates so a routine's own body carries one
-- readable line, and so the shape can change without four migrations.
create or replace function public.job_started(p_job text)
returns void
language sql
as $$
  update public.job_health set last_started_at = now() where job_name = p_job;
$$;

create or replace function public.job_succeeded(p_job text, p_counters jsonb default null)
returns void
language sql
as $$
  update public.job_health
     set last_success_at      = now(),
         last_counters        = coalesce(p_counters, last_counters),
         consecutive_failures = 0,
         alerted_at           = null
   where job_name = p_job;
$$;

-- SECURITY INVOKER (the default) on all three, and it costs nothing: pg_cron
-- runs the routines as the role that scheduled them -- the owner -- and the
-- app reaches them with the service key. An authenticated caller reaching one
-- updates zero rows, because RLS above grants nobody anything.
create or replace function public.check_job_health()
returns table (
  job_name        text,
  last_success_at timestamptz,
  last_started_at timestamptz,
  last_counters   jsonb,
  alerted_at      timestamptz
)
language sql
stable
as $$
  select h.job_name, h.last_success_at, h.last_started_at, h.last_counters, h.alerted_at
    from public.job_health h
   where coalesce(h.last_success_at, '-infinity'::timestamptz) < now() - h.max_silence
   order by h.job_name;
$$;

comment on function public.check_job_health() is
  'Block 11b. The routines that have gone quiet for longer than they are allowed to. Detection is by silence rather than by a caught exception, because a routine that commits cannot carry an exception handler.';

revoke execute on function public.job_started(text) from public;
revoke execute on function public.job_succeeded(text, jsonb) from public;
revoke execute on function public.check_job_health() from public;
grant execute on function public.check_job_health() to service_role;
grant execute on function public.job_succeeded(text, jsonb) to service_role;
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `25_job_health` reports 11 of 11, and the suite total rises to 1386.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0132_job_health.sql supabase/tests/25_job_health.test.sql
git commit -m "feat(ops): one row per scheduled routine, and failure detected by silence"
```

---

## Task 5: The routines stamp themselves

**Files:**
- Create: `supabase/migrations/0133_job_health_stamps.sql`
- Modify: `supabase/tests/25_job_health.test.sql` (raise `plan()`, add three assertions)
- Create: `tests/isolation/job-health.test.ts`

**Interfaces:**
- Consumes: `job_started`, `job_succeeded` from Task 4.
- Produces: `public.run_pickup_deadline_sweep()`, `public.run_pickup_reminder_sweep()`, `public.run_expire_report_runs()`, a rewritten `public.sweep_retention()`, and the `job-health-check` cron entry.

- [ ] **Step 1: Write the failing isolation test**

```ts
// tests/isolation/job-health.test.ts
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_DB_URL } from '../local-supabase';

/**
 * Block 11b. The stamping, CALLED.
 *
 * The rule Block 11a paid for: IF A SCHEDULED ROUTINE COMMITS, WRITE A TEST
 * THAT CALLS IT. pgTAP cannot -- it wraps each file in a transaction it rolls
 * back, and a procedure that commits raises inside one. PostgREST cannot --
 * `supabase.rpc()` answers PGRST202 for a procedure. A direct connection can,
 * and it is what pg_cron itself uses.
 */
async function call(statement: string): Promise<void> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

describe('Block 11b — the scheduled routines report their own health', () => {
  let admin: SupabaseClient;

  beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { persistSession: false } },
    );
    // Backdate every row so a stamp is unmistakably new rather than the seed.
    await call(`update public.job_health set last_success_at = now() - interval '30 days'`);
  }, 60_000);

  it.each([
    ['call public.sweep_retention()', 'retention-sweep'],
    ['call public.run_pickup_deadline_sweep()', 'pickup-deadline-sweep'],
    ['call public.run_pickup_reminder_sweep()', 'pickup-reminder-sweep'],
    ['call public.run_expire_report_runs()', 'expire-report-runs'],
  ])('%s stamps %s', async (statement, job) => {
    await expect(call(statement), `${statement} raised`).resolves.toBeUndefined();

    const { data } = await admin
      .from('job_health')
      .select('last_success_at, last_started_at')
      .eq('job_name', job)
      .single();

    const success = Date.parse(data?.last_success_at ?? '');
    expect(success, `${job} recorded no success`).toBeGreaterThan(Date.now() - 120_000);
    expect(success, `${job} recorded success before it started`).toBeGreaterThanOrEqual(
      Date.parse(data?.last_started_at ?? ''),
    );
  }, 60_000);

  it('the retention sweep records what it deleted, not just that it ran', async () => {
    // The complaint this block exists to answer: the counters went to a Postgres
    // log nobody reads, so a sweep failing for a month looked like one working.
    const { data } = await admin
      .from('job_health')
      .select('last_counters')
      .eq('job_name', 'retention-sweep')
      .single();

    const counters = (data?.last_counters ?? {}) as Record<string, number>;
    expect(Object.keys(counters).sort()).toEqual([
      'contact_requests',
      'outbox_messages',
      'rate_limit_counters',
      'storage_erasure_queue',
      'total',
      'webhook_events',
      'whatsapp_conversation_leases',
      'whatsapp_conversations',
    ]);
  }, 60_000);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:isolation`
Expected: FAIL — `procedure public.run_pickup_deadline_sweep() does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0133_job_health_stamps.sql
--
-- Block 11b, D5. The routines stamp job_health.
--
-- TWO SHAPES, AND THE ASYMMETRY IS DELIBERATE.
--
-- `sweep_retention` is RESTATED IN FULL, because its counters are the point:
-- the complaint that opened this block is that they went to the Postgres log
-- and nowhere else, so a sweep failing for a month looked exactly like one that
-- worked. Only its own body can report them.
--
-- The other three get a thin wrapper that stamps around an untouched call. They
-- have no counters worth surfacing -- what is wanted from them is "did it run"
-- -- and restating three long procedures to add two lines each would be three
-- chances to introduce a defect in code that works.
--
-- Nothing here carries an `exception` handler, for the reason 0132 gives.

-- ---------------------------------------------------------------------------
-- 1. The three wrappers.
--
-- A procedure may CALL another procedure that commits, because pg_cron invokes
-- the outer one with CALL and so no atomic context encloses it. A FUNCTION
-- could not: it would be an atomic context, and the inner commit would raise
-- `invalid transaction termination`.
-- ---------------------------------------------------------------------------
create or replace procedure public.run_pickup_deadline_sweep()
language plpgsql
as $$
begin
  perform public.job_started('pickup-deadline-sweep');
  call public.sweep_pickup_deadlines();
  perform public.job_succeeded('pickup-deadline-sweep');
  commit;
end;
$$;

create or replace procedure public.run_pickup_reminder_sweep()
language plpgsql
as $$
begin
  perform public.job_started('pickup-reminder-sweep');
  call public.sweep_pickup_reminders();
  perform public.job_succeeded('pickup-reminder-sweep');
  commit;
end;
$$;

create or replace procedure public.run_expire_report_runs()
language plpgsql
as $$
begin
  perform public.job_started('expire-report-runs');
  call public.expire_report_runs();
  perform public.job_succeeded('expire-report-runs');
  commit;
end;
$$;

-- The schedules now call the wrappers. unschedule first: cron.schedule on an
-- existing name replaces it, but naming the removal makes the intent legible to
-- whoever reads cron.job afterwards.
select cron.unschedule('pickup-deadline-sweep');
select cron.schedule('pickup-deadline-sweep', '0 * * * *',
  $$ call public.run_pickup_deadline_sweep(); $$);

select cron.unschedule('pickup-reminder-sweep');
select cron.schedule('pickup-reminder-sweep', '0 * * * *',
  $$ call public.run_pickup_reminder_sweep(); $$);

select cron.unschedule('expire-report-runs');
select cron.schedule('expire-report-runs', '17 3 * * *',
  $$ call public.run_expire_report_runs(); $$);

-- ---------------------------------------------------------------------------
-- 2. sweep_retention, restated with its counters.
--
-- The body below is 0131's, unchanged in every delete, every period and every
-- comment it carried about them -- read that file for why each table is on the
-- list and why audit_logs is not. What is new is v_counters and the two stamps.
-- ---------------------------------------------------------------------------
create or replace procedure public.sweep_retention()
language plpgsql
as $$
declare
  v_deleted  integer;
  v_total    integer := 0;
  v_counters jsonb   := '{}'::jsonb;
begin
  perform public.job_started('retention-sweep');
  commit;

  delete from public.webhook_events
   where received_at < now() - interval '90 days'
     and status in ('DONE', 'FAILED');
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('webhook_events', v_deleted);

  delete from public.outbox_messages
   where created_at < now() - interval '180 days'
     and status in ('SENT', 'FAILED');
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('outbox_messages', v_deleted);

  delete from public.whatsapp_conversations
   where expires_at < now() - interval '180 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('whatsapp_conversations', v_deleted);

  delete from public.contact_requests
   where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('contact_requests', v_deleted);

  delete from public.rate_limit_counters
   where reset_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('rate_limit_counters', v_deleted);

  delete from public.whatsapp_conversation_leases
   where claimed_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('whatsapp_conversation_leases', v_deleted);

  -- processed_at NOT NULL only: an unprocessed row is an erasure this
  -- installation still owes somebody, and 0087 has no give-up threshold for
  -- exactly that reason.
  delete from public.storage_erasure_queue
   where processed_at is not null
     and processed_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('storage_erasure_queue', v_deleted);

  -- Where the counters go now. The `raise notice` of 0131 is gone, not
  -- duplicated: a number in two places is a number that disagrees with itself.
  perform public.job_succeeded(
    'retention-sweep',
    v_counters || jsonb_build_object('total', v_total));
  commit;
end;
$$;

comment on procedure public.sweep_retention() is
  'Requirement N7. Deletes data whose retention period has expired: webhook_events at 90 days, outbox_messages and whatsapp_conversations at 180, contact_requests at 365, three operational tables at 30. Commits per table so one failure does not roll back the rest. DOES NOT TOUCH audit_logs, nor any business record. Block 11b: reports what it deleted into job_health rather than into a Postgres log nobody reads.';

-- ---------------------------------------------------------------------------
-- 3. The check itself, hourly, through the app -- the same road 0064 built.
--
-- The database cannot send e-mail: the mailer is nodemailer over SMTP, in the
-- application. So pg_net knocks on the app's door and the app decides who to
-- tell. The consequence, stated rather than discovered: if the app is down, no
-- alert leaves. That case belongs to external uptime monitoring, and this
-- installation's answer to it is the EasyPanel healthcheck on /api/health.
--
-- :23, off the hour, so it is not competing with the two sweeps at :00.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'job-health-check',
  '23 * * * *',
  $$
  select net.http_post(
    url     := current_setting('app.health_alert_url', true),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-worker-secret', current_setting('app.worker_tick_secret', true)),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where nullif(current_setting('app.health_alert_url', true), '') is not null;
  $$
);
```

- [ ] **Step 4: Extend the pgTAP file**

In `supabase/tests/25_job_health.test.sql`, change `select plan(11);` to
`select plan(14);` and add before `select * from finish();`:

```sql
-- The three wrappers exist and are procedures, because only a procedure may
-- call one that commits.
select is(
  (select count(*)::int from pg_proc
    where proname in ('run_pickup_deadline_sweep', 'run_pickup_reminder_sweep',
                      'run_expire_report_runs')
      and prokind = 'p'),
  3,
  'the three tracking wrappers exist and are procedures');

-- The schedules point at the wrappers now, not at the bare sweeps.
select ok(
  (select count(*)::int from cron.job
    where command like '%run_pickup_deadline_sweep%'
       or command like '%run_pickup_reminder_sweep%'
       or command like '%run_expire_report_runs%') = 3,
  'the three schedules call the wrappers');

select ok(
  exists (select 1 from cron.job where jobname = 'job-health-check'),
  'the hourly health check is scheduled');
```

- [ ] **Step 5: Run both suites**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `25_job_health` 14 of 14.

Run: `npm run test:isolation`
Expected: PASS — the five new cases in `job-health.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0133_job_health_stamps.sql supabase/tests/25_job_health.test.sql tests/isolation/job-health.test.ts
git commit -m "feat(ops): the routines stamp their own health, and the sweep says what it deleted

sweep_retention is restated in full because its counters are the point; the
other three get a wrapper that stamps around an untouched call, since restating
three working procedures to add two lines each is three chances to break one."
```

---

## Task 6: The tick stamps itself

**Files:**
- Modify: `src/app/api/worker/tick/route.ts`
- Modify: `tests/unit/worker-tick-route.test.ts`

**Interfaces:**
- Consumes: `job_succeeded` from Task 4, reached with the service key.
- Produces: a `whatsapp-worker-tick` row that stays fresh while the app runs.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/worker-tick-route.test.ts`. The existing file already mocks
`@/lib/supabase/service-client` with `createServiceClient: () => ({})`; replace
that mock with one that records the RPC:

```ts
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/service-client', () => ({ createServiceClient: () => ({ rpc }) }));
```

and add to `beforeEach`: `rpc.mockReset(); rpc.mockResolvedValue({ error: null });`

Then the case:

```ts
  it('stamps its own health so silence means something', async () => {
    await post({ 'x-worker-secret': SECRET });

    // Block 11b, D5. The tick is stamped here rather than in SQL because its
    // cron statement only ENQUEUES an HTTP request: pg_cron reports success the
    // moment pg_net accepts it, with the app in the ground.
    expect(rpc).toHaveBeenCalledWith('job_succeeded', {
      p_job: 'whatsapp-worker-tick',
      p_counters: expect.objectContaining({ ingested: 3, sent: 2 }),
    });
  });

  it('does not stamp when the secret is wrong', async () => {
    await post({ 'x-worker-secret': 'wrong' });
    expect(rpc).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/worker-tick-route.test.ts`
Expected: FAIL — `rpc` was never called.

- [ ] **Step 3: Stamp in the route**

In `src/app/api/worker/tick/route.ts`, immediately before the final
`return Response.json(...)`:

```ts
  // Block 11b, D5. The tick's own heartbeat. Wrapped like the two drains above
  // it and for the same reason: a health stamp that throws must not lose a tick
  // that worked -- the counters are already computed, and losing them to a
  // monitoring write would be the monitor causing the outage.
  try {
    const { error } = await supabase.rpc('job_succeeded', {
      p_job: 'whatsapp-worker-tick',
      p_counters: { ...result, erasures, reports },
    });
    // An error RESULT is not a throw. Without this line a permission or schema
    // fault leaves the heartbeat silently unwritten -- and a monitor that fails
    // quietly is worse than none, because its silence reads as health.
    if (error) throw new Error(error.message);
  } catch (cause) {
    console.error(
      `worker tick: could not stamp job_health: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/worker-tick-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Regenerate the database types**

The new table and functions must exist in `src/lib/supabase/database.types.ts`
or `supabase.rpc('job_succeeded', …)` does not typecheck.

Run: `npm run db:types && npm run typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/worker/tick/route.ts tests/unit/worker-tick-route.test.ts src/lib/supabase/database.types.ts
git commit -m "feat(ops): the worker tick stamps its own health, because pg_cron cannot"
```

---

## Task 7: The alert — the service and the route

**Files:**
- Create: `src/services/job-health.ts`, `src/app/api/worker/health-alert/route.ts`, `tests/unit/health-alert-route.test.ts`
- Modify: `src/lib/env.ts`, `.env.example`

**Interfaces:**
- Consumes: `check_job_health()` from Task 4, the `Mailer` interface from `@/lib/mailer`.
- Produces: `findUnhealthyJobs(client): Promise<UnhealthyJob[]>`, `markJobAlerted(client, jobName): Promise<void>`, `describeUnhealthyJob(job): { subject: string; text: string }`, and `POST /api/worker/health-alert`.

- [ ] **Step 1: Add the environment variable**

In `src/lib/env.ts`, inside `envSchema`, after `MAIL_FROM`:

```ts
  // Block 11b. Where a failing scheduled routine is reported. OPTIONAL, like
  // SMTP_URL: a container refusing to boot because an alert address is missing
  // would be a worse outage than the one it is trying to report. Unset means
  // the health-alert route sends nothing and says why.
  ALERT_EMAIL: z.string().email().optional(),
```

In `.env.example`, beside `MAIL_FROM`:

```
# Where a failing scheduled routine is reported (Block 11b). Optional.
ALERT_EMAIL=ops@example.com
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/health-alert-route.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnhealthyJobs, markJobAlerted } = vi.hoisted(() => ({
  findUnhealthyJobs: vi.fn(),
  markJobAlerted: vi.fn(),
}));
vi.mock('@/services/job-health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/job-health')>()),
  findUnhealthyJobs,
  markJobAlerted,
}));

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/mailer', () => ({
  DevMailer: class {
    send = send;
  },
  SmtpMailer: class {
    send = send;
  },
}));

vi.mock('@/lib/supabase/service-client', () => ({ createServiceClient: () => ({}) }));

const SECRET = 'a-shared-secret-for-pg-cron';
process.env.WORKER_TICK_SECRET = SECRET;
process.env.ALERT_EMAIL = 'ops@example.test';

const { POST } = await import('@/app/api/worker/health-alert/route');

const post = (headers: Record<string, string>) =>
  POST(new Request('http://localhost/api/worker/health-alert', { method: 'POST', headers }));

const QUIET_SWEEP = {
  job_name: 'retention-sweep',
  last_success_at: '2026-07-01T04:11:00.000Z',
  last_started_at: '2026-07-01T04:11:00.000Z',
  last_counters: { total: 412 },
  alerted_at: null as string | null,
};

beforeEach(() => {
  findUnhealthyJobs.mockReset();
  findUnhealthyJobs.mockResolvedValue([QUIET_SWEEP]);
  markJobAlerted.mockReset();
  markJobAlerted.mockResolvedValue(undefined);
  send.mockReset();
  send.mockResolvedValue({ id: 'dev-1' });
});

describe('POST /api/worker/health-alert', () => {
  it('refuses without the shared secret, before reading anything', async () => {
    const response = await post({ 'x-worker-secret': 'wrong' });
    expect(response.status).toBe(401);
    expect(findUnhealthyJobs).not.toHaveBeenCalled();
  });

  it('sends one message per unhealthy routine and stamps it', async () => {
    const response = await post({ 'x-worker-secret': SECRET });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.to).toBe('ops@example.test');
    expect(message.subject).toContain('retention-sweep');
    // The last success and what it counted, because "it is broken" without
    // "and here is what working looked like" starts an investigation from zero.
    expect(message.text).toContain('412');
    expect(markJobAlerted).toHaveBeenCalledWith(expect.anything(), 'retention-sweep');
  });

  it('says nothing twice about the same incident', async () => {
    // One e-mail per incident, not one per hour. The stamp is cleared by the
    // next success, which is what re-arms it.
    findUnhealthyJobs.mockResolvedValue([
      { ...QUIET_SWEEP, alerted_at: new Date().toISOString() },
    ]);

    await post({ 'x-worker-secret': SECRET });

    expect(send).not.toHaveBeenCalled();
    expect(markJobAlerted).not.toHaveBeenCalled();
  });

  it('reminds once a day while it stays broken', async () => {
    findUnhealthyJobs.mockResolvedValue([
      {
        ...QUIET_SWEEP,
        alerted_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
      },
    ]);

    await post({ 'x-worker-secret': SECRET });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports that it is not configured rather than pretending to alert', async () => {
    delete process.env.ALERT_EMAIL;
    vi.resetModules();
    const { POST: unconfigured } = await import('@/app/api/worker/health-alert/route');

    const response = await unconfigured(
      new Request('http://localhost/api/worker/health-alert', {
        method: 'POST',
        headers: { 'x-worker-secret': SECRET },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false });
    expect(send).not.toHaveBeenCalled();
    process.env.ALERT_EMAIL = 'ops@example.test';
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/unit/health-alert-route.test.ts`
Expected: FAIL — cannot find `@/app/api/worker/health-alert/route`.

- [ ] **Step 4: Write the service**

```ts
// src/services/job-health.ts
import type { SupabaseClient } from '@supabase/supabase-js';

/** How long an unfixed routine waits before it is mentioned again. */
export const ALERT_REMINDER_MS = 24 * 60 * 60 * 1000;

export type UnhealthyJob = {
  job_name: string;
  last_success_at: string | null;
  last_started_at: string | null;
  last_counters: Record<string, unknown> | null;
  alerted_at: string | null;
};

export async function findUnhealthyJobs(client: SupabaseClient): Promise<UnhealthyJob[]> {
  const { data, error } = await client.rpc('check_job_health');
  if (error) throw new Error(`could not read job health: ${error.message}`);
  return (data ?? []) as UnhealthyJob[];
}

export async function markJobAlerted(client: SupabaseClient, jobName: string): Promise<void> {
  const { error } = await client
    .from('job_health')
    .update({ alerted_at: new Date().toISOString() })
    .eq('job_name', jobName);
  if (error) throw new Error(`could not stamp the alert for ${jobName}: ${error.message}`);
}

/** True when this incident has not been reported, or was reported a day ago. */
export function shouldAlert(job: UnhealthyJob, now: number): boolean {
  if (!job.alerted_at) return true;
  return now - Date.parse(job.alerted_at) >= ALERT_REMINDER_MS;
}

/**
 * What the operator reads at 04:30. It names the routine, when it last worked,
 * and what that run counted -- "it is broken" without "and here is what working
 * looked like" starts every investigation from zero.
 */
export function describeUnhealthyJob(job: UnhealthyJob): { subject: string; text: string } {
  const lastSuccess = job.last_success_at ?? 'never';
  return {
    subject: `[CRM] the scheduled routine ${job.job_name} has gone quiet`,
    text: [
      `The scheduled routine ${job.job_name} has not reported a success for longer than it is allowed to.`,
      '',
      `Last success: ${lastSuccess}`,
      `Last start:   ${job.last_started_at ?? 'never'}`,
      `That run counted: ${job.last_counters ? JSON.stringify(job.last_counters) : 'nothing recorded'}`,
      '',
      'A start later than a success means it began and did not finish. Silence in both means it never ran:',
      'check `select * from cron.job_run_details order by start_time desc limit 20;` for the reason.',
    ].join('\n'),
  };
}
```

- [ ] **Step 5: Write the route**

```ts
// src/app/api/worker/health-alert/route.ts
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase/service-client';
import { DevMailer, SmtpMailer, type Mailer } from '@/lib/mailer';
import {
  describeUnhealthyJob,
  findUnhealthyJobs,
  markJobAlerted,
  shouldAlert,
} from '@/services/job-health';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Block 11b, D6. What pg_cron calls, through pg_net, every hour at :23.
 *
 * The database cannot send e-mail -- the mailer is nodemailer over SMTP -- so
 * the alert leaves from here. The consequence is stated rather than discovered:
 * IF THIS APPLICATION IS DOWN, NO ALERT LEAVES. That case belongs to external
 * uptime monitoring against /api/health, not to this route.
 *
 * Excluded from the middleware matcher along with the rest of /api/worker/
 * (src/middleware.ts): pg_net holds no session cookie, and matched this would be
 * answered with a 307 to /login that pg_cron would never read.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = env.WORKER_TICK_SECRET;
  if (!secret) return new Response('not configured', { status: 503 });
  if (!secretMatches(request.headers.get('x-worker-secret'), secret)) {
    return new Response('unauthorized', { status: 401 });
  }

  const to = env.ALERT_EMAIL;
  if (!to) {
    // Not a 503: the caller did nothing wrong and there is nothing to retry.
    // Answered honestly so pg_net's stored response says why nothing happened.
    return Response.json({ configured: false, alerted: 0 });
  }

  const supabase = createServiceClient();
  const unhealthy = await findUnhealthyJobs(supabase);
  const now = Date.now();
  const mailer = alertMailer();

  let alerted = 0;
  for (const job of unhealthy) {
    if (!shouldAlert(job, now)) continue;
    const { subject, text } = describeUnhealthyJob(job);
    await mailer.send({ to, subject, text });
    await markJobAlerted(supabase, job.job_name);
    alerted += 1;
  }

  return Response.json({ configured: true, unhealthy: unhealthy.length, alerted });
}

/** SMTP when configured, otherwise the recording DevMailer -- as Block 0 does. */
function alertMailer(): Mailer {
  if (env.SMTP_URL && env.MAIL_FROM) return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  return new DevMailer();
}

/** Constant-time, for the reason the worker tick's copy gives. */
function secretMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `npx vitest run tests/unit/health-alert-route.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add src/services/job-health.ts src/app/api/worker/health-alert/route.ts tests/unit/health-alert-route.test.ts src/lib/env.ts .env.example
git commit -m "feat(ops): one e-mail per incident, to an address that is allowed to be unset"
```

---

## Task 8: The buckets

**Files:**
- Create: `supabase/migrations/0134_bucket_limits.sql`, `supabase/tests/26_bucket_limits.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `file_size_limit` on both buckets and `allowed_mime_types` on `delivery-receipts`.

- [ ] **Step 1: Write the failing pgTAP test**

```sql
-- supabase/tests/26_bucket_limits.test.sql
begin;
select plan(5);

-- Block 11b, D7. The bucket is the barrier no client goes around.
-- Configuration nobody asserts is configuration that returns to its default on
-- the next db reset.

select is(
  (select file_size_limit from storage.buckets where id = 'delivery-receipts'),
  10485760::bigint,
  'a delivery receipt may be ten megabytes at most');

select ok(
  (select allowed_mime_types from storage.buckets where id = 'delivery-receipts')
    @> array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'],
  'a delivery receipt is a photograph or a scan');

select ok(
  not ((select allowed_mime_types from storage.buckets where id = 'delivery-receipts')
    && array['text/html', 'image/svg+xml', 'application/octet-stream']),
  'and never anything a browser would run');

select is(
  (select file_size_limit from storage.buckets where id = 'reports'),
  104857600::bigint,
  'a report has a runaway wall at a hundred megabytes');

-- D7: deliberately no list here. Its content type comes from a frozen
-- server-side map, one of whose values is `text/csv; charset=utf-8` -- a
-- parameterised type an allow-list of `text/csv` may well refuse. A check that
-- can only break a working path buys the opposite of safety.
select is(
  (select allowed_mime_types from storage.buckets where id = 'reports'),
  null,
  'the reports bucket carries no MIME list, deliberately');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — `file_size_limit` is null on both.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0134_bucket_limits.sql
--
-- Block 11b, D7. Neither bucket has ever carried a size limit or a MIME list.
-- An operator can upload two gigabytes of HTML as a delivery receipt and have
-- it served back as HTML from a signed URL.
--
-- HERE, AND NOT ONLY IN THE ACTION, because this is the one check no client can
-- go around: the action's own validation exists so the operator reads "that
-- file is 40 MB" instead of a raw Storage error, and it is not the boundary.
update storage.buckets
   set file_size_limit    = 10485760,  -- 10 MiB: a phone photograph, comfortably
       allowed_mime_types = array[
         'image/jpeg',
         'image/png',
         'image/webp',
         'image/heic',   -- what an iPhone actually uploads
         'application/pdf'
       ]
 where id = 'delivery-receipts';

-- The reports bucket gets the wall and NO list, deliberately (D7). Its content
-- type comes from FORMAT_CONTENT_TYPES (src/lib/reports/types.ts), a frozen
-- server-side map no client can influence, and one of its three values is
-- `text/csv; charset=utf-8` -- a parameterised type that an allow-list of
-- `text/csv` may refuse. Adding a check that can only break a working path is
-- the opposite of hardening. 100 MiB is far above the 50,000-row ceiling
-- (REPORT_ROW_CEILING) and still bounds a runaway.
update storage.buckets
   set file_size_limit = 104857600
 where id = 'reports';
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `26_bucket_limits` 5 of 5.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0134_bucket_limits.sql supabase/tests/26_bucket_limits.test.sql
git commit -m "feat(security): a size and a type on the buckets that had neither"
```

---

## Task 9: The upload path

**Files:**
- Create: `src/lib/security/uploads.ts`, `tests/unit/security/uploads.test.ts`
- Modify: `src/services/winners.ts`, `src/app/(app)/promotions/[id]/draws/actions.ts`, `src/components/draws/draw-detail.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `RECEIPT_MAX_BYTES: number`, `RECEIPT_ACCEPT: string`, `receiptExtension(mime: string): string | null`, `describeReceiptRejection(file: { type: string; size: number }): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/security/uploads.test.ts
import { describe, expect, it } from 'vitest';
import {
  describeReceiptRejection,
  receiptExtension,
  RECEIPT_ACCEPT,
  RECEIPT_MAX_BYTES,
} from '@/lib/security/uploads';

describe('the delivery receipt allow-list', () => {
  it.each([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/webp', '.webp'],
    ['image/heic', '.heic'],
    ['application/pdf', '.pdf'],
  ])('%s is stored as %s', (mime, extension) => {
    expect(receiptExtension(mime)).toBe(extension);
  });

  it('has no extension for a type it does not accept', () => {
    // D8. The extension comes from the validated type, never from the client's
    // filename, which is a string that goes straight into a storage key.
    expect(receiptExtension('text/html')).toBeNull();
    expect(receiptExtension('application/octet-stream')).toBeNull();
  });

  it('accepts an ordinary photograph', () => {
    expect(describeReceiptRejection({ type: 'image/jpeg', size: 2_000_000 })).toBeNull();
  });

  it('names the size when the file is too big', () => {
    const message = describeReceiptRejection({ type: 'image/jpeg', size: 40_000_000 });
    expect(message).toContain('10');
    expect(message).toContain('38');
  });

  it('refuses a type that is not on the list', () => {
    expect(describeReceiptRejection({ type: 'text/html', size: 100 })).toContain('image');
  });

  it('refuses an empty type rather than guessing', () => {
    expect(describeReceiptRejection({ type: '', size: 100 })).toBeTruthy();
  });

  it('offers the same list to the file picker', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']) {
      expect(RECEIPT_ACCEPT).toContain(mime);
    }
  });

  it('agrees with the bucket', () => {
    // 0134 sets exactly this. Two numbers that must not drift apart.
    expect(RECEIPT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/security/uploads.test.ts`
Expected: FAIL — cannot find `@/lib/security/uploads`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/security/uploads.ts

/**
 * Block 11b, D7–D9. What a delivery receipt may be.
 *
 * MUST agree with `supabase/migrations/0134_bucket_limits.sql`, which is the
 * real barrier: this file exists so the operator reads a sentence instead of a
 * raw Storage error, and `supabase/tests/26_bucket_limits.test.sql` asserts the
 * bucket half.
 *
 * NO MAGIC-BYTE SNIFFING, deliberately (D9). What makes a stored object
 * dangerous is the Content-Type it is SERVED with, not the bytes inside it:
 * HTML stored as image/jpeg is inert. Since the stored type now comes from this
 * closed list, a lying file is junk rather than script.
 */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

const RECEIPT_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};

/** For the file picker. Convenience, not a defence: it filters a dialog. */
export const RECEIPT_ACCEPT = Object.keys(RECEIPT_TYPES).join(',');

/**
 * D8. The stored extension comes from the validated type, never from the
 * client's filename -- which is a string that would otherwise go straight into
 * a storage key.
 */
export function receiptExtension(mime: string): string | null {
  return RECEIPT_TYPES[mime] ?? null;
}

/** The reason to refuse, in a sentence, or null when the file is fine. */
export function describeReceiptRejection(file: { type: string; size: number }): string | null {
  if (file.size > RECEIPT_MAX_BYTES) {
    const megabytes = Math.round(file.size / (1024 * 1024));
    return `That file is ${megabytes} MB. A receipt may be at most 10 MB.`;
  }
  if (!receiptExtension(file.type)) {
    return 'A receipt must be an image (JPEG, PNG, WebP or HEIC) or a PDF.';
  }
  return null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/security/uploads.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Use it in the service**

In `src/services/winners.ts`, replace the extension derivation inside
`attachDeliveryReceipt`:

```ts
  const client = asCaller(accessToken);
  // Block 11b, D8. From the validated content type, not from input.file.name:
  // that name is client-supplied and this value is pasted into a storage key.
  const extension = receiptExtension(input.file.type);
  if (!extension) {
    throw new InternalError('That file type cannot be stored as a receipt.');
  }
  const path = `${input.companyId}/${input.winnerId}/${crypto.randomUUID()}${extension}`;

  const uploaded = await client.storage.from(RECEIPT_BUCKET).upload(path, input.file, {
    // From the same closed list. `input.file.type || 'application/octet-stream'`
    // stored whatever the browser claimed.
    contentType: input.file.type,
    upsert: false,
  });
```

with `import { receiptExtension } from '@/lib/security/uploads';` at the top.

- [ ] **Step 6: Use it in the action**

In `src/app/(app)/promotions/[id]/draws/actions.ts`, in `attachReceiptAction`:

```ts
  const file = formData.get('receipt');
  if (!(file instanceof File) || file.size === 0) return 'Choose a file.';
  // Block 11b, D7. The bucket refuses this too, and that refusal is the real
  // boundary -- this one exists so the operator reads a sentence rather than a
  // raw Storage error.
  const rejection = describeReceiptRejection(file);
  if (rejection) return rejection;
```

with `import { describeReceiptRejection } from '@/lib/security/uploads';`.

- [ ] **Step 7: Filter the picker**

In `src/components/draws/draw-detail.tsx`, on the file input:

```tsx
      <input
        type="file"
        name="receipt"
        accept={RECEIPT_ACCEPT}
        aria-label="Receipt of the handover"
        data-testid="receipt-input"
        className="text-sm"
      />
```

with `import { RECEIPT_ACCEPT } from '@/lib/security/uploads';`.

- [ ] **Step 8: Fix the existing e2e that this breaks**

`tests/e2e/delivery-flow.spec.ts:153` attaches a `text/plain` file called
`receipt.txt`. Both the action and the bucket now refuse it, so that journey
fails on a line that has nothing to do with what it tests. Change the fixture to
a file the product actually accepts:

```ts
  await page.getByTestId('receipt-input').setInputFiles({
    name: 'receipt.jpg',
    mimeType: 'image/jpeg',
    // Block 11b: the content is irrelevant -- what is stored is the declared
    // type, from a closed list, which is why no magic-byte check exists (D9).
    buffer: Buffer.from('a photograph of a handover'),
  });
```

Run: `npx playwright test tests/e2e/delivery-flow.spec.ts`
Expected: PASS. **If this step is skipped the suite goes red for a reason that
looks like the CSP and is not.**

- [ ] **Step 9: Verify nothing regressed**

Run: `npx vitest run tests/unit/winner-actions.test.ts && npm run typecheck && npm run lint`
Expected: all clean.

- [ ] **Step 10: Commit**

```bash
git add src/lib/security/uploads.ts tests/unit/security/uploads.test.ts src/services/winners.ts "src/app/(app)/promotions/[id]/draws/actions.ts" src/components/draws/draw-detail.tsx tests/e2e/delivery-flow.spec.ts
git commit -m "feat(security): a receipt is a photo or a scan, and the extension comes from the type"
```

---

## Task 10: The CSV import cap

**Files:**
- Modify: `src/app/(app)/participations/import-form.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a size refusal before the file is read.

- [ ] **Step 1: Add the constant**

Beside the file's other module-level constants:

```tsx
// Block 11b, D10. This file never becomes a storage object -- it is parsed in
// the browser and posted as rows -- so it has no MIME question. What it can do
// is kill the tab: arrayBuffer() below pulls the whole file into memory, and a
// mis-selected multi-gigabyte file takes the dialog with it. Well above
// IMPORT_ROWS_BODY_LIMIT_BYTES, which is the cap that actually governs how much
// can be imported; this one exists only to stop the read itself.
const IMPORT_FILE_MAX_BYTES = 20 * 1024 * 1024;
```

- [ ] **Step 2: Refuse before the read**

In `onFileChosen`, between the `if (!chosen)` guard and the `try` block — the
existing refusal channel is `setReadFailure`, and the sentence matches the one
already there:

```tsx
    if (chosen.size > IMPORT_FILE_MAX_BYTES) {
      setFile(null);
      setReadFailure(
        `That file is ${Math.round(chosen.size / (1024 * 1024))} MB. An import file may be at most 20 MB — split it and import the parts.`,
      );
      return;
    }
```

- [ ] **Step 3: Verify**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/participations/import-form.tsx"
git commit -m "fix(participations): refuse an import file too big to read before reading it"
```

---

## Task 11: The e2e that proves the refusal, and the full gate

**Files:**
- Modify: `tests/e2e/delivery-flow.spec.ts`

- [ ] **Step 1: Write the failing test**

Read `tests/e2e/delivery-flow.spec.ts` first — it already reaches the delivery
screen and already uses `data-testid="receipt-input"`. Add one case using that
spec's existing navigation:

Add this immediately **before** the existing successful attach at line ~153, so
it runs with the delivery screen already open and needs no fixture of its own:

```ts
  // Block 11b, D7. The bucket refuses this too, and that refusal is the real
  // boundary; what is proved here is that the operator is told WHY, instead of
  // reading a raw Storage error.
  await page.getByTestId('receipt-input').setInputFiles({
    name: 'not-a-receipt.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<h1>not a receipt</h1>'),
  });
  await page.getByTestId('receipt-attach').click();
  await expect(page.getByRole('alert')).toContainText(/must be an image/i);
```

The message is rendered by the `role="alert"` span already in
`src/components/draws/draw-detail.tsx`. This is an assertion inside the existing
delivery journey, not a new test — the pass count does not change for it.

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/e2e/delivery-flow.spec.ts`
Expected: PASS.

- [ ] **Step 3: Run every gate, in order, and read every number**

```bash
npm run lint
npm run typecheck
npm run build
npm run test
npm run db:reset
npm run db:test
npm run test:isolation
npx playwright test --workers=1
```

Expected, and **read each as a number**:
- unit: 849 + 8 (csp) + 12 (uploads) + 5 (health-alert) + 2 (tick) = **876**
- pgTAP: 1375 + 14 + 5 = **1394**
- isolation: 279 + 5 = **284**
- e2e: **42** (38 + the nonce probe + three public-page cases; the receipt
  refusal is an assertion inside an existing journey and adds no test)

`npm run db:reset` before `db:test` is not optional: after an e2e or isolation
run, `15_music_rpcs` fails with "more than one row returned by a subquery" and
that is not a regression.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/delivery-flow.spec.ts
git commit -m "test(delivery): the operator is told why a receipt was refused"
```

---

## Task 12: The runbook and the report

**Files:**
- Create: `docs/block-11b-runbook.md`, `docs/block-11b-report.md`

- [ ] **Step 1: Write the runbook**

Follow `docs/block-11a-runbook.md`'s shape: audience line, `## 0. Deploy`, then a
section per shipped thing. It must contain, in the author's own words:

- **Deploy order:** `supabase db push` (`0132`–`0134`), `npm run db:test`,
  `npm run test:isolation`, then the frontend. Database first is safe and
  uneventful; frontend first leaves `/api/worker/health-alert` logging a missing
  table and nothing else.
- **The two settings the alert needs**, and that nothing works without them:
  `app.health_alert_url` (the new one, pointing at
  `https://<host>/api/worker/health-alert`) and the existing
  `app.worker_tick_secret`. Both are `alter database … set …` on the hosted
  project, exactly as `app.worker_tick_url` already is — say where that is
  documented (`docs/block-5a-runbook.md`) rather than restating it.
- **`ALERT_EMAIL`** in the EasyPanel runtime environment, and that unset means
  silence by design.
- **What the CSP does and does not cover**, including whichever of D1's causes
  turned out to be the real one and what was done about it — and the standing
  instruction: *anybody who edits the policy runs the full Playwright suite and
  reads the pass count, because this failure produces no error message.*
- **How to read a health alert**: last success, last start, the counters, and
  `select * from cron.job_run_details order by start_time desc limit 20;`.
- **How to silence one deliberately** (`update public.job_health set
  last_success_at = now() where job_name = …`) and why that is a lie you should
  only tell on purpose.

- [ ] **Step 2: Write the report**

Follow `docs/block-11a-report.md`: what shipped, the decisions that changed
during implementation and why, the verification numbers from Task 11 Step 3
copied verbatim, and what was left undone.

- [ ] **Step 3: Commit and open the PR**

```bash
git add docs/block-11b-runbook.md docs/block-11b-report.md
git commit -m "docs(security): the runbook and report for Block 11b"
git push -u origin block-11b
gh pr create --base main \
  --title "Block 11b — the CSP, alerting for the scheduled routines, and the upload review" \
  --body-file docs/block-11b-report.md
```

**The base is `main`** — this project's PRs merge while the next block is in
flight, and a base on a merged branch fails with a 404. The report used as the
body must open by saying it branched from `main` at `32adc73`, list the three
migrations, and carry the verification numbers from Task 11 Step 3 verbatim.

---

## Post-merge

**Push the migrations to the hosted project the same day** — `npx supabase
migration list --linked`, then `supabase db push`. This project has drifted 41
migrations behind once and 10 behind twice; nothing in CI applies them.

Then set `app.health_alert_url` on the hosted database, or the sixth cron job
runs hourly and posts nowhere.
