import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listRegisteredTemplates } from '@/services/templates';
import type { RegisteredTemplate } from '@/services/templates';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { canManageTemplates } from '../permissions';
import { describeTemplateReadError } from '../errors';
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

  let templates: RegisteredTemplate[];
  let manage: boolean;
  try {
    [templates, manage] = await Promise.all([
      listRegisteredTemplates(selected.id),
      canManageTemplates(supabase, selected.id),
    ]);
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
        The one thing an operator arriving here has to already know, said before
        they can type anything: this screen RECORDS an approval, it does not ask
        for one (D4). Somebody who fills the form expecting it to submit will
        wait for an approval that was never requested, and read the silence as a
        bug in this product.
      */}
      <div className="mb-4 flex flex-col gap-2 rounded-md border border-dashed p-3">
        <p className="text-sm">
          {t('templatesAreCreatedAndApprovedIn')}{' '}<strong>{t('metaSOwnConsole')}</strong>, not here.
          Approval takes days and is outside this system. Once it comes through, transcribe the
          approved name, language and body below — exactly as approved — so this Station can send
          it.
        </p>
        <p className="text-xs text-muted-foreground">
          {t('aRevokedOrEditedApprovalIs')}</p>
      </div>

      {/*
        THE PAIRING CARD USED TO BE HERE, owner-gated, and Block 29a moved it to
        the Station's own record on /app (station-settings.tsx). Its reasoning
        travelled with it and is written in the component's own header; what
        matters at this end is that nothing was made harder to reach. The gate
        was `isStationOwner`, and it is the same predicate on the same
        `is_owner_of_company` at the new site — the owner who paired from this
        screen pairs from that one.
      */}
      <TemplateRegistry
        templates={templates}
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
