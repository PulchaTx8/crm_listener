import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listTemplates } from '@/services/templates';
import type { RegisteredTemplate } from '@/services/templates';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { canManageTemplates } from '../permissions';
import { describeTemplateReadError } from '../errors';
import { MarketingGrid } from './marketing-grid';
import { TemplateRegistry } from './template-registry';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function WhatsAppTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; station?: string }>;
}) {
  const t = await getTranslations('templates');
  const params = await searchParams;
  const stationSearch = params.station?.trim().slice(0, STATION_SEARCH_MAX_LENGTH) || undefined;

  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  let viewable: ViewableCompany[];
  let suspended: SuspendedCompany[];
  let capped: boolean;
  try {
    ({ viewable, suspended, capped } = await listCompanyAccess(
      supabase,
      'templates.view',
      stationSearch,
    ));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve template access');
    return <LoadError message={describeTemplateReadError(cause, await getTranslations('templates'))} />;
  }

  const first = viewable[0];

  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: 0110's select policy filters every read and
  // both registry doors in 0113 re-check templates.manage before writing.
  if (!first) redirect('/app');

  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  let system: RegisteredTemplate[];
  let marketing: RegisteredTemplate[];
  let manage: boolean;
  try {
    const [templates, canManage] = await Promise.all([
      listTemplates(selected.id),
      canManageTemplates(supabase, selected.id),
    ]);
    system = templates.system;
    marketing = templates.marketing;
    manage = canManage;
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the template registry');
    return <LoadError message={describeTemplateReadError(cause, await getTranslations('templates'))} />;
  }

  return (
    <>
      <PageHeader
        title={t('whatsappTemplates')}
        description={t('whatsappDescription')}
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')}{' '}{viewable.length + suspended.length} {t('ofTheStationsYouCanReach')}</p>
          )}
          <StationSearchForm
            action="/messages/templates"
            value={stationSearch ?? ''}
            preserve={{}}
            label={t('findAStation')}
          />
        </div>
      )}

      {viewable.length + suspended.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {viewable.map((company) => (
            <Link
              key={company.id}
              href={stationSwitchHref('/messages/templates', company.id, stationSearch)}
              aria-current={company.id === selected.id ? 'page' : undefined}
              className={
                company.id === selected.id
                  ? 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground'
                  : 'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent'
              }
            >
              {company.name}
            </Link>
          ))}
          {suspended.map((company) => (
            <span
              key={company.id}
              title={t('suspendedNoDataIsAvailableWhile')}
              className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground"
            >
              {company.name} (suspended)
            </span>
          ))}
        </div>
      )}

      {/*
        THE PAIRING CARD USED TO BE HERE, owner-gated, and Block 29a moved it to
        the Station's own record on /app (station-settings.tsx). Its reasoning
        travelled with it and is written in the component's own header; what
        matters at this end is that nothing was made harder to reach. The gate
        was `isStationOwner`, and it is the same predicate on the same
        `is_owner_of_company` at the new site — the owner who paired from this
        screen pairs from that one.
      */}

      {/*
        Block 29b-1, Task 9. Two groups, not one list — `listTemplates`
        partitions on `purpose` (services/templates.ts's own comment) and this
        is the screen that renders both halves of that split. A card per
        SYSTEM purpose, unchanged from before this block; a row per MARKETING
        template below it, new in this block. The notice that used to sit here
        — "created and approved in Meta's own console, not here" — moved into
        TemplateDialog's own WhatsApp branch (D4 is a fact about a WHATSAPP
        template specifically, since Block 29b-1 an e-mail one is written here,
        not transcribed, and a notice on the page body could not tell an
        operator which one they were about to fill in).
      */}
      <h2 className="mb-2 text-lg font-semibold">{t('systemTemplatesTitle')}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t('systemTemplatesDescription')}</p>
      <TemplateRegistry
        templates={system}
        companyId={selected.id}
        timeZone={selected.timezone}
        manage={manage}
      />

      <h2 className="mb-2 mt-10 text-lg font-semibold">{t('marketingTemplatesTitle')}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t('marketingTemplatesDescription')}</p>
      <MarketingGrid
        templates={marketing}
        companyId={selected.id}
        timeZone={selected.timezone}
        manage={manage}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('templates');
  return (
    <>
      <PageHeader title={t('whatsappTemplates')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link
            href="/messages/templates"
            className="text-sm text-primary underline underline-offset-2"
          >
            {t('clearTheStationSearch')}</Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('templates');
  return (
    <>
      <PageHeader title={t('whatsappTemplates')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
