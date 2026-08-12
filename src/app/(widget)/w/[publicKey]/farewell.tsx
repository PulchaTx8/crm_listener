'use client';

import { useTranslations } from 'next-intl';

/**
 * Block 19b, D5. What is left after "Sair": a thank-you, and the way back that
 * fits the door the listener came through.
 *
 * REACHED BY NAVIGATION, NOT BY CLIENT STATE — Task 6, fix round 1. The first
 * version held a `left` flag in `WidgetMenu` and rendered this in place once
 * `signOutAction` resolved; the walkthrough that version's own step 9 asked
 * for caught that the cookie clear inside that action makes Next.js force a
 * refresh of the route deciding `<WidgetMenu>` vs `<IdentifyForm>`, which
 * replaced `WidgetMenu` — and this panel with it — before a listener could
 * read it. `signOutAction` now redirects to `?left=1` instead, and `page.tsx`
 * renders this component from THAT request, server-side, before it ever
 * reaches the cookie-driven branch. There is no state here to lose, because
 * there is no longer a component instance old enough to have any: this one
 * is born already showing the farewell.
 *
 * `exitHref` IS BOTH THE ADDRESS AND THE ANSWER TO "WHICH DOOR". It is non-null
 * only in the application presentation, and only for a Station whose WhatsApp
 * number is recorded — the embedded widget on a Station's own website never
 * reads the identity door at all, so it is null there by construction rather
 * than by a second flag that could disagree with the first.
 *
 * STILL A CLIENT COMPONENT, for `useTranslations` alone — `next-intl`'s
 * server-side reader is a different function, and swapping to it here would
 * be a change this task was not asked to make.
 */
export function Farewell({ exitHref, publicKey }: { exitHref: string | null; publicKey: string }) {
  const t = useTranslations('widget');

  return (
    <div
      className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
      data-testid="widget-farewell"
    >
      <p className="text-sm">{t('goodbye')}</p>

      {exitHref !== null ? (
        // A PLAIN ANCHOR, not a `<Button>`: this address leaves the
        // application entirely, and `src/components/ui/button.tsx` has no
        // `asChild` — it is a bare `<button>` with variants, not a Radix
        // Slot, so it cannot lend its styling to an `<a>`. The classes below
        // are `variant="outline" size="default"` copied from that file.
        // `form-action 'self'` in csp.ts governs form submissions and does
        // not apply to a link, and no `navigate-to` directive is set — so
        // this needs no CSP change.
        <a
          href={exitHref}
          className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="widget-back-to-whatsapp"
        >
          {t('backToWhatsApp')}
        </a>
      ) : (
        // ALSO A PLAIN ANCHOR, and for the same reason as above — this panel
        // holds no state a click could reset, so there is no `router.refresh()`
        // left to call. The cookie is already gone; the address below is the
        // same one this page is served at, and the server renders the
        // identify form for it, which is the truth.
        <a
          // `encodeURIComponent`, same as every other place this codebase
          // turns a public key back into a URL (`enter/route.ts`'s
          // `redirectTo`, `signOutAction`) — harmless here, since a
          // `publicKey` this component ever receives already named a live
          // installation to get this far, but one rule for the shape rather
          // than an exception for the caller that happens to be safe today.
          href={`/w/${encodeURIComponent(publicKey)}`}
          className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="widget-identify-again"
        >
          {t('identifyAgainAction')}
        </a>
      )}
    </div>
  );
}
