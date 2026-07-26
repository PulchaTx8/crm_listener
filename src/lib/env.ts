import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SMTP_URL: z.string().url().optional(),
  MAIL_FROM: z.string().email().optional(),
});

// Schema frouxo usado SOMENTE sob `SKIP_ENV_VALIDATION=1` (isto é, durante
// `next build`, quando os segredos legitimamente não existem). Nada é
// obrigatório — mas os defaults do schema continuam valendo e o formato dos
// valores presentes ainda é conferido. Ausência é tolerada; lixo não é.
const looseEnvSchema = envSchema.partial().extend({ NODE_ENV: envSchema.shape.NODE_ENV });

export type Env = z.infer<typeof envSchema>;

/**
 * Ambiente possivelmente incompleto. É o que existe de fato quando a validação
 * é pulada: cada campo obrigatório pode simplesmente não ter sido definido.
 */
export type LooseEnv = z.infer<typeof looseEnvSchema>;

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

export function parseLooseEnv(source: NodeJS.ProcessEnv): LooseEnv {
  return looseEnvSchema.parse(source);
}

// Valida no boot — o import acontece em `src/instrumentation.ts`, então um
// ambiente inválido lança antes de o servidor atender qualquer requisição.
// Pulado durante `next build` (SKIP_ENV_VALIDATION=1).
export const env: Env | LooseEnv =
  process.env.SKIP_ENV_VALIDATION === '1' ? parseLooseEnv(process.env) : parseEnv(process.env);
