'use client';

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
import { QUESTION_KIND_HINTS, QUESTION_KIND_LABELS } from './format';

const INITIAL: QuestionFormState = { status: 'idle' };
const KINDS: PromotionQuestionKind[] = ['QUIZ', 'MULTIPLE_CHOICE', 'ESSAY'];

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
  onSaved,
}: {
  promotionId: string;
  questions: PromotionQuestion[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState<PromotionQuestion | 'new' | null>(null);

  return (
    <div className="flex flex-col gap-5">
      {questions.length === 0 && !editing && (
        <p className="text-sm text-muted-foreground">
          This promotion has no quiz. A promotion does not need one.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {questions.map((question) => (
          <li key={question.id} className="rounded-md border p-3" data-testid="quiz-question">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{question.prompt}</span>
                <span className="text-xs text-muted-foreground">
                  {question.position}. {QUESTION_KIND_LABELS[question.kind]}
                </span>
                {question.options.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                    {question.options.map((option) => (
                      <li key={option.id}>
                        {option.label}
                        {option.isCorrect && (
                          <span className="ml-1 font-medium text-emerald-700">· right answer</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {canEdit && (
                <div className="flex shrink-0 gap-1">
                  <Button type="button" variant="outline" onClick={() => setEditing(question)}>
                    Edit
                  </Button>
                  <RemoveQuestionButton questionId={question.id} onRemoved={onSaved} />
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
            Add a question
          </Button>
        </div>
      )}

      {editing && (
        <QuestionForm
          promotionId={promotionId}
          question={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onSaved();
          }}
        />
      )}

      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          You do not hold promotions.edit at this Station, so the quiz can be read here but not
          changed.
        </p>
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
        aria-label="Remove this question"
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
  onCancel,
  onSaved,
}: {
  promotionId: string;
  question: PromotionQuestion | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, action, pending] = useActionState(savePromotionQuestionAction, INITIAL);
  const [kind, setKind] = useState<PromotionQuestionKind>(question?.kind ?? 'MULTIPLE_CHOICE');
  const [options, setOptions] = useState<DraftOption[]>(
    question?.options.map((o) => ({ label: o.label, isCorrect: o.isCorrect })) ?? [
      { label: '', isCorrect: false },
      { label: '', isCorrect: false },
    ],
  );

  useEffect(() => {
    if (state.status === 'saved') onSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const isEssay = kind === 'ESSAY';

  return (
    <form action={action} className="flex flex-col gap-4 rounded-md border p-4" data-testid="quiz-form">
      <input type="hidden" name="promotionId" value={promotionId} />
      {question && <input type="hidden" name="questionId" value={question.id} />}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Kind</span>
        <Select
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as PromotionQuestionKind)}
          data-testid="quiz-kind"
        >
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {QUESTION_KIND_LABELS[value]}
            </option>
          ))}
        </Select>
        <span className="text-xs text-muted-foreground">{QUESTION_KIND_HINTS[kind]}</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Question</span>
        <Input
          name="prompt"
          defaultValue={question?.prompt ?? ''}
          maxLength={300}
          required
          data-testid="quiz-prompt"
        />
      </label>

      {!isEssay && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Menu title</span>
              <Input
                name="menuTitle"
                defaultValue={question?.menuTitle ?? ''}
                maxLength={24}
                required
                data-testid="quiz-menu-title"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Button label</span>
              <Input
                name="buttonLabel"
                defaultValue={question?.buttonLabel ?? ''}
                maxLength={20}
                required
                data-testid="quiz-button-label"
              />
            </label>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm text-muted-foreground">Options</legend>
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
                  placeholder={`Option ${index + 1}`}
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
                    right
                  </label>
                )}
                {options.length > 2 && (
                  <button
                    type="button"
                    aria-label={`Remove option ${index + 1}`}
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
                Add an option
              </Button>
            </div>
          </fieldset>
        </>
      )}

      {state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="quiz-error">
          {state.message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} data-testid="quiz-save">
          {pending ? 'Saving…' : 'Save question'}
        </Button>
      </div>
    </form>
  );
}
