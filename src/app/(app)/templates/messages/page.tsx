import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listSystemMessages } from '@/services/templates';
import type { SystemMessageRow } from '@/services/templates';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { canManageTemplates } from '../permissions';
import { describeTemplateReadError } from '../errors';
import { SystemMessageList } from './system-message-list';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function SystemMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; station?: string }>;
}) {
  const t = await getTranslations('templates');
  const params = await searchParams;
  // The same bound listCompanyAccess enforces on its own argument, imported
  // rather than copied.
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

  // A Station search that matches nothing leaves this caller with no Station to
  // show, which is not the same as holding templates.view nowhere: the redirect
  // below would throw them off the screen with no way to clear the search.
  // Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: 0109's select policy filters every read and
  // the four doors in 0113 re-check their own permission before writing.
  if (!first) redirect('/app');

  // A stale or tampered companyId that is not in `viewable` — access revoked
  // since the link was generated, or a hand-edited URL — falls back to the
  // first Station this caller can actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  let rows: SystemMessageRow[];
  let manage: boolean;
  try {
    [rows, manage] = await Promise.all([
      listSystemMessages(selected.id),
      canManageTemplates(supabase, selected.id),
    ]);
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the system messages');
    return <LoadError message={describeTemplateReadError(cause, await getTranslations('templates'))} />;
  }

  return (
    <>
      <PageHeader
        title={t('messages')}
        description="Everything the bot says on its own — in this Station’s words, or the system’s."
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')}{' '}{viewable.length + suspended.length} {t('ofTheStationsYouCanReach')}</p>
          )}
          <StationSearchForm
            action="/templates/messages"
            value={stationSearch ?? ''}
            preserve={{}}
            label="Find a Station"
          />
        </div>
      )}

      {viewable.length + suspended.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {viewable.map((company) => (
            <Link
              key={company.id}
              href={stationSwitchHref('/templates/messages', company.id, stationSearch)}
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
        Said on the screen rather than only in the runbook: these ten bodies are
        the one place in this product where Portuguese is correct, and an
        operator who does not know that will "fix" them into English and take
        the bot's voice away from every listener at this Station.
      */}
      <p className="mb-4 text-sm text-muted-foreground">
        {t('theseAreReadByListenersOn')}</p>

      <SystemMessageList
        rows={rows}
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
      <PageHeader title={t('messages')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link
            href="/templates/messages"
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
      <PageHeader title={t('messages')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
