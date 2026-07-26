import pino from 'pino';

/**
 * Nomes de campo que nunca podem ir para o log. A lista traz as variantes de
 * capitalização/grafia que este stack realmente produz — os `paths` do pino são
 * literais e case-sensitive, então `access_token` e `accessToken` são entradas
 * distintas. `access_token`/`refresh_token` são os nomes exatos dentro de uma
 * sessão do Supabase Auth.
 */
const REDACT_FIELDS = [
  'password',
  'senha',
  'token',
  'access_token',
  'refresh_token',
  'accessToken',
  'refreshToken',
  'authorization',
  'Authorization',
  'apiKey',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'service_role',
  'SUPABASE_SERVICE_ROLE_KEY',
  'cpf',
  'passaporte',
  'passport',
];

const CENSOR = '[REDACTED]';

/** Redação nativa do pino: cobre o nível raiz e um nível de aninhamento. */
const REDACT_PATHS = REDACT_FIELDS.flatMap((field) => [field, `*.${field}`]);

/** Mesma lista, normalizada, para a varredura recursiva (case-insensitive). */
const SENSITIVE_KEYS = new Set(REDACT_FIELDS.map((field) => field.toLowerCase()));

/** Objetos mais fundos que isto passam intactos — guarda contra logs patológicos. */
const MAX_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const out = value.map((item) => redactValue(item, seen, depth + 1));
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const out = redactObject(value, seen, depth);
  seen.delete(value);
  return out;
}

function redactObject(
  obj: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? CENSOR : redactValue(value, seen, depth + 1);
  }
  return out;
}

/**
 * O `redact` do pino (fast-redact) só entende curinga de UM nível (`*.campo`):
 * não existe `**`, então `session.user.cpf` escaparia. Um `censor` também não
 * resolve — ele só decide o valor de um path já casado, não descobre paths
 * novos. Por isso a varredura própria em `formatters.log`, que roda antes dos
 * stringifiers de redação (pino/lib/tools.js `_asJson`) e cobre profundidade
 * arbitrária e qualquer capitalização.
 *
 * O `redact` nativo continua ativo porque ele — e não `formatters.log` — é o
 * que alcança os bindings de `child()` (`asChindings`), usados por
 * `withCorrelation`. Os dois são idempotentes entre si.
 *
 * A varredura só desce em objetos literais e arrays: Error, Date, Buffer e
 * instâncias de classe passam por referência, para não quebrar os serializers
 * do pino (o `err` serializer, em particular).
 */
function redactLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  seen.add(obj);
  return redactObject(obj, seen, 0);
}

export interface Logger extends pino.Logger {
  withCorrelation(id: string): Logger;
}

export function createLogger(destination?: pino.DestinationStream): Logger {
  const base = pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: REDACT_PATHS, censor: CENSOR },
      formatters: { log: redactLogObject },
    },
    destination,
  );
  return attach(base);
}

function attach(instance: pino.Logger): Logger {
  const logger = instance as Logger;
  logger.withCorrelation = (id: string) => attach(instance.child({ correlationId: id }));
  return logger;
}

export const logger = createLogger();
