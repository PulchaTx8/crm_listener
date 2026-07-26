import { NextResponse } from 'next/server';

// Without this, Next statically optimizes the route at build time and the
// HEALTHCHECK ends up measuring a pre-rendered file instead of the live process.
export const dynamic = 'force-dynamic';

/**
 * Liveness probe consumed by the Dockerfile `HEALTHCHECK` and by the EasyPanel
 * proxy.
 *
 * Deliberately trivial: **it does not touch the database**. A health check that
 * queries Supabase turns a database blip into a container restart — the app is
 * still alive and able to serve pages, so tearing it down only makes the
 * incident worse. Configuration validation already happens at boot
 * (`src/instrumentation.ts`), so a misconfigured container never even gets to
 * answer here.
 */
export function GET() {
  return NextResponse.json({ status: 'ok', uptime: Math.round(process.uptime()) });
}
