import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { env } from '@/lib/env';
import { WIDGET_SESSION_COOKIE, readSessionFor } from '@/lib/widget/session';
import { installationExists } from '@/services/widget-installations';
import { IdentifyForm } from './identify-form';
import { WidgetMenu } from './menu';

/**
 * Block 17a. What a listener on a radio station's own website actually sees.
 *
 * TWO STATES AND NOTHING ELSE: a visitor this deployment cannot name gets the
 * form; one it can gets the menu. There is no third "loading" state on the
 * server — the cookie is either a valid session for THIS installation or it is
 * not, and `readSessionFor` answers that without a round trip (design D5 chose
 * a signed token over a session row precisely so this page costs no lookup).
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

  const cookieStore = await cookies();
  const token = cookieStore.get(WIDGET_SESSION_COOKIE)?.value;
  const secret = env.WIDGET_SESSION_SECRET;

  // THE CROSS-STATION CHECK IS INSIDE `readSessionFor`, not written out here,
  // and moving it there was the point. The cookie's Path is `/w` — ONE path for
  // every installation this deployment serves — so a browser that identified at
  // Station A presents that same cookie to Station B's widget. The signature
  // proves the token was minted by us; only the installation comparison proves
  // it was minted HERE, and 17b and 17c will read this session from their own
  // server actions where an inline comparison is exactly the thing somebody
  // forgets. It costs no round trip, which is what D5 chose a signed token for.
  const claims = secret && token ? readSessionFor(token, secret, publicKey) : null;

  // A DEAD TOKEN IS EXPIRED BY THE NEXT SERVER ACTION, NOT HERE, and that is a
  // Next constraint rather than a preference. `cookies()` is read-only inside a
  // Server Component; a `delete` on this line throws
  //
  //   Error: Cookies can only be modified in a Server Action or Route Handler.
  //
  // which was measured, not assumed — the page answers 500 and the widget does
  // not render at all, which is a far worse outcome than a cookie the browser
  // re-sends. A route handler added purely to expire it would be a second public
  // endpoint under `/w`, and this block has been deliberate about that surface
  // being one page. So `expireDeadSession` (actions.ts) does it on the visitor's
  // very next submission — which is the one interaction this screen exists to
  // produce.
  return claims !== null ? <WidgetMenu /> : <IdentifyForm publicKey={publicKey} />;
}
