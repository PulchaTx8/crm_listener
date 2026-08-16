'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useRef, useState, useTransition, type KeyboardEvent } from 'react';
import { createCategoryInlineAction, createPrizeAction, type PrizeFormState } from './actions';
import { useCategoryList } from './category-list';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { ImageUploadField } from '@/components/media/image-upload-field';

const INITIAL: PrizeFormState = { status: 'idle' };

export function PrizeForm({
  companyId,
  onCreated,
}: {
  companyId: string;
  /** Reports the new prize's id so the grid can open its record and take the row from it. */
  onCreated?: (prizeId: string) => void;
}) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(createPrizeAction, INITIAL);
  // Block 26. From the shared list rather than a prop, because the box below adds
  // to it and the filter bar outside this dialog reads the same array.
  const { categories } = useCategoryList();
  /**
   * CONTROLLED since Block 26, where it was `defaultValue=""`. A category
   * registered from the box below has to arrive already chosen — the operator
   * asked for it while filling in this prize — and an uncontrolled select cannot
   * be told which option to stand on after it has mounted.
   */
  const [categoryId, setCategoryId] = useState('');

  return (
    <form action={action} data-testid="prize-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />

      {/* Settled after the prize is registered, not with it: the storage key is
          derived from the prize's id, which does not exist until the row does.
          See settlePrizePhoto in ./actions.ts. */}
      <ImageUploadField
        name="photo"
        kind="thumb"
        currentUrl={null}
        disabled={pending}
        onDirty={() => undefined}
        label={t('prizePicture')}
        hint={t('shownOnTheStockList')}
      />

      <label className="flex flex-col gap-1 text-sm">
        {t('name')}<Input name="name" required maxLength={120} />
      </label>

      <div className="flex flex-col gap-1 text-sm">
        <label className="flex flex-col gap-1">
          {/* A testid rather than the label: this control is a `<select>` inside
              its own `<label>`, so the label's text content is "Category"
              followed by every option in it — `getByLabel` cannot name it
              exactly, and naming it loosely would match whatever an option
              happens to be called. */}
          {t('category')}<Select
            name="categoryId"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            disabled={pending}
            data-testid="prize-category"
          >
            <option value="">{t('uncategorised')}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </label>
        <InlineCategoryField
          companyId={companyId}
          disabled={pending}
          onCreated={(id) => setCategoryId(id)}
        />
      </div>

      <label className="flex flex-col gap-1 text-sm">
        {t('internalCode')}<Input name="internalCode" maxLength={40} placeholder={t('optionalSkuOrBarcode')} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('description')}<Textarea name="description" maxLength={2000} placeholder={t('optional')} />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="allowsReturnToStock" defaultChecked />
        {t('allowsReturnToStock')}</label>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('registerPrize')}
        </Button>
        {/* The confirmation stays on screen and opening the new record is a
            deliberate click, the same shape the registration desk uses for a
            listener: a dialog that closed itself the moment the write landed
            would take its own "Prize registered." with it. */}
        {state.status === 'saved' && (
          <p className="text-sm text-success">
            {t('prizeRegistered')}{' '}
            {state.prizeId && onCreated && (
              <button
                type="button"
                onClick={() => onCreated(state.prizeId as string)}
                className="underline underline-offset-2"
              >
                {t('viewPrize')}</button>
            )}
          </p>
        )}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}

/**
 * Block 26. Registering a category from inside the prize form, because the moment
 * somebody discovers a category is missing is the moment they are registering the
 * prize that needed it — and sending them to /inventory/categories for it would
 * lose the half-filled form behind them. Renaming and retiring live on that
 * screen; this box does one thing.
 *
 * NOT A NESTED `<form>`. This sits inside the prize form, and a form inside a form
 * is invalid HTML that browsers resolve by dropping the inner one — the OUTER
 * form's action would run, and the operator would register a prize by asking for a
 * category. So there is no `<form action={...}>` and no `useActionState` here: the
 * button calls `createCategoryInlineAction` directly, inside a transition.
 *
 * EVERY BUTTON IS `type="button"`, EXPLICITLY, and `Button` is why it has to be
 * said: it renders a bare `<button>` with no default type, and a `<button>` inside
 * a form with no type IS a submit button. That is the whole of a defect this
 * product has already shipped once — two unkeyed buttons in one position, silently
 * recording participations. Enter inside the box is caught for the same reason: an
 * uncaught Enter submits the prize.
 *
 * THE INPUT HAS NO `name`, deliberately. A named field here is posted with the
 * prize — `createPrizeAction` reads its fields by name off that FormData, so a
 * box called `name` or `categoryId` would silently overwrite one of them, and any
 * other name would ride along as dead weight in every registration.
 */
function InlineCategoryField({
  companyId,
  disabled,
  onCreated,
}: {
  companyId: string;
  disabled: boolean;
  /** The new category's id, so the picker above can stand on it. */
  onCreated: (categoryId: string) => void;
}) {
  const t = useTranslations('inventory');
  const { add } = useCategoryList();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function create() {
    const typed = name.trim();
    if (!typed || saving) return;
    setError(null);
    startSaving(async () => {
      const result = await createCategoryInlineAction(companyId, typed);
      if (result.status === 'error') {
        // The box stays open holding what was typed: the commonest refusal here
        // is a name that already exists, and clearing it would make the operator
        // retype in order to read the message.
        setError(result.message);
        return;
      }
      add(result.category);
      onCreated(result.category.id);
      setName('');
      setOpen(false);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    // Without this the keystroke reaches the prize form and registers the prize.
    event.preventDefault();
    create();
  }

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          // The box is why they clicked; focusing it after paint saves a second
          // click and gives a keyboard caller somewhere to be.
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="self-start text-xs text-primary underline underline-offset-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        data-testid="inline-category-open"
      >
        {t('registerANewCategory')}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={inputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={120}
          disabled={disabled || saving}
          aria-label={t('newCategoryName')}
          placeholder={t('newCategoryName')}
          className="w-56"
          data-testid="inline-category-name"
        />
        <Button
          type="button"
          size="sm"
          disabled={disabled || saving || !name.trim()}
          onClick={create}
          data-testid="inline-category-save"
        >
          {saving ? t('saving') : t('add')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => {
            setOpen(false);
            setName('');
            setError(null);
          }}
        >
          {t('cancel')}
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive" data-testid="inline-category-error">
          {error}
        </p>
      )}
    </div>
  );
}
