import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { parseRecordParam, ORGANIZATION_TABS } from '@/lib/record-params';
import { PageHeader } from '@/components/layout/app-shell';
import { listOrganizations } from '@/services/organizations';
import type { OrganizationRow, StationBrief } from './actions';
import { OrganizationsGrid } from './organizations-grid';

// Renders from the caller's session cookies, so it can never be static. Stated
// explicitly rather than inferred from cookies(): the Supabase client is built
// before cookies() is reached, so during a build with no configuration this page
// would fail as a prerender error instead of being skipped as dynamic.
export const dynamic = 'force-dynamic';

/**
 * The customer groups.
 *
 * TWO READS FOR THE WHOLE SCREEN, and both happen here rather than when a record
 * opens: list_organizations for the groups and their records, and one query for
 * every Station under them. The dialog opens from what this read — the URL
 * changes without a server round trip (use-record-dialog.ts), so a fetch on open
 * would be a second way for one screen to be wrong.
 *
 * NO PAGING AND NO SEARCH. The platform has tens of groups; the screen that
 * needed a cursor was listing Stations, and it has one of its own now.
 */
export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ record?: string; tab?: string }>;
}) {
  const t = await getTranslations('admin');
  const params = await searchParams;
  const supabase = await createUserClient();

  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) redirect('/login');

  let organizations: Awaited<ReturnType<typeof listOrganizations>> = [];
  try {
    organizations = await listOrganizations(token);
  } catch (cause) {
    // Logged rather than thrown: an empty list with a message beats an error
    // page over the whole console — the discipline the retiring customers screen
    // adopted after a failed read rendered as "nothing provisioned yet".
    logger.error({ err: cause }, 'could not load organizations');
  }

  // Every Station of every listed group, in ONE query rather than one per row.
  // Affordable at this size for the same reason the screen has no paging, and
  // scoped to the groups on screen rather than the platform.
  const stationsByOrganization: Record<string, StationBrief[]> = {};
  if (organizations.length > 0) {
    const { data: stations, error } = await supabase
      .from('companies')
      .select('id, name, status, organization_id')
      .in(
        'organization_id',
        organizations.map((o) => o.id),
      )
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    if (error) logger.error({ err: error }, 'could not load the stations of the listed groups');

    for (const station of stations ?? []) {
      (stationsByOrganization[station.organization_id] ??= []).push({
        id: station.id,
        name: station.name,
        status: station.status,
      });
    }
  }

  const rows: OrganizationRow[] = organizations.map((organization) => ({
    ...organization,
    stations: stationsByOrganization[organization.id] ?? [],
  }));

  const record = parseRecordParam(params, ORGANIZATION_TABS);

  return (
    <>
      <PageHeader title={t('organizations')} description={t('organizationsDescription')} />
      <OrganizationsGrid initialRows={rows} initialRecord={record} />
    </>
  );
}
