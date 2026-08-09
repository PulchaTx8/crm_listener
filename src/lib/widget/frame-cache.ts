/**
 * Block 17a, spec §4.3. The one question src/middleware.ts asks the database
 * before it decides whether a `/w/<publicKey>` document may be framed, and by
 * which origins.
 *
 * A PLAIN fetch, NOT supabase-js, and not @supabase/ssr's client either. This
 * module is imported by src/middleware.ts, which runs on the EDGE runtime --
 * the same constraint that file's own `btoa` comment records. One POST to one
 * RPC granted to `anon` (0161) is the whole requirement; a cookie-aware session
 * client would be a large dependency added to the one request in this product
 * that has no session and never will.
 *
 * THE REFUSAL IS THE DEFAULT BRANCH, and every path that is not a successful
 * lookup reaches it: an unknown key, a disabled installation, an archived one
 * (0161 answers identically for all three, deliberately), a fetch that throws,
 * a fetch that times out, a non-2xx answer, and a body that is not the shape
 * this file expects. All of them return `[]`, which frameAncestorsValue turns
 * into `'none'`.
 *
 * THAT PARAGRAPH IS THE ONE A LATER "let us make this more resilient" CHANGE
 * WOULD DELETE. Falling back to "allow" when the database cannot be reached
 * would make every widget in the product embeddable from anywhere for as long
 * as the outage lasts, with nothing on any screen to say so, and the outage is
 * exactly when nobody is looking at that screen. A widget that will not load is
 * a visible, reported failure; a widget that loads anywhere is not.
 */

/**
 * D6. SIXTY SECONDS, AND IT CUTS BOTH WAYS -- the second direction is the one
 * that chose the number.
 *
 * An origin just ADDED may not frame for up to a minute. That is lag, an
 * operator sees it as "wait a moment and reload", and it harms nobody.
 *
 * An origin just REMOVED -- or an installation just disabled, or archived --
 * may KEEP framing for up to a minute. That is a real window in which somebody
 * who was told they no longer have permission still has it. Bounded at a
 * minute it is a defensible trade against a database round trip on every widget
 * load by every listener; at an hour it would not be, and that is the whole
 * reasoning behind this constant.
 */
const TTL_MS = 60_000;

/**
 * A ceiling on how long a listener waits for a decision they cannot see being
 * made. Past it the lookup is abandoned and the refusal above applies: a widget
 * that does not appear is a better answer than a page that hangs on a database
 * that is not answering.
 */
const TIMEOUT_MS = 2_000;

/**
 * The map is keyed by a value an outsider chooses -- a public key out of an
 * iframe src -- so somebody probing with random keys could otherwise grow it
 * without bound inside a long-lived Edge instance. Cleared WHOLE rather than
 * evicted one entry at a time: an LRU would be more code than the thing it
 * protects, and the cost of a clear is one extra round trip per live
 * installation, of which a Station has exactly one.
 */
const MAX_ENTRIES = 500;

type Entry = { origins: string[]; at: number };

/**
 * MODULE SCOPE, which on the Edge means "per instance and no longer" -- there
 * is no shared cache to invalidate and none is wanted: a stale entry expires by
 * the clock above, wherever it lives.
 */
const cache = new Map<string, Entry>();

/**
 * The origins one installation may be framed by. `[]` means NOWHERE, never
 * "anywhere" -- 0159's own column comment states the same rule at the database
 * layer.
 */
export async function frameOrigins(publicKey: string): Promise<string[]> {
  // An empty key cannot be an installation, and asking would spend a round trip
  // to be told so. `/w/` with nothing after it lands here.
  if (!publicKey) return [];

  const hit = cache.get(publicKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.origins;

  const answer = await lookup(publicKey);

  // ONLY AN AUTHORITATIVE ANSWER IS REMEMBERED. `null` means the database did
  // not tell us anything -- unreachable, too slow, an answer we could not read
  // -- and caching that would turn a blip into a full minute of refusal for a
  // Station whose configuration is perfectly correct. A found/not-found answer
  // is cached; a failure is retried on the very next request. Note the
  // asymmetry is deliberate and only ever costs round trips: both branches
  // refuse, and only one of them is the truth.
  if (answer !== null) remember(publicKey, answer);

  return answer ?? [];
}

/**
 * `null` when the answer is not authoritative, a list when it is. The
 * distinction exists only for the caching decision above -- every caller of
 * `frameOrigins` sees `[]` for both.
 */
async function lookup(publicKey: string): Promise<string[] | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Not `!` on either: this runs before any route, so a missing variable must
  // refuse framing rather than throw a middleware exception onto every request
  // in the product -- including the ones that have nothing to do with a widget.
  if (!url || !key) return null;

  // AbortController rather than AbortSignal.timeout: this file is compiled for
  // the Edge runtime, and setTimeout is the primitive that is certainly there.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${url}/rest/v1/rpc/widget_frame_context`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_public_key: publicKey }),
      signal: controller.signal,
      // Next patches fetch with its own cache. A cached 200 here would extend
      // the sixty seconds above by an unknown amount, silently, which is the
      // half of that trade the comment on TTL_MS says must stay bounded.
      cache: 'no-store',
    });

    if (!response.ok) return null;

    return readOrigins(await response.json());
  } catch {
    // Every throw: a network error, an abort from the timeout above, a body
    // that is not JSON. See this file's header for why this branch may never
    // become anything but a refusal.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 0161 answers `{"found": bool, "origins": [...]}`. ANYTHING ELSE IS NOT AN
 * ANSWER: a PostgREST error envelope, a proxy's HTML error page parsed as JSON,
 * a future migration that changes the shape. Those return `null` rather than a
 * best guess, because the only guess available here would be a permissive one.
 *
 * Non-string and empty elements are refused rather than filtered out. The
 * database CHECK (`are_origins`, 0159) cannot produce either, so seeing one
 * means the answer did not come from where this function thinks it did, and
 * salvaging the rest of such a list is exactly the reasoning that ends in a
 * frame-ancestors directive nobody intended.
 */
function readOrigins(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;

  const { found, origins } = body as { found?: unknown; origins?: unknown };

  if (found === false) return [];
  if (found !== true) return null;

  if (!Array.isArray(origins)) return null;
  if (!origins.every((origin) => typeof origin === 'string' && origin.length > 0)) return null;

  return origins as string[];
}

function remember(publicKey: string, origins: string[]): void {
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(publicKey, { origins, at: Date.now() });
}
