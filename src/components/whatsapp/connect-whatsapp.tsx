'use client';

import { useTranslations } from 'next-intl';
import { ConnectWhatsAppButton } from './connect-whatsapp-button';

/**
 * Where a Station pairs its own WhatsApp Business account with this product,
 * through Meta's Embedded Signup flow.
 *
 * BLOCK 29a MOVED IT, AND THE MOVE IS THE POINT. It used to sit above the
 * template registry on /templates/whatsapp, on the reasoning that the account
 * must be paired before a template registered below it can send anything. True,
 * and still not where it belongs: pairing binds a telephone number the
 * Organization pays for to this product, once, for the life of the Station. It
 * is a fact about the Station, not about its words — so it now lives in the
 * Station's own record, reached from /app, and the template screen is only
 * about templates.
 *
 * WHAT IT DELIBERATELY DID NOT MOVE TO. The obvious home was the platform
 * console's Stations record, which already carries a WhatsApp tab holding the
 * phone_number_id and the WABA. That tab is behind `(admin)/layout.tsx`, which
 * redirects anyone failing `is_platform_admin()` — so filing it there would have
 * taken pairing away from the Organization owner and handed it to the platform
 * operator alone. The owner ruled that out explicitly. The card is rendered in
 * BOTH places instead, from this one module: the owner's Station record and the
 * console's WhatsApp tab.
 *
 * NOW A CLIENT COMPONENT, where it used to be a server one. Not a preference:
 * both hosts are client components (a dialog and a form tab), and a server
 * component cannot be rendered inside either. The four strings come from a
 * `connectWhatsApp` namespace of their own rather than from whichever screen is
 * hosting it — two hosts in two namespaces would otherwise mean two copies of
 * the same four sentences, drifting apart at the first correction.
 *
 * The one decision it makes, "configured or not", was made before it was
 * called: `embeddedSignupUrl` (src/lib/integrations/whatsapp/embedded-signup.ts)
 * returns null for absent, blank, unparseable and non-https alike, and every one
 * of those renders the same way here. It is resolved on the server and arrives
 * as a prop, because `WHATSAPP_EMBEDDED_SIGNUP_URL` is deliberately not a
 * `NEXT_PUBLIC_` variable — see that module's own header.
 *
 * The card SHOWS ITSELF when nothing is configured, rather than disappearing.
 * An owner who was told this button exists and finds an empty screen has no
 * way to tell a missing feature from a missing environment variable; the
 * sentence below tells them which, and who can fix it.
 */
export function ConnectWhatsAppBusiness({ url }: { url: string | null }) {
  const t = useTranslations('connectWhatsApp');

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border bg-card p-4"
      data-testid="connect-whatsapp"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>

      {url ? (
        // Wrapped so the control takes its own width instead of stretching the
        // full column, the way the archive button in template-registry.tsx is.
        <div>
          <ConnectWhatsAppButton url={url} label={t('button')} />
        </div>
      ) : (
        <p
          className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
          data-testid="connect-whatsapp-unconfigured"
        >
          {t('notConfigured')}
        </p>
      )}
    </section>
  );
}
