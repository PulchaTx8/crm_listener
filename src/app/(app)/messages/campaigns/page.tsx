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
import { listCampaigns } from '@/services/campaigns';
import type { CampaignsPage as CampaignsReadPage } from '@/services/campaigns';
import { listSendLists } from '@/services/send-lists';
import type { SendListsPage as SendListsReadPage } from '@/services/send-lists';
import { describeCampaignReadError } from '../errors';
import { CampaignsGrid } from './campaigns-grid';
import type { CampaignGridRow } from './campaigns-grid';
import { NewCampaignDialog } from './new-campaign-dialog';
import type { CampaignListOption } from './new-campaign-dialog';

// Renders from the caller's session cookies and per-Station permission checks
// (messaging.view, messaging.send), so it can never be static -- the same
// reason /messages/lists (this section's own sibling) gives for itself.
export const dynamic = 'force-dynamic';

/**
 * Block 29d-2, Task 7. Every campaign this caller's `messaging.view` reaches,
 * across every Station -- the same shape SendListsPage (messages/lists/page.tsx)
 * already establishes for its own grid, right down to why Station is a COLUMN
 * here rather than a selection (0238's D3, restated by 0242's own list_id):
 * a campaign belongs to exactly one Station, so an operator holding
 * messaging.view at more than one sees every campaign in one place.
 *
 * ALSO LOADS `listSendLists`' FIRST PAGE, for the New Campaign dialog's own
 * "choose a list" dropdown's initial <select> -- capped at
 * SEND_LIST_PAGE_SIZE (50), newest first, the same bound SendListsPage
 * itself accepts before an operator follows its own "older lists" link.
 * AN OPERATOR WITH MORE THAN FIFTY LISTS IS NOT STRANDED (fix round 1, F3):
 * the dialog's own search box (searchCampaignListsAction, actions.ts)
 * reaches every list this caller's messaging.view admits, by name,
 * unbounded by this page's own 50-newest cap -- the fiftieth-oldest list
 * this read drops is still one keystroke away, not a silent loss with no
 * way back.
 */
export default async function CampaignsPage({
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
  let sendableCompanyIds: Set<string>;
  let campaignsPage: CampaignsReadPage;
  let listsPage: SendListsReadPage;
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) redirect('/login');

    const [viewAccess, sendAccess, campaignsResult, listsResult] = await Promise.all([
      listCompanyAccess(supabase, 'messaging.view'),
      // A SECOND scan, for messaging.send rather than a boolean read off the
      // first -- the two are different permissions a Station can hand to
      // different people (0236, restated by 0243's own header: "approving a
      // send is not the act of drafting one"), and this grid can hold rows
      // from more than one Station, so "may this caller cancel THIS row" has
      // to be answered per row's own Station, the same shape
      // SendListsPage's own `manageableCompanyIds` takes for messaging.manage.
      listCompanyAccess(supabase, 'messaging.send'),
      listCampaigns(accessToken, cursor),
      listSendLists(accessToken, null),
    ]);
    viewable = viewAccess.viewable;
    sendableCompanyIds = new Set(sendAccess.viewable.map((c) => c.id));
    campaignsPage = campaignsResult;
    listsPage = listsResult;
  } catch (cause) {
    logger.error({ err: cause }, 'could not load the campaigns screen');
    return <LoadError message={describeCampaignReadError(cause, t)} />;
  }

  // A courtesy, not the boundary: 0242's own select policy is what actually
  // filtered `campaignsPage.rows` above to rows this caller may see. The
  // same shape messages/lists/page.tsx and messages/templates/page.tsx
  // already use for this section.
  if (viewable.length === 0) redirect('/app');

  const stationById = new Map(viewable.map((c) => [c.id, c]));

  // Only campaigns whose Station this caller can also NAME (whole-branch
  // review, Minor 7). Both reads are bounded by the identical messaging.view
  // -- 0242's own select policy filtered `campaignsPage.rows`, and
  // `listCompanyAccess` filtered `viewable` -- so in practice this removes
  // nothing; it is the same defensive filter `listOptions` below already
  // applies. What it replaces is a fallback that rendered the raw company
  // UUID in the Station column, which is a fabricated name in the one place
  // this branch is otherwise careful never to fabricate one (`listName` and
  // `templateName` are null rather than invented, and
  // `searchCampaignListsAction` drops the row).
  const rows: CampaignGridRow[] = campaignsPage.rows
    .filter((record) => stationById.has(record.companyId))
    .map((record) => ({
      id: record.id,
      companyId: record.companyId,
      companyName: stationById.get(record.companyId)!.name,
      status: record.status,
      listName: record.listName,
      channel: record.channel,
      templateName: record.templateName,
      totalRecipients: record.totalRecipients,
      sentCount: record.sentCount,
      failedCount: record.failedCount,
      suppressedCount: record.suppressedCount,
      createdByName: record.createdByName,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      // Gated per row on its OWN Station's messaging.send, never on a single
      // flag for the whole grid -- the identical reasoning ListsGrid's own
      // `canManage` gives for messaging.manage.
      canCancel: sendableCompanyIds.has(record.companyId),
    }));

  // Only lists this caller can also SEE the Station of -- `listSendLists`
  // is already bounded by the identical `messaging.view` RLS policy this
  // page itself redirects on, so in practice every row it returns has a
  // matching entry in `stationById`; the filter is defensive rather than
  // expected to remove anything.
  const listOptions: CampaignListOption[] = listsPage.rows
    .filter((list) => stationById.has(list.companyId))
    .map((list) => ({
      id: list.id,
      name: list.name,
      companyId: list.companyId,
      companyName: stationById.get(list.companyId)!.name,
    }));

  return (
    <>
      <PageHeader title={t('campaignsTitle')} description={t('campaignsDescription')} />
      <div className="mb-4 flex justify-end">
        <NewCampaignDialog lists={listOptions} sendableCompanyIds={[...sendableCompanyIds]} />
      </div>
      <CampaignsGrid rows={rows} />

      {campaignsPage.nextCursor && (
        <div className="mt-4 text-sm">
          <Link
            href={(`/messages/campaigns?cursor=${encodeURIComponent(campaignsPage.nextCursor)}` as Route)}
            className="underline underline-offset-4"
          >
            {t('olderCampaigns')}
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
      <PageHeader title={t('campaignsTitle')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
