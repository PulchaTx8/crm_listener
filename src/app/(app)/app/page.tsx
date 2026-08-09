import { getLocale, getTranslations } from 'next-intl/server';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { formatFrequency } from '@/lib/frequency';

// Renders from the caller's session cookies, so it can never be static. Stated
// explicitly rather than inferred from cookies(): the Supabase client is built
// before cookies() is reached, so during a build with no configuration this page
// would fail as a prerender error instead of being skipped as dynamic.
export const dynamic = 'force-dynamic';

/**
 * Where a signed-in member lands. Every reachable Company still appears,
 * suspended or not — companies_select_org_member (0006, corrected by 0021 to
 * scope by actual per-Company access rather than blanket Organization
 * membership) allows reading metadata regardless of status precisely so the
 * customer sees why access stopped instead of an empty screen (spec §4).
 *
 * BLOCK 15: the card now shows the Station rather than only its name — the
 * picture, the dial frequency and the address that 0153 added. It DISPLAYS and
 * does not edit: every one of those columns is written from /admin/customers
 * (design D9), which is why there is no gear here and no dialog behind it. The
 * card reads `companies` directly and needs no RPC, because RLS already answers
 * "which Stations may I see" and nothing here asks anything else.
 *
 * Coordinates are deliberately absent (D12). They are recorded so the platform
 * has them; a pair of numbers on this card would tell a member nothing.
 */
export default async function MemberHomePage() {
  const t = await getTranslations('app');
  const locale = await getLocale();
  const supabase = await createUserClient();

  const { data: companies, error: companiesError } = await supabase
    .from('companies')
    // ONE LITERAL, never a concatenation: PostgREST's types are inferred from
    // this exact string, and a `+` between two halves widens the row to
    // GenericStringError and takes every field access down with it.
    // prettier-ignore
    .select('id, name, status, timezone, thumb_url, broadcast_band, frequency_khz, address_line, address_number, neighbourhood, city, state, postal_code')
    .is('deleted_at', null)
    .order('name', { ascending: true });

  if (companiesError) logger.error({ err: companiesError }, 'could not load stations');

  const list = companies ?? [];

  return (
    <>
      <PageHeader title={t('yourStations')} description={t('yourStationsDescription')} />

      {list.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            {/* Was hardcoded English until Block 15, having escaped Block 12's
                language migration — as did the suspension line below. */}
            <p className="text-sm text-muted-foreground">{t('noStationLinkedYet')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((c) => {
            const frequency = formatFrequency(c.broadcast_band, c.frequency_khz, locale);
            const address = formatAddress(c);

            return (
              <Card key={c.id} data-testid="station-card">
                <CardContent className="flex flex-col gap-3 pt-6">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      {c.thumb_url ? (
                        // eslint-disable-next-line @next/next/no-img-element -- the same decision ImageThumb documents.
                        <img
                          src={c.thumb_url}
                          alt=""
                          className="size-10 shrink-0 rounded-md border object-cover"
                          data-testid="station-thumb"
                        />
                      ) : (
                        // The name's initial rather than an empty frame: a
                        // Station with no picture yet should still read as a
                        // row somebody set up, not as a broken one.
                        <span
                          aria-hidden="true"
                          className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-sm font-medium text-muted-foreground"
                          data-testid="station-initial"
                        >
                          {c.name.trim().charAt(0).toUpperCase()}
                        </span>
                      )}
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{c.name}</span>
                        {frequency && (
                          <span className="text-sm text-muted-foreground" data-testid="station-frequency">
                            {frequency}
                          </span>
                        )}
                      </div>
                    </div>
                    <span
                      className={
                        c.status === 'active'
                          ? 'shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary'
                          : 'shrink-0 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive'
                      }
                    >
                      {c.status}
                    </span>
                  </div>

                  {address && (
                    <span className="text-sm text-muted-foreground" data-testid="station-address">
                      {address}
                    </span>
                  )}

                  <span className="text-sm text-muted-foreground">{c.timezone}</span>

                  {c.status === 'suspended' ? (
                    <p className="text-sm text-muted-foreground">{t('suspendedNoDataAvailable')}</p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * The address as one line, with only the parts that exist.
 *
 * Assembled here rather than stored assembled, because the seven columns are
 * `members`' seven (0031) and the two must go on meaning the same thing. A
 * Station with nothing filled in renders no address line at all, rather than a
 * row of commas.
 */
function formatAddress(company: {
  address_line: string | null;
  address_number: string | null;
  neighbourhood: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}): string | null {
  const street = [company.address_line, company.address_number].filter(Boolean).join(', ');
  const place = [company.city, company.state].filter(Boolean).join('/');
  const parts = [street, company.neighbourhood, place, company.postal_code].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}
