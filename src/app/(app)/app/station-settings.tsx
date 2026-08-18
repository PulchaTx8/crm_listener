'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConnectWhatsAppBusiness } from '@/components/whatsapp/connect-whatsapp';
import { StationEmailTab, type StationEmailIdentity } from './station-email-tab';

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
 * TWO TABS NOW, and the earlier version of this comment named this exact
 * moment before it happened: it said a heading that becomes a tab strip later
 * is a smaller change than a section that becomes one, and Task 7's e-mail
 * identity tab is that later. WhatsApp pairing and who a Station's campaign
 * mail comes from are unrelated facts that happen to share one settings
 * dialog — not two views of one setting — which is why they are two tabs
 * rather than one screen carrying two headings.
 *
 * LOCAL STATE, NOT `useRecordDialog`. That hook exists so a record can open OVER
 * a keyset-paginated list without re-running its query, and keeps the open
 * record in the address so it can be linked. Neither applies: /app renders a
 * short unpaginated grid, and a settings dialog is somewhere an owner goes, not
 * something they send to somebody else. A `?record=` here would buy the URL
 * machinery and pay for it with a second source of truth.
 */
export function StationSettings({
  companyId,
  companyName,
  signupUrl,
  status,
  emailIdentity,
}: {
  companyId: string;
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
  /** Read straight off the `companies` row page.tsx already selects — Task 7. */
  emailIdentity: StationEmailIdentity;
}) {
  const t = useTranslations('app');
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'whatsapp' | 'email'>('whatsapp');
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
            role="tablist"
            aria-label={t('stationSettings')}
            className="flex gap-4 border-b pb-2 text-sm font-medium text-muted-foreground"
            data-testid="station-settings-tabs"
          >
            {/* LOCAL STATE, NOT A ROUTE OR QUERY PARAMETER, for a reason
                distinct from the dialog's own `open` above (this file's header
                gives that one): this dialog's state dies WITH the dialog, so a
                `?tab=` on /app would survive a reload into a record the
                operator had already closed, reopening it on whichever tab was
                last selected instead of leaving /app alone the way a reload of
                a closed dialog should. Block 20b made exactly that mistake
                with its own `?tab=` shortcut and undid it; this dialog never
                gives the address bar anything to remember in the first place.
                Two real buttons with distinct keys rather than one span that
                toggles a label — a conditionally rendered <Button> without a
                stable key has, in this codebase, inherited `type="submit"`
                from whichever sibling React reused its DOM node for, and the
                email tab below renders a form. */}
            <button
              key="whatsapp"
              type="button"
              role="tab"
              aria-selected={tab === 'whatsapp'}
              onClick={() => setTab('whatsapp')}
              className={
                tab === 'whatsapp'
                  ? 'border-b-2 border-primary pb-2 text-foreground'
                  : 'border-b-2 border-transparent pb-2 hover:text-foreground'
              }
            >
              {t('tabWhatsapp')}
            </button>
            <button
              key="email"
              type="button"
              role="tab"
              aria-selected={tab === 'email'}
              onClick={() => setTab('email')}
              className={
                tab === 'email'
                  ? 'border-b-2 border-primary pb-2 text-foreground'
                  : 'border-b-2 border-transparent pb-2 hover:text-foreground'
              }
            >
              {t('tabEmail')}
            </button>
          </div>

          {tab === 'whatsapp' && (
            <>
              {/* THE STATUS COMES FIRST, above the button that changes it. An
                  owner opening this has one question — did the pairing work —
                  and the answer must not be below the control that starts a
                  new one. */}
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

                  {/* Only once there is something to show. A row reading "—"
                      for a Station nobody has paired says nothing the line
                      above did not already say, twice. */}
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
            </>
          )}

          {tab === 'email' && (
            <StationEmailTab companyId={companyId} initial={emailIdentity} />
          )}
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
