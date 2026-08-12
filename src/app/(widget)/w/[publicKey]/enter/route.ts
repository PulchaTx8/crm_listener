import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase/service-client';
import {
  WIDGET_SESSION_COOKIE,
  WIDGET_SESSION_SECONDS,
  mintSession,
  type WidgetClaims,
} from '@/lib/widget/session';

/**
 * Block 19a. The door a WhatsApp reply's link opens: trades the single-use
 * code Task 2's `consume_widget_link` guards for the same session cookie
 * 17a's `verifyCodeAction` mints, then sends the browser on to the widget
 * itself — identified, with nothing left in the address bar to show for it.
 *
 * NEVER A 404. A code can fail for reasons that are entirely the listener's:
 * they waited past the fifteen-minute expiry, they already opened this exact
 * link once, or (rarer) they pasted a code from one Station's WhatsApp number
 * onto another Station's widget. None of those is a broken link, and a 404
 * reads as one — which is what stops somebody trusting the number they wrote
 * to. Every failure below, whatever its cause, lands on the widget itself
 * with `?link=expired`, the same page a listener who never had a code sees,
 * saying "ask again".
 *
 * SERVICE ROLE, because there is no alternative: `consume_widget_link` is
 * granted to `service_role` only (0178) — a visitor arriving from WhatsApp
 * has no session to present, the same argument `actions.ts`'s header makes
 * for 17a's two server actions.
 */

/** The two destinations Task 7's page understands. Anything else is dropped, not passed on. */
const OPEN_DESTINATIONS = new Set(['music', 'promotion']);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicKey: string }> },
): Promise<Response> {
  const { publicKey } = await params;
  const url = new URL(request.url);
  const code = url.searchParams.get('k');
  const open = readOpen(url.searchParams);

  // A DEPLOYMENT FAULT, NOT A CALLER FAULT, and refused before the code is
  // ever spent — the same order `verifyCodeAction` (actions.ts) uses for the
  // same reason: `consume_widget_link` burns the code in the same statement
  // that reads it, so calling it with nowhere to put the session would waste
  // a listener's only working link to produce an error nobody sees. 503, not
  // a redirect: `env.ts`'s own comment names this exact shape, the one
  // `/api/worker/tick` and the WhatsApp webhook already use for a missing
  // secret — there is no "ask again" that fixes a deployment nobody configured.
  const secret = env.WIDGET_SESSION_SECRET;
  if (!secret) {
    logger.error('widget: WIDGET_SESSION_SECRET is not configured; refusing to open a link');
    return new Response('not configured', { status: 503 });
  }

  // A missing code is the same fact as a refused one to whoever is standing
  // here: nothing to exchange for a session.
  if (!code) return redirectTo(publicKey, { link: 'expired' });

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc('consume_widget_link', { p_code: code });
  if (error) {
    // `error.message` carries PostgREST's text, which names arguments and
    // never their values — the code itself never reaches this log line.
    logger.error({ publicKey, code: error.code, message: error.message }, 'widget: consume_widget_link failed');
    return redirectTo(publicKey, { link: 'expired' });
  }

  const answer = readLinkAnswer(data);
  if (!answer) {
    logger.error({ publicKey }, 'widget: consume_widget_link answered a shape this code does not know');
    return redirectTo(publicKey, { link: 'expired' });
  }
  // `unusable` (used, expired, or unknown) and `unavailable` (the Station was
  // switched off or suspended since the code was minted) are ONE outcome
  // here, on purpose: 0178's own comment gives a distinct reason so an
  // OPERATOR can act on `unavailable` from a screen that reads it, and this
  // door has no such screen — a public URL's caller has nothing useful to do
  // with the difference, same as 0178's own reasoning for folding used,
  // expired and unknown into `unusable` in the first place.
  if (!answer.ok) return redirectTo(publicKey, { link: 'expired' });

  if (!answer.publicKey || !answer.companyId || !answer.organizationId || !answer.memberId) {
    // `ok` with a claim missing is not a success anybody here can act on —
    // the same guard `verifyCodeAction` applies to `widget_verify_code`'s
    // answer, for the same reason.
    logger.error({ publicKey }, 'widget: consume_widget_link said ok without every claim a session needs');
    return redirectTo(publicKey, { link: 'expired' });
  }

  // THE KEY THE CODE WAS MINTED FOR, NEVER THE ONE IN THE ADDRESS. A code
  // pasted onto another Station's URL must not mint a session there — the
  // exact cross-tenant shape `readSessionFor`'s own header warns about, one
  // step earlier: at MINT time rather than at every later read.
  if (answer.publicKey !== publicKey) return redirectTo(publicKey, { link: 'expired' });

  // `consume_widget_link` does not return the listener's phone — by design:
  // it answers with exactly what `widget_link_tokens` (0178) stores, and that
  // row never held one. `members.phone` is read directly instead of widening
  // the door's answer, because the door is already shipped and reviewed
  // (Task 2) and Task 5 set the precedent for this exact trade-off with
  // `widget_link_send_context` rather than reopening 0178 a second time. The
  // read costs nothing extra in access: 0035 grants `service_role` a bare
  // SELECT on `members`, read-only, for exactly this kind of system lookup.
  const { data: memberRow, error: memberError } = await supabase
    .from('members')
    .select('phone')
    .eq('id', answer.memberId)
    .maybeSingle();
  if (memberError) {
    logger.error(
      { publicKey, code: memberError.code, message: memberError.message },
      'widget: could not read the phone of the member a consumed link named',
    );
    return redirectTo(publicKey, { link: 'expired' });
  }
  if (!memberRow?.phone) {
    // The FK from widget_link_tokens.member_id makes a missing row nearly
    // unreachable; a member row with no phone at all is the one this guards
    // against — WidgetClaims.phone is not optional, and inventing a
    // placeholder would hand every later door a listener that does not exist.
    logger.error({ publicKey, memberId: answer.memberId }, 'widget: consume_widget_link named a member with no phone on file');
    return redirectTo(publicKey, { link: 'expired' });
  }

  const claims: WidgetClaims = {
    publicKey: answer.publicKey,
    companyId: answer.companyId,
    organizationId: answer.organizationId,
    memberId: answer.memberId,
    phone: memberRow.phone,
    // Block 19a's own claim (session.ts): this session was minted by a code a
    // WhatsApp link carried, not by 17a's identify form on the Station's site.
    channel: 'WHATSAPP',
    // `mintSession` takes no clock; expiry is decided here, by the caller, in
    // unix seconds to match `readSession`'s comparison — same as
    // `verifyCodeAction`.
    exp: Math.floor(Date.now() / 1000) + WIDGET_SESSION_SECONDS,
  };

  const cookieStore = await cookies();
  cookieStore.set(WIDGET_SESSION_COOKIE, mintSession(claims, secret), {
    // Copied from `verifyCodeAction` (actions.ts) rather than reinvented —
    // that file's own comment explains why each of these five is load-bearing
    // for a cookie the widget's third-party iframe has to receive.
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    partitioned: true,
    path: '/w',
    maxAge: WIDGET_SESSION_SECONDS,
  });

  return redirectTo(publicKey, open);
}

/**
 * `open`/`id`, filtered to the two shapes Task 7's page understands and
 * dropped — not merely defaulted — for anything else: a `promotion` with no
 * `id` names nothing to open, and a value outside `OPEN_DESTINATIONS` is a
 * URL somebody edited by hand, not a destination this door can honour.
 * Whether the named promotion is one THIS listener may actually see is
 * Task 7's question, asked again on the page — this is only ever a pass
 * through of what the address bar already said.
 */
function readOpen(params: URLSearchParams): Record<string, string> {
  const open = params.get('open');
  if (!open || !OPEN_DESTINATIONS.has(open)) return {};
  if (open === 'promotion') {
    const id = params.get('id');
    return id ? { open, id } : {};
  }
  return { open };
}

/**
 * A RELATIVE Location, and it takes no request at all — which is the point.
 * `src/app/auth/signout/route.ts` measured why: an absolute URL built from
 * this request's own origin resolves to the reverse proxy's internal address
 * in production (`https://0.0.0.0:3000`, 2026-08-10), and the browser cannot
 * follow it. RFC 7231 §7.1.2 has the browser resolve a relative Location
 * against the request it just made, so this needs the deployment's public
 * address for nothing.
 *
 * ALWAYS ONE LEADING SLASH, NEVER TWO: `publicKey` reaches this function as a
 * path segment Next decoded out of the incoming URL, so it is not trusted
 * verbatim — `encodeURIComponent` keeps it to a single segment no matter what
 * it contains, and the literal `/w/` this function itself prepends is what
 * stops the result from ever starting `//`, which a browser would resolve as
 * protocol-relative to another host entirely (the same open-redirect shape
 * `auth/callback/route.ts` guards against for its own `next` parameter).
 */
function redirectTo(publicKey: string, query: Record<string, string>): NextResponse {
  const qs = new URLSearchParams(query).toString();
  const path = `/w/${encodeURIComponent(publicKey)}${qs ? `?${qs}` : ''}`;
  // 303, not 302: the browser must issue a fresh GET, so the code in `k=`
  // does not survive into the request that follows, the address bar, or
  // history.
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

/** What `consume_widget_link` (0178) answers, checked rather than trusted — it arrives as `Json`. */
interface LinkAnswer {
  ok: boolean;
  publicKey: string | null;
  companyId: string | null;
  organizationId: string | null;
  memberId: string | null;
}

function readLinkAnswer(data: unknown): LinkAnswer | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.ok !== 'boolean') return null;
  return {
    ok: row.ok,
    publicKey: typeof row.public_key === 'string' ? row.public_key : null,
    companyId: typeof row.company_id === 'string' ? row.company_id : null,
    organizationId: typeof row.organization_id === 'string' ? row.organization_id : null,
    memberId: typeof row.member_id === 'string' ? row.member_id : null,
  };
}
