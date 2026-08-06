import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import type { Card as CardValue, Withheld } from '@/schemas/dashboards';

/** One tile's key (matching a `cards` property name) and its display label. */
export interface CardSpec {
  key: string;
  label: string;
  /**
   * A caveat about what this figure counts, rendered under the number when the
   * figure needs one — today, only the Audience panel's four, and only in a
   * consolidated view (whole-branch review, Important B5).
   *
   * It exists because `listeners`, `new_listeners`, `took_part` and `barred`
   * all count DISTINCT MEMBERS, and members are Organization-scoped (0031): a
   * listener reachable from two of the selected Stations is one listener, so
   * the consolidated figure is not the sum of the single-Station figures
   * anybody could produce by visiting each panel in turn. Design spec §3.1
   * already said so for `barred` and the page already printed it there; the
   * other three carry exactly the same arithmetic and said nothing, which
   * makes the one caveat read as a quirk of bars rather than the property of
   * the panel it actually is.
   */
  note?: string;
}

/**
 * The em dash and "Needs `<permission>`" sentence D13 requires for any figure
 * the caller's permissions cannot support. Exported so a whole withheld
 * CHART — `monthly`, `breakdowns.participation_status`, `top.promotions` on
 * the Promotions panel, none of which is a `cards` entry `DashboardCards`
 * below would ever see — can render the identical treatment a card gets,
 * rather than a second, drifting copy of the same two lines in each page.
 */
export async function WithheldFigure({ needs }: { needs?: string }) {
  const t = await getTranslations('dashboards');
  return (
    <div className="flex flex-col gap-1">
      <p className="text-2xl font-semibold text-muted-foreground" aria-hidden="true">
        —
      </p>
      <p className="text-xs text-muted-foreground">
        {needs ? (
          <>
            {t('needs')}{' '}<code className="font-mono">{needs}</code>.
          </>
        ) : (
          'Not available.'
        )}
      </p>
    </div>
  );
}

/**
 * One tile per spec, in the order given. `cards` and `withheld` are named
 * exactly as the payload's own keys, so a page passes `dashboard.cards` and
 * `dashboard.withheld` straight through with no reshaping in between.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE (D13, schemas/dashboards.ts's own
 * header): **never `?? 0` anywhere here.** A card whose key is present in
 * `cards` renders its real number; a card named in `withheld` renders the em
 * dash and the permission that would fill it; a card that is neither —
 * which the Zod schema at the service boundary should already have made
 * impossible — renders the SAME em dash rather than a fabricated zero, so
 * even a defect this file did not cause cannot show a false "nobody took
 * part" the way one stray `??` would.
 */
export async function DashboardCards({
  specs,
  cards,
  withheld,
}: {
  specs: readonly CardSpec[];
  cards: Record<string, CardValue | undefined>;
  withheld: Withheld[];
}) {
  const t = await getTranslations('dashboards');
  return (
    <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="dashboard-cards">
      {specs.map((spec) => {
        const withheldEntry = withheld.find((w) => w.figure === spec.key);
        const card = cards[spec.key];
        return (
          <Card key={spec.key} data-testid={`dashboard-card-${spec.key}`}>
            <CardHeader className="pb-2">
              <CardDescription>{spec.label}</CardDescription>
            </CardHeader>
            <CardContent>
              {withheldEntry ? (
                <WithheldFigure needs={withheldEntry.needs} />
              ) : card ? (
                <div className="flex flex-col gap-1">
                  <p className="text-2xl font-semibold">{card.current.toLocaleString()}</p>
                  {card.previous !== undefined && (
                    <p className="text-xs text-muted-foreground">
                      {t('previousPeriod')}{' '}{card.previous.toLocaleString()}
                    </p>
                  )}
                  {/* Only on a real figure. A withheld tile says nothing about
                      what it would have counted — that is the whole of D13. */}
                  {spec.note && <p className="text-xs text-muted-foreground">{spec.note}</p>}
                </div>
              ) : (
                <WithheldFigure />
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
