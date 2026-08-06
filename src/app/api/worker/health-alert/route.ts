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
 * uptime monitoring against /api/health, and no amount of code here changes it.
 * What this covers is the case that motivated the block: a database routine
 * failing silently while the app is perfectly healthy, which is what the
 * retention sweep did for a whole block.
 *
 * Excluded from the middleware matcher along with the rest of /api/worker/
 * (src/middleware.ts): pg_net holds no session cookie, so matched, this would
 * be answered with a 307 to /login that pg_cron would never read -- the same
 * defect that once stopped both queues in silence.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = env.WORKER_TICK_SECRET;
  if (!secret) {
    // A deployment fault, not a caller fault.
    return new Response('not configured', { status: 503 });
  }
  if (!secretMatches(request.headers.get('x-worker-secret'), secret)) {
    return new Response('unauthorized', { status: 401 });
  }

  const to = env.ALERT_EMAIL;
  if (!to) {
    // NOT a 503: the caller did nothing wrong and there is nothing to retry.
    // Answered honestly, so the row pg_net leaves in net._http_response says
    // why nothing happened instead of looking like a healthy installation.
    return Response.json({ configured: false, unhealthy: 0, alerted: 0 });
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
    // Stamped AFTER the send, deliberately: a stamp written first would swallow
    // the incident if the mailer threw, and silence is the failure mode this
    // whole block exists to remove.
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

/**
 * Constant-time, for the reason the worker tick's copy gives: this compares a
 * value an unauthenticated caller controls against a secret. No test fails if
 * it is swapped for `===`, so that swap has to be caught by review.
 */
function secretMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
