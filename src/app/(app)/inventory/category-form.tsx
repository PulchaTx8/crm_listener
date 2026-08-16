'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { createCategoryAction, type CategoryFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const INITIAL: CategoryFormState = { status: 'idle' };

export function CategoryForm({ companyId }: { companyId: string }) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(createCategoryAction, INITIAL);

  return (
    <form action={action} data-testid="category-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />

      <label className="flex flex-col gap-1 text-sm">
        {t('name')}<Input name="name" required maxLength={120} />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('registerCategory')}
        </Button>
        {state.status === 'saved' && (
          <p className="text-sm text-success">{t('categoryRegistered')}</p>
        )}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
