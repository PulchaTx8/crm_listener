import { getTranslations } from 'next-intl/server';
import { ConnectWhatsAppButton } from './connect-whatsapp-button';

/**
 * Where a Station pairs its own WhatsApp Business account with this product,
 * through Meta's Embedded Signup flow.
 *
 * It sits on this screen, above the registry, because that is the operator's
 * real order: the account has to exist and be paired before an approved
 * template registered below can send anything through it.
 *
 * A plain server component with no state — the whole thing is an anchor, and
 * an anchor needs no client bundle. The one decision it makes, "configured or
 * not", was made before it was called: `embeddedSignupUrl`
 * (src/lib/integrations/whatsapp/embedded-signup.ts) returns null for absent,
 * blank, unparseable and non-https alike, and every one of those renders the
 * same way here.
 *
 * The card SHOWS ITSELF when nothing is configured, rather than disappearing.
 * An owner who was told this button exists and finds an empty screen has no
 * way to tell a missing feature from a missing environment variable; the
 * sentence below tells them which, and who can fix it.
 */
export async function ConnectWhatsAppBusiness({ url }: { url: string | null }) {
  const t = await getTranslations('templates');

  return (
    <section
      className="mb-6 flex flex-col gap-4 rounded-lg border bg-card p-4"
      data-testid="connect-whatsapp"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{t('connectWhatsAppTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('connectWhatsAppDescription')}</p>
      </div>

      {url ? (
        // Wrapped so the control takes its own width instead of stretching the
        // full column, the way the archive button in template-registry.tsx is.
        <div>
          <ConnectWhatsAppButton url={url} label={t('connectWhatsAppButton')} />
        </div>
      ) : (
        <p
          className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
          data-testid="connect-whatsapp-unconfigured"
        >
          {t('connectWhatsAppNotConfigured')}
        </p>
      )}
    </section>
  );
}
