import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { env } from '@/lib/env';
import { parseOpenTarget } from '@/lib/widget/open-target';
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
  searchParams,
}: {
  params: Promise<{ publicKey: string }>;
  searchParams: Promise<{ open?: string | string[]; id?: string | string[]; link?: string }>;
}) {
  const { publicKey } = await params;
  const { open, id, link } = await searchParams;

  // Task 19a-6's door folds every failure of a WhatsApp link — a used code,
  // one whose fifteen minutes ran out, or (below) a Station that went dark in
  // between — into this one query param before it redirects here.
  const linkExpired = link === 'expired';

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
  if (!(await installationExists(publicKey))) {
    // TASK 7's REPAIR, found by Task 6's own review. `consume_widget_link`
    // answers `unavailable` — folded into the same `?link=expired` redirect as
    // every other failure, by design (`enter/route.ts`'s own comment) — when
    // the Station was switched off, suspended or archived BETWEEN the link
    // being minted and this tap. `installationExists` returns false for
    // exactly that Station, so without this branch a listener who followed a
    // perfectly correct redirect landed on the one answer the spec forbids: a
    // 404, which reads as broken rather than as "try again".
    //
    // WHAT THIS DOES AND DOES NOT LEAK, in writing: an unknown `publicKey`
    // and a real Station that has gone dark now render the IDENTICAL
    // sentence when `link=expired` is present, so probing this parameter
    // learns nothing a probe could not already learn from the plain 404
    // below — one answer for every cause is the rule 0164 already set for
    // this exact key (an unknown key, a disabled installation and an
    // archived one are indistinguishable there too), applied here to the one
    // redirect a listener can arrive carrying. An unknown key with NO
    // `link=expired` still 404s, unchanged — that probing answer is the one
    // 17a chose deliberately, and tests/e2e/widget-headers.spec.ts pins it.
    if (linkExpired) return <IdentifyForm publicKey={publicKey} linkExpired />;
    notFound();
  }

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
  // The key travels into the menu because 17b's actions each take it and check
  // it against the session again — `readSessionFor`, never `readSession`. The
  // claims themselves deliberately do NOT: nothing on the client needs a
  // listener's telephone number, and a value serialised into the page is a
  // value that leaves the server.
  //
  // `open`/`id` ONLY MATTER ONCE THE MENU CAN BE SHOWN AT ALL. `parseOpenTarget`
  // is shape-only (`src/lib/widget/open-target.ts`) — whether a named
  // promotion is one this listener may actually SEE is `EnterPromotionPanel`'s
  // question, asked with the same `listPromotionsAction` call it already
  // makes to draw its own list, so a bad or invisible id falls back to the
  // menu there rather than being refused here.
  return claims !== null ? (
    <WidgetMenu publicKey={publicKey} initialOpen={parseOpenTarget(open, id)} />
  ) : (
    <IdentifyForm publicKey={publicKey} linkExpired={linkExpired} />
  );
}
