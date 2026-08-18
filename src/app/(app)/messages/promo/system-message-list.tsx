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
 * once here rather than nine times below, so the nine cannot drift into
 * nine subtly different explanations of the same rule.
 */
// The field is a catalogue key rather than the noun itself: Portuguese and
// Spanish carry the article with it (*o CPF*, *a cidade*), which no English
// stem can supply.
function fieldWhen(fieldKey: string, t: (key: string, values?: Record<string, string>) => string): string {
  return t('fieldWhen', { field: t(fieldKey) });
}

/**
 * What each of the fourteen texts is, in the operator's language. Ten field
 * and conversation prompts from 0109, the three Block 19a added (LINK_MUSIC,
 * LINK_MENU, LINK_PROMOTION) — the words in front of the link a matched
 * hashtag now sends — and Block 28's COUNTRY.
 *
 * TOTAL over `SystemMessageKey`, which is the generated `system_message_key`
 * enum — so a fifteenth key fails to compile HERE rather than rendering on
 * screen as a bare key nobody can interpret. The same reason FIELD_PROMPTS
 * and FIELD_MESSAGE_KEYS are total in engine.ts, and COUNTRY is the value that
 * collected on all three promises at once.
 *
 * English, like every operator-facing string in this codebase. The BODIES are
 * Portuguese and stay Portuguese: they are what a listener reads, which is the
 * one exception this block exists for.
 */
function messageLabels(
  t: (key: string, values?: Record<string, string>) => string,
): Record<SystemMessageKey, { title: string; when: string }> {
  return {
    REFUSAL: { title: t('messageRefusalTitle'), when: t('messageRefusalWhen') },
    ABANDON: { title: t('messageAbandonTitle'), when: t('messageAbandonWhen') },
    FULL_NAME: { title: t('messageFullNameTitle'), when: fieldWhen('fieldFullName', t) },
    ADDRESS: { title: t('messageAddressTitle'), when: fieldWhen('fieldStreetAddress', t) },
    CITY: { title: t('messageCityTitle'), when: fieldWhen('fieldCity', t) },
    NEIGHBOURHOOD: {
      title: t('messageNeighbourhoodTitle'),
      when: fieldWhen('fieldNeighbourhood', t),
    },
    AGE: { title: t('messageAgeTitle'), when: fieldWhen('fieldDateOfBirth', t) },
    // The gender block, and the only card here whose text is not the whole of
    // what a listener sees: this one field goes out with three reply buttons
    // (FIELD_SHAPE, lib/conversation/steps.ts), and a Station may reword the
    // question but not the three answers. `messageGenderWhen` says so on the
    // card rather than leaving an operator to discover it by editing the body
    // and finding the buttons unchanged.
    GENDER: { title: t('messageGenderTitle'), when: t('messageGenderWhen') },
    CPF: { title: t('messageCpfTitle'), when: fieldWhen('fieldCpf', t) },
    PASSPORT: { title: t('messagePassportTitle'), when: fieldWhen('fieldPassportNumber', t) },
    DISCOVERY_SOURCE: {
      title: t('messageDiscoverySourceTitle'),
      when: fieldWhen('fieldDiscoverySource', t),
    },
    COUNTRY: { title: t('messageCountryTitle'), when: fieldWhen('fieldCountry', t) },
    LINK_MUSIC: { title: t('messageLinkMusicTitle'), when: t('messageLinkMusicWhen') },
    LINK_MENU: { title: t('messageLinkMenuTitle'), when: t('messageLinkMenuWhen') },
    LINK_PROMOTION: { title: t('messageLinkPromotionTitle'), when: t('messageLinkPromotionWhen') },
    MARKETING_CONSENT: { title: t('messageMarketingConsentTitle'), when: t('messageMarketingConsentWhen') },
    MARKETING_STOPPED: { title: t('messageMarketingStoppedTitle'), when: t('messageMarketingStoppedWhen') },
  };
}

/**
 * The fourteen texts, whether this Station has overridden them or not.
 *
 * ALL FOURTEEN ROWS ALWAYS — `listSystemMessages` builds them from the
 * defaults and fills in what was overridden, so a brand-new Station sees
 * every text editable rather than an empty page. Rendering the query's rows
 * alone would be the
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
  const label = messageLabels(t)[row.key];

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
