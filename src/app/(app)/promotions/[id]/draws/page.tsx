import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { getPromotionRecord, getPromotionStationId } from '@/services/promotions';
import { DEFAULT_RUNNER_UP_COUNT, getDraw, listDraws } from '@/services/draws';
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

  const [powers, record] = await Promise.all([
    getPromotionPowers(supabase, companyId),
    getPromotionRecord(promotionId, token),
  ]);
  if (!record) notFound();

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
    readError = 'Não foi possível ler os sorteios desta promoção.';
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
        title={`Sorteios — ${record.name}`}
        description="Quem ganhou, com que prazo, e como qualquer pessoa confere o sorteio."
      />
      <Card>
        <CardContent className="space-y-6 pt-6">
          <Link href="/promotions" className="text-sm underline">
            ← Voltar às promoções
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
              defaultRunnerUpCount={DEFAULT_RUNNER_UP_COUNT}
              companyId={companyId}
              canDraw={powers.drawsExecute}
              canCancel={powers.drawsCancel}
              winnerPowers={{
                deliver: powers.winnersDeliver,
                deliverCancel: powers.winnersDeliverCancel,
                return: powers.winnersReturn,
                writeOff: powers.winnersWriteOff,
              }}
              receiptUrls={receiptUrls}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
