'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PromotionDetail } from '@/services/promotions';
import { situationOf } from '@/lib/promotion-situation';
// The tab tuple is declared with parseRecordParam rather than here, because the
// page that validates `tab=` against it is a Server Component and cannot import
// a value out of a client module. See src/lib/record-params.ts.
import { PROMOTION_TABS, type PromotionTab } from '@/lib/record-params';
import { updatePromotionAction, type PromotionFormState } from './actions';
import { getPromotionRecordAction } from './record';
import { formatInstant, SITUATION_CLASSES, SITUATION_LABELS } from './format';
import { PromotionFields } from './promotion-fields';
import { WhatsappFields } from './whatsapp-fields';
import { ParticipationsTab } from './participations-tab';
import { PrizesTab } from './prizes-tab';
import { QuizTab } from './quiz-tab';

const TAB_LABELS: Record<PromotionTab, string> = {
  data: 'Promotion',
  whatsapp: 'WhatsApp',
  quiz: 'Quiz',
  prizes: 'Prizes',
  participations: 'Entries',
};

/**
 * The tabs the shared promotion form spans, and so the tabs the footer's Save
 * belongs on. Stated positively rather than as a list of the tabs it is not:
 * the negative form is right today and silently offers Save again the day a
 * fifth tab is added, which is exactly how Save came to be offered from the
 * Prizes tab before this list existed.
 */
const FORM_TABS: readonly PromotionTab[] = ['data', 'whatsapp'];

export interface PromotionRecordPowers {
  edit: boolean;
  /** Linking moves stock, so it is its own code rather than part of promotions.edit. */
  prizes: boolean;
  /** The fifth tab's five; see PromotionPowers in ./access.ts for why two of them are audience codes. */
  participationsView: boolean;
  participationsCreate: boolean;
  participationsImport: boolean;
  membersView: boolean;
  membersCreate: boolean;
}

const INITIAL_SAVE: PromotionFormState = { status: 'idle' };

/**
 * What a failed re-read should leave on screen.
 *
 * `refresh()` re-reads one promotion after a write made inside the dialog —
 * including the import's own write, whose result is the per-line report
 * ImportParticipationsForm renders from its own local action state. Before the
 * first fix round, every failed read (first load or a later refresh alike)
 * called `setRecord(null)`, which unmounts the whole `{record && (...)}`
 * subtree — ParticipationsTab, the import form, and the report on rows the
 * import had already written — over a re-read that failed for a reason that
 * has nothing to do with whether those rows exist. A transient blip right
 * after a successful import would silently destroy the only place that
 * result was ever shown, with the promotion's own participations already
 * sitting in the database and nothing on screen saying so.
 *
 * That fix's own gap, found on re-review: it treated every failure alike.
 * `getPromotionRecordAction` (`./record.ts`) does not — it is two different
 * facts wearing one `status !== 'ok'` shape:
 *
 * - `'not-found'` is RLS answering "zero rows, right now"
 *   (`services/promotions.ts`'s `getPromotionRecord`: `.maybeSingle()`
 *   SUCCEEDED and returned none). That is deliberately not told apart from a
 *   revoked permission — `record.ts`'s own comment: "this must not let the
 *   screen tell them apart, or `?record=<id>` becomes an oracle for ids" — but
 *   either way it is authoritative and CURRENT, not flaky: nothing about a
 *   network blip makes a successful query return zero rows for a promotion
 *   that is still there. A stale record must not outlive that answer, whatever
 *   id it names — an editable form with a working Save button rendered
 *   underneath "you do not have permission to see this one" is a worse defect
 *   than the one this function exists to fix.
 * - anything else reaching here is `'error'`: an exception was THROWN and
 *   caught (`record.ts`'s own try/catch), which is the shape a network blip or
 *   a momentary timeout actually takes. That is the case worth keeping stale
 *   content for — but only for the SAME promotion: `previous.id === recordId`
 *   rather than "reloadToken === 0", because this dialog is not remounted
 *   between two different promotions (only `recordId` changes), so a plain
 *   "is this the first reload" flag would still read as satisfied the moment
 *   a SECOND promotion is opened after the first one's tab was ever refreshed
 *   even once — showing promotion A's fields under promotion B's title.
 *
 * Exported and pure so this decision can be checked without rendering the
 * component — this project's unit tests run in vitest's `node` environment
 * (vitest.config.ts) with no DOM, so a test that mounted the dialog itself is
 * not available here.
 */
export function nextRecordAfterFailedRead<T extends { id: string }>(
  previous: T | null,
  recordId: string,
  status: 'not-found' | 'error',
): T | null {
  if (status === 'not-found') return null;
  return previous && previous.id === recordId ? previous : null;
}

/**
 * One promotion's whole record over the list. Same shape as the audience and
 * inventory records, and for the same reason: one read per opening, every tab
 * rendered from it, so nothing here can re-run the list query behind the
 * dialog.
 *
 * The Promotion and WhatsApp tabs are ONE form spanning two tabs. The inactive
 * one is hidden rather than unmounted, exactly as a role's two halves are in
 * Block 3c: update_promotion replaces every field on every call, so unmounting
 * the WhatsApp tab would post nothing for the hashtag, the art and the whole
 * requested list, and silently clear all three.
 */
export function PromotionRecordDialog({
  recordId,
  tab,
  companyId,
  timeZone,
  powers,
  onTab,
  onClose,
  onSaved,
  onLoaded,
}: {
  recordId: string | null;
  tab: PromotionTab;
  /**
   * The Station the list behind this dialog is showing — `?companyId=`, which
   * is also where `timeZone` and every flag in `powers` come from. Held here so
   * a record belonging to a DIFFERENT Station can be refused rather than
   * rendered against the wrong Station's answers; see the check in the read
   * below.
   */
  companyId: string;
  timeZone: string;
  powers: PromotionRecordPowers;
  onTab: (tab: PromotionTab) => void;
  onClose: () => void;
  /** Called with the id whose row the grid should patch from its own next read. */
  onSaved: (promotionId: string) => void;
  /** Every successful read, which is how a promotion registered a moment ago gets its row. */
  onLoaded?: (record: PromotionDetail) => void;
}) {
  const t = useTranslations('promotions');
  const titleId = useId();
  const [record, setRecord] = useState<PromotionDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [saveState, saveAction, saving] = useActionState(updatePromotionAction, INITIAL_SAVE);

  // Mirrors of the two ticks that decide which fields render. Held here rather
  // than inside each tab because the tabs are one form and the Promotion tab's
  // repeat tick has to survive a trip through the WhatsApp tab.
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [repeats, setRepeats] = useState(false);
  /**
   * Set when the record that came back belongs to a Station other than the one
   * on screen. Holds that Station's id, because the way out of this state is a
   * link to it — see the refusal rendered in the body.
   */
  const [elsewhere, setElsewhere] = useState<string | null>(null);

  useEffect(() => {
    if (!recordId) {
      setRecord(null);
      setFailure(null);
      setElsewhere(null);
      setDirty(false);
      return;
    }
    let current = true;
    setLoading(true);
    setFailure(null);
    setElsewhere(null);
    void getPromotionRecordAction(recordId).then((result) => {
      if (!current) return;
      setLoading(false);
      if (result.status === 'ok') {
        // `?companyId=<A>&record=<a promotion at B>` is a URL nobody has to
        // forge — a pasted or stale link is the shape record-params.ts exists
        // to support — and getPromotionRecord reads by id alone, with no
        // company filter, so the record comes back perfectly while EVERY answer
        // this dialog was handed alongside it belongs to Station A:
        //
        //   - `timeZone`, which both writing surfaces convert wall-clock to
        //     instant with. Brazil spans three zones, so that is a silent one-
        //     or two-hour shift on the single value design spec D7 measures the
        //     minimum interval against — and the import's mapping panel would
        //     have CONFIRMED the wrong instant back to the operator rather than
        //     exposing it, once per file rather than once per row.
        //   - every flag in `powers`, resolved per Station in ./access.ts, so
        //     the tab could hide a control this caller holds at B or offer one
        //     they do not.
        //   - `onLoaded` below, which patches the grid — a promotion from
        //     Station B appearing in Station A's list.
        //
        // Refused rather than papered over. Carrying the record's own zone
        // would have fixed the first of those three and left the other two, and
        // this dialog's whole contract is "the selected Station's promotion":
        // there is no version of it that is half true. The refusal is one
        // click from being fixed, so the deep link still works — it just goes
        // through the Station that owns the promotion.
        if (result.record.companyId !== companyId) {
          setRecord(null);
          setElsewhere(result.record.companyId);
          return;
        }
        setRecord(result.record);
        setWhatsappEnabled(result.record.whatsappEnabled);
        setRepeats(result.record.allowMultipleEntries);
        onLoaded?.(result.record);
        return;
      }
      // See nextRecordAfterFailedRead's own comment: a `not-found` clears
      // unconditionally (RLS's current, authoritative answer), and only an
      // `error` for THIS SAME promotion keeps an already-showing record
      // (and everything mounted under it) rather than taking it down over a
      // re-read that may well be transient.
      setRecord((previous) => nextRecordAfterFailedRead(previous, recordId, result.status));
      setFailure(
        result.status === 'not-found'
          ? 'No such promotion, or you do not have permission to see this one.'
          : result.message,
      );
    });
    return () => {
      current = false;
    };
    // onLoaded is stable for this dialog's lifetime, and adding it would make
    // the record re-read whenever the grid re-renders its callback. companyId
    // is in the list because a Station change re-renders this component in
    // place — the dialog is not remounted — and the answer to "does this record
    // belong here" is different afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, reloadToken, companyId]);

  /**
   * Re-reads this one promotion after a write made inside the dialog.
   *
   * Not a hole in the rule this block rests on: the prohibition is on
   * re-running the LIST, not on reading one record again, and nothing about
   * the screen behind the dialog is re-rendered or re-queried. Block 3c
   * shipped this as a fix after its record dialogs failed to show what had
   * just been written; it is not to be rediscovered.
   */
  function refresh() {
    setReloadToken((token) => token + 1);
  }

  useEffect(() => {
    if (saveState.status === 'saved' && saveState.promotionId) {
      setDirty(false);
      onSaved(saveState.promotionId);
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveState]);

  function requestClose() {
    if (dirty && !window.confirm('Discard the changes you have not saved?')) return;
    setDirty(false);
    onClose();
  }

  const situation = record
    ? situationOf({
        startsAt: record.startsAt,
        endsAt: record.endsAt,
        cancelledAt: record.cancelledAt,
      })
    : null;

  const readOnly = !powers.edit;

  return (
    <Dialog open={recordId !== null} onClose={requestClose} labelledBy={titleId}>
      <DialogHeader>
        <div className="flex flex-col gap-1">
          <DialogTitle id={titleId}>
            {record?.name ?? (loading ? 'Loading…' : 'Promotion')}
          </DialogTitle>
          {record && situation && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${SITUATION_CLASSES[situation]}`}
                data-testid="promotion-dialog-situation"
              >
                {SITUATION_LABELS[situation]}
              </span>
              <span className="text-muted-foreground">
                {t('registered')}{' '}{formatInstant(record.createdAt, timeZone)}
              </span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={requestClose}
          aria-label={t('closeRecord')}
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      {record && (
        <div role="tablist" aria-label={t('recordSections')} className="flex gap-1 border-b px-5">
          {PROMOTION_TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => onTab(name)}
              className={
                tab === name
                  ? 'border-b-2 border-primary px-3 py-2 text-sm font-medium'
                  : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
              }
              data-testid={`promotion-tab-${name}`}
            >
              {TAB_LABELS[name]}
            </button>
          ))}
        </div>
      )}

      <DialogBody>
        {loading && <p className="text-sm text-muted-foreground">{t('loadingTheRecord')}</p>}

        {failure && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{failure}</p>
            <Button type="button" variant="outline" onClick={refresh}>
              {t('tryAgain')}</Button>
          </div>
        )}

        {/* The whole promotion is readable — this caller holds promotions.view
            at the Station that owns it — so this is not a denial and must not
            read as one. It is the one thing this dialog cannot do: render a
            promotion against another Station's timezone, permissions and list.
            The link is the fix, and it carries the tab so the operator lands
            back where they were.

            Built by hand rather than through promotionsHref: that builder takes
            the CURRENT list's whole state, and every part of it — the search,
            the situation filter, the sort, the cursor — belongs to the Station
            being left. Carrying them across would be carrying a position in a
            result set that no longer exists. */}
        {elsewhere && (
          <div className="flex flex-col items-start gap-3" data-testid="promotion-record-elsewhere">
            <p className="text-sm text-muted-foreground">
              {t('thisPromotionBelongsToAnotherStation')}</p>
            <Link
              href={
                `/promotions?companyId=${encodeURIComponent(elsewhere)}&record=${encodeURIComponent(
                  recordId ?? '',
                )}&tab=${encodeURIComponent(tab)}` as Route
              }
              className="text-sm text-primary underline underline-offset-2"
              data-testid="promotion-record-elsewhere-link"
            >
              {t('openItAtTheStationIt')}</Link>
          </div>
        )}

        {record && (
          <>
            {record.cancelledAt && (
              <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {t('cancelled')}{' '}{formatInstant(record.cancelledAt, timeZone)}
                {record.cancellationReason ? ` — ${record.cancellationReason}` : ''}
              </p>
            )}
            {record.deletedAt && (
              <p className="mb-4 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                {t('archived')}{' '}{formatInstant(record.deletedAt, timeZone)}. You can see this because you
                own this Organization; nobody else&apos;s reads return it.
              </p>
            )}

            {/* One form across two tabs. `hidden` rather than unmounting: see
                this component's own doc comment. */}
            <form action={saveAction} id="promotion-record-form">
              <input type="hidden" name="promotionId" value={record.id} />
              <input type="hidden" name="companyId" value={record.companyId} />

              <div hidden={tab !== 'data'}>
                <PromotionFields
                  record={record}
                  timeZone={timeZone}
                  disabled={readOnly}
                  repeats={repeats}
                  onRepeatsChange={(next) => {
                    setRepeats(next);
                    setDirty(true);
                  }}
                  onDirty={() => setDirty(true)}
                />
              </div>

              <div hidden={tab !== 'whatsapp'}>
                <WhatsappFields
                  record={record}
                  enabled={whatsappEnabled}
                  onEnabledChange={(next) => {
                    setWhatsappEnabled(next);
                    setDirty(true);
                  }}
                  disabled={readOnly}
                  onDirty={() => setDirty(true)}
                />
              </div>
            </form>

            {tab === 'quiz' && (
              <QuizTab
                promotionId={record.id}
                questions={record.questions}
                canEdit={powers.edit}
                onSaved={refresh}
              />
            )}

            {tab === 'prizes' && (
              <PrizesTab
                promotionId={record.id}
                companyId={record.companyId}
                prizes={record.prizes}
                canLink={powers.prizes}
                onSaved={refresh}
              />
            )}

            {/* Props and `onSaved`, exactly like Quiz and Prizes: the counts
                come with the record and every write here calls `refresh`, which
                re-reads this one promotion. That is not a hole in the rule this
                block rests on — the prohibition is on re-running the LIST — and
                it is deliberately not the cheaper shape Task 8 tried first,
                where the tab fetched its own counts when it mounted. See the
                note beside the count read in services/promotions.ts: an action
                dispatched from an effect that runs right after the tab strip's
                navigation is silently dropped, and that tab could hang for
                ever. */}
            {tab === 'participations' && (
              <ParticipationsTab
                promotionId={record.id}
                companyId={record.companyId}
                timeZone={timeZone}
                questions={record.questions}
                requireCorrectAnswer={record.requireCorrectAnswer}
                counts={record.participationCounts}
                powers={powers}
                onSaved={refresh}
              />
            )}

            {saveState.status === 'error' && (
              <p className="mt-4 text-sm text-destructive" data-testid="promotion-save-error">
                {saveState.message}
              </p>
            )}
            {saveState.status === 'saved' && !dirty && (
              <p className="mt-4 text-sm text-emerald-700" data-testid="promotion-saved">
                {t('saved')}</p>
            )}

            {/* Scoped to the tabs the shared form spans, because that is what
                the sentence is about. On the Quiz tab it merely duplicated
                QuizTab's own version of it; on the Prizes tab it would be
                false — promotions.prizes is a separate code, so a caller who
                holds it without promotions.edit is being offered the Link
                control directly underneath a line telling them this promotion
                cannot be changed. Each of those two tabs says its own
                sentence about its own permission. */}
            {readOnly && FORM_TABS.includes(tab) && (
              <p className="mt-4 text-sm text-muted-foreground">
                {t('youDoNotHoldPromotionsEdit')}</p>
            )}
          </>
        )}
      </DialogBody>

      <DialogFooter>
        {record && !readOnly && FORM_TABS.includes(tab) && (
          <Button
            type="submit"
            form="promotion-record-form"
            disabled={saving}
            data-testid="promotion-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={requestClose}>
          {t('close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
