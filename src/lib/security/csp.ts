/**
 * Block 11b. The policy Block 11a implemented, tested and withdrew.
 *
 * A pure function on purpose. The middleware that uses it cannot be unit-tested
 * without a Next request, and a policy nobody can assert is a policy that decays
 * one "temporary" keyword at a time -- which is how `'unsafe-inline'` gets into
 * a script-src during an incident and stays there.
 *
 * The nonce itself is minted per request in src/middleware.ts, which is the only
 * place a per-request value can be produced. The five STATIC headers live in
 * next.config.mjs (Block 11a) and are not repeated here.
 */
export const CSP_NONCE_HEADER = 'x-nonce';

export function buildContentSecurityPolicy(
  nonce: string,
  supabaseUrl: string,
  isDev: boolean,
): string {
  // Throws on a URL it cannot parse, deliberately. The alternative is a
  // connect-src carrying the string "undefined", which fails at runtime in the
  // browser of whoever deployed it rather than here, where a test can see it.
  const origin = new URL(supabaseUrl).origin;
  const socket = origin.replace(/^http/, 'ws');

  return [
    "default-src 'self'",
    // 'strict-dynamic' lets a script Next itself loaded load its own chunks;
    // without it every hashed bundle filename would have to be listed.
    //
    // 'unsafe-eval' in development ONLY: `next dev` compiles with eval-based
    // source maps and React Refresh, and playwright.config.ts runs the dev
    // server locally. Without it the framework is blocked outright and nothing
    // hydrates -- the exact shape of the Block 11a failure, reported in the
    // browser console where no test was listening.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Deliberate. In CSP this keyword also covers the style ATTRIBUTE, which
    // React emits for every style={{...}} prop -- the Block 8a charts are made
    // of them. Inline style is a far smaller class of risk than inline script,
    // and pretending otherwise would cost a rewrite of working screens.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${origin}`,
    "font-src 'self' data:",
    // MUST carry the Supabase origin: supabase-js talks to the project from the
    // browser, and the realtime socket uses ws(s). Without this every
    // client-side query dies and it looks like a broken product.
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
