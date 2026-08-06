import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Narrows a capped Station list by name (Block 3b). Rendered only when
 * listCompanyAccess actually capped, on both screens that call it.
 *
 * A plain GET form, with no `'use client'` and no router: submitting it is a
 * navigation, which is all this needs, and a screen whose whole job is
 * server-rendered lists should not ship JavaScript to move a name into a
 * query string. The trade is that a GET form submits only its own fields, so
 * anything else already in the URL has to be repeated as a hidden input —
 * `preserve` is that, built by its callers from the same helper that builds
 * their links, rather than hand-listed here and left to drift.
 */
export async function StationSearchForm({
  action,
  value,
  preserve,
  label,
}: {
  action: string;
  value: string;
  preserve: Record<string, string>;
  label: string;
}) {
  const t = await getTranslations('inventory');
  return (
    <form method="get" action={action} className="flex flex-wrap items-end gap-2">
      {Object.entries(preserve).map(([name, hiddenValue]) => (
        <input key={name} type="hidden" name={name} value={hiddenValue} />
      ))}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <Input
          type="search"
          name="station"
          defaultValue={value}
          placeholder={t('stationName')}
          className="h-9 w-56 text-sm"
          data-testid="station-search-input"
        />
      </label>
      <Button type="submit" variant="outline" className="h-9">
        {t('findStation')}</Button>
    </form>
  );
}
