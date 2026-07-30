'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PromotionDetail } from '@/services/promotions';
import { situationOf } from '@/lib/promotion-situation';
import { updatePromotionAction, type PromotionFormState } from './actions';
import { getPromotionRecordAction } from './record';
import { formatInstant, SITUATION_CLASSES, SITUATION_LABELS } from './format';
import { PromotionFields } from './promotion-fields';
import { WhatsappFields } from './whatsapp-fields';
import { PrizesTab } from './prizes-tab';
import { QuizTab } from './quiz-tab';

export const PROMOTION_TABS = ['data', 'whatsapp', 'quiz', 'prizes'] as const;
export type PromotionTab = (typeof PROMOTION_TABS)[number];

const TAB_LABELS: Record<PromotionTab, string> = {
  data: 'Promotion',
  whatsapp: 'WhatsApp',
  quiz: 'Quiz',
  prizes: 'Prizes',
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
}

const INITIAL_SAVE: PromotionFormState = { status: 'idle' };

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
  timeZone,
  powers,
  onTab,
  onClose,
  onSaved,
  onLoaded,
}: {
  recordId: string | null;
  tab: PromotionTab;
  timeZone: string;
  powers: PromotionRecordPowers;
  onTab: (tab: PromotionTab) => void;
  onClose: () => void;
  /** Called with the id whose row the grid should patch from its own next read. */
  onSaved: (promotionId: string) => void;
  /** Every successful read, which is how a promotion registered a moment ago gets its row. */
  onLoaded?: (record: PromotionDetail) => void;
}) {
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

  useEffect(() => {
    if (!recordId) {
      setRecord(null);
      setFailure(null);
      setDirty(false);
      return;
    }
    let current = true;
    setLoading(true);
    setFailure(null);
    void getPromotionRecordAction(recordId).then((result) => {
      if (!current) return;
      setLoading(false);
      if (result.status === 'ok') {
        setRecord(result.record);
        setWhatsappEnabled(result.record.whatsappEnabled);
        setRepeats(result.record.allowMultipleEntries);
        onLoaded?.(result.record);
        return;
      }
      setRecord(null);
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
    // the record re-read whenever the grid re-renders its callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, reloadToken]);

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
                Registered {formatInstant(record.createdAt, timeZone)}
              </span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={requestClose}
          aria-label="Close record"
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      {record && (
        <div role="tablist" aria-label="Record sections" className="flex gap-1 border-b px-5">
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
        {loading && <p className="text-sm text-muted-foreground">Loading the record…</p>}

        {failure && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{failure}</p>
            <Button type="button" variant="outline" onClick={refresh}>
              Try again
            </Button>
          </div>
        )}

        {record && (
          <>
            {record.cancelledAt && (
              <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                Cancelled {formatInstant(record.cancelledAt, timeZone)}
                {record.cancellationReason ? ` — ${record.cancellationReason}` : ''}
              </p>
            )}
            {record.deletedAt && (
              <p className="mb-4 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                Archived {formatInstant(record.deletedAt, timeZone)}. You can see this because you
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

            {saveState.status === 'error' && (
              <p className="mt-4 text-sm text-destructive" data-testid="promotion-save-error">
                {saveState.message}
              </p>
            )}
            {saveState.status === 'saved' && !dirty && (
              <p className="mt-4 text-sm text-emerald-700" data-testid="promotion-saved">
                Saved.
              </p>
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
                You do not hold promotions.edit at this Station, so this promotion can be read here
                but not changed.
              </p>
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
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
