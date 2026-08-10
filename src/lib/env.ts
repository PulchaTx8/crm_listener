import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SMTP_URL: z.string().url().optional(),
  MAIL_FROM: z.string().email().optional(),
  // Block 11b. Where a failing scheduled routine is reported. OPTIONAL, like
  // SMTP_URL above: a container refusing to boot because an alert address is
  // missing would be a worse outage than the one it is trying to report. Unset
  // means /api/worker/health-alert sends nothing and says so in its response.
  ALERT_EMAIL: z.string().email().optional(),
  // Public base URL, used to build the password-reset callback link.
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
  // WhatsApp Cloud API. Optional so CI and `next build` run without them; the
  // webhook route refuses to serve when they are missing rather than the whole
  // app refusing to boot (design spec D6 — no secret lives in the database).
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  // Shared secret pg_cron presents to the worker tick.
  WORKER_TICK_SECRET: z.string().min(1).optional(),
  // Signs the widget visitor session (Block 17a, design D5). OPTIONAL,
  // following WORKER_TICK_SECRET above for the same reason: a deployment with
  // no widget installed must still boot. min(32) because this key is compared
  // byte-for-byte inside an HMAC rather than hashed first, unlike the API
  // tokens in src/lib/api/credentials.ts, so it needs real entropy rather than
  // just non-emptiness. The widget's route handlers refuse with a 503 when it
  // is absent, the same shape /api/worker/tick uses for its own secret.
  WIDGET_SESSION_SECRET: z.string().min(32).optional(),
  // Where conversations live (design spec D6). OPTIONAL, and that is the whole
  // decision: unset means the Postgres driver, so the application boots, CI
  // runs and a developer works with no new service to install. A Station turns
  // it on when volume justifies it.
  REDIS_URL: z.string().url().optional(),
});

// Loose schema used ONLY under `SKIP_ENV_VALIDATION=1` (that is, during
// `next build`, when the secrets legitimately do not exist). Nothing is
// required — but the schema defaults still apply and the format of whatever
// values are present is still checked. Absence is tolerated; garbage is not.
const looseEnvSchema = envSchema.partial().extend({ NODE_ENV: envSchema.shape.NODE_ENV });

export type Env = z.infer<typeof envSchema>;

/**
 * Possibly incomplete environment. This is what actually exists when validation
 * is skipped: every required field may simply never have been defined.
 */
export type LooseEnv = z.infer<typeof looseEnvSchema>;

/**
 * An empty string means "not configured", not "configured as nothing". Docker
 * turns an `ARG` with no value into `ENV NAME=`, and an unset shell variable
 * assigned through a script lands the same way — so without this the loose
 * branch rejects an unset build arg as garbage rather than tolerating it, and
 * the strict branch reports "Invalid url" where "Required" is the truth.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== '') cleaned[key] = value;
  }
  return cleaned;
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(withoutBlanks(source));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return result.data;
}

export function parseLooseEnv(source: NodeJS.ProcessEnv): LooseEnv {
  return looseEnvSchema.parse(withoutBlanks(source));
}

// Validates at boot — the import happens in `src/instrumentation.ts`, so an
// invalid environment throws before the server serves any request.
// Skipped during `next build` (SKIP_ENV_VALIDATION=1).
export const env: Env | LooseEnv =
  process.env.SKIP_ENV_VALIDATION === '1' ? parseLooseEnv(process.env) : parseEnv(process.env);
