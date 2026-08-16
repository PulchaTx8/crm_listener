'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import type { PromotionQuestion, PromotionQuestionKind } from '@/services/promotions';
import {
  removePromotionQuestionAction,
  savePromotionQuestionAction,
  type QuestionFormState,
} from './actions';
import { QUESTION_KIND_HINT_KEYS, QUESTION_KIND_LABEL_KEYS } from './format';

const INITIAL: QuestionFormState = { status: 'idle' };
/**
 * The two kinds the operator may choose, by the owner's ruling of 2026-08-11:
 * a Quiz, where the listener picks from alternatives, and an Enquete, where
 * they write an answer.
 *
 * MULTIPLE_CHOICE IS DEPRECATED RATHER THAN DELETED, and the distinction is the
 * whole of this list. Postgres cannot drop an enum value, and the hosted
 * database has a live question of that kind — so removing it here would leave a
 * real question no screen could save. It is offered only when the question
 * being edited already IS one, which lets the operator finish or change it and
 * never create another.
 */
const KINDS: PromotionQuestionKind[] = ['QUIZ', 'ESSAY'];

function kindsFor(current: PromotionQuestionKind | undefined): PromotionQuestionKind[] {
  return current === 'MULTIPLE_CHOICE' ? ['QUIZ', 'MULTIPLE_CHOICE', 'ESSAY'] : KINDS;
}

interface DraftOption {
  label: string;
  isCorrect: boolean;
}

/**
 * The quiz. Each question is written in ONE call with its options, because they
 * are one form: splitting them would let a question exist for an instant with
 * no options, or still carrying the previous version's.
 *
 * Every write here calls `onSaved`, which re-reads this one record. That is not
 * a hole in the rule this block rests on: the prohibition is on re-running the
 * LIST, not on reading one record again, and nothing about the screen behind
 * the dialog is re-rendered.
 */
export function QuizTab({
  promotionId,
  questions,
  canEdit,
  frozen,
  onSaved,
}: {
  promotionId: string;
  questions: PromotionQuestion[];
  canEdit: boolean;
  /**
   * Block 24. Whether this promotion has anybody in it, which is exactly when
   * `save_promotion_question` refuses to replace a question (0055): rewording an
   * option would leave every answer pointing at text the person never read.
   *
   * A COURTESY, never the boundary — the RPC refuses regardless. What it buys is
   * that the tab stops offering an edit the database will reject, and still
   * offers the one field the freeze does not cover: the moderation guidelines,
   * which have their own door precisely because their only useful moment is
   * after the first participation.
   */
  frozen: boolean;
  onSaved: () => void;
}) {
  const t = useTranslations('promotions');
  const [editing, setEditing] = useState<PromotionQuestion | 'new' | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      {questions.length === 0 && !editing && (
        <p className="text-sm text-muted-foreground">
          {t('thisPromotionHasNoQuizA')}</p>
      )}

      <ul className="flex flex-col gap-2">
        {questions.map((question) => (
          <li key={question.id} className="rounded-md border p-3" data-testid="quiz-question">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{question.prompt}</span>
                <span className="text-xs text-muted-foreground">
                  {question.position}. {t(QUESTION_KIND_LABEL_KEYS[question.kind])}
                </span>
                {question.options.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                    {question.options.map((option) => (
                      <li key={option.id}>
                        {option.label}
                        {option.isCorrect && (
                          <span className="ml-1 font-medium text-success">· right answer</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {/* Block 24. On the card rather than only inside the form, so
                    somebody about to go and read three hundred answers can see
                    the guidance without opening an editor first. Marked as
                    internal in the copy, because it sits in a list where
                    everything else IS shown to a listener. */}
                {question.moderationGuidelines && (
                  <p
                    className="mt-2 whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground"
                    data-testid="quiz-guidelines"
                  >
                    <span className="font-medium">{t('moderationGuidelines')}</span>{' '}
                    {question.moderationGuidelines}
                  </p>
                )}
              </div>
              {canEdit && (
                <div className="flex shrink-0 gap-1">
                  <Button type="button" variant="outline" onClick={() => setEditing(question)}>
                    {t('edit')}</Button>
                  {/* NOT OFFERED once anybody has entered. remove_promotion_question
                      is refused then (Block 4c), and the refusal reaches the
                      operator as a SQL sentence in every locale — the screen does
                      not offer what the database will refuse. */}
                  {!frozen && (
                    <RemoveQuestionButton questionId={question.id} onRemoved={onSaved} />
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {canEdit && !editing && (
        <div>
          <Button type="button" variant="outline" onClick={() => setEditing('new')} data-testid="quiz-add">
            <Plus className="mr-1 size-4" aria-hidden="true" />
            {t('addAQuestion')}</Button>
        </div>
      )}

      {/* The one thing a save can report while still having saved: the question
          landed and its guidelines did not (actions.ts says why that is `saved`
          rather than an error). Rendered here rather than in the form, because
          the form has closed by the time anybody could read it. */}
      {warning && (
        <p className="text-sm text-warning" data-testid="quiz-warning">
          {warning}
        </p>
      )}

      {editing && (
        <QuestionForm
          promotionId={promotionId}
          question={editing === 'new' ? null : editing}
          // A NEW question is never frozen out. 0055's freeze is on the REPLACE
          // branch alone — "appending a new question stays open", in that
          // migration's own words, because a question nobody has been asked
          // cannot invalidate an answer nobody gave.
          frozen={frozen && editing !== 'new'}
          onCancel={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setWarning(message ?? null);
            onSaved();
          }}
        />
      )}

      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          {t('youDoNotHoldPromotionsEdit2')}</p>
      )}
    </div>
  );
}

function RemoveQuestionButton({
  questionId,
  onRemoved,
}: {
  questionId: string;
  onRemoved: () => void;
}) {
  const t = useTranslations('promotions');
  const [state, action, pending] = useActionState(removePromotionQuestionAction, INITIAL);

  useEffect(() => {
    if (state.status === 'saved') onRemoved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action}>
      <input type="hidden" name="questionId" value={questionId} />
      <Button
        type="submit"
        variant="outline"
        disabled={pending}
        aria-label={t('removeThisQuestion')}
        data-testid="quiz-remove"
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>
      {state.status === 'error' && (
        <span className="ml-2 text-xs text-destructive">{state.message}</span>
      )}
    </form>
  );
}

function QuestionForm({
  promotionId,
  question,
  frozen,
  onCancel,
  onSaved,
}: {
  promotionId: string;
  question: PromotionQuestion | null;
  /**
   * An existing question on a promotion somebody has already entered. Everything
   * about the question itself is then unwritable — `save_promotion_question`'s
   * REPLACE branch is refused with 22023 (`0055`) — and exactly one field is
   * not: the moderation guidelines, whose own door was built outside that freeze
   * because reading answers is the only reason the field exists.
   *
   * So this form has two shapes rather than one form with disabled inputs. A
   * disabled input still sits there looking like something the operator failed
   * to fill in; read-only text with a sentence above it says what is actually
   * true.
   */
  frozen: boolean;
  onCancel: () => void;
  onSaved: (warning?: string) => void;
}) {
  const t = useTranslations('promotions');
  const [state, action, pending] = useActionState(savePromotionQuestionAction, INITIAL);
  // A new question starts as a Quiz, which is the kind this product exists for.
  // It used to default to MULTIPLE_CHOICE, a kind the operator can no longer
  // choose at all.
  const [kind, setKind] = useState<PromotionQuestionKind>(question?.kind ?? 'QUIZ');
  const kinds = kindsFor(question?.kind);
  const [options, setOptions] = useState<DraftOption[]>(
    question?.options.map((o) => ({ label: o.label, isCorrect: o.isCorrect })) ?? [
      { label: '', isCorrect: false },
      { label: '', isCorrect: false },
    ],
  );

  useEffect(() => {
    if (state.status === 'saved') onSaved(state.message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const isEssay = kind === 'ESSAY';

  if (frozen && question) {
    return (
      <FrozenQuestionForm
        question={question}
        promotionId={promotionId}
        action={action}
        pending={pending}
        error={state.status === 'error' ? (state.message ?? null) : null}
        onCancel={onCancel}
      />
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4 rounded-md border p-4" data-testid="quiz-form">
      <input type="hidden" name="promotionId" value={promotionId} />
      {question && <input type="hidden" name="questionId" value={question.id} />}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('kind')}</span>
        <Select
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as PromotionQuestionKind)}
          data-testid="quiz-kind"
        >
          {kinds.map((value) => (
            <option key={value} value={value}>
              {t(QUESTION_KIND_LABEL_KEYS[value])}
            </option>
          ))}
        </Select>
        <span className="text-xs text-muted-foreground">{t(QUESTION_KIND_HINT_KEYS[kind])}</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('question')}</span>
        <Input
          name="prompt"
          defaultValue={question?.prompt ?? ''}
          maxLength={300}
          required
          data-testid="quiz-prompt"
        />
      </label>

      {/* THE MENU TITLE AND THE BUTTON LABEL ARE GONE FROM THIS FORM, and they
          are still written (Block 24, D3). They are the two halves of the
          WhatsApp list message; promotion_questions_list_fields (0041) requires
          both on a QUIZ, and questionOutbound throws without them. So
          savePromotionQuestion supplies DEFAULT_QUESTION_MENU_TITLE and
          DEFAULT_QUESTION_BUTTON_LABEL at the door — the operator simply stopped
          inventing a menu title for every question they write. */}
      {!isEssay && (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm text-muted-foreground">{t('options')}</legend>
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  name="optionLabel"
                  value={option.label}
                  onChange={(e) =>
                    setOptions((current) =>
                      current.map((o, i) => (i === index ? { ...o, label: e.target.value } : o)),
                    )
                  }
                  maxLength={24}
                  placeholder={t('optionNumber', { number: index + 1 })}
                  data-testid="quiz-option-label"
                />
                {/* The value is the INDEX, not a boolean per row: an unticked
                    checkbox posts nothing at all, so a per-row boolean would
                    put the two lists out of step the moment any option was
                    left unmarked. */}
                {kind === 'QUIZ' && (
                  <label className="flex shrink-0 items-center gap-1 text-xs">
                    <input
                      type="radio"
                      name="optionCorrect"
                      value={index}
                      checked={option.isCorrect}
                      onChange={() =>
                        setOptions((current) =>
                          current.map((o, i) => ({ ...o, isCorrect: i === index })),
                        )
                      }
                      data-testid="quiz-option-correct"
                    />
                    {t('right')}</label>
                )}
                {options.length > 2 && (
                  <button
                    type="button"
                    aria-label={t('removeOption', { number: index + 1 })}
                    onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                    className="rounded-md p-1.5 hover:bg-accent"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOptions((current) => [...current, { label: '', isCorrect: false }])}
                data-testid="quiz-option-add"
              >
                {t('addAnOption')}</Button>
            </div>
          </fieldset>
        </>
      )}

      {/* A POLL ALONE, because a Quiz has a right answer rather than a
          judgement call — promotion_questions_guidelines_shape (0197) says the
          same in SQL, and its sibling trigger retires the text if the operator
          turns this question into a Quiz.

          Rendered inside this branch rather than always-and-disabled: the field
          is unmounted for a Quiz, so it posts nothing at all, which is what
          keeps a kind switch from carrying an ESSAY's guidance into a QUIZ
          submission. */}
      {isEssay && <ModerationGuidelinesField defaultValue={question?.moderationGuidelines ?? ''} />}

      {state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="quiz-error">
          {state.message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}</Button>
        <Button type="submit" disabled={pending} data-testid="quiz-save">
          {pending ? t('saving') : t('saveQuestion')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The internal half of a Poll question (Block 24, item 5).
 *
 * Its own component because BOTH shapes of the form render it — the ordinary one
 * above and the frozen one below — and a second copy of the label and the hint
 * is how the two come to describe the field differently.
 */
function ModerationGuidelinesField({ defaultValue }: { defaultValue: string }) {
  const t = useTranslations('promotions');
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{t('moderationGuidelines')}</span>
      <textarea
        name="moderationGuidelines"
        defaultValue={defaultValue}
        rows={4}
        maxLength={4000}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        data-testid="quiz-guidelines-input"
      />
      {/* The hint carries the guarantee, not just a description of it: this text
          is on no path to a listener (0197's header lists the four it is absent
          from), and an operator who believes otherwise will write it as though
          the audience were reading. */}
      <span className="text-xs text-muted-foreground">{t('internalOnlyNeverSentToThe')}</span>
    </label>
  );
}

/**
 * What is left of the question form once somebody has entered the promotion.
 *
 * `0055` refuses to replace a question then, so every field but one is shown as
 * text rather than as an input the operator would fill in and be refused. The
 * one that stays writable is the moderation guidelines, and that is not an
 * exception carved out of the freeze — it is `set_question_moderation_guidelines`
 * (`0197`) being a different door with a different reason, built precisely
 * because reading answers only happens after the first participation.
 */
function FrozenQuestionForm({
  question,
  promotionId,
  action,
  pending,
  error,
  onCancel,
}: {
  question: PromotionQuestion;
  promotionId: string;
  action: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  const t = useTranslations('promotions');
  const isEssay = question.kind === 'ESSAY';

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-md border p-4"
      data-testid="quiz-form-frozen"
    >
      <input type="hidden" name="promotionId" value={promotionId} />
      <input type="hidden" name="questionId" value={question.id} />
      {/* What tells the action to call the second door alone. Trusted only in
          the direction that narrows what is written — see its comment there. */}
      <input type="hidden" name="guidelinesOnly" value="on" />

      <p className="text-sm text-muted-foreground" data-testid="quiz-frozen-note">
        {t('someoneHasAlreadyEnteredThisPromotion')}
      </p>

      <div className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('question')}</span>
        <p className="font-medium">{question.prompt}</p>
        <span className="text-xs text-muted-foreground">
          {t(QUESTION_KIND_LABEL_KEYS[question.kind])}
        </span>
      </div>

      {question.options.length > 0 && (
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('options')}</span>
          <ul className="flex flex-col gap-0.5 text-sm">
            {question.options.map((option) => (
              <li key={option.id}>
                {option.label}
                {option.isCorrect && (
                  <span className="ml-1 text-xs font-medium text-success">· right answer</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isEssay && (
        <ModerationGuidelinesField defaultValue={question.moderationGuidelines ?? ''} />
      )}

      {error && (
        <p className="text-sm text-destructive" data-testid="quiz-error">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {isEssay ? t('cancel') : t('close')}
        </Button>
        {/* A Quiz question on a frozen promotion has nothing writable at all, so
            there is no Save to offer. The window is then a legible view of the
            question, which is a useful thing rather than a broken one — the same
            argument AttendDialog makes for opening without the permission to
            act. */}
        {isEssay && (
          <Button type="submit" disabled={pending} data-testid="quiz-guidelines-save">
            {pending ? t('saving') : t('saveGuidelines')}
          </Button>
        )}
      </div>
    </form>
  );
}
