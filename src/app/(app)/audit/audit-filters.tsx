import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AuditListState } from './list-params';

/**
 * Block 10a. The filter bar.
 *
 * A plain `<form method="get">` and no client component at all: every control
 * here maps to a URL parameter that `list-params.ts` already parses, so the
 * browser's own submission does exactly what a `router.push` would and works
 * with JavaScript disabled, in a printed page, and in a link somebody pastes
 * into a ticket. That last one matters more here than on any other screen —
 * "here is the filter that shows what happened" is the thing people send each
 * other about an audit trail.
 *
 * `after` is deliberately not carried: changing a filter starts the list over,
 * because a cursor from the previous filter points into a set that no longer
 * exists.
 */
export async function AuditFilters({ state }: { state: AuditListState }) {
  const t = await getTranslations('audit');
  return (
    <form method="get" action="/audit" className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t('action')}</span>
        <Input
          name="action"
          defaultValue={state.action ?? ''}
          placeholder={t('createMember')}
          maxLength={60}
          className="w-52"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t('targetTable')}</span>
        <Input
          name="target"
          defaultValue={state.targetTable ?? ''}
          placeholder={t('members')}
          maxLength={60}
          className="w-44"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t('from')}</span>
        <Input type="date" name="from" defaultValue={state.from ?? ''} className="w-40" />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">To</span>
        <Input type="date" name="to" defaultValue={state.to ?? ''} className="w-40" />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t('outcome')}</span>
        <select
          name="ok"
          defaultValue={state.succeeded === undefined ? '' : state.succeeded ? 'yes' : 'no'}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">{t('any')}</option>
          <option value="yes">{t('succeeded')}</option>
          <option value="no">{t('failed')}</option>
        </select>
      </label>

      <Button type="submit" variant="outline" size="sm">
        {t('filter')}</Button>
      {/* A LINK, not a submit button. A second submit would post the fields
          that are currently filled in, which is the opposite of clearing them;
          navigating to the bare path is what actually empties the state,
          because every filter lives in the URL and nowhere else. */}
      <Link
        href="/audit"
        className="inline-flex h-9 items-center px-3 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        {t('clear')}</Link>
    </form>
  );
}
