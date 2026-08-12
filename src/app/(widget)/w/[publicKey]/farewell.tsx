'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * Block 19b, D5. What is left after "Sair": a thank-you, and the way back that
 * fits the door the listener came through.
 *
 * THE SESSION IS ALREADY GONE when this renders — `signOutAction` cleared the
 * cookie before the state that shows this panel was set. Nothing here reads it,
 * and a reload lands on the identify form, which is the truth.
 *
 * `exitHref` IS BOTH THE ADDRESS AND THE ANSWER TO "WHICH DOOR". It is non-null
 * only in the application presentation, and only for a Station whose WhatsApp
 * number is recorded — the embedded widget on a Station's own website never
 * reads the identity door at all, so it is null there by construction rather
 * than by a second flag that could disagree with the first.
 */
export function Farewell({ exitHref }: { exitHref: string | null }) {
  const t = useTranslations('widget');
  const router = useRouter();

  return (
    <div
      className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
      data-testid="widget-farewell"
    >
      <p className="text-sm">{t('goodbye')}</p>

      {exitHref !== null ? (
        // A PLAIN ANCHOR, not a router push and not a `<Button>`: this address
        // leaves the application entirely, and `src/components/ui/button.tsx`
        // has no `asChild` — it is a bare `<button>` with variants, not a
        // Radix Slot, so it cannot lend its styling to an `<a>`. The classes
        // below are `variant="outline" size="default"` copied from that file.
        // `form-action 'self'` in csp.ts governs form submissions and does not
        // apply to a link, and no `navigate-to` directive is set — so this
        // needs no CSP change.
        <a
          href={exitHref}
          className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="widget-back-to-whatsapp"
        >
          {t('backToWhatsApp')}
        </a>
      ) : (
        // The cookie is gone, so the server renders the identify form for this
        // same address. `refresh` rather than a state reset in the parent: the
        // parent is only rendered at all because the SERVER saw a session, and
        // asking it again is what makes the screen agree with the cookie.
        <Button
          type="button"
          variant="outline"
          onClick={() => router.refresh()}
          data-testid="widget-identify-again"
        >
          {t('identifyAgainAction')}
        </Button>
      )}
    </div>
  );
}
