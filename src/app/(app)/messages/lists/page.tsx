import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Route } from 'next';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { decodeCursor } from '@/lib/keyset';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listCompanyAccess } from '../../inventory/station-access';
import type { ViewableCompany } from '../../inventory/station-access';
import { listSendLists } from '@/services/send-lists';
import type { SendListsPage as SendListsReadPage } from '@/services/send-lists';
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
 *
 * NEITHER THIS PAGE NOR `listSendLists` ASKS FOR REACH ANY MORE (fix round 1,
 * F5, Critical). The first version of this screen called Task 5's `listReach`
 * once per row inside a `Promise.all`, before anything could render -- see
 * `listSendLists`'s own header (services/send-lists.ts) for the round-trip
 * count that made unbounded. Reach is now asked for per row, on demand, by
 * `ReachCells` (lists-grid.tsx) through `getSendListReachAction` -- a page
 * load here costs exactly one `listCompanyAccess` pair plus one bounded
 * `listSendLists` page, never more because of how many lists exist or how
 * large a LIVING one's filters resolve to.
 */
export default async function SendListsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const t = await getTranslations('templates');
  const params = await searchParams;
  const cursor = decodeCursor(params.cursor);

  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  let viewable: ViewableCompany[];
  let manageableCompanyIds: Set<string>;
  let listPage: SendListsReadPage;
  try {
    // listSendLists reads under the caller's own JWT (`asCaller`, matching
    // every other function in that file) rather than the cookie-bound
    // `supabase` above, so it needs its own access token -- the same pair
    // messages/templates/actions.ts's own requireAccessToken reads, fetched
    // here rather than via requireAccessToken because this is a page render,
    // not a Server Action, and a redirect here belongs to THIS function.
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) redirect('/login');

    const [viewAccess, manageAccess, sendListsResult] = await Promise.all([
      listCompanyAccess(supabase, 'messaging.view'),
      // A SECOND scan, for messaging.manage rather than a boolean read off the
      // first -- the two are different permissions a Station can hand to
      // different people, and this grid can hold rows from more than one
      // Station, so "can this caller rename/delete" has to be answered PER
      // ROW's own Station, never once for the whole page.
      listCompanyAccess(supabase, 'messaging.manage'),
      listSendLists(accessToken, cursor),
    ]);
    viewable = viewAccess.viewable;
    manageableCompanyIds = new Set(manageAccess.viewable.map((c) => c.id));
    listPage = sendListsResult;
  } catch (cause) {
    logger.error({ err: cause }, 'could not load the send lists');
    return <LoadError message={describeSendListReadError(cause, t)} />;
  }

  // A courtesy, not the boundary: 0238's own select policy is what actually
  // filtered `listPage.rows` above to rows this caller may see. The same
  // shape messages/templates/page.tsx and messages/promo/page.tsx already
  // use for this section.
  if (viewable.length === 0) redirect('/app');

  const stationById = new Map(viewable.map((c) => [c.id, c]));

  const rows: SendListGridRow[] = listPage.rows.map((record) => {
    const station = stationById.get(record.companyId);
    return {
      id: record.id,
      name: record.name,
      companyId: record.companyId,
      // Falls back to the raw id only for a Station beyond
      // listCompanyAccess's own COMPANY_SCAN_CAP (station-access.ts) --
      // narrower than the RLS boundary above, which is uncapped, so a list
      // on such a Station still appears here with an imperfect label rather
      // than vanishing.
      companyName: station?.name ?? record.companyId,
      kind: record.kind,
      source: record.source,
      filters: record.filters,
      canManage: manageableCompanyIds.has(record.companyId),
    };
  });

  return (
    <>
      <PageHeader title={t('sendListsTitle')} description={t('sendListsDescription')} />
      <ListsGrid rows={rows} />

      {listPage.nextCursor && (
        <div className="mt-4 text-sm">
          <Link
            href={(`/messages/lists?cursor=${encodeURIComponent(listPage.nextCursor)}` as Route)}
            className="underline underline-offset-4"
          >
            {t('olderSendLists')}
          </Link>
        </div>
      )}
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
