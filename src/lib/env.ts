import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SMTP_URL: z.string().url().optional(),
  MAIL_FROM: z.string().email().optional(),
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

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return result.data;
}

export function parseLooseEnv(source: NodeJS.ProcessEnv): LooseEnv {
  return looseEnvSchema.parse(source);
}

// Validates at boot — the import happens in `src/instrumentation.ts`, so an
// invalid environment throws before the server serves any request.
// Skipped during `next build` (SKIP_ENV_VALIDATION=1).
export const env: Env | LooseEnv =
  process.env.SKIP_ENV_VALIDATION === '1' ? parseLooseEnv(process.env) : parseEnv(process.env);
