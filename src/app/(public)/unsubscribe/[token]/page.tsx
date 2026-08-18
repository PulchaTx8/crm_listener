import { getTranslations } from 'next-intl/server';
import type { Route } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { consumeUnsubscribeToken } from '@/services/consent';
import { hashIpAddress } from '@/services/contact-requests';
import { createServiceClient } from '@/lib/supabase/service-client';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { RateLimitError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/button';

const WINDOW_SECONDS = 3600;
const MAX_PER_WINDOW = 5;

/**
 * Its own bucket (`unsubscribe:`), keyed on IP alone -- never on the token.
 * Keying on the token would let the SAME visitor retry the same dead link
 * without limit while still capping everyone else at five; keying on IP is
 * what actually bounds one person hammering this route.
 *
 * `createServiceClient()`, not the anon client `consumeUnsubscribeToken`
 * itself uses: `rate_limit_counters` has RLS with no grants to anon at all
 * (src/lib/rate-limit/index.ts), the same pairing `submitContactRequest` and
 * `submitDataDeletionRequest` already rely on for the same reason.
 */
async function withRateLimit<T>(ipAddress: string, run: () => Promise<T>): Promise<T> {
  const client = createServiceClient();
  const limiter = new PostgresRateLimiter(client);
  const ipHash = hashIpAddress(ipAddress);

  const verdict = await limiter.check(`unsubscribe:${ipHash}`, MAX_PER_WINDOW, WINDOW_SECONDS);
  if (!verdict.allowed) {
    throw new RateLimitError('Too many attempts. Please try again later.');
  }
  return run();
}

/**
 * Block 11c's trap: behind the proxy, `request.ip`/`connection.remoteAddress`
 * is the PROXY's own address, identical for every visitor. Read exactly like
 * `delete-data/page.tsx` reads it, or every listener clicking this link would
 * share one rate-limit bucket -- one person's click blocking everyone else's.
 */
async function clientIp(): Promise<string> {
  const headerList = await headers();
  return headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

/**
 * THE GET WRITES NOTHING, and that is the whole design of this file.
 *
 * Corporate mail filters and antivirus scanners PREFETCH links to inspect them.
 * A route that acted on GET would unsubscribe every listener whose employer
 * scans mail -- silently, with nobody having clicked, and visible only as a
 * campaign whose audience collapsed. The GET renders a page with buttons; the
 * Server Action behind each button is a POST, and it is the POST that writes.
 *
 * The same reasoning is why this page is not "one-click": one click that a
 * machine can perform is not the listener's click.
 *
 * NO STATION NAME ON THIS SCREEN, and that is not an omission either.
 * `unsubscribe_tokens` (0232) has RLS enabled with NO POLICY and grants
 * revoked from anon and authenticated -- the table's own comment says the
 * only reachable path is `consume_unsubscribe_token`, which SPENDS the token
 * as the price of reading anything about it. There is no non-consuming
 * lookup to render one, on this token or any other, and Task 6 exports none.
 * Naming the Station here would require a second, consuming call before the
 * listener has chosen anything -- exactly the write this file exists to not
 * make. The copy below is deliberately generic for the same reason.
 */
export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ left?: string; error?: string }>;
}) {
  const [t, tPublic, { token }, sp] = await Promise.all([
    getTranslations('unsubscribe'),
    getTranslations('public'),
    params,
    searchParams,
  ]);

  async function leaveStation() {
    'use server';
    // redirect() signals by throwing, so it must sit outside the catch below --
    // inside, a successful withdrawal would be reported as a failure.
    let destination: Route = `/unsubscribe/${token}?error=failed` as Route;
    try {
      await withRateLimit(await clientIp(), () => consumeUnsubscribeToken(token, false));
      destination = `/unsubscribe/${token}?left=station` as Route;
    } catch (cause) {
      if (cause instanceof NotFoundError) {
        destination = `/unsubscribe/${token}?error=notfound` as Route;
      } else {
        // The visitor gets a deliberately vague sentence; the operator needs
        // the real one, matching delete-data/page.tsx's own reasoning.
        logger.error({ err: cause }, 'unsubscribe (single Station) failed');
      }
    }
    redirect(destination);
  }

  async function leaveAllStations() {
    'use server';
    let destination: Route = `/unsubscribe/${token}?error=failed` as Route;
    try {
      await withRateLimit(await clientIp(), () => consumeUnsubscribeToken(token, true));
      destination = `/unsubscribe/${token}?left=all` as Route;
    } catch (cause) {
      if (cause instanceof NotFoundError) {
        destination = `/unsubscribe/${token}?error=notfound` as Route;
      } else {
        logger.error({ err: cause }, 'unsubscribe (every Station) failed');
      }
    }
    redirect(destination);
  }

  // The receipt replaces the buttons rather than sitting beside them, the same
  // reason delete-data's own receipt does: buttons still on screen after a
  // successful withdrawal invite a second, redundant click at a token that has
  // already been spent -- which would render only the not-found sentence below.
  if (sp.left === 'station' || sp.left === 'all') {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">{t('heading')}</h1>
        <p data-testid="unsubscribe-success" className="text-muted-foreground">
          {sp.left === 'all' ? t('leftEveryStation') : t('leftThisStation')}
        </p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('explanation')}</p>
      </div>
      {sp.error ? (
        <p data-testid="unsubscribe-error" className="text-sm text-destructive">
          {sp.error === 'notfound' ? t('linkNoLongerWorks') : tPublic('somethingWentWrongPleaseTry')}
        </p>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row">
        {/*
          A distinct `key` on each button, though neither branch here is a
          conditional swap in one JSX slot the way enter-promotion.tsx's once
          was (see that file's "THE TWO KEYS ARE LOAD-BEARING" comment, and
          identify-form.tsx's own copy of it) -- the defect that shipped from
          having none. These two are always both present, in their own
          `<form>`s, so reconciliation cannot merge them today; the keys cost
          nothing and foreclose the same defect class if that ever changes.
        */}
        <form action={leaveStation}>
          <Button key="leave-station" type="submit">
            {t('leaveThisStation')}
          </Button>
        </form>
        <form action={leaveAllStations}>
          <Button key="leave-all-stations" type="submit" variant="outline">
            {t('leaveEveryStationOfTheGroup')}
          </Button>
        </form>
      </div>
    </main>
  );
}
