import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { env } from '@/lib/env';
import {
  choosePresentation,
  WIDGET_PRESENTATION_COOKIE,
  type WidgetPresentation,
} from '@/lib/widget/presentation';
import { parseOpenTarget } from '@/lib/widget/open-target';
import { WIDGET_SESSION_COOKIE, readSessionFor } from '@/lib/widget/session';
import { installationContext, stationIdentity } from '@/services/widget-installations';
import { Farewell } from './farewell';
import { AppFrame, EmbeddedFrame } from './frames';
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

/**
 * Block 19b, fix round found by Task 7's own e2e. THE COOKIE FIRST, THE
 * HEADER ONLY AS A FALLBACK.
 *
 * `middleware.ts`'s widget branch writes `WIDGET_PRESENTATION_COOKIE` on
 * every genuine document request to this route, from the SAME
 * `Sec-Fetch-Dest` this file used to read directly — and, critically, leaves
 * it untouched on every other request. Reading the header here directly
 * broke the moment anything caused this component to re-render without a
 * real navigation: `identify-form.tsx`'s post-verify `router.refresh()`, and
 * every "Sair" submission, are Server Action / RSC fetches, and those always
 * carry `Sec-Fetch-Dest: empty` — a script's own `fetch()` reports that
 * regardless of whether the script is running inside an iframe, so this
 * component cannot tell "an old browser opened this address directly" from
 * "a listener just typed a correct code inside a Station's embedded widget"
 * by reading that header on such a request. `isDocumentRequest`'s own
 * comment (`presentation.ts`) has the rest.
 *
 * The header is read anyway, as a fallback for a request that somehow
 * reaches this component with no cookie at all — not expected in production,
 * since the middleware above runs first on every request this route serves.
 */
async function resolvePresentation(): Promise<WidgetPresentation> {
  const cookieValue = (await cookies()).get(WIDGET_PRESENTATION_COOKIE)?.value;
  if (cookieValue === 'embedded' || cookieValue === 'app') return cookieValue;
  return choosePresentation((await headers()).get('sec-fetch-dest'));
}

export default async function WidgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicKey: string }>;
  searchParams: Promise<{ open?: string | string[]; id?: string | string[]; link?: string; left?: string }>;
}) {
  const { publicKey } = await params;
  const { open, id, link, left } = await searchParams;

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
  // `installationContext` THROWS rather than answering `found: false` when the
  // database cannot be reached, and that throw is deliberately not caught: a
  // 500 during an outage is the truth, and turning it into this 404 would tell
  // a Station whose configuration is perfectly correct that their key is
  // wrong.
  const context = await installationContext(publicKey);
  if (!context.found) {
    // TASK 7's REPAIR, found by Task 6's own review. `consume_widget_link`
    // answers `unavailable` — folded into the same `?link=expired` redirect as
    // every other failure, by design (`enter/route.ts`'s own comment) — when
    // the Station was switched off, suspended or archived BETWEEN the link
    // being minted and this tap. `installationContext` answers `found: false`
    // for exactly that Station, so without this branch a listener who followed a
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
    // D3: a listener whose link died has no session by definition, and this is
    // the FIRST screen they see. Framing it as a 28rem transparent column in a
    // full tab is the exact complaint this block exists to answer, so it takes
    // the same decision the live page does — with no identity, because the key
    // resolves to nothing to be identified.
    if (linkExpired) {
      const expired = <IdentifyForm publicKey={publicKey} linkExpired />;
      // THE REQUEST'S OWN LOCALE HERE, not a Station's: this branch is reached
      // precisely when the key resolves to no installation, so there is no
      // Station to have chosen anything, and this screen renders under the
      // ROOT provider — the same catalogue `<html lang>` already names. Stated
      // rather than left off, because an omitted `lang` and a `lang` that
      // happens to equal the document's read identically on screen and only
      // one of them says which it meant.
      const requestLocale = await getLocale();
      return (await resolvePresentation()) === 'embedded' ? (
        <EmbeddedFrame lang={requestLocale}>{expired}</EmbeddedFrame>
      ) : (
        <AppFrame identity={null} lang={requestLocale}>
          {expired}
        </AppFrame>
      );
    }
    notFound();
  }

  // Block 30d, D7. The root provider resolves from the `locale` cookie, and
  // src/middleware.ts:421 writes that cookie from the signed-in profile with
  // `path: '/'` -- a path that covers /w. An operator who set the console to
  // English then saw an English widget on the Station's own site. The Station's
  // choice has to win HERE, over a provider that has already resolved, which is
  // why this is a second provider rather than a change to src/i18n/request.ts:
  // that file serves every route and knows nothing about installations.
  //
  // COMPUTED ONCE, ABOVE BOTH RETURNS THIS FUNCTION CAN STILL REACH for a
  // found installation -- the farewell below and the menu/identify form
  // further down -- so a listener who signs out sees the same language they
  // were just reading, rather than the wrap applying to one screen and not
  // the other.
  const widgetLocale = context.listenerLocale ?? (await getLocale());

  // THE `widget` NAMESPACE ALONE, not the whole catalogue, and on this page
  // that is not a micro-optimisation. The root layout's provider
  // (src/app/layout.tsx) already serialises the request-locale catalogue into
  // every response; a second complete `messages/<locale>.json` here would send
  // the console's strings twice in a payload a radio station serves from its
  // own website, in an iframe, to a listener on a telephone. MEASURED, not
  // estimated: `JSON.stringify` of `messages/pt.json` is 139 890 bytes and of
  // `{ widget: … }` alone is 3 779 -- 2.7% of it. Every other namespace in
  // that file belongs to screens no widget renders.
  //
  // WHAT MAKES THE SLICE SAFE, checked rather than assumed: every component
  // under this provider -- IdentifyForm, WidgetMenu and everything it opens
  // (EnterPromotionPanel, RequestSongPanel), Farewell, and both frames --
  // reads `useTranslations('widget')` and nothing else, and the only shared
  // components any of them import are Button and Input, neither of which is
  // translated. `grep -rn "useTranslations\|getTranslations\|useFormatter"
  // "src/app/(widget)/"` names those files and no other namespace. A
  // component added under here that reaches for another namespace gets
  // next-intl's missing-message error, not a silent blank -- so the failure
  // announces itself and this line is where it is answered.
  const messages = (await import(`../../../../../messages/${widgetLocale}.json`)).default;
  const widgetMessages = { widget: messages.widget };

  // D1: the frame around it, and the frame decides. Resolved via
  // `resolvePresentation` (this file's own header comment) rather than a
  // direct `Sec-Fetch-Dest` read, because this call also has to answer
  // correctly for `left=1` below — reached through a Server Action redirect,
  // never a real navigation.
  // HOISTED ABOVE THE SESSION CHECK — Task 6, fix round 1 — so `left=1` below
  // can render the farewell in the correct frame, with the correct identity,
  // WITHOUT going anywhere near `claims`. Read ONCE either way: the header and
  // the farewell's way back are the same fact, and asking the identity door
  // twice per request would be two round trips to answer one question.
  const presentation = await resolvePresentation();
  const identity = presentation === 'app' ? await stationIdentity(publicKey) : null;

  // `signOutAction` (actions.ts) clears the cookie and redirects HERE with
  // `?left=1`, rather than leaving `WidgetMenu` to render the farewell as
  // client state after the cookie clear — that action's own comment has the
  // measurement: a Server Action that mutates a cookie makes Next.js force a
  // refresh of the very route that decides `<WidgetMenu>` vs `<IdentifyForm>`
  // from that cookie, and client state loses that race every time. Checked
  // BEFORE the session check below on purpose: by the time this request
  // lands, the cookie is already gone, and reaching the ordinary claims logic
  // would draw the identify form — correct for a cookie that verifies to
  // nothing, but not what a listener who just pressed "Sair" should see.
  if (left === '1') {
    const farewell = <Farewell exitHref={identity?.whatsappHref ?? null} publicKey={publicKey} />;
    const framed =
      presentation === 'embedded' ? (
        <EmbeddedFrame lang={widgetLocale}>{farewell}</EmbeddedFrame>
      ) : (
        <AppFrame identity={identity} lang={widgetLocale}>
          {farewell}
        </AppFrame>
      );
    return (
      <NextIntlClientProvider locale={widgetLocale} messages={widgetMessages}>
        {framed}
      </NextIntlClientProvider>
    );
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
  const body =
    claims !== null ? (
      <WidgetMenu publicKey={publicKey} initialOpen={parseOpenTarget(open, id)} />
    ) : (
      <IdentifyForm publicKey={publicKey} linkExpired={linkExpired} />
    );

  const framed =
    presentation === 'embedded' ? (
      <EmbeddedFrame lang={widgetLocale}>{body}</EmbeddedFrame>
    ) : (
      <AppFrame identity={identity} lang={widgetLocale}>
        {body}
      </AppFrame>
    );

  return (
    <NextIntlClientProvider locale={widgetLocale} messages={widgetMessages}>
      {framed}
    </NextIntlClientProvider>
  );
}
