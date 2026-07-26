import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SMTP_URL: z.string().url().optional(),
  MAIL_FROM: z.string().email().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Configuração de ambiente inválida — ${issues}`);
  }
  return result.data;
}

// Valida no boot. Pulado durante `next build` (SKIP_ENV_VALIDATION=1).
export const env: Env =
  process.env.SKIP_ENV_VALIDATION === '1'
    ? (process.env as unknown as Env)
    : parseEnv(process.env);
