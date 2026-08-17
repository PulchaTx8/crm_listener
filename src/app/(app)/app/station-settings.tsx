'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConnectWhatsAppBusiness } from '@/components/whatsapp/connect-whatsapp';

/** What `station_whatsapp_status` (0218) answers, already resolved on the server. */
export interface WhatsAppStatus {
  connected: boolean;
  displayPhoneNumber: string | null;
  enabled: boolean;
}

/**
 * A Station's own settings, opened from its card on /app.
 *
 * WHY THIS SCREEN EXISTS AT ALL (Block 29a, D1). Pairing a WhatsApp Business
 * account binds a telephone number the Organization pays for to this product,
 * once, for the life of the Station. It used to be started from the template
 * registry, which is the wrong subject; the obvious alternative was the platform
 * console's Stations record, which is behind `is_platform_admin()` and would
 * have taken the act away from the owner entirely. So the owner got a record of
 * their own, and this is it.
 *
 * IT DOES NOT EDIT THE STATION, and that is not an omission to fill in later.
 * page.tsx's own header records the standing decision: every column on that card
 * is written from /admin/customers (Block 15, D9), which is why there was no
 * gear on it before this. Nothing here contradicts that — pairing is not a
 * column on `companies`, it is a row in `integrations` that no screen in the
 * member area could reach at all. The distinction is worth keeping: the day
 * somebody adds a "Station data" tab here, D9 is what they are reversing.
 *
 * ONE TAB, and it is drawn as a tab rather than as a bare section on purpose —
 * Block 29's later passes have per-Station settings to put beside it, and a
 * heading that becomes a tab strip later is a smaller change than a section that
 * becomes one. SHOW_TABS (`src/lib/record-params.ts`) is the precedent for a
 * one-tab record.
 *
 * LOCAL STATE, NOT `useRecordDialog`. That hook exists so a record can open OVER
 * a keyset-paginated list without re-running its query, and keeps the open
 * record in the address so it can be linked. Neither applies: /app renders a
 * short unpaginated grid, and a settings dialog is somewhere an owner goes, not
 * something they send to somebody else. A `?record=` here would buy the URL
 * machinery and pay for it with a second source of truth.
 */
export function StationSettings({
  companyName,
  signupUrl,
  status,
}: {
  companyName: string;
  /**
   * Resolved by `embeddedSignupUrl` on the server, null when this installation
   * has no pairing address configured. Passed down rather than read here:
   * `WHATSAPP_EMBEDDED_SIGNUP_URL` is deliberately not a `NEXT_PUBLIC_`
   * variable, so a client component cannot read it.
   */
  signupUrl: string | null;
  /** Null when the status could not be read — see the message below. */
  status: WhatsAppStatus | null;
}) {
  const t = useTranslations('app');
  const [open, setOpen] = useState(false);
  const titleId = useId();

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="station-settings-open"
      >
        {t('stationSettings')}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={titleId}
        className="max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle id={titleId}>{companyName}</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <div
            className="border-b pb-2 text-sm font-medium text-muted-foreground"
            data-testid="station-settings-tabs"
          >
            {/* The one tab. Not a button, because there is nothing to switch to
                — a tab strip of one that responds to clicks would be a control
                that does nothing. It becomes real the first time a second tab
                arrives. */}
            <span className="border-b-2 border-primary pb-2 text-foreground">
              {t('tabWhatsapp')}
            </span>
          </div>

          {/* THE STATUS COMES FIRST, above the button that changes it. An owner
              opening this has one question — did the pairing work — and the
              answer must not be below the control that starts a new one. */}
          {status === null ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-destructive">
              {t('whatsappStatusUnavailable')}
            </p>
          ) : (
            <dl
              className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-[10rem_1fr]"
              data-testid="station-whatsapp-status"
            >
              <dt className="text-muted-foreground">{t('whatsappConnection')}</dt>
              <dd>{status.connected ? t('whatsappConnected') : t('whatsappNotConnected')}</dd>

              {/* Only once there is something to show. A row reading "—" for a
                  Station nobody has paired says nothing the line above did not
                  already say, twice. */}
              {status.connected && (
                <>
                  <dt className="text-muted-foreground">{t('whatsappNumber')}</dt>
                  <dd>{status.displayPhoneNumber ?? t('whatsappNumberUnknown')}</dd>

                  <dt className="text-muted-foreground">{t('whatsappSending')}</dt>
                  <dd>{status.enabled ? t('whatsappSendingOn') : t('whatsappSendingOff')}</dd>
                </>
              )}
            </dl>
          )}

          <ConnectWhatsAppBusiness url={signupUrl} />
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
