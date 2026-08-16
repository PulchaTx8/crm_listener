import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { GeographyPlace, MusicGeographyPlace } from '@/schemas/geography';
import { PlaceMap } from './place-map';

/**
 * Block 28. The geography panel, shared by the Audience and Music dashboards.
 *
 * A SERVER COMPONENT, with exactly one client component inside it and only when
 * a key exists. The tables, the coverage line and the headings are all rendered
 * on the server; PlaceMap is the only thing that needs a browser.
 *
 * WITHOUT `NEXT_PUBLIC_GOOGLE_MAPS_KEY` THE TABLES ARE UNCHANGED and one muted
 * line says the map is not configured. That is design D6 and not a degraded
 * mode: the ranked lists are where an operator actually reads "which
 * neighbourhoods" — a map is how they see it — so the block is finishable,
 * shippable and testable before a key exists, and the whole e2e journey runs on
 * this path.
 */

/** How many rows a person reads before a ranked list stops being reading. */
const TOP_N = 10;

function rank(places: GeographyPlace[], by: (place: GeographyPlace) => string | null) {
  const totals = new Map<string, number>();
  for (const place of places) {
    const key = by(place);
    if (!key) continue;
    totals.set(key, (totals.get(key) ?? 0) + place.count);
  }
  return [...totals.entries()]
    .map(([name, count]) => ({ name, count }))
    // Ties broken by name so two loads of the same data render the same order.
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, TOP_N);
}

export async function GeographyPanel({
  title,
  places,
  withPlace,
  total,
  /** The Music panel passes its places, which carry a top song per place. */
  songs,
}: {
  title: string;
  places: GeographyPlace[];
  withPlace: number;
  total: number;
  songs?: MusicGeographyPlace[];
}) {
  const t = await getTranslations('dashboards');
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;

  const byCity = rank(places, (place) => place.city);
  const byNeighbourhood = rank(places, (place) => place.neighbourhood);

  return (
    <Card className="mt-6" data-testid="geography-panel">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* THE COVERAGE LINE, and it names BOTH numbers on purpose. A map
            showing 412 dots over an audience of 1,208 is not wrong, but read
            without this sentence it implies the 412 are everybody — and a
            Station would plan a campaign on it. */}
        <p className="text-sm text-muted-foreground" data-testid="geography-coverage">
          {t('placesCoverage', { withPlace, total })}
        </p>

        {places.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="geography-empty">
            {t('noPlacesAreKnownYet')}
          </p>
        ) : (
          <>
            {apiKey ? (
              <PlaceMap
                apiKey={apiKey}
                places={places}
                label={title}
                unavailableLabel={t('theMapCouldNotBeLoaded')}
              />
            ) : (
              // One muted line, and the tables below it unchanged. Design D6.
              <p className="text-sm text-muted-foreground" data-testid="map-not-configured">
                {t('theMapIsNotConfigured')}
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <PlaceTable
                caption={t('byCity')}
                testId="geography-by-city"
                nameHeader={t('city')}
                countHeader={t('listenersColumn')}
                rows={byCity}
              />
              <PlaceTable
                caption={t('byNeighbourhood')}
                testId="geography-by-neighbourhood"
                nameHeader={t('neighbourhood')}
                countHeader={t('listenersColumn')}
                rows={byNeighbourhood}
              />
            </div>

            {songs && songs.length > 0 && (
              <PlaceTable
                caption={t('mostRequestedByPlace')}
                testId="geography-top-songs"
                nameHeader={t('place')}
                countHeader={t('song')}
                rows={songs
                  .filter((place) => place.top_song)
                  .slice(0, TOP_N)
                  .map((place) => ({
                    name: place.neighbourhood ?? place.city ?? place.key,
                    // The song's title in the count column rather than a
                    // number: what a Station wants off this table is WHICH
                    // song, and the count is already in the ranking above.
                    label: place.top_song ?? '',
                    count: place.top_song_count ?? 0,
                  }))}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PlaceTable({
  caption,
  testId,
  nameHeader,
  countHeader,
  rows,
}: {
  caption: string;
  testId: string;
  nameHeader: string;
  countHeader: string;
  rows: { name: string; count: number; label?: string }[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{caption}</h3>
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead>{nameHeader}</TableHead>
            <TableHead>{countHeader}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name}>
              <TableCell>{row.name}</TableCell>
              <TableCell>{row.label ?? row.count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
