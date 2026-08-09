import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { Database } from '@/lib/supabase/database.types';
import { buildContentSecurityPolicy, CSP_NONCE_HEADER } from '@/lib/security/csp';
import { frameOrigins } from '@/lib/widget/frame-cache';
import { frameAncestorsValue } from '@/lib/widget/origins';
import { localeCookieUpdate } from '@/i18n/locales';

/**
 * Routes reachable without a session. Everything else redirects to /login.
 * `/auth/callback` must be here: someone arriving from a password-reset e-mail
 * has no session yet, and bouncing them would leave the code unexchanged.
 */
// `/` IS NOT HERE ANY MORE, and its absence is not an oversight. The body
// redirects it to /login before this list is consulted, so an entry would say
// that `/` is a public page somebody can be shown — which it stopped being when
// the landing page was deleted.
const PUBLIC_PATHS = ['/contato', '/login', '/forgot-password', '/auth/callback', '/api/health'];

const CHANGE_PASSWORD_PATH = '/change-password';
const SIGN_OUT_PATH = '/auth/signout';
const MEMBER_HOME = '/app';

export async function middleware(request: NextRequest) {
  // Block 11b. btoa rather than Buffer: this file runs on the Edge runtime.
  const nonce = btoa(crypto.randomUUID());
  const policy = buildContentSecurityPolicy(
    nonce,
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NODE_ENV !== 'production',
  );

  /**
   * Snapshotted FRESH on every call, and that is the whole of Block 11b's fix.
   *
   * Supabase's setAll below writes cookies onto `request` and then rebuilds the
   * response. A Headers object captured once would carry the cookie header from
   * before that write -- and, worse, a rebuild that passes a bare `request`
   * throws these headers away entirely, which is how Block 11a's nonce never
   * reached the renderer.
   *
   * IT TAKES THE POLICY IT IS TO ANNOUNCE, defaulting to the one above, and
   * the parameter exists for exactly one caller: the /w/ branch below builds a
   * DIFFERENT policy, and this header is where Next reads the nonce from. A
   * fixed capture of `policy` would leave the request announcing
   * `frame-ancestors 'none'` while the response announces a Station's
   * allowlist -- inert today, since Next takes only the nonce out of it, and a
   * disagreement waiting for the version that takes more.
   */
  const forwarded = (announced: string = policy) => {
    const headers = new Headers(request.headers);
    headers.set(CSP_NONCE_HEADER, nonce);
    // THIS header, on the REQUEST, is what makes Next stamp the nonce onto its
    // own inline bootstrap scripts. Setting only the response header renders a
    // page whose bootstrap is blocked by the very policy the response
    // announces -- silently, with nothing in any console the test can read.
    headers.set('Content-Security-Policy', announced);
    return headers;
  };

  const nextWithCsp = () => {
    const built = NextResponse.next({ request: { headers: forwarded() } });
    built.headers.set('Content-Security-Policy', policy);
    return built;
  };

  const redirectWithCsp = (url: URL) => {
    const built = NextResponse.redirect(url);
    built.headers.set('Content-Security-Policy', policy);
    // A redirect is a NEW response and starts with no cookies at all, so
    // everything written onto `response` above has to be carried over by hand:
    // the refreshed Supabase session from setAll, and the locale sync. Without
    // this the three branches below silently drop both -- which for the locale
    // is precisely the /change-password case its comment names.
    for (const cookie of response.cookies.getAll()) built.cookies.set(cookie);
    return built;
  };

  let response = nextWithCsp();

  /**
   * The front door. There is no landing page any more: what it said now sits
   * beside the sign-in form, in the panel the (auth) layout draws, so `/` has
   * nothing left to render.
   *
   * HERE RATHER THAN IN next.config.mjs's `redirects()`, and MEASURED rather
   * than assumed: a config redirect is answered before this file ever runs, and
   * that response carries neither the CSP nor any of the five static headers
   * from `headers()` — 0 of 6, against 6 of 6 for the line below. On the one
   * request most likely to be somebody's first contact with this product,
   * that is the wrong trade for a saved hop.
   *
   * BEFORE THE SUPABASE CLIENT IS EVEN BUILT, which is the whole reason this
   * sits at the top of the body rather than beside the redirects further down.
   * `/` has the same answer for a visitor with a session and one without, so
   * asking Supabase Auth who they are would be a network round trip whose
   * result is discarded — paid by every anonymous visitor who ever types the
   * bare domain.
   *
   * The consequence, and it is deliberate: somebody who still holds a session
   * and types `/` lands on the sign-in screen rather than on /app. That is
   * already what `/login` does for them, and changing it is a rule about where
   * a signed-in person belongs, which is not this block's business.
   */
  if (request.nextUrl.pathname === '/') {
    return redirectWithCsp(new URL('/login', request.url));
  }

  /**
   * Block 17a, spec §4.3. THE ONE ROUTE IN THIS PRODUCT THAT MAY BE FRAMED.
   *
   * Two mechanisms refused framing everywhere before this block: the
   * `X-Frame-Options: DENY` header in next.config.mjs and this policy's
   * `frame-ancestors 'none'`. The header cannot vary per route -- Next applies
   * every matching `headers()` entry and the browser obeys the strictest, so a
   * looser second entry would sit beside the DENY rather than replace it --
   * which is why the exception is written there as an EXCLUSION from that
   * entry's source, and why the value that actually names the allowed origins
   * has to be built here, in the one directive that can vary by route.
   *
   * HERE, ABOVE THE SUPABASE CLIENT, for the reason the `/` branch above
   * gives: a visitor on a radio station's website has no session and never
   * will, so getUser() would be a round trip whose answer is thrown away --
   * paid on every widget load, by every listener.
   *
   * DOCUMENT REQUESTS ONLY. Framing is a question about a page. The server
   * action POSTs from inside the frame carry no framing question, and making
   * them pay this lookup would put a database round trip in front of every
   * form submission; they get the refusal instead, which costs them nothing.
   *
   * frameOrigins returns `[]` for every path that is not a successful lookup
   * -- unknown key, disabled installation, archived installation, a fetch that
   * throws or times out, an answer it cannot read -- and frameAncestorsValue
   * turns that into 'none'. See src/lib/widget/frame-cache.ts's header for why
   * that must never become a permissive fallback.
   */
  if (request.nextUrl.pathname.startsWith('/w/')) {
    const isDocument =
      request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');

    const ancestors = isDocument
      ? frameAncestorsValue(await frameOrigins(request.nextUrl.pathname.split('/')[2] ?? ''))
      : "'none'";

    const widgetPolicy = buildContentSecurityPolicy(
      nonce,
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NODE_ENV !== 'production',
      ancestors,
    );
    const built = NextResponse.next({ request: { headers: forwarded(widgetPolicy) } });
    built.headers.set('Content-Security-Policy', widgetPolicy);
    return built;
  }

  // Refreshing the session here is what makes the cookie-write guard in
  // user-client.ts safe: Server Components cannot write cookies, so without
  // this the refreshed session would be silently discarded.
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = nextWithCsp();
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // `/invite/<token>` is public and prefix-matched, since PUBLIC_PATHS is an
  // exact-match list and a dynamic segment cannot be enumerated. The invitee has
  // no session yet, and bouncing them to /login would strand the invitation.
  const isPublic = PUBLIC_PATHS.includes(path) || path.startsWith('/invite/');

  if (!user) {
    if (isPublic) return response;
    return redirectWithCsp(new URL('/login', request.url));
  }

  // Signing out must work even from behind the gate, or a user who cannot
  // change their password has no way out of the loop.
  if (path === SIGN_OUT_PATH) return response;

  const { data: profile } = await supabase
    .from('profiles')
    .select('must_change_password, provisional_expires_at, locale')
    .eq('id', user.id)
    .single();

  // Block 12a, D2. The profile is the choice that follows this person between
  // browsers; the cookie is what rendering actually reads (src/i18n/request.ts).
  // Synchronised HERE because this is the one place holding both — the row was
  // already loaded for must_change_password, so the language costs no query at
  // all, and the renderer can read a cookie and stop.
  //
  // Before the branches below on purpose: somebody being sent to
  // /change-password should arrive there in their own language.
  const cookieLocale = localeCookieUpdate({
    profile: profile?.locale,
    cookie: request.cookies.get('locale')?.value,
  });
  if (cookieLocale) {
    // Onto the REQUEST too, following the setAll pattern above. What
    // src/i18n/request.ts reads is the REQUEST's cookies; a response-only write
    // renders THIS page in the old language and only takes effect on the next
    // one. Rebuilding the response is what carries the amended request headers
    // forward, so the cookies already on it have to be carried across the
    // rebuild -- the session refresh lives there.
    request.cookies.set('locale', cookieLocale);
    const rebuilt = nextWithCsp();
    for (const cookie of response.cookies.getAll()) rebuilt.cookies.set(cookie);
    response = rebuilt;
    response.cookies.set('locale', cookieLocale, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
    });
  }

  // A provisional password travels outside the system and is treated as
  // compromised, so it dies of old age (spec §6). Checked here rather than at
  // sign-in because an already-open session must lose access too — Supabase
  // Auth knows nothing about this column, so nothing else would stop it.
  const expiresAt = profile?.provisional_expires_at;
  if (profile?.must_change_password && expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await supabase.auth.signOut();
    return redirectWithCsp(new URL('/login?error=expired', request.url));
  }

  // The gate has no holes: while the flag is set, every path other than the
  // change screen itself redirects to it.
  if (profile?.must_change_password && path !== CHANGE_PASSWORD_PATH) {
    return redirectWithCsp(new URL(CHANGE_PASSWORD_PATH, request.url));
  }

  // And once it is clear, the change screen has nothing left to do. Everyone
  // lands on the member home; platform admins reach the console from there,
  // which keeps an is_platform_admin() round trip off every single request.
  if (!profile?.must_change_password && path === CHANGE_PASSWORD_PATH) {
    return redirectWithCsp(new URL(MEMBER_HOME, request.url));
  }

  return response;
}

export const config = {
  // `/api/webhooks/` and `/api/worker/` are excluded from the matcher itself,
  // not added to PUBLIC_PATHS. Neither caller has a session cookie: Meta (and
  // any future provider under the first prefix) is an outside system, and
  // pg_cron reaches the second through pg_net, which sends an HTTP request
  // and nothing else. Without these exclusions every such call hits line ~50
  // above and is 307-redirected to /login before the route handler ever runs
  // — Meta's GET verification handshake can never echo hub.challenge and the
  // callback URL cannot even be registered, and the worker tick returns a
  // redirect to a scheduler that reads no body, so both queues stop draining
  // in complete silence. Neither failure is visible to a unit test, which
  // imports the handler and calls it directly.
  //
  // PUBLIC_PATHS would "fix" the redirect but not the cost: getUser() at
  // line ~41 still runs first, on every request, which means every inbound
  // WhatsApp message would pay a Supabase Auth round trip before Task 11's
  // route ever starts — on the one endpoint whose entire design is staying
  // inside Meta's timeout with no promotion logic in the request path — and
  // the tick would pay another one every ten seconds, for ever. Excluding
  // from the matcher skips the middleware function's body entirely, so
  // neither cost applies.
  //
  // `/api/v1/` JOINS THEM IN BLOCK 15, on the same terms and for the same
  // reason. It holds the two external intake endpoints, which authenticate
  // themselves on a per-Station key presented as a bearer token and checked
  // against its SHA-256 in the database (0148/0149). An automation carries no
  // session cookie, so matched it would pay the same getUser() round trip on
  // every call and then be 307-redirected to /login — and a redirect answered
  // to an integration that reads only status codes is a failure that looks
  // exactly like silence.
  //
  // Kept as narrow as that: three named prefixes, not all of `/api`. All three
  // hold only machine endpoints that authenticate themselves — the webhook on
  // Meta's HMAC over the raw body, the tick on a shared secret header, the v1
  // endpoints on a hashed per-Station key — so the exclusion removes a check
  // that could not have run rather than one that was doing work.
  // `/api/health` is unaffected and stays reachable through PUBLIC_PATHS
  // exactly as before.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/webhooks/|api/worker/|api/v1/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
