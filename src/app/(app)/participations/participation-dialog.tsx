'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { STATUS_CLASSES, STATUS_LABEL_KEYS } from '@/lib/participation-status';
import type { ParticipationAnswerDetail, ParticipationSummary } from '@/services/participations';
// The Station-zone instant formatter, borrowed from the screen that owns it
// rather than re-derived here. formatInstant pins the zone explicitly (spec
// L2).
import { formatInstant } from '../promotions/format';
import { lastFourDigits, maskedPhone } from '@/lib/members/mask';
import { readParticipationAnswersAction } from './actions';
import { SOURCE_LABEL_KEYS } from './list-params';

/**
 * Block 24, item 6. One participation, read in full.
 *
 * MODELLED ON `AttendDialog` (Block 22), down to two behaviours that are not
 * obvious and that screen paid for: the subject is derived from the live rows by
 * id on every render rather than snapshotted when the button was pressed, and
 * the id is CLEARED when the row leaves the page — without that, clearing a
 * filter brings the row back, the derivation matches again on its own, and the
 * window the operator already finished with reopens unprompted. Both live in
 * `participations-grid.tsx`, which is where the rows are.
 *
 * What this window is FOR is the answers, and they are the one thing
 * `list_participations` does not return: everything else here comes off the row
 * that is already on screen.
 */
export function ParticipationDialog({
  entry,
  promotionThumbUrl,
  timeZone,
  onClose,
}: {
  entry: ParticipationSummary;
  /** The promotion's own picture, from the page's map — the same one the grid's first column shows. */
  promotionThumbUrl: string | null;
  timeZone: string;
  onClose: () => void;
}) {
  const t = useTranslations('participations');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');
  const titleId = useId();

  const [answers, setAnswers] = useState<ParticipationAnswerDetail[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setAnswers(null);
    setFailure(null);
    void readParticipationAnswersAction(entry.id).then((result) => {
      // The answer to a participation the operator has already moved past must
      // not land — the same guard every read-on-open dialog here carries.
      if (!current) return;
      if (result.status === 'ok') setAnswers(result.answers);
      else setFailure(result.message);
    });
    return () => {
      current = false;
    };
  }, [entry.id]);

  // last4, not phone, is what the row-render guard below tests. phone is never
  // falsy now that maskedPhone (Block 30a) answers bare dots instead of null
  // when there are no four digits, and guarding on phone would render the
  // row's dots even for a caller without members.view, whose entry carries
  // neither listenerPhone nor listenerCpfLastDigits (0090 nulls both together).
  const last4 = lastFourDigits(entry.listenerPhone);
  const phone = maskedPhone(last4);

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('theEntry')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {/*
          A missing name is rendered the same way whatever the reason, exactly as
          the grid renders it: listenerName is null for an anonymised listener
          (0034 scrubs full_name) AND for a caller who holds participations.view
          but not members.view, and telling those two apart here would let this
          window answer "has this person been erased?" for somebody who may not
          read the person at all.
        */}
        <p className="text-2xl font-semibold" data-testid="participation-listener">
          {entry.listenerName ?? '—'}
        </p>

        {/*
          FOUR DIGITS, on the owner's instruction, and derived here rather than
          read from a narrower column: list_participations returns the whole
          number to a caller holding members.view (0090), which is what the grid
          behind this window still shows. This is the stricter rendering of the
          same value, in the window where somebody might read it aloud.
        */}
        {(last4 || entry.listenerCpfLastDigits) && (
          <p className="mt-1 text-sm text-muted-foreground">
            <span data-testid="participation-phone">{phone}</span>
            {entry.listenerCpfLastDigits && (
              <span className="ml-2">···{entry.listenerCpfLastDigits}</span>
            )}
          </p>
        )}

        <div className="mt-4 flex items-center gap-3">
          {promotionThumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={promotionThumbUrl} alt="" width={40} height={40} className="rounded" />
          ) : (
            <span className="block size-10 rounded bg-muted" aria-hidden="true" />
          )}
          <span className="text-lg" data-testid="participation-promotion">
            {entry.promotionName ?? '—'}
          </span>
        </div>

        <p className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[entry.status]}`}
          >
            {tv(STATUS_LABEL_KEYS[entry.status])}
          </span>
          <span>·</span>
          <span>{tv(SOURCE_LABEL_KEYS[entry.source])}</span>
          <span>·</span>
          <span>{formatInstant(entry.participatedAt, timeZone)}</span>
          {/* Block 6c's own column, restated here: somebody who has already won
              is not in the next round's hat (0076), so their row vanishes
              between rounds and this is what accounts for it. */}
          {entry.alreadyWon && (
            <span
              className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
              data-testid="participation-already-won-badge"
            >
              {t('wonHere')}
            </span>
          )}
        </p>

        <div className="mt-5 border-t pt-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('answers')}</p>

          {failure && (
            <p className="mt-2 text-sm text-destructive" data-testid="participation-answers-error">
              {failure}
            </p>
          )}

          {!failure && answers === null && (
            <p className="mt-2 text-sm text-muted-foreground">{t('loadingTheAnswers')}</p>
          )}

          {/* An empty list is a real and ordinary state: a promotion with no
              quiz asks nothing, and this says so rather than showing a heading
              over nothing. */}
          {answers !== null && answers.length === 0 && (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="participation-no-answers">
              {t('thisPromotionAskedNothing')}
            </p>
          )}

          {answers !== null && answers.length > 0 && (
            <ul className="mt-3 flex flex-col gap-4">
              {answers.map((answer) => (
                <li key={answer.id} data-testid="participation-answer">
                  <p className="text-sm font-medium">{answer.prompt || '—'}</p>

                  {/* THE GUIDANCE COMES FIRST, above the answer it is about
                      (Block 24, item 5). This is the reader that field was added
                      for, and guidance read after the answer is guidance read
                      too late. Internal — never sent to the listener — and the
                      label says so, because everything else on this line is
                      something the listener wrote or chose. */}
                  {answer.moderationGuidelines && (
                    <p
                      className="mt-1 whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground"
                      data-testid="participation-answer-guidelines"
                    >
                      <span className="font-medium">{t('moderationGuidelines')}</span>{' '}
                      {answer.moderationGuidelines}
                    </p>
                  )}

                  {answer.answerText !== null ? (
                    <p
                      className="mt-1 whitespace-pre-wrap text-sm"
                      data-testid="participation-answer-text"
                    >
                      {answer.answerText}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm" data-testid="participation-answer-option">
                      {answer.optionLabel ?? '—'}
                      {/* Only on a QUIZ. A MULTIPLE_CHOICE has no right answer
                          at all — 0041 refuses is_correct on one — so marking
                          its option "wrong" would invent a verdict the promotion
                          never had. */}
                      {answer.kind === 'QUIZ' && answer.optionIsCorrect !== null && (
                        <span
                          className={
                            answer.optionIsCorrect
                              ? 'ml-2 text-xs font-medium text-success'
                              : 'ml-2 text-xs font-medium text-muted-foreground'
                          }
                          data-testid="participation-answer-verdict"
                        >
                          {answer.optionIsCorrect ? t('rightAnswer') : t('wrongAnswer')}
                        </span>
                      )}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
