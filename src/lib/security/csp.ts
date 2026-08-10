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
  // Block 17a. Defaults to 'none', which is what every caller that existed
  // before this block gets without being touched. Exactly one call site passes
  // anything else: src/middleware.ts's /w/ branch, and only after it has looked
  // up one specific Station's allowed_origins through widget_frame_context.
  // Every other request in this product -- including the same middleware's own
  // ordinary path -- still gets the value this function has always produced,
  // which is why the default is the refusal and not a wildcard.
  frameAncestors: string = "'none'",
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
    // cdn-images.dzcdn.net is where every album cover in this product comes
    // from (Block 13a, design D4). The host is named here and in exactly one
    // other place -- src/lib/integrations/deezer/cover.ts, which builds the
    // URL -- because nothing stores a Deezer URL. If one moves, both move.
    `img-src 'self' data: blob: ${origin} https://cdn-images.dzcdn.net`,
    // NEW IN BLOCK 13a, and the reason it has to exist at all: there was no
    // media-src before, so audio fell back to default-src 'self' and every
    // 30-second preview in the Deezer tab was blocked -- silently, which in a
    // search results list reads as "this track has no preview" rather than as
    // a policy refusing it.
    //
    // The wildcard is deliberate. Deezer's preview host has moved between
    // `cdns-preview-N.dzcdn.net` and `cdnt-preview.dzcdn.net` over the years,
    // and a literal host would break the tab on a day nobody deployed
    // anything. The subdomain wildcard costs the ability to load media from
    // any dzcdn.net host, which is Deezer's own CDN and nothing else.
    "media-src 'self' https://*.dzcdn.net",
    "font-src 'self' data:",
    // MUST carry the Supabase origin: supabase-js talks to the project from the
    // browser, and the realtime socket uses ws(s). Without this every
    // client-side query dies and it looks like a broken product.
    `connect-src 'self' ${origin} ${socket}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Agrees with X-Frame-Options: DENY in next.config.mjs (Block 11a) on
    // every route except /w/ (Block 17a), where Task 9 narrows that header's
    // source to exclude the widget path -- X-Frame-Options cannot itself vary
    // by route: Next applies every matching `headers()` entry and the browser
    // obeys the strictest, so a second, looser entry for /w/ would not
    // "override" the blanket DENY, it would just ship a widget that still
    // frames nowhere. The per-route exception has to live here instead, in
    // the one directive that CAN vary by route, which is the whole reason
    // `frameAncestors` is now a parameter rather than the literal this line
    // used to be. A permissive value beside a strict one is still the shape
    // of an accident; what changes with Task 9 is that the strict one is no
    // longer everywhere, and this parameter is what keeps that exception
    // recorded in code instead of in a route's silent absence from a regex.
    `frame-ancestors ${frameAncestors}`,
    'upgrade-insecure-requests',
  ].join('; ');
}
