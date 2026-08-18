import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listCompanyAccess } from '../../inventory/station-access';
import type { ViewableCompany } from '../../inventory/station-access';
import { listReach, listSendLists } from '@/services/send-lists';
import type { ListReach, SendListRecord } from '@/services/send-lists';
import { describeSendListReadError } from '../errors';
import { ListsGrid } from './lists-grid';
import type { SendListGridRow } from './lists-grid';

// Renders from the caller's session cookies and per-Station permission checks
// (messaging.view, messaging.manage), so it can never be static.
export const dynamic = 'force-dynamic';

/**
 * Block 29d-1, Task 6. Every send list this caller's `messaging.view` reaches,
 * ACROSS EVERY STATION AT ONCE -- unlike `/messages/templates`, which picks
 * one Station and shows a tab strip to switch between them. That screen needs
 * a "current Station" because a template's OWN registry differs per Station;
 * a send list instead names its Station as data (0238's own D3: one Station
 * per list), so Station is a COLUMN here rather than a selection, and an
 * operator holding the permission at more than one Station sees all of them
 * in one place. 0238's own RLS policy is what actually bounds `listSendLists`'
 * read; nothing here narrows it by company_id.
 */
export default async function SendListsPage() {
  const t = await getTranslations('templates');

  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // listReach (Task 5) asks members_marketing_eligible_bulk as the caller, not
  // as a worker -- its own header explains why -- so this page needs the raw
  // access token alongside the cookie-bound client above, the same pair
  // messages/templates/actions.ts's own requireAccessToken reads.
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect('/login');

  let viewable: ViewableCompany[];
  let manageableCompanyIds: Set<string>;
  let records: SendListRecord[];
  try {
    const [viewAccess, manageAccess, listRows] = await Promise.all([
      listCompanyAccess(supabase, 'messaging.view'),
      // A SECOND scan, for messaging.manage rather than a boolean read off the
      // first -- the two are different permissions a Station can hand to
      // different people, and this grid can hold rows from more than one
      // Station, so "can this caller rename/delete" has to be answered PER
      // ROW's own Station, never once for the whole page.
      listCompanyAccess(supabase, 'messaging.manage'),
      listSendLists(accessToken),
    ]);
    viewable = viewAccess.viewable;
    manageableCompanyIds = new Set(manageAccess.viewable.map((c) => c.id));
    records = listRows;
  } catch (cause) {
    logger.error({ err: cause }, 'could not load the send lists');
    return <LoadError message={describeSendListReadError(cause, t)} />;
  }

  // A courtesy, not the boundary: 0238's own select policy is what actually
  // filtered `records` above to rows this caller may see. The same shape
  // messages/templates/page.tsx and messages/promo/page.tsx already use for
  // this section.
  if (viewable.length === 0) redirect('/app');

  const stationById = new Map(viewable.map((c) => [c.id, c]));

  // One listReach round trip per row (Task 5's own API, unchanged by this
  // task -- no bulk-reach RPC exists to ask instead). A single row's failure
  // is caught HERE, per row, rather than let one bad list blank a grid that
  // loaded every other row correctly -- see lists-grid.tsx's own comment on
  // SendListGridRow.reach for the state this produces.
  const rows: SendListGridRow[] = await Promise.all(
    records.map(async (record) => {
      let reach: ListReach | 'error';
      try {
        reach = await listReach(record.id, accessToken);
      } catch (cause) {
        logger.error({ err: cause, listId: record.id }, 'could not compute reach for a send list');
        reach = 'error';
      }
      const station = stationById.get(record.companyId);
      return {
        id: record.id,
        name: record.name,
        companyId: record.companyId,
        // Falls back to the raw id only for a Station beyond
        // listCompanyAccess's own COMPANY_SCAN_CAP (station-access.ts) --
        // narrower than the RLS boundary above, which is uncapped, so a list
        // on such a Station still appears here with an imperfect label
        // rather than vanishing.
        companyName: station?.name ?? record.companyId,
        kind: record.kind,
        source: record.source,
        filters: record.filters,
        canManage: manageableCompanyIds.has(record.companyId),
        reach,
      };
    }),
  );

  return (
    <>
      <PageHeader title={t('sendListsTitle')} description={t('sendListsDescription')} />
      <ListsGrid rows={rows} />
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('templates');
  return (
    <>
      <PageHeader title={t('sendListsTitle')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
