import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Version skew: what happens to somebody who had a screen open when a deploy
 * landed.
 *
 * Every Server Action carries an id minted during `next build`, and a new build
 * mints new ones. A browser holding a page from the previous image posts an id
 * the running image has never heard of, and Next answers
 * `Failed to find Server Action "<id>"` — reported from the hosted environment
 * on 2026-08-07. The operator sees it at the moment they press Save, on a form
 * they have just filled in.
 *
 * Next's own remedy is a deployment id: with one configured, it compares the
 * client's against the server's (the `x-nextjs-deployment-id` header) and
 * answers a mismatch with a HARD NAVIGATION instead of a dead action. The
 * screen reloads onto the new build rather than failing.
 *
 * Asserted here, as text, for the reason `security/headers.test.ts` gives about
 * the same file: `next.config.mjs` is ESM config loaded by Next's own
 * machinery and importing it would pull the config loader into the test.
 * Reading it is the honest alternative to asserting nothing, and what it
 * catches is the realistic failure — the wiring quietly removed, or the build
 * arg dropped so the config reads an env var nothing ever sets.
 */
const config = readFileSync(join(process.cwd(), 'next.config.mjs'), 'utf8');
const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

describe('version skew protection', () => {
  it('next.config declares a deploymentId', () => {
    expect(config).toMatch(/deploymentId\s*:/);
  });

  it('takes it from the environment rather than hardcoding one', () => {
    // A literal would be the same value on every build, which is the same as
    // having none: skew is detected by the value CHANGING between builds.
    expect(config).toMatch(/deploymentId\s*:\s*process\.env\.NEXT_DEPLOYMENT_ID/);
  });

  it('the Dockerfile passes that variable into the build', () => {
    // The id is inlined by `next build`, so it has to exist in the BUILDER
    // stage. Setting it only at runtime reaches a bundle that was already
    // compiled — the same trap this Dockerfile already documents for
    // NEXT_PUBLIC_*.
    expect(dockerfile).toMatch(/ARG NEXT_DEPLOYMENT_ID/);
    expect(dockerfile).toMatch(/ENV NEXT_DEPLOYMENT_ID=\$NEXT_DEPLOYMENT_ID/);
  });

  it('never declares the Server Actions encryption key as a build arg', () => {
    // It is a SECRET, and a build arg is baked into the image layers — the
    // exact rule this Dockerfile already states for SUPABASE_SERVICE_ROLE_KEY.
    // It belongs in the runtime environment only. Asserted because the
    // temptation to "fix the other half of skew" by adding one more ARG beside
    // the two that are already there is real.
    expect(dockerfile).not.toMatch(/ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
  });
});
