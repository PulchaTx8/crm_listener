import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { InternalError } from '@/lib/errors';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { getPromotionRecord, getPromotionStationId } from '@/services/promotions';
import { getDraw, listDraws } from '@/services/draws';
import { signReceiptUrl } from '@/services/winners';
import type { DrawDetail, DrawSummary } from '@/services/draws';
import { getPromotionPowers } from '../../access';
import { DrawsScreen } from './draws-screen';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function PromotionDrawsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ draw?: string }>;
}) {
  const { id: promotionId } = await params;
  const { draw: selectedDrawId } = await searchParams;

  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) redirect('/login');

  // RLS answers "no such promotion" for one this caller may not reach, which is
  // the same answer a stale id deserves, so both land on notFound().
  const companyId = await getPromotionStationId(promotionId, token);
  if (!companyId) notFound();

  // The Station's zone goes out with the two reads that were already here.
  // Every instant on this screen is rendered in it rather than in the reader's,
  // which is spec L2 — an operator in another state would otherwise see a draw
  // as having happened an hour from when the Station ran it. 6a rendered these
  // with toLocaleString('pt-BR') and no zone at all; Block 6c's Task 7 fixes
  // both halves of that at once, because they are the same call.
  const [powers, record, station] = await Promise.all([
    getPromotionPowers(supabase, companyId),
    getPromotionRecord(promotionId, token),
    supabase.from('companies').select('timezone').eq('id', companyId).maybeSingle(),
  ]);
  if (!record) notFound();
  // getPromotionStationId resolved this same Station under the same policies a
  // moment ago, so a row that will not come back now is a fault rather than a
  // permission — and one that would silently move every time on this page.
  if (station.error || !station.data) {
    throw new InternalError(
      `Could not read this Station's timezone: ${station.error?.message ?? 'no row'}`,
    );
  }
  const timeZone = station.data.timezone;

  let draws: DrawSummary[] = [];
  let detail: DrawDetail | null = null;
  let readError: string | null = null;

  try {
    draws = await listDraws(token, promotionId);
    // The newest draw is the one an operator has just made, so it opens by
    // default rather than leaving them to click the row they were looking at
    // when they pressed the button.
    const openId = selectedDrawId ?? draws[0]?.id ?? null;
    if (openId) detail = await getDraw(token, openId);
  } catch {
    readError = 'The draws of this promotion could not be read.';
  }

  // The bucket is private, so a path is not a link. One short-lived signed URL
  // per receipt, minted here rather than on the client, which is what keeps it
  // that way. A receipt that cannot be signed simply shows no link (the service
  // returns null) rather than failing a screen whose other half still reads.
  const receiptUrls: Record<string, string> = {};
  for (const winner of detail?.winners ?? []) {
    if (!winner.receiptPath) continue;
    const url = await signReceiptUrl(token, winner.receiptPath);
    if (url) receiptUrls[winner.id] = url;
  }

  const linked = record.prizes
    .map((prize) => ({
      promotionPrizeId: prize.promotionPrizeId,
      prizeName: prize.prizeName,
      available: prize.linked - prize.drawn,
      requested: prize.linked - prize.drawn,
    }))
    .filter((prize) => prize.available > 0);

  return (
    <>
      <PageHeader
        title={`Draws — ${record.name}`}
        description="Who won, by when they must collect, and how anybody can check the draw."
      />
      <Card>
        <CardContent className="space-y-6 pt-6">
          <Link href="/promotions" className="text-sm underline">
            ← Back to promotions
          </Link>

          {readError ? (
            <p role="alert" className="text-sm text-destructive">
              {readError}
            </p>
          ) : (
            <DrawsScreen
              promotionId={promotionId}
              draws={draws}
              detail={detail}
              linked={linked}
              timeZone={timeZone}
              companyId={companyId}
              canDraw={powers.drawsExecute}
              canCancel={powers.drawsCancel}
              winnerPowers={{
                deliver: powers.winnersDeliver,
                deliverCancel: powers.winnersDeliverCancel,
                return: powers.winnersReturn,
                writeOff: powers.winnersWriteOff,
                // Deliberately false here, not a permission lookup: reopening a
                // deadline (0093) needs a NEW deadline, and this screen has no
                // field to collect one. Block 6d Task 9 builds the Pickups
                // screen -- the one place with a date beside the reason -- and
                // wires winners.reopen_deadline there. Offering the button here
                // ahead of that field would only ever produce a click that
                // fails.
                reopenDeadline: false,
              }}
              receiptUrls={receiptUrls}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
