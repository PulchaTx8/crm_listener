'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Button } from '@/components/ui/button';
import type { PromotionParticipationCounts } from '@/services/participations';
import type { PromotionQuestion } from '@/services/promotions';
import { ImportParticipationsForm } from '../participations/import-form';
import { RecordParticipationForm } from '../participations/record-participation-form';
// The list screen's own URL builder, so the link out of here and the links its
// filter bar writes are produced by one function over one shape. A hand-rolled
// query string here is exactly how a Station selection stops surviving a filter
// change (list-params.ts's own comment).
import { ANY_STATUS, participationsHref } from '../participations/list-params';
import type { PromotionRecordPowers } from './promotion-record-dialog';

/**
 * The promotion record's fifth tab (design spec D8).
 *
 * **Fixed cost, and that is the design constraint rather than a nicety.** The
 * record is read once per opening (Block 3c) and every tab renders from what
 * that read returned — but a promotion with eight thousand entries cannot be
 * read once per opening, so this tab does not list them. Two counts, two
 * buttons, and a link into /participations filtered to this promotion, which is
 * where eight thousand rows are paged through a keyset cursor.
 *
 * Everything it renders arrives as a prop, exactly as the Prizes tab's rows do,
 * and every write calls `onSaved` to re-read this one record. That is not a hole
 * in the rule this block rests on: the prohibition is on re-running the LIST,
 * and nothing behind the dialog is touched.
 */
export function ParticipationsTab({
  promotionId,
  companyId,
  timeZone,
  questions,
  requireCorrectAnswer,
  counts,
  powers,
  onSaved,
}: {
  promotionId: string;
  companyId: string;
  timeZone: string;
  questions: PromotionQuestion[];
  requireCorrectAnswer: boolean;
  counts: PromotionParticipationCounts;
  powers: PromotionRecordPowers;
  onSaved: () => void;
}) {
  const t = useTranslations('promotions');
  const [pane, setPane] = useState<'none' | 'record' | 'import'>('none');

  const listHref = participationsHref({
    companyId,
    promotionId,
    // Every status, not the screen's usual VALID default: the two figures above
    // this link add up to every entry in the promotion, and landing on the
    // counted ones alone would show a list that disagrees with the number the
    // operator just clicked beside.
    status: ANY_STATUS,
  });

  return (
    <div className="flex flex-col gap-5">
      {/*
        Both counts are read under 0053's select policy, which answers a caller
        who does not hold participations.view with zero rather than with an
        error. So the numbers are shown only to somebody allowed to know them:
        rendered unqualified, "0 in the draw" is this screen asserting as fact
        something it was refused. The same reasoning the audience grid gives for
        rendering an unreadable listener name and an anonymised one identically.
      */}
      {powers.participationsView ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-4">
            <p className="text-2xl font-semibold" data-testid="promotion-participations-valid">
              {counts.valid}
            </p>
            <p className="text-sm text-muted-foreground">{t('inTheDraw')}</p>
          </div>
          <div className="rounded-md border p-4">
            <p className="text-2xl font-semibold" data-testid="promotion-participations-refused">
              {counts.refused}
            </p>
            <p className="text-sm text-muted-foreground">{t('recordedAndNotInTheDraw')}</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="promotion-participations-hidden">
          {t('youDoNotHoldParticipationsView')}</p>
      )}

      {/* Design spec D5, said where the number is: a refused attempt was written
          down with the reason it did not count, rather than thrown away. Without
          this sentence the second figure reads as a count of errors.

          The second sentence is the qualification the counts had been shipping
          without. countPromotionParticipations reads `count: 'estimated'` —
          design spec D8's fixed cost, and the whole reason this tab can exist
          on a promotion with eight thousand entries — which PostgREST answers
          with an exact COUNT(*) below `db-max-rows` (1000 in
          supabase/config.toml) and with a planner estimate above it. So on a
          large promotion these two figures and the list's own exact footer
          total, one click away through the link below, will disagree. That was
          judged not to block, and the fix for it was never the architecture: it
          was saying so where the numbers are, rather than letting an operator
          find two different answers to one question and have to decide which
          screen is lying. */}
      {powers.participationsView && (
        <p className="text-xs text-muted-foreground" data-testid="promotion-participations-note">
          {t('anAttemptThatDidNotCount')}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {powers.participationsCreate && pane !== 'record' && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setPane('record')}
            data-testid="promotion-participation-record-open"
          >
            {t('recordAnEntry')}</Button>
        )}
        {powers.participationsImport && pane !== 'import' && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setPane('import')}
            data-testid="promotion-participation-import-open"
          >
            {t('importAFile')}</Button>
        )}
        {/* Offered only to somebody who can read the list it leads to. Without
            participations.view here, that screen either redirects them off it or
            opens on a different Station — either way the link is a promise this
            tab cannot keep. */}
        {powers.participationsView && (
          <Link
            // typedRoutes cannot express a URL assembled at runtime, so this
            // casts to Route — the pattern SortLink and member-search-form both
            // use for the same reason.
            href={listHref as Route}
            className="text-sm text-primary underline underline-offset-2"
            data-testid="promotion-participations-link"
          >
            {t('seeEveryEntryInThisPromotion')}</Link>
        )}
      </div>

      {!powers.participationsCreate && !powers.participationsImport && (
        <p className="text-sm text-muted-foreground">
          {t('youHoldNeitherParticipationsCreateNor')}</p>
      )}

      {pane === 'record' && (
        <RecordParticipationForm
          promotionId={promotionId}
          companyId={companyId}
          timeZone={timeZone}
          questions={questions}
          canFindListeners={powers.membersView}
          canRegisterListeners={powers.membersCreate}
          onCancel={() => setPane('none')}
          onRecorded={onSaved}
        />
      )}

      {pane === 'import' && (
        <ImportParticipationsForm
          promotionId={promotionId}
          timeZone={timeZone}
          requireCorrectAnswer={requireCorrectAnswer}
          hasQuestions={questions.length > 0}
          canRegisterListeners={powers.membersCreate}
          onCancel={() => setPane('none')}
          onImported={onSaved}
        />
      )}
    </div>
  );
}
