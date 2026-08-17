'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  answersFor,
  decideAutoOpen,
  firstUnansweredScreen,
  screensFor,
  type WidgetOption,
  type WidgetPromotion,
  type WidgetStep,
} from '@/lib/widget/promotion-mapping';
// The gender block. The SHAPE of a field and the values its one closed set may
// hold, shared with the WhatsApp engine rather than restated here — see
// FIELD_SHAPE's own comment for why they live in the conversation vocabulary
// even though this is a browser bundle. Both are plain data; nothing in that
// module reaches a database, a network or a clock.
import { fieldShapeOf, GENDER_VALUES } from '@/lib/conversation/steps';
import { signOutAction } from './actions';
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
   * The step list collapsed into screens — `screensFor` (promotion-mapping.ts),
   * shared with `firstUnansweredScreen` so the two cannot disagree about what
   * a screen index means. Derived rather than stored, so a promotion chosen
   * twice cannot leave a stale screen count behind.
   */
  const screens = useMemo(() => (chosen ? screensFor(chosen.steps) : []), [chosen]);

  /**
   * Which screen a `missing_answers` refusal was shown on, so the message can
   * follow the listener there.
   *
   * The message is otherwise gated on `last` — because a refusal rendered
   * under every screen the listener walks back through reads as if each of
   * them were wrong, which is what happened on 2026-08-11. Moving the listener
   * without moving the message would land them on a silent screen; this is the
   * one screen other than the last where it has something to say.
   */
  const [flagged, setFlagged] = useState<number | null>(null);

  /**
   * Which promotion `state`'s most recent refusal actually belongs to.
   *
   * `state` COMES FROM `useActionState`, and nothing outside that hook's own
   * reducer can reset it — the same fact `handledRefusal` below already lives
   * with. So a refusal from promotion A is still sitting in `state` after the
   * listener leaves it, and Block 20a's earlier consent fix (resetting
   * `consent`/`fields`/`answers`/`flagged` when a different promotion is
   * chosen) does not touch it either, because it CANNOT: there is no
   * `setState` to call.
   *
   * THIS IS WHAT MAKES THAT SURVIVAL VISIBLE ANYWAY. Found in the same
   * whole-branch review as the consent defect, one step further in: the
   * message below is gated on `state.status === 'refused' && (last || screen
   * === flagged)`, and `last` depends only on the CHOSEN PROMOTION'S OWN
   * screen count — nothing the earlier fix resets. A promotion asking for
   * nothing but consent has exactly one screen, so `last` is true on that
   * screen's very first render, before the listener has touched anything on
   * it. Without this guard, choosing such a promotion right after a refusal
   * on a different one would show "Faltou alguma coisa. Volte e confira suas
   * respostas." under rules the listener has not even finished reading — the
   * precise shape of refusal-nobody-earned this whole block exists to close,
   * reopened by the one piece of state that cannot be reset directly.
   *
   * RECORDED, NOT CLEARED — the same move `identify-form.tsx`'s `spentVerify`
   * makes for a verification result the visitor has abandoned: since `state`
   * itself is out of reach, the message is gated on whether it still
   * describes what is on screen, not on making the stale value disappear.
   */
  const [refusalFor, setRefusalFor] = useState<string | null>(null);

  /**
   * `state`, ACTED ON ONCE — the same identity guard `identify-form.tsx` uses
   * for `handledRequest`, and for the same reason. `fields` and `answers` are
   * in this effect's dependencies, so without the guard every keystroke after
   * a refusal would drag the listener back to the screen they had just left.
   */
  const [handledRefusal, setHandledRefusal] = useState<EnterState>(IDLE);
  useEffect(() => {
    if (state === handledRefusal) return;
    setHandledRefusal(state);
    if (state.status !== 'refused') return;
    setRefusalFor(chosen?.id ?? null);

    if (state.reason !== 'missing_answers') return;
    const target = firstUnansweredScreen(screens, fields, answers);
    if (target === null) return;
    setScreen(target);
    setFlagged(target);
  }, [state, handledRefusal, screens, fields, answers, chosen]);

  if (state.status === 'entered' || state.status === 'declined') {
    return (
      <Shell title={t('enterAPromotion')} onClose={onClose} publicKey={publicKey}>
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
                    {/*
                      The gender block. A CHOICE-SHAPED field is a `<select>`
                      here and three reply buttons on WhatsApp — two renderings
                      of one decision, taken from `FIELD_SHAPE`
                      (lib/conversation/steps.ts) rather than from a check on
                      the field's name in each place.

                      In a browser this costs nothing and gains everything the
                      normaliser exists to recover on the other door: a visitor
                      typing "masc" into a text box is a value `gender_normalize`
                      has to guess at, and a `<select>` cannot produce one. The
                      normaliser still runs on the way in — it is the column's
                      one gate, whichever form posted.
                    */}
                    {fieldShapeOf(step.field) === 'choice' ? (
                      <select
                        value={fields[step.field] ?? ''}
                        onChange={(e) =>
                          setFields((f) => ({ ...f, [step.field]: e.target.value }))
                        }
                        className="rounded-md border bg-background p-2 text-sm"
                        data-testid={`widget-promotion-field-${step.field}`}
                      >
                        {/* Blank first and selected by default, so the form
                            never answers on somebody's behalf. `firstUnansweredScreen`
                            already treats an empty string as unanswered. */}
                        <option value="">{t('choosePlaceholder')}</option>
                        {GENDER_VALUES.map((value) => (
                          <option key={value} value={value}>
                            {t(`field_gender_${value}`)}
                          </option>
                        ))}
                      </select>
                    ) : (
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
                    )}
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

          {/* Only on the screen that submits, AND only about the promotion
              that is actually on screen. The first half of that guard is a
              refusal shown while the listener walks back through earlier
              steps, which reads as if each of them were wrong — the same red
              line ended up under the rules AND under the address on
              2026-08-11. The second half (`refusalFor`) is a refusal from a
              DIFFERENT promotion the listener has since left; without it, a
              single-screen promotion chosen right after a refusal reads
              `last` as true immediately and shows a stale message about
              rules it has not finished displaying — see `refusalFor`'s own
              comment above. */}
          {state.status === 'refused' && refusalFor === chosen.id && (last || screen === flagged) ? (
            <p className="text-sm text-destructive" data-testid="widget-promotion-error">
              {refusalMessage(t, state.reason)}
            </p>
          ) : null}

          {/*
            THE TWO KEYS ARE LOAD-BEARING, the same defect class
            identify-form.tsx's own "THE TWO KEYS ARE LOAD-BEARING" comment
            documents for the name/code labels, and the same reasoning:
            without them a listener pressing "Next" onto the last screen
            recorded an entry.

            Both branches occupy the same slot of this ternary, so React
            reconciled them against each other rather than unmounting one and
            mounting the other — one <Button>, its `type` toggled between
            "button" and "submit" by which branch last rendered it. `onClick`
            for "Next" runs inside the click's own dispatch and React 19
            flushes a discrete-event update synchronously, so by the time the
            browser ran this SAME node's post-dispatch activation behaviour,
            `type` had already flipped to "submit" — and activation for a
            submit button submits the enclosing `<form action={submit}>`. The
            click meant to advance a screen posted the walk instead.

            On screen this read as two different failures depending on what
            the listener did next. Reaching the last screen for the first
            time posted an incomplete answer, which the door correctly
            refused with missing_answers — and that refusal, arriving after
            Block 20a's jump had nothing to move (the fields were already
            complete), is almost certainly the "Something is missing. Go back
            and check your answers." the product owner reported seeing under
            a form that had, in fact, been filled in correctly: a button that
            said "Next" was the one that submitted, and its failure read back
            as if the FORM had failed. A listener who then answered the
            question, pressed "Back", and pressed "Next" again fared worse —
            that second "Next" carried a complete answer, and the walk was
            entered without "Enter now" ever being pressed.

            Distinct keys say these are different elements, not one element
            with different props, which is exactly what they are: the button
            that submits now MOUNTS on the screen that needs it, rather than
            the button that advances MUTATING into one mid-click.
          */}
          <div className="flex gap-2">
            {last ? (
              <Button key="send" type="submit" disabled={sending} data-testid="widget-promotion-send">
                {sending ? t('sending') : t('enterNow')}
              </Button>
            ) : (
              <Button
                key="next"
                type="button"
                onClick={() => {
                  setScreen((s) => s + 1);
                  setFlagged(null);
                }}
                data-testid="widget-promotion-next"
              >
                {t('next')}
              </Button>
            )}
            {screen > 0 ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setScreen((s) => s - 1);
                  setFlagged(null);
                }}
              >
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
                    // Block 20a, whole-branch review. Block 17c's own defect:
                    // this handler set `chosen` and `screen` for the newly
                    // picked promotion and left CONSENT EXACTLY WHERE THE LAST
                    // PROMOTION'S WALK LEFT IT. A listener who ticked promotion
                    // A's agreement box, came back here through "Other
                    // promotions", and picked promotion B found B's box
                    // ALREADY TICKED — agreed to rules B never showed them.
                    // Submitting from there would write a `member_consents`
                    // row (`widget_enter_promotion`, 0171's `rules` consent)
                    // for an agreement nobody gave. `fields` and `answers`
                    // carried the same way, and a stray `flagged` screen index
                    // from A's walk could point at the wrong step of B's — none
                    // of them describe anything true about a promotion this
                    // listener has not opened yet. This is Block 17c's defect,
                    // found reading the whole branch rather than introduced by
                    // this one, and the product owner ruled it fixed here
                    // rather than deferred: a consent record is not a detail
                    // this system is willing to get wrong.
                    //
                    // `refusalFor` RESET HERE TOO, second round of the same
                    // review. `state` itself cannot be reset (see its own
                    // comment above), so this is the only place left to say
                    // "the last refusal was not about THIS promotion" —
                    // without it, a refusal from the promotion just left can
                    // still render under this one if it happens to have a
                    // single screen (`refusalFor`'s comment has the full
                    // mechanism).
                    setChosen(promotion);
                    setScreen(0);
                    setConsent(false);
                    setFields({});
                    setAnswers({});
                    setFlagged(null);
                    setRefusalFor(null);
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
  publicKey,
  closeLabel,
  children,
}: {
  title: string;
  onClose: () => void;
  /**
   * Block 19b, D6. Present only on the screen that ENDS an errand — never
   * beside a half-filled promotion form, where a button that discards the
   * session sits next to the field being typed into.
   *
   * A PUBLIC KEY, NOT A CALLBACK — Task 6, fix round 1. "Sair" is a
   * `<form action={signOutAction.bind(null, publicKey)}>`, the same shape
   * `menu.tsx` uses, and for the same reason: `signOutAction` ends in a
   * `redirect()`, which a real form submission carries through cleanly, and
   * a callback threaded down from a parent's client state cannot.
   */
  publicKey?: string;
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
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {closeLabel ?? t('back')}
        </Button>
        {publicKey ? (
          <form action={signOutAction.bind(null, publicKey)}>
            <Button type="submit" variant="ghost" data-testid="widget-exit">
              {t('exit')}
            </Button>
          </form>
        ) : null}
      </div>
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
