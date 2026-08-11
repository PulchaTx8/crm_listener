'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Band } from '@/lib/shows/bands';
import type { ShowSummary } from '@/services/shows';
import { ShowRecordDialog } from './show-record-dialog';

/**
 * Block 18. The programme list, on the shape of `songs-grid.tsx`: a table, a
 * register button, and the record dialog hosted over it.
 *
 * Writes patch the row in place rather than re-rendering the route — the same
 * rule songs, inventory and members carry, because a fresh render would rebuild
 * the keyset list from page one under whoever was reading it.
 */
export function ShowsGrid({
  companyId,
  rows,
  canManage,
}: {
  companyId: string;
  rows: ShowSummary[];
  canManage: boolean;
}) {
  const t = useTranslations('shows');
  const [shows, setShows] = useState(rows);
  const [editing, setEditing] = useState<ShowSummary | 'new' | null>(null);

  const onSaved = (saved: ShowSummary) => {
    setShows((current) => {
      const known = current.some((show) => show.id === saved.id);
      return known ? current.map((show) => (show.id === saved.id ? saved : show)) : [saved, ...current];
    });
    setEditing(null);
  };

  return (
    <div className="flex flex-col gap-4">
      {canManage && !editing && (
        <div>
          <Button type="button" onClick={() => setEditing('new')} data-testid="show-add">
            <Plus className="mr-1 size-4" aria-hidden="true" />
            {t('registerAProgramme')}
          </Button>
        </div>
      )}

      {editing && (
        <ShowRecordDialog
          companyId={companyId}
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}

      {shows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="shows-empty">
          {t('noProgrammesYet')}
        </p>
      ) : (
        <Table data-testid="shows-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('kind')}</TableHead>
              <TableHead>{t('ageRating')}</TableHead>
              <TableHead>{t('schedule')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shows.map((show) => (
              <TableRow key={show.id} data-testid="show-row">
                <TableCell>
                  <span className="flex items-center gap-2">
                    {show.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={show.thumbUrl} alt="" width={32} height={32} className="rounded" />
                    ) : null}
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">{show.name}</span>
                      {show.presenterName && (
                        <span className="text-xs text-muted-foreground">{show.presenterName}</span>
                      )}
                    </span>
                  </span>
                </TableCell>
                <TableCell>{show.kind ? t(`kind_${show.kind}`) : '—'}</TableCell>
                <TableCell>{show.ageRating ? t(`age_${show.ageRating}`) : '—'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {show.bands.length > 0 ? <ScheduleSummary bands={show.bands} /> : '—'}
                </TableCell>
                <TableCell>
                  <span className="flex items-center justify-end gap-2">
                    {/* D3 and D7: the four programmes that predate this block
                        carry only a name, and this is where an operator learns
                        which half is missing rather than from a document. */}
                    {!show.complete && (
                      <span
                        className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        data-testid="show-incomplete"
                      >
                        {t('incomplete')}
                      </span>
                    )}
                    {show.ended && (
                      <span
                        className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        data-testid="show-ended"
                      >
                        {t('ended')}
                      </span>
                    )}
                    {canManage && (
                      <Button type="button" variant="outline" onClick={() => setEditing(show)}>
                        {t('edit')}
                      </Button>
                    )}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/**
 * "Seg–Sex 10:00–12:30 · Sáb 23:00–02:00".
 *
 * Consecutive days are collapsed into a range because that is how a schedule is
 * read aloud, and because five separate day names in a table cell is a wall.
 */
function ScheduleSummary({ bands }: { bands: Band[] }) {
  const t = useTranslations('shows');

  const short = (day: number) => t(`dayShort_${day}`);

  const describe = (band: Band): string => {
    const days = [...band.days].sort((a, b) => a - b);
    const parts: string[] = [];
    let run: number[] = [];

    const flush = () => {
      if (run.length === 0) return;
      const first = run[0];
      const last = run[run.length - 1];
      if (first === undefined || last === undefined) return;
      parts.push(run.length > 2 ? `${short(first)}–${short(last)}` : run.map(short).join(', '));
      run = [];
    };

    for (const day of days) {
      const previous = run[run.length - 1];
      if (previous !== undefined && day !== previous + 1) flush();
      run.push(day);
    }
    flush();

    return `${parts.join(', ')} ${band.starts}–${band.ends}`;
  };

  return (
    <span className="flex flex-col">
      {bands.map((band, index) => (
        <span key={index}>{describe(band)}</span>
      ))}
    </span>
  );
}
