import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type {
  GeographyPlace,
  MusicGeographyPlace,
  PromotionsGeographyPlace,
} from '@/schemas/geography';
import { PlaceMap } from './place-map';
import { placeName } from './place-map-geometry';

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
  /** The Promotions panel passes its own, which carry the promotion most played there. */
  promotions,
  /**
   * WHAT THE NUMBERS COUNT, named because the sentence changes with it: the
   * Audience and Music panels count listeners, and Block 30e's Promotions panel
   * counts entries. A coverage line reading "412 of 1,208 listeners" under a map
   * of entries would be the same false claim that line exists to prevent, only
   * wearing the right numbers.
   */
  subject = 'listeners',
}: {
  title: string;
  places: GeographyPlace[];
  withPlace: number;
  total: number;
  songs?: MusicGeographyPlace[];
  promotions?: PromotionsGeographyPlace[];
  subject?: 'listeners' | 'entries';
}) {
  const t = await getTranslations('dashboards');
  // TRIMMED, and a key that is only whitespace counts as unset. EasyPanel's
  // Environment tab keeps a trailing newline on a pasted value more often than
  // anyone expects, and an untrimmed one reaches Google as `AIza...%0A` — a key
  // it REFUSES, so the panel would render Google's own grey error card instead
  // of the honest "not configured" line one character would have earned. This is
  // the same family of trap `withoutBlanks` (src/lib/env.ts) exists for.
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY?.trim() || undefined;

  const byCity = rank(places, (place) => place.city);
  const byNeighbourhood = rank(places, (place) => place.neighbourhood);

  // THE HOVER BUBBLES, WORDED HERE. A circle sized by count cannot be read as a
  // number — an eye compares two areas, it does not measure one — and below the
  // top ten the tables do not name a place at all, so this is the only place a
  // Station can find out that the dot over Guarulhos is 43 listeners and not 4.
  //
  // Built on the server for the same reason every other string PlaceMap renders
  // is: see MapPlace. `songs` is the same array `places` is when the Music panel
  // passes it — only its TYPE is wider, and the extra line is the whole reason
  // the two maps differ.
  // Widened once, here, rather than narrowed at each of the two reads below:
  // `songs` and `places` are the SAME array when the Music panel passes both, so
  // the union of their two types is a distinction with no value at runtime.
  const mapSource: (GeographyPlace & {
    top_song?: string | null;
    top_song_count?: number | null;
    top_promotion?: string | null;
    top_promotion_count?: number | null;
  })[] = songs ?? promotions ?? places;

  const mapPlaces = mapSource.map((place) => ({
    key: place.key,
    latitude: place.latitude,
    longitude: place.longitude,
    count: place.count,
    name: placeName(place),
    lines: [
      t(subject === 'entries' ? 'entriesHere' : 'listenersHere', { count: place.count }),
      ...(place.top_song && place.top_song_count
        ? [t('mostRequestedHere', { song: place.top_song, count: place.top_song_count })]
        : []),
      ...(place.top_promotion && place.top_promotion_count
        ? [
            t('mostPlayedHere', {
              promotion: place.top_promotion,
              count: place.top_promotion_count,
            }),
          ]
        : []),
    ],
  }));

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
          {t(subject === 'entries' ? 'entriesCoverage' : 'placesCoverage', { withPlace, total })}
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
                places={mapPlaces}
                label={title}
                unavailableLabel={t('theMapCouldNotBeLoaded')}
                refusedLabel={t('theMapKeyWasRefused')}
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
                countHeader={t(subject === 'entries' ? 'entriesColumn' : 'listenersColumn')}
                rows={byCity}
              />
              <PlaceTable
                caption={t('byNeighbourhood')}
                testId="geography-by-neighbourhood"
                nameHeader={t('neighbourhood')}
                countHeader={t(subject === 'entries' ? 'entriesColumn' : 'listenersColumn')}
                rows={byNeighbourhood}
              />
            </div>

            {promotions && promotions.length > 0 && (
              <PlaceTable
                caption={t('mostPlayedByPlace')}
                testId="geography-top-promotions"
                nameHeader={t('place')}
                countHeader={t('promotion')}
                rows={promotions
                  .filter((place) => place.top_promotion)
                  .slice(0, TOP_N)
                  .map((place) => ({
                    // The same function the map's hover bubble titles a circle
                    // with, so a place cannot be named one way here and another
                    // way over its own dot.
                    name: placeName(place),
                    label: place.top_promotion ?? '',
                    count: place.top_promotion_count ?? 0,
                  }))}
              />
            )}

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
                    // The same function the map's hover bubble titles a circle
                    // with, so a place cannot be named one way here and another
                    // way over its own dot.
                    name: placeName(place),
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
