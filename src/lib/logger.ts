import pino from 'pino';

/**
 * Field names that must never reach the log. The list carries the
 * capitalization/spelling variants this stack actually produces — pino `paths`
 * are literal and case-sensitive, so `access_token` and `accessToken` are
 * distinct entries. `access_token`/`refresh_token` are the exact names inside a
 * Supabase Auth session.
 *
 * The Portuguese entries (`senha`, `cpf`, `passaporte`) are deliberate and stay
 * despite the English-only policy: they are *data* keys, not identifiers we
 * own. The legacy database being migrated (and the Brazilian PII it carries)
 * uses those column names, so dropping them from this list would be a silent
 * redaction regression the day the ETL starts logging.
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

/** Pino's native redaction: covers the root level and one nesting level. */
const REDACT_PATHS = REDACT_FIELDS.flatMap((field) => [field, `*.${field}`]);

/** Same list, normalized, for the recursive sweep (case-insensitive). */
const SENSITIVE_KEYS = new Set(REDACT_FIELDS.map((field) => field.toLowerCase()));

/** Objects deeper than this pass through untouched — a guard against pathological logs. */
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
 * Pino's `redact` (fast-redact) only understands a ONE-level wildcard
 * (`*.field`): there is no `**`, so `session.user.cpf` would escape. A `censor`
 * does not help either — it only decides the value of an already-matched path,
 * it does not discover new paths. Hence the custom sweep in `formatters.log`,
 * which runs before the redaction stringifiers (pino/lib/tools.js `_asJson`)
 * and covers arbitrary depth and any capitalization.
 *
 * Native `redact` stays enabled because it — and not `formatters.log` — is what
 * reaches the `child()` bindings (`asChindings`) used by `withCorrelation`. The
 * two are idempotent with respect to each other.
 *
 * The sweep only descends into plain objects and arrays: Error, Date, Buffer
 * and class instances pass by reference, so as not to break pino's serializers
 * (the `err` serializer in particular).
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
