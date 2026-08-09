import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Where the visitor session lives, and how long a mint is good for (D5, §7). */
export const WIDGET_SESSION_COOKIE = 'pw_session';
export const WIDGET_SESSION_SECONDS = 1800;

export interface WidgetClaims {
  installationId: string;
  companyId: string;
  organizationId: string;
  memberId: string;
  phone: string;
  /** Unix seconds. Set by the caller, not derived here — see mintSession. */
  exp: number;
}

/**
 * Mints `<payload>.<signature>`, both base64url.
 *
 * Design spec D5 chose a signed token over a session row on purpose: the
 * token carries everything a request needs, so there is nothing to look up
 * and — because it stores a phone number for at most thirty minutes and then
 * simply expires — nothing to sweep, unlike `widget_verifications` (0161),
 * which needed 0131's retention sweep extended for exactly that reason.
 *
 * Takes no `now`. The brief's interface listed one for symmetry with
 * `readSession`, but `exp` already arrives as part of `claims` — the caller
 * (Task 10, after a correct code) computes it from its own clock plus
 * `WIDGET_SESSION_SECONDS` before calling this. There is nothing left for a
 * clock to do inside mint: recomputing `exp` from a `now` here would silently
 * override whatever the caller decided expiry should be, and an unused
 * parameter is exactly the kind of thing `@typescript-eslint/no-unused-vars`
 * (this repo's config has no blanket `args: 'none'` escape hatch) exists to
 * catch.
 */
export function mintSession(claims: WidgetClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verifies and decodes a session token. Returns null for anything that does
 * not check out — wrong shape, bad signature, wrong secret, or expired — one
 * outcome for every cause, on purpose: the caller is a route handler serving
 * a public iframe, with nothing useful to do with a reason, and a distinct
 * answer per cause would only hand a prober a way to tell them apart.
 *
 * CONSTANT-TIME COMPARISON HERE, and this differs from
 * `src/lib/api/credentials.ts`'s `hashToken`/`authenticate` (around line 41)
 * ON PURPOSE, not by inconsistency with that file's own "please do not fix
 * this into a scan" — the two are answering different questions. There, what
 * arrives is hashed before anything happens and what is stored is a hash, so
 * the lookup is an indexed equality over a digest: an attacker would need a
 * preimage, and a b-tree probe's timing says nothing about the secret. Here a
 * caller hands us a token straight off the wire, and we compare a MAC we
 * compute against the MAC they attached — a secret-to-secret comparison
 * against a value an attacker can vary freely, one byte at a time, and watch
 * how long each guess takes. That is exactly the shape `secretMatches` in
 * `src/app/api/worker/tick/route.ts` exists for, and this uses the same cure:
 * `timingSafeEqual`, guarded by a length check first, because
 * `timingSafeEqual` THROWS on a length mismatch rather than returning false —
 * which would leak the length through an exception instead of through the
 * comparison it exists to make safe.
 */
export function readSession(token: string, secret: string, now: number = Date.now()): WidgetClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  // noUncheckedIndexedAccess types both as possibly-undefined even though the
  // length check just above guarantees indices 0 and 1 exist -- the same
  // "satisfying the compiler about a case that cannot actually occur" idiom
  // src/app/(app)/music/permissions.ts already uses for the same reason.
  if (payload === undefined || signature === undefined) return null;

  // The MAC is checked over the payload EXACTLY AS RECEIVED — the raw
  // base64url text, before anything is decoded or parsed — because that is
  // the only thing the sender actually signed. Decoding first, parsing into
  // claims, and re-encoding those claims to verify against would check a
  // value this function invented rather than the bytes the caller sent, and
  // would wave through any edit that survives a decode/parse/re-encode
  // round-trip. This is what makes the "payload was edited" test fail closed.
  if (!signaturesMatch(sign(payload, secret), signature)) return null;

  let claims: WidgetClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as WidgetClaims;
  } catch {
    return null;
  }

  // exp is unix seconds (the shape every other timestamp of this kind in the
  // codebase is NOT — Postgres columns are timestamptz — chosen here because
  // the token is JSON, not SQL, and seconds match the JWT convention a future
  // reader will already expect). now is milliseconds, `Date.now()`'s unit, so
  // exp is scaled up rather than now scaled down, keeping the default
  // parameter a plain `Date.now()` with no unit conversion at the call site.
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;

  return claims;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * `timingSafeEqual` throws on a length mismatch, so the length is compared
 * first and a mismatch answered directly — the same guard `secretMatches`
 * (src/app/api/worker/tick/route.ts) uses, for the same reason: the throw
 * would leak the length through an exception rather than through the
 * comparison it is there to make safe.
 */
function signaturesMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'base64url');
  const b = Buffer.from(presented, 'base64url');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
