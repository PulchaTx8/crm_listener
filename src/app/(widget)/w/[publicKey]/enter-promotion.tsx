'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { WidgetPromotion, WidgetStep } from '@/lib/widget/promotion-mapping';
import {
  enterPromotionAction,
  listPromotionsAction,
  type EnterState,
  type ListState,
} from './promotion-actions';

/**
 * Block 17c. The widget's second button, opened.
 *
 * THREE STATES: the list, the walk, and what happened. The walk is browser
 * state and NOTHING IS WRITTEN UNTIL THE END — which is not only simpler but
 * the only order that is correct: the first step is consent, and persisting a
 * listener's address and CPF as they typed them would collect personal data
 * ahead of the agreement that authorises collecting it.
 *
 * THE WALK IS NOT A CHAT. The step list arrives in the order the WhatsApp bot
 * asks it, one thing per message, because a conversation has no other shape. A
 * page does: consent alone, because it gates everything after it; then every
 * requested field on one screen, which is what a person filling in a form
 * expects; then one question per screen, because each carries its own options.
 */

const IDLE: EnterState = { status: 'idle' };

export function EnterPromotionPanel({
  publicKey,
  onClose,
}: {
  publicKey: string;
  onClose: () => void;
}) {
  const t = useTranslations('widget');

  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [chosen, setChosen] = useState<WidgetPromotion | null>(null);
  const [screen, setScreen] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  /**
   * Held in state rather than left to the checkbox, because THE CHECKBOX IS NOT
   * ON THE SCREEN THAT SUBMITS. It lives on the consent screen; a promotion
   * asking for fields or questions submits from a later one, where an unmounted
   * input posts nothing and the entry would arrive as a refusal the listener
   * never gave.
   */
  const [consent, setConsent] = useState(false);
  const [state, submit, sending] = useActionState(enterPromotionAction, IDLE);

  useEffect(() => {
    let live = true;
    void listPromotionsAction(publicKey).then((next) => {
      if (live) setList(next);
    });
    return () => {
      live = false;
    };
  }, [publicKey]);

  /**
   * The step list collapsed into screens. Every `field` step shares one screen;
   * everything else keeps its own. Derived rather than stored, so a promotion
   * chosen twice cannot leave a stale screen count behind.
   */
  const screens = useMemo(() => {
    if (!chosen) return [] as WidgetStep[][];
    const fieldSteps = chosen.steps.filter((s) => s.kind === 'field');
    const questions = chosen.steps.filter((s) => s.kind === 'question');
    return [
      [{ kind: 'consent' } as WidgetStep],
      ...(fieldSteps.length > 0 ? [fieldSteps] : []),
      ...questions.map((q) => [q]),
    ];
  }, [chosen]);

  if (state.status === 'entered' || state.status === 'declined') {
    return (
      <Shell title={t('enterAPromotion')} onClose={onClose}>
        <p className="text-sm" data-testid="widget-promotion-done">
          {state.status === 'entered' ? t('entryRecorded') : t('entryNotRecorded')}
        </p>
      </Shell>
    );
  }

  if (chosen) {
    const current = screens[screen] ?? [];
    const last = screen === screens.length - 1;

    return (
      <Shell title={chosen.name} onClose={() => setChosen(null)}>
        <form action={submit} className="flex flex-col gap-3">
          <input type="hidden" name="publicKey" value={publicKey} />
          <input type="hidden" name="promotionId" value={chosen.id} />
          {/* The agreement, carried to whichever screen actually submits. An
              unchecked box posts NOTHING — which is the shape the schema reads
              — so this is rendered only when the listener said yes. */}
          {consent ? <input type="hidden" name="consent" value="on" /> : null}
          <input type="hidden" name="fields" value={JSON.stringify(fields)} />
          <input
            type="hidden"
            name="answers"
            value={JSON.stringify(
              Object.entries(answers).map(([question_id, answer_text]) => ({
                question_id,
                answer_text,
              })),
            )}
          />

          {current[0]?.kind === 'consent' ? (
            <>
              {chosen.artUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={chosen.artUrl} alt="" className="w-full rounded" />
              ) : null}
              <div
                className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border p-3 text-sm"
                data-testid="widget-promotion-rules"
              >
                {chosen.rules}
              </div>
              <label className="flex items-center gap-2 text-sm">
                {/* NO `name`, deliberately: this box drives state and never
                    posts. The hidden input above is what the form carries, and
                    a second field with the same name would post twice from the
                    one screen where both exist. */}
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-input"
                  data-testid="widget-promotion-consent"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>{t('iAgreeToTheRules')}</span>
              </label>
            </>
          ) : null}

          {current[0]?.kind === 'field' ? (
            <div className="flex flex-col gap-3">
              {current.map((step) =>
                step.kind === 'field' ? (
                  <label key={step.field} className="flex flex-col gap-1 text-sm">
                    {t(`field_${step.field}`)}
                    <input
                      type="text"
                      value={fields[step.field] ?? ''}
                      onChange={(e) =>
                        setFields((f) => ({ ...f, [step.field]: e.target.value }))
                      }
                      maxLength={500}
                      className="rounded-md border bg-background p-2 text-sm"
                      data-testid={`widget-promotion-field-${step.field}`}
                    />
                  </label>
                ) : null,
              )}
            </div>
          ) : null}

          {current[0]?.kind === 'question' ? (
            <label className="flex flex-col gap-1 text-sm">
              {t('yourAnswer')}
              <input
                type="text"
                value={answers[current[0].questionId] ?? ''}
                onChange={(e) => {
                  const id = current[0]?.kind === 'question' ? current[0].questionId : '';
                  setAnswers((a) => ({ ...a, [id]: e.target.value }));
                }}
                maxLength={2000}
                className="rounded-md border bg-background p-2 text-sm"
                data-testid="widget-promotion-answer"
              />
            </label>
          ) : null}

          {state.status === 'refused' ? (
            <p className="text-sm text-destructive" data-testid="widget-promotion-error">
              {refusalMessage(t, state.reason)}
            </p>
          ) : null}

          <div className="flex gap-2">
            {last ? (
              <Button type="submit" disabled={sending} data-testid="widget-promotion-send">
                {sending ? t('sending') : t('enterNow')}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => setScreen((s) => s + 1)}
                data-testid="widget-promotion-next"
              >
                {t('next')}
              </Button>
            )}
            {screen > 0 ? (
              <Button type="button" variant="outline" onClick={() => setScreen((s) => s - 1)}>
                {t('back')}
              </Button>
            ) : null}
          </div>
        </form>
      </Shell>
    );
  }

  return (
    <Shell title={t('enterAPromotion')} onClose={onClose}>
      {list.status === 'loading' ? <p className="text-sm">{t('searching')}</p> : null}

      {list.status === 'refused' ? (
        <p className="text-sm text-destructive" data-testid="widget-promotion-error">
          {refusalMessage(t, list.reason)}
        </p>
      ) : null}

      {list.status === 'ready' ? (
        list.promotions.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="widget-promotion-none">
            {t('noPromotionsRightNow')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="widget-promotion-list">
            {list.promotions.map((promotion) => (
              <li key={promotion.id}>
                <button
                  type="button"
                  onClick={() => {
                    setChosen(promotion);
                    setScreen(0);
                  }}
                  disabled={promotion.alreadyEntered}
                  className="flex w-full items-center gap-2 rounded-md border p-2 text-left hover:bg-accent disabled:opacity-60"
                >
                  {promotion.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={promotion.thumbUrl} alt="" width={40} height={40} className="rounded" />
                  ) : null}
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{promotion.name}</span>
                    {promotion.alreadyEntered ? (
                      <span className="text-xs text-muted-foreground">{t('alreadyEntered')}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Shell>
  );
}

function Shell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations('widget');

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
      data-testid="widget-promotion-panel"
    >
      <h1 className="text-base font-semibold">{title}</h1>
      {children}
      <Button type="button" variant="ghost" onClick={onClose} className="self-start">
        {t('back')}
      </Button>
    </div>
  );
}

function refusalMessage(t: ReturnType<typeof useTranslations>, reason: string): string {
  switch (reason) {
    case 'no_session':
      return t('identifyAgain');
    case 'rate_limited':
      return t('tooManyRequests');
    case 'promotion_closed':
      return t('thisPromotionIsClosed');
    case 'already_entered':
      return t('youHaveAlreadyEntered');
    case 'missing_answers':
      return t('somethingIsMissing');
    case 'listener_anonymized':
      return t('numberCannotBeUsed');
    case 'unknown_installation':
      return t('widgetUnavailable');
    default:
      return t('somethingWentWrong');
  }
}
