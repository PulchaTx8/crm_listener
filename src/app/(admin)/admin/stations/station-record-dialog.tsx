'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
// The tab tuple is declared with parseRecordParam rather than here, because the
// page that validates `tab=` against it is a Server Component and cannot import
// a value out of a client module. See src/lib/record-params.ts.
import { STATION_TABS, type StationTab } from '@/lib/record-params';
import type { ApiCredentialRow } from '@/services/api-credentials';
import type { IntegrationRow } from '@/services/integrations';
import type { StationRow } from './actions';
import { ApiKeysTab } from './api-keys-tab';
import { IntegrationTab } from './integration-tab';
import { StationForm, type StationProfile } from './station-form';

/**
 * One Station's record: what it is, how it reaches WhatsApp, and what machines
 * may speak for it.
 *
 * NOTHING IS FETCHED WHEN THIS OPENS. page.tsx read the profile, the keys and
 * the integration of EVERY Station in the selected group before this dialog
 * existed — the URL changes without a server round trip (use-record-dialog.ts),
 * so a fetch on open would be a second way for one screen to be wrong. That is
 * the defect Block 15 shipped, and it is why the screen is filtered to one group
 * at a time: reading three or four Stations eagerly is affordable, and reading
 * the platform would not be.
 */
export function StationRecordDialog({
  open,
  row,
  missing,
  profile,
  credentials,
  integration,
  tab,
  onTab,
  onClose,
}: {
  open: boolean;
  row: StationRow | null;
  /** An address that named no Station in the selected group. */
  missing?: boolean;
  profile: StationProfile | null;
  credentials: ApiCredentialRow[];
  integration: IntegrationRow | null;
  tab: StationTab;
  onTab: (tab: StationTab) => void;
  onClose: () => void;
}) {
  const t = useTranslations('admin');
  const titleId = useId();

  const tabLabels: Record<StationTab, string> = {
    data: t('tabStationData'),
    whatsapp: t('tabWhatsappIntegration'),
    keys: t('tabApiKeys'),
  };

  if (missing || !row) {
    return (
      <Dialog open={open} onClose={onClose} labelledBy={titleId} className="max-w-lg">
        <DialogHeader>
          <DialogTitle id={titleId}>{t('station')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {/* Two readings, and the operator can act on either: the id may name a
              Station of a different group, which the combobox above fixes. */}
          <p className="text-sm text-destructive">{t('noSuchStationInThisGroup')}</p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <div className="flex flex-col gap-1">
          <DialogTitle id={titleId}>{row.name}</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {row.status}
            {row.suspensionReason ? ` — ${row.suspensionReason}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('closeRecord')}
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      <div role="tablist" aria-label={t('recordSections')} className="flex gap-1 border-b px-5">
        {STATION_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => onTab(name)}
            className={
              tab === name
                ? 'border-b-2 border-primary px-3 py-2 text-sm font-medium'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
            }
          >
            {tabLabels[name]}
          </button>
        ))}
      </div>

      <DialogBody>
        {tab === 'data' &&
          (profile ? (
            <StationForm companyId={row.id} profile={profile} />
          ) : (
            // The page reads a profile for every listed Station, so a null here
            // means that read failed rather than that the Station has no record.
            <p className="text-sm text-muted-foreground">{t('couldNotLoadThisStationsRecord')}</p>
          ))}

        {tab === 'whatsapp' && <IntegrationTab companyId={row.id} initialRow={integration} />}

        {tab === 'keys' && <ApiKeysTab companyId={row.id} initialRows={credentials} />}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
