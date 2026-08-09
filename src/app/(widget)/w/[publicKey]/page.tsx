import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { env } from '@/lib/env';
import { WIDGET_SESSION_COOKIE, readSession } from '@/lib/widget/session';
import { installationExists } from '@/services/widget-installations';
import { IdentifyForm } from './identify-form';
import { WidgetMenu } from './menu';

/**
 * Block 17a. What a listener on a radio station's own website actually sees.
 *
 * TWO STATES AND NOTHING ELSE: a visitor this deployment cannot name gets the
 * form; one it can gets the menu. There is no third "loading" state on the
 * server — the cookie is either a valid session or it is not, and `readSession`
 * answers that without a round trip (design D5 chose a signed token over a
 * session row precisely so this page costs no lookup).
 */
export default async function WidgetPage({
  params,
}: {
  params: Promise<{ publicKey: string }>;
}) {
  const { publicKey } = await params;

  // 404 FOR A KEY THAT RESOLVES TO NOTHING, and it is not politeness: an
  // unknown key, a disabled installation and an archived one are one answer
  // here (0161 makes the same choice for the same reason — probing learns
  // nothing an iframe `src` did not already say), and
  // tests/e2e/widget-headers.spec.ts pins this route at 404 for an unknown key.
  // Rendering a form instead would invite somebody to type a telephone number
  // into a widget whose every submission is refused.
  //
  // `installationExists` THROWS rather than returning false when the database
  // cannot be reached, and that throw is deliberately not caught: a 500 during
  // an outage is the truth, and turning it into this 404 would tell a Station
  // whose configuration is perfectly correct that their key is wrong.
  if (!(await installationExists(publicKey))) notFound();

  const token = (await cookies()).get(WIDGET_SESSION_COOKIE)?.value;
  const secret = env.WIDGET_SESSION_SECRET;
  const claims = secret && token ? readSession(token, secret) : null;

  // THE CROSS-STATION CHECK, and the reason the session carries a `publicKey`
  // at all. The cookie's Path is `/w` — ONE path for every installation this
  // deployment serves — so a browser that identified at Station A presents that
  // same cookie to Station B's widget. The signature proves the token was
  // minted by us; only this comparison proves it was minted HERE. It costs no
  // round trip, which is what D5 chose a signed token for.
  const identified = claims !== null && claims.publicKey === publicKey;

  return identified ? <WidgetMenu /> : <IdentifyForm publicKey={publicKey} />;
}
