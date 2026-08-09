'use server';

import { cookies, headers } from 'next/headers';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { createServiceClient } from '@/lib/supabase/service-client';
import { generateCode, hashCode, hashLimitSubject } from '@/lib/widget/code';
import {
  WIDGET_SESSION_COOKIE,
  WIDGET_SESSION_SECONDS,
  mintSession,
  readSession,
  type WidgetClaims,
} from '@/lib/widget/session';
import { identifySchema, publicKeySchema, verifySchema } from '@/schemas/widget';

/**
 * Block 17a, spec §6. The two things a visitor on a Station's own website can
 * ask this product to do before they are anybody: send me a code, and here is
 * the code.
 *
 * THE RAW CODE APPEARS IN EXACTLY TWO EXPRESSIONS IN THIS FILE — the
 * `generateCode()` that makes it and the object literal that hands it to
 * `widget_request_code` as `p_code_hash`/`p_code_plain`. It is never returned,
 * never put in a state object a browser receives, and never logged. That last
 * one is the easy mistake: a `logger.info({ payload })` added later "to debug
 * the widget" would write live six-digit codes into the log of a system whose
 * whole verification story is that the database keeps only their SHA-256. The
 * log lines below name a `reason` and a `publicKey`, and nothing else — not the
 * telephone number either, which is personal data with its own retention rule
 * (0161's 30-day sweep) that a log file does not honour.
 *
 * SERVICE ROLE, because there is no alternative: `widget_request_code` and
 * `widget_verify_code` are granted to `service_role` only (0161), and a visitor
 * has no session to borrow. This is the same argument Block 15's API door makes
 * for its own key-as-subject; the containment is that both doors take the
 * public key as an argument and resolve everything from it themselves, so
 * nothing here chooses which Station it is acting for.
 */

// ---------------------------------------------------------------------------
// The limits. Spec §6.3: THIS IS THE ENDPOINT THAT SPENDS MONEY — every call
// that gets past them makes Meta bill the Station.
//
// PostgresRateLimiter, NEVER the in-memory one, and this is not a style
// preference: `output: 'standalone'` (next.config.mjs) means there may be
// several instances, each with its own Map, so an in-memory counter multiplies
// every limit below by however many containers happen to be running. That is
// acceptable for a person clicking a button and worthless against a script,
// which is the only caller these numbers exist for.
// ---------------------------------------------------------------------------

/** One code a minute per number: a person who mistyped can retry, a loop cannot. */
const CODE_PER_PHONE_MINUTE = { limit: 1, windowSeconds: 60 } as const;
/** Five an hour per number, spec §6.3. Past that the number is not the problem. */
const CODE_PER_PHONE_HOUR = { limit: 5, windowSeconds: 3600 } as const;
/** Ten an hour per address: a household or a small office, not a fleet of numbers. */
const CODE_PER_IP_HOUR = { limit: 10, windowSeconds: 3600 } as const;

/**
 * THE STATION CEILING, and it is the one that is not about fairness (spec
 * §6.3): without it a script requesting codes for a thousand invented numbers
 * from a thousand addresses produces a BILL rather than an outage, and a bill
 * is discovered a month later.
 *
 * Neither the spec nor 0159 fixes the number — there is no per-installation
 * column for it, so it is one constant here and tuning it is a deployment, not
 * a console setting. 200/hour is chosen against the two failure modes rather
 * than picked round: a Station reading its widget out on air can plausibly draw
 * a few hundred identifications in the hour that follows, and refusing a real
 * listener is a visible product failure, while 200 WhatsApp template messages
 * is a bounded, small, *noticeable* hourly bill rather than an open tap. Lower
 * it and the first real promotion is what discovers the ceiling.
 */
const CODE_PER_STATION_HOUR = { limit: 200, windowSeconds: 3600 } as const;

/**
 * KEYED BY THE PUBLIC KEY, NOT BY `company_id`, and that is forced rather than
 * chosen. Nothing this action can call will tell it which company a public key
 * belongs to: `widget_installations` has RLS on and its ACL revoked (0159 —
 * measured: `service_role` gets 42501 on that table), `widget_request_code`
 * resolves the installation privately and returns only
 * `{ok, reason, verification_id}`, and `widget_frame_context` returns origins.
 * The alternative to this key is no Station ceiling at all.
 *
 * It costs almost nothing, because the two are 1:1 for a live installation
 * (`widget_installations_key_unique`, 0159). The one difference: an
 * installation archived and recreated gets a new key and therefore a fresh
 * hourly budget — which requires a platform admin, and is not a move available
 * to the script this ceiling exists to stop.
 */
function stationKey(publicKey: string): string {
  return `widget:code:station:${publicKey}`;
}

/**
 * The verify limits, DELIBERATELY ON THEIR OWN KEYS rather than sharing the
 * budget above, and that separation is load-bearing.
 *
 * Spending `widget:code:*` budget on a verification would mean a visitor who
 * asked for one code could make exactly one attempt at typing it — the
 * one-a-minute phone limit would refuse the second — and the database's ceiling
 * of five attempts (0161) would never be reachable at all. The product would
 * look broken to anybody who fumbles six digits, which is most people.
 *
 * The numbers are DERIVED from the limits above rather than chosen: the most
 * attempts a legitimate visitor can make in an hour is five codes times five
 * attempts (25) per number, and ten codes times five attempts (50) per address.
 * These sit just above both, so they can only ever refuse a caller who is
 * already past what the code limits permit. What actually protects a six-digit
 * code is the ceiling and the ten-minute expiry, both in the database; this is
 * only here so an unauthenticated POST endpoint is not unbounded.
 */
const VERIFY_PER_PHONE_HOUR = { limit: 30, windowSeconds: 3600 } as const;
const VERIFY_PER_IP_HOUR = { limit: 60, windowSeconds: 3600 } as const;

/** Every named refusal the first step can answer with, plus this layer's own. */
export type RequestCodeRefusal =
  | 'invalid'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown_installation'
  | 'no_integration'
  | 'no_template'
  | 'failed';

export type RequestCodeState =
  | { status: 'idle' }
  | { status: 'sent' }
  | { status: 'refused'; reason: RequestCodeRefusal };

/** 0161's named refusals for the second step, plus this layer's own. */
export type VerifyRefusal =
  | 'invalid'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown_installation'
  | 'no_pending_code'
  | 'expired'
  | 'too_many_attempts'
  | 'wrong_code'
  | 'name_required'
  | 'listener_anonymized'
  | 'failed';

export type VerifyState =
  | { status: 'idle' }
  | { status: 'identified' }
  | { status: 'refused'; reason: VerifyRefusal };

/**
 * Sends six digits to a telephone number, if every limit in §6.3 allows it.
 *
 * THE ORDER OF THE FIRST THREE STEPS IS THE WHOLE DESIGN OF THIS FUNCTION:
 * refuse without a secret, then parse, then limit, then spend. Parsing before
 * limiting looks like it breaks "rate-limit before anything else" and does not
 * — a Zod parse is pure, local and free, and the phone it yields is what the
 * first limit is keyed by, so there is nothing to key on until it has run.
 * Every step that costs anything at all is after all four limits.
 */
export async function requestCodeAction(
  _previous: RequestCodeState,
  formData: FormData,
): Promise<RequestCodeState> {
  // A DEPLOYMENT FAULT, NOT A CALLER FAULT — the same refusal /api/worker/tick
  // gives when its own secret is missing, and it belongs here rather than only
  // in `verifyCodeAction` because a code that can never be exchanged for a
  // session is the Station's money spent on nothing. Checked before the limits
  // deliberately: an unconfigured deployment should not also burn a visitor's
  // hourly budget telling them so.
  const secret = env.WIDGET_SESSION_SECRET;
  if (!secret) {
    logger.error('widget: WIDGET_SESSION_SECRET is not configured; refusing to send a code');
    return { status: 'refused', reason: 'unavailable' };
  }

  // Before anything can refuse and return: whatever else this submission does,
  // the visitor should stop carrying a token no installation would accept. It
  // costs a cookie read and no round trip.
  await expireDeadSession(secret);

  // THE ONE INPUT THAT WOULD OTHERWISE SKIP THE SCHEMA LAYER. It arrives in a
  // hidden field, so it is as much "whatever was posted" as the phone beside
  // it, and it goes on to become a rate-limit key and an RPC argument. Parsed
  // against the same shape 0159's CHECK enforces, so an unbounded or malformed
  // value is refused here rather than opening a rate-limit bucket of its own —
  // which is how a key nobody can exhaust becomes a ceiling nobody has.
  const key = publicKeySchema.safeParse(formData.get('publicKey'));
  const parsed = identifySchema.safeParse({
    phone: formData.get('phone'),
    name: formData.get('name'),
  });
  if (!key.success || !parsed.success) return { status: 'refused', reason: 'invalid' };
  const publicKey = key.data;

  const supabase = createServiceClient();
  const limiter = new PostgresRateLimiter(supabase);
  const ip = await callerIp();
  const phoneBucket = phoneKey(parsed.data.phone);

  // ALL FOUR BEFORE ANYTHING IS SENT, and short-circuited rather than checked
  // all at once: a `check` CONSUMES budget from its own window whether it
  // allows or refuses (the RateLimiter contract), so asking every one of them
  // every time would spend a visitor's hourly allowance on a request the first
  // limit already refused.
  const refusedBy = await withinLimits(limiter, publicKey, [
    { key: `widget:code:phone:${phoneBucket}`, label: 'code/phone/minute', ...CODE_PER_PHONE_MINUTE },
    { key: `widget:code:phone:hour:${phoneBucket}`, label: 'code/phone/hour', ...CODE_PER_PHONE_HOUR },
    { key: `widget:code:ip:${ipKey(ip)}`, label: 'code/ip/hour', ...CODE_PER_IP_HOUR },
    { key: stationKey(publicKey), label: 'code/station/hour', ...CODE_PER_STATION_HOUR },
  ]);
  if (refusedBy) return { status: 'refused', reason: 'rate_limited' };

  // From here to the RPC below is the only place the six digits exist in this
  // process. `p_ttl_seconds` is not passed: 0161's default of 600 is the ten
  // minutes the spec names, and repeating it here would create a second place
  // for the expiry to be changed in.
  const code = generateCode();
  const { data, error } = await supabase.rpc('widget_request_code', {
    p_public_key: publicKey,
    p_phone: parsed.data.phone,
    p_code_hash: hashCode(code),
    p_code_plain: code,
  });

  if (error) {
    // `error.message` carries PostgREST's text, which names ARGUMENTS and never
    // their values — no code can reach a log through this line.
    logger.error({ publicKey, code: error.code, message: error.message }, 'widget: request_code failed');
    return { status: 'refused', reason: 'failed' };
  }

  const answer = readAnswer(data);
  if (!answer) {
    logger.error({ publicKey }, 'widget: request_code answered a shape this code does not know');
    return { status: 'refused', reason: 'failed' };
  }
  if (!answer.ok) {
    // Named refusals, passed through: 0161 distinguishes unknown_installation,
    // no_integration and no_template so somebody can be told which, and
    // collapsing them into one sentence here would throw away the only
    // information a visitor could act on ("this station cannot send codes" is a
    // different fact from "try again later").
    logger.warn({ publicKey, reason: answer.reason }, 'widget: request_code refused');
    return { status: 'refused', reason: requestRefusal(answer.reason) };
  }

  return { status: 'sent' };
}

/**
 * Proves the six digits and, if they are right, writes the session cookie that
 * makes this browser a known listener for the next thirty minutes.
 */
export async function verifyCodeAction(
  _previous: VerifyState,
  formData: FormData,
): Promise<VerifyState> {
  const secret = env.WIDGET_SESSION_SECRET;
  if (!secret) {
    // Same deployment fault as above, and refused BEFORE the door rather than
    // after: `widget_verify_code` consumes the verification row on a correct
    // code (0161, step 6, stamped before anything else can fail), so calling it
    // with nowhere to put the session would burn a listener's only valid code
    // to produce an error message.
    logger.error('widget: WIDGET_SESSION_SECRET is not configured; refusing to verify a code');
    return { status: 'refused', reason: 'unavailable' };
  }

  await expireDeadSession(secret);

  // Same reasoning as `requestCodeAction`: the key is posted, so it is checked.
  const key = publicKeySchema.safeParse(formData.get('publicKey'));
  const parsed = verifySchema.safeParse({
    phone: formData.get('phone'),
    name: formData.get('name'),
    code: formData.get('code'),
  });
  if (!key.success || !parsed.success) return { status: 'refused', reason: 'invalid' };
  const publicKey = key.data;

  const supabase = createServiceClient();
  const limiter = new PostgresRateLimiter(supabase);
  const ip = await callerIp();

  const refusedBy = await withinLimits(limiter, publicKey, [
    {
      key: `widget:verify:phone:${phoneKey(parsed.data.phone)}`,
      label: 'verify/phone/hour',
      ...VERIFY_PER_PHONE_HOUR,
    },
    { key: `widget:verify:ip:${ipKey(ip)}`, label: 'verify/ip/hour', ...VERIFY_PER_IP_HOUR },
  ]);
  if (refusedBy) return { status: 'refused', reason: 'rate_limited' };

  // No installation lookup: the door resolves the public key itself and answers
  // `unknown_installation` when it names nothing live, which is the same
  // refusal a lookup here would have produced — one round trip instead of two,
  // and one authority on what a live installation is instead of two.
  const { data, error } = await supabase.rpc('widget_verify_code', {
    p_public_key: publicKey,
    p_phone: parsed.data.phone,
    p_code_hash: hashCode(parsed.data.code),
    p_name: parsed.data.name,
  });

  if (error) {
    logger.error({ publicKey, code: error.code, message: error.message }, 'widget: verify_code failed');
    return { status: 'refused', reason: 'failed' };
  }

  const answer = readAnswer(data);
  if (!answer) {
    logger.error({ publicKey }, 'widget: verify_code answered a shape this code does not know');
    return { status: 'refused', reason: 'failed' };
  }
  if (!answer.ok) return { status: 'refused', reason: verifyRefusal(answer.reason) };
  if (!answer.memberId) {
    // ok with no listener behind it is not a success anybody can act on.
    logger.error({ publicKey }, 'widget: verify_code said ok without a member');
    return { status: 'refused', reason: 'failed' };
  }

  if (!answer.companyId || !answer.organizationId) {
    logger.error({ publicKey }, 'widget: verify_code said ok without a station');
    return { status: 'refused', reason: 'failed' };
  }

  const claims: WidgetClaims = {
    // WHICH WIDGET THIS SESSION IS FOR. The door just proved this key names a
    // live installation — it refuses `unknown_installation` otherwise — so the
    // key is carried into the token, and the page compares it against its own
    // URL. Without it a session minted at Station A is presented, by the
    // browser, to Station B's page on the same Path=/w and looks valid. See the
    // field's comment in src/lib/widget/session.ts for why it is the key rather
    // than the row id.
    publicKey,
    companyId: answer.companyId,
    organizationId: answer.organizationId,
    memberId: answer.memberId,
    phone: parsed.data.phone,
    // `mintSession` takes no clock; expiry is decided here, by the caller, and
    // in unix SECONDS to match `readSession`'s comparison.
    exp: Math.floor(Date.now() / 1000) + WIDGET_SESSION_SECONDS,
  };

  const cookieStore = await cookies();
  cookieStore.set(WIDGET_SESSION_COOKIE, mintSession(claims, secret), {
    // EVERY ONE OF THESE FIVE IS LOAD-BEARING, and every one of them looks
    // removable to somebody who has only ever set a first-party cookie.
    //
    // httpOnly: the token is an HMAC that names a listener. Script inside the
    // frame has no business reading it, and the widget never needs to.
    httpOnly: true,
    // secure: required by BOTH of the two below — a browser drops a
    // SameSite=None cookie and a Partitioned cookie that is not Secure. It is
    // not an extra precaution here, it is the precondition.
    secure: true,
    // sameSite 'none': THE WIDGET LIVES IN A THIRD-PARTY IFRAME. A 'lax' cookie
    // is simply not sent in that context — not "sometimes", not "on the first
    // request", never — so the widget would identify a visitor, set a cookie,
    // and then not know them on the very next click. That reads as this product
    // being broken rather than as a cookie policy, which is exactly why it must
    // not be "tightened" back to 'lax' by somebody reading this line out of
    // context. Spec §7 says the same in writing.
    sameSite: 'none',
    // partitioned: CHIPS. Chrome is removing unpartitioned third-party cookies,
    // and without this attribute the widget goes with them — in a BROWSER
    // release, on a day nobody here deployed anything, with no error anywhere
    // and nothing on any screen to say so. It also scopes the cookie to the
    // pair (embedding site, this site), which is the scope a per-Station
    // visitor session should have had regardless.
    partitioned: true,
    // path '/w': the widget's own subtree and nothing else. It keeps this
    // cookie off every other route in the product, including the signed-in
    // application, so it can never be confused for an authentication cookie.
    // It does NOT separate one installation from another — every widget on
    // this deployment shares this path — which is what `publicKey` in the
    // claims above is for.
    path: '/w',
    maxAge: WIDGET_SESSION_SECONDS,
  });

  return { status: 'identified' };
}

/**
 * Throws away a session cookie that is dead, on the visitor's next submission.
 *
 * WHY IT LIVES HERE AND NOT ON THE PAGE that discovers the dead token:
 * `cookies()` is read-only inside a Server Component, and a `delete` there
 * throws "Cookies can only be modified in a Server Action or Route Handler" —
 * measured, and the page 500s. A server action is one of the two places Next
 * allows the write, and it is the place the visitor reaches by submitting the
 * form the page just rendered.
 *
 * DEAD EVERYWHERE, NOT MERELY FOREIGN, and the distinction is the whole care in
 * this function. `readSession` rather than `readSessionFor`: a session minted at
 * another Station is still that Station's, and a visitor identified on radio
 * A's widget who happens to open radio B's must not be signed out of A by
 * having typed a telephone number into B. Only a token that no installation
 * could accept — expired, forged, or signed with a retired secret — is expired
 * here.
 *
 * WRITTEN AS AN EXPIRY RATHER THAN A `delete`, WITH EVERY ATTRIBUTE REPEATED.
 * A browser matches a removal against name AND path, and a Partitioned cookie
 * belongs to a partitioned jar: a `Set-Cookie` that omits `Partitioned`,
 * `Secure` and `SameSite=None` addresses a different cookie than the one
 * `verifyCodeAction` wrote, and the dead token would survive the attempt to
 * remove it. `maxAge: 0` on an otherwise identical cookie cannot miss.
 */
async function expireDeadSession(secret: string): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(WIDGET_SESSION_COOKIE)?.value;
  if (token === undefined) return;
  if (readSession(token, secret) !== null) return;

  cookieStore.set(WIDGET_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    partitioned: true,
    path: '/w',
    maxAge: 0,
  });
}

/**
 * The first entry of `x-forwarded-for`, the way `src/app/(public)/contato/page
 * .tsx` already reads it — the client address, with every proxy that appended
 * itself after it ignored.
 *
 * 'unknown' when the header is absent: a shared bucket for callers this
 * deployment cannot tell apart is stricter than no bucket at all, which is the
 * right direction for a limit that exists to stop a script.
 */
async function callerIp(): Promise<string> {
  const headerList = await headers();
  return headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

/**
 * A telephone number, as something a counter row may hold.
 *
 * TWO STEPS, IN THIS ORDER, AND BOTH ARE LOAD-BEARING.
 *
 * First the digits, which is `normalize_phone`'s rule (0031) applied in Node so
 * that '+55 11 99999-8888' and '5511999998888' land in the same bucket rather
 * than in two. A BUCKET KEY, NOT AN IDENTITY: the database remains the only
 * authority on who a number belongs to — `members.phone_normalized` is
 * GENERATED from `normalize_phone` and nothing here is compared against it. If
 * this rule ever drifts from that one the cost is a rate-limit bucket slightly
 * wider or narrower than intended, never a listener resolved wrongly. Calling
 * the `normalize_phone` RPC instead was rejected: it would put a database round
 * trip in front of the limit that exists to protect the database.
 *
 * Then the digest, and it has to be second. Hashing the raw string would give
 * one person two budgets, because the two spellings above hash to two unrelated
 * values — which is the whole reason normalisation exists here, undone.
 *
 * WHY IT IS HASHED AT ALL: `rate_limit_counters.key` is a plain column, kept
 * for thirty days after its window closes and present in every backup. This
 * file's header already forbids a telephone number reaching a LOG, on the
 * grounds that it is personal data with a thirty-day rule (0161's sweep) a log
 * file does not honour — and writing that same number verbatim into a database
 * column, which is what this did before, contradicted the argument in the file
 * that makes it. Both of this product's other anonymous limiters hash first
 * (`hashIpAddress`, services/contact-requests.ts; the invitation limiter,
 * services/invitations.ts) and docs/SECURITY.md §9 states it as the rule.
 */
function phoneKey(phone: string): string {
  return hashLimitSubject(phone.replace(/\D/g, ''));
}

/**
 * The caller's address, the same way and for the same reason.
 *
 * No normalisation step: an address arrives from `x-forwarded-for` already in
 * one canonical spelling per caller, so unlike a telephone number there is
 * nothing to fold together first. 'unknown' — `callerIp`'s answer when the
 * header is absent — hashes like any other value, so that shared bucket keeps
 * working exactly as it did.
 */
function ipKey(ip: string): string {
  return hashLimitSubject(ip);
}

type Limit = { limit: number; windowSeconds: number };

/**
 * One bucket: what the counter is keyed by, and what a log line is allowed to
 * say about it.
 *
 * THE TWO ARE SEPARATE FIELDS ON PURPOSE, and the digests in `phoneKey` and
 * `ipKey` do not make it redundant. Five of the six keys below are derived from
 * a telephone number or an address, and a digest is still a stable per-person
 * identifier: two log lines carrying the same one say "the same caller", and a
 * digest beside a known number is a lookup rather than a puzzle. What an
 * operator needs is WHICH LIMIT refused, which the label answers on its own, so
 * the key never travels into a log even hashed. The hashing defends the
 * counter ROW, which lives for thirty days in a table nothing prunes sooner;
 * this field defends the log line, which leaves the host entirely.
 *
 * The STATION is still identifiable in every line, because `publicKey` is
 * logged alongside and 0159's own column comment says in writing that it is not
 * a secret — so "which Station hit its ceiling" is answerable without putting a
 * listener in the log to answer it.
 */
type Bucket = Limit & { key: string; label: string };

/**
 * The label of the bucket that refused, or null when every one allowed. Stops
 * at the first refusal, so a refused request does not spend the budget of the
 * limits after it.
 *
 * IT LOGS, AND THAT IS WHY IT RETURNS A LABEL RATHER THAN A BOOLEAN. Before
 * this, a refusal here was the only outcome in the whole file that produced
 * nothing at all — and the most important one to see: `code/station/hour` means
 * either a script is billing this customer or real listeners are being turned
 * away during a promotion somebody just read out on air, and neither is
 * discoverable from an empty log. `warn` rather than `error` because a refused
 * limit is the system working; the deployment fault below is the one that is
 * not.
 */
async function withinLimits(
  limiter: PostgresRateLimiter,
  publicKey: string,
  buckets: readonly Bucket[],
): Promise<string | null> {
  for (const bucket of buckets) {
    try {
      const { allowed } = await limiter.check(bucket.key, bucket.limit, bucket.windowSeconds);
      if (!allowed) {
        logger.warn({ publicKey, bucket: bucket.label }, 'widget: a limit refused a request');
        return bucket.label;
      }
    } catch (cause) {
      // A LIMITER THAT CANNOT ANSWER REFUSES. The tempting branch is to let the
      // request through "so an outage in the counters does not break the
      // widget" — which turns the one hour when nobody is watching into the one
      // hour with no ceiling on the Station's Meta bill. Failing closed costs a
      // visitor a retry; failing open costs money nobody sees until the invoice.
      //
      // The BUCKET, never the key: this line fires during an outage, which is
      // precisely when logs are being read, copied into a ticket and shipped to
      // whoever is on call.
      logger.error(
        { err: cause, publicKey, bucket: bucket.label },
        'widget: the rate limiter could not answer',
      );
      return bucket.label;
    }
  }
  return null;
}

type DoorAnswer = {
  ok: boolean;
  reason: string | null;
  memberId: string | null;
  companyId: string | null;
  organizationId: string | null;
};

/**
 * 0161's doors answer a `jsonb` object, which reaches supabase-js as `Json` —
 * so the shape is checked rather than asserted. `null` means "not an answer
 * this code understands", which every caller turns into `failed`: a PostgREST
 * error envelope, or a future migration that changes the shape, must not be
 * read as a success with missing fields.
 */
function readAnswer(data: unknown): DoorAnswer | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.ok !== 'boolean') return null;
  return {
    ok: row.ok,
    reason: typeof row.reason === 'string' ? row.reason : null,
    memberId: typeof row.member_id === 'string' ? row.member_id : null,
    companyId: typeof row.company_id === 'string' ? row.company_id : null,
    organizationId: typeof row.organization_id === 'string' ? row.organization_id : null,
  };
}

/**
 * A reason string from the database, narrowed to one this application has a
 * sentence for. An unrecognised value becomes `failed` rather than being passed
 * to the client verbatim: the widget renders a message per reason, and a reason
 * with no message renders as nothing at all — the failure mode where the box
 * simply does nothing when submitted.
 */
function requestRefusal(reason: string | null): RequestCodeRefusal {
  switch (reason) {
    case 'unknown_installation':
    case 'no_integration':
    case 'no_template':
      return reason;
    default:
      return 'failed';
  }
}

function verifyRefusal(reason: string | null): VerifyRefusal {
  switch (reason) {
    case 'unknown_installation':
    case 'no_pending_code':
    case 'expired':
    case 'too_many_attempts':
    case 'wrong_code':
    case 'name_required':
    case 'listener_anonymized':
      return reason;
    default:
      return 'failed';
  }
}
