'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { createPrizeAction, type PrizeFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import type { PrizeCategorySummary } from '@/services/inventory';

const INITIAL: PrizeFormState = { status: 'idle' };

export function PrizeForm({
  companyId,
  categories,
  onCreated,
}: {
  companyId: string;
  categories: PrizeCategorySummary[];
  /** Reports the new prize's id so the grid can open its record and take the row from it. */
  onCreated?: (prizeId: string) => void;
}) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(createPrizeAction, INITIAL);

  return (
    <form action={action} data-testid="prize-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />

      <label className="flex flex-col gap-1 text-sm">
        {t('name')}<Input name="name" required maxLength={120} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('category')}<Select name="categoryId" defaultValue="">
          <option value="">{t('uncategorised')}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </label>

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
          {pending ? 'Saving…' : 'Register prize'}
        </Button>
        {/* The confirmation stays on screen and opening the new record is a
            deliberate click, the same shape the registration desk uses for a
            listener: a dialog that closed itself the moment the write landed
            would take its own "Prize registered." with it. */}
        {state.status === 'saved' && (
          <p className="text-sm text-emerald-700">
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
