'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  answersFor,
  decideAutoOpen,
  type WidgetOption,
  type WidgetPromotion,
  type WidgetStep,
} from '@/lib/widget/promotion-mapping';
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
  autoOpenId,
}: {
  publicKey: string;
  onClose: () => void;
  /**
   * Block 19a, Task 7. A promotion id `?open=promotion&id=…` named, already
   * checked for SHAPE by `parseOpenTarget` — never for whether this listener
   * may see it. That second check happens below, against the same list this
   * panel fetches to draw itself, because it is the only list this listener
   * is entitled to and asking a second door the same question would be a
   * second place for the two to disagree.
   */
  autoOpenId?: string;
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
   * `autoOpenId`, ACTED ON ONCE. `list` moves from `loading` to a settled
   * status exactly once per mount (the effect above never re-fetches after
   * its first call), so a ref guards against this effect firing again on a
   * render the settled state alone would not have caused — `onClose` is a
   * fresh closure every render of the parent, and listing it as a dependency
   * without the guard would attempt the decision a second time.
   *
   * THE DECISION ITSELF IS `decideAutoOpen` (promotion-mapping.ts), not
   * written out here, so it is one function a test can call rather than a
   * branch only a browser exercises. Its three outcomes:
   *   - `open` — set as `chosen`, exactly what clicking the list entry does;
   *   - `show-list` — an ALREADY-ENTERED match. Do nothing: `chosen` stays
   *     null, and the fall-through render below already shows this exact
   *     promotion, disabled, with `alreadyEntered` on screen — which answers
   *     what the listener's link was actually about, unlike the bare
   *     two-button menu this used to fall back to (fix round 1);
   *   - `back-to-menu` — no promotion in this listener's own list carries
   *     this id at all. `onClose` is the same fallback a click on "Back"
   *     gives, because a bad `open` is never an error here.
   * A list that never reached `ready` (refused, or still loading when the
   * guard fires) cannot be searched at all, and is folded into the same
   * `back-to-menu` fallback: a promotion this code could not confirm is
   * visible is not one it can open.
   */
  const autoOpenAttempted = useRef(false);
  useEffect(() => {
    if (!autoOpenId || autoOpenAttempted.current) return;
    if (list.status === 'loading') return;
    autoOpenAttempted.current = true;

    if (list.status === 'ready') {
      const decision = decideAutoOpen(list.promotions, autoOpenId);
      if (decision.action === 'open') {
        setChosen(decision.promotion);
        setScreen(0);
        return;
      }
      if (decision.action === 'show-list') return;
    }

    onClose();
  }, [autoOpenId, list, onClose]);

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
      <Shell title={chosen.name} onClose={() => setChosen(null)} closeLabel={t('otherPromotions')}>
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
            value={JSON.stringify(answersFor(chosen.steps, answers))}
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

          {current[0]?.kind === 'question' ? <Question
            step={current[0]}
            options={chosen.options[current[0].questionId] ?? []}
            value={answers[current[0].questionId] ?? ''}
            onChange={(next) => {
              const id = current[0]?.kind === 'question' ? current[0].questionId : '';
              setAnswers((a) => ({ ...a, [id]: next }));
            }}
          /> : null}

          {/* Only on the screen that submits. A refusal shown while the
              listener walks back through earlier steps reads as if each of
              them were wrong, which is how the same red line ended up under
              the rules AND under the address on 2026-08-11. */}
          {state.status === 'refused' && last ? (
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

/**
 * One question, drawn by its KIND.
 *
 * A TEXT BOX FOR EVERY KIND WAS THE FIRST VERSION AND IT REACHED PRODUCTION.
 * participation_answers_shape (0052) requires `option_id` with a null
 * `answer_text` for a question with alternatives and exactly the opposite for
 * an open one — so a listener typing prose into a quiz tripped a CHECK deep
 * inside apply_participation and read "something went wrong".
 *
 * A question with alternatives and NO options is drawn as nothing rather than
 * as a text box. It cannot happen — the door sends the options — and if it does,
 * an empty screen followed by the door's own refusal is better than a box whose
 * every answer is rejected.
 */
function Question({
  step,
  options,
  value,
  onChange,
}: {
  step: Extract<WidgetStep, { kind: 'question' }>;
  options: WidgetOption[];
  value: string;
  onChange: (next: string) => void;
}) {
  const t = useTranslations('widget');

  if (step.questionKind === 'ESSAY') {
    return (
      <label className="flex flex-col gap-1 text-sm">
        {t('yourAnswer')}
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={2000}
          className="rounded-md border bg-background p-2 text-sm"
          data-testid="widget-promotion-answer"
        />
      </label>
    );
  }

  return (
    <fieldset className="flex flex-col gap-2" data-testid="widget-promotion-options">
      <legend className="text-sm">{t('chooseOne')}</legend>
      {options.map((option) => (
        <label key={option.id} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="option"
            value={option.id}
            checked={value === option.id}
            onChange={() => onChange(option.id)}
            className="h-4 w-4 border-input"
            data-testid={`widget-promotion-option-${option.id}`}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function Shell({
  title,
  onClose,
  closeLabel,
  children,
}: {
  title: string;
  onClose: () => void;
  /**
   * What the panel's own way out is called. Named by the caller because inside
   * a walk it leaves the promotion rather than the step, and two buttons both
   * saying "Back" — one meaning the previous screen, one meaning the list —
   * is what a listener saw on 2026-08-11.
   */
  closeLabel?: string;
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
        {closeLabel ?? t('back')}
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
