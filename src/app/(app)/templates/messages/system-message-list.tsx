'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import type { SystemMessageKey } from '@/lib/conversation/engine';
import type { SystemMessageRow } from '@/services/templates';
import { formatInstant } from '../../promotions/format';
import {
  clearSystemMessageAction,
  saveSystemMessageAction,
  type SystemMessageState,
} from './actions';

const INITIAL: SystemMessageState = { status: 'idle' };

/**
 * The eight field prompts differ only in the field they ask for, and they are
 * asked under exactly one condition: the promotion requested that field. Said
 * once here rather than eight times below, so the eight cannot drift into
 * eight subtly different explanations of the same rule.
 */
function fieldWhen(field: string): string {
  return `Asked while a promotion collects entries, and only when that promotion requests the ${field}.`;
}

/**
 * What each of the ten texts is, in the operator's language.
 *
 * TOTAL over `SystemMessageKey`, which is the generated `system_message_key`
 * enum — so an eleventh key added to 0109 fails to compile HERE rather than
 * rendering on screen as a bare `DISCOVERY_SOURCE` nobody can interpret. The
 * same reason FIELD_PROMPTS and FIELD_MESSAGE_KEYS are total in engine.ts.
 *
 * English, like every operator-facing string in this codebase. The BODIES are
 * Portuguese and stay Portuguese: they are what a listener reads, which is the
 * one exception this block exists for.
 */
const MESSAGE_LABELS: Record<SystemMessageKey, { title: string; when: string }> = {
  REFUSAL: {
    title: 'Declining an invitation',
    when: 'Sent when a listener presses the “no” button on a promotion invitation. The conversation ends there and nothing is entered.',
  },
  ABANDON: {
    title: 'Giving up on a conversation',
    when: 'Sent after three unusable answers to the same question. The conversation ends and the listener is told they can start again.',
  },
  FULL_NAME: { title: 'Asking for the full name', when: fieldWhen('full name') },
  ADDRESS: { title: 'Asking for the address', when: fieldWhen('street address') },
  CITY: { title: 'Asking for the city', when: fieldWhen('city') },
  NEIGHBOURHOOD: { title: 'Asking for the neighbourhood', when: fieldWhen('neighbourhood') },
  AGE: { title: 'Asking for the date of birth', when: fieldWhen('date of birth') },
  CPF: { title: 'Asking for the CPF', when: fieldWhen('CPF') },
  PASSPORT: { title: 'Asking for the passport number', when: fieldWhen('passport number') },
  DISCOVERY_SOURCE: {
    title: 'Asking how they found the Station',
    when: fieldWhen('discovery source'),
  },
};

/**
 * The ten texts, whether this Station has overridden them or not.
 *
 * TEN ROWS ALWAYS — `listSystemMessages` builds them from the defaults and
 * fills in what was overridden, so a brand-new Station sees ten editable texts
 * rather than an empty page. Rendering the query's rows alone would be the
 * all-or-nothing misreading of D2 that resolveSystemMessage's own test exists
 * to catch: an absent row is a text at its default, not a text that is missing.
 *
 * The forms render only when `manage` — a courtesy, not the boundary:
 * set_station_message_template and clear_station_message_template (0113) each
 * re-check templates.manage themselves before writing anything, so a
 * permission revoked after this page loaded is still refused where it matters.
 */
export function SystemMessageList({
  rows,
  companyId,
  timeZone,
  manage,
}: {
  rows: SystemMessageRow[];
  companyId: string;
  /** The Station's own zone — `updatedAt` is rendered there, never the reader's (spec L2). */
  timeZone: string;
  /** Whether the caller holds templates.manage at this Station. */
  manage: boolean;
}) {
  return (
    <ul className="flex flex-col gap-4" data-testid="system-message-list">
      {rows.map((row) => (
        <li key={row.key}>
          <MessageRow row={row} companyId={companyId} timeZone={timeZone} manage={manage} />
        </li>
      ))}
    </ul>
  );
}

function MessageRow({
  row,
  companyId,
  timeZone,
  manage,
}: {
  row: SystemMessageRow;
  companyId: string;
  timeZone: string;
  manage: boolean;
}) {
  const t = useTranslations('templates');
  const [saveState, saveAction, savePending] = useActionState(saveSystemMessageAction, INITIAL);
  const [clearState, clearAction, clearPending] = useActionState(clearSystemMessageAction, INITIAL);
  const label = MESSAGE_LABELS[row.key];

  // Two forms, two states, and the newest error wins. Both cannot be pending
  // at once — a save and a clear on the same row are a single operator's two
  // consecutive decisions — so this is about which message is still on screen
  // after one of them failed, not about a race.
  const error =
    (clearState.status === 'error' && clearState.message) ||
    (saveState.status === 'error' && saveState.message) ||
    null;

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border bg-card p-4"
      data-testid={`system-message-${row.key}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">{label.title}</h2>
          <p className="text-xs text-muted-foreground">{label.when}</p>
        </div>
        <SourceBadge overridden={row.overridden} />
      </div>

      {manage ? (
        <form action={saveAction} className="flex flex-col gap-2">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="key" value={row.key} />
          {/*
            Keyed on the body that came back from the database, not on the key
            (the <li> one level up already is): this remounts the uncontrolled
            textarea only once a save has actually landed and the fresh value
            has been re-read. A FAILED save leaves the database — and therefore
            `row.body` — untouched, so the key does not change and the
            operator's just-typed text stays on screen beside the error saying
            why it was not saved. ReferencePanel's own name input does this for
            the same reason.
          */}
          <Textarea
            key={row.body}
            name="body"
            defaultValue={row.body}
            required
            maxLength={4096}
            rows={3}
            aria-label={label.title}
            data-testid={`system-message-body-${row.key}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={savePending || clearPending}>
              {savePending ? t('saving') : t('save')}
            </Button>
            {/*
              A real button with its own action, never an empty save (spec §5).
              Rendered only when there is something to clear: a text already at
              the default has no override to remove, and 0113's door answers
              P0002 to the attempt.
            */}
            {row.overridden && (
              <Button
                type="submit"
                size="sm"
                variant="outline"
                form={`clear-${row.key}`}
                disabled={savePending || clearPending}
                data-testid={`system-message-clear-${row.key}`}
              >
                {clearPending ? t('restoring') : t('restoreTheDefault')}
              </Button>
            )}
          </div>
        </form>
      ) : (
        <p className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">{row.body}</p>
      )}

      {/*
        Outside the save form, because a <form> cannot be nested inside another
        one — the Restore button above reaches it by id instead. Rendered
        whenever the row is overridden, so the button always has its form.
      */}
      {manage && row.overridden && (
        <form id={`clear-${row.key}`} action={clearAction} className="hidden">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="key" value={row.key} />
        </form>
      )}

      {/*
        THE DEFAULT, VISIBLE WHILE OVERRIDING (spec §5). Shown to anyone who can
        edit, whether this text is overridden yet or not: somebody typing over
        the default loses sight of it the moment they start, and "what am I
        replacing?" is the question this screen has to be able to answer without
        a deploy to look at. A read-only viewer sees it only when it differs
        from what is on screen above, where printing it twice would say nothing.
      */}
      {(manage || row.overridden) && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('systemDefault')}</span>
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{row.defaultBody}</p>
        </div>
      )}

      {row.overridden && row.updatedAt && (
        <p className="text-xs text-muted-foreground">
          {t('changed')}{' '}{formatInstant(row.updatedAt, timeZone)}
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function SourceBadge({ overridden }: { overridden: boolean }) {
  const t = useTranslations('templates');
  return overridden ? (
    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      {t('thisStationSOwnWording')}</span>
  ) : (
    <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {t('systemDefault')}</span>
  );
}
