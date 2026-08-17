import { getLocale, getTranslations } from 'next-intl/server';
import { createUserClient } from '@/lib/supabase/user-client';
import type { UserClient } from '@/lib/supabase/user-client';
import { env } from '@/lib/env';
import { embeddedSignupUrl } from '@/lib/integrations/whatsapp/embedded-signup';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { formatFrequency } from '@/lib/frequency';
import { StationSettings, type WhatsAppStatus } from './station-settings';

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
 * BLOCK 29a PUT A DIALOG BEHIND IT AFTER ALL, and D9 above is not reversed by
 * it. That decision is about the COLUMNS on this card — name, picture,
 * frequency, address — and every one of them is still read-only here and still
 * written from /admin/customers. What the Settings button opens edits none of
 * them: it carries the WhatsApp pairing, which is a row in `integrations` that
 * no screen in the member area could reach at all, and which belongs to the
 * Organization owner rather than to the platform (station-settings.tsx says why
 * at length). The day somebody adds a "Station data" tab to that dialog, D9 is
 * what they are reversing; a WhatsApp tab is not.
 *
 * THE BUTTON IS GATED ON OWNERSHIP OF THE ORGANIZATION, NOT ON
 * `is_owner_of_company`, and the difference is deliberate. The second is also
 * true for the platform admin (0044) — the house convention, and the right one
 * for the RPC behind the dialog, where support acting on a customer's behalf is
 * intended. But it would put a Settings button on every card a platform admin
 * can see on THIS screen, which is the member area; the console is where support
 * does that work.
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
    .select('id, name, organization_id, status, timezone, thumb_url, broadcast_band, frequency_khz, address_line, address_number, neighbourhood, city, state, postal_code')
    .is('deleted_at', null)
    .order('name', { ascending: true });

  if (companiesError) logger.error({ err: companiesError }, 'could not load stations');

  const list = companies ?? [];
  const settings = await stationSettings(supabase, list);
  // Resolved once for the page rather than per card: it is one environment
  // variable and the same answer for every Station. Server-side, because
  // WHATSAPP_EMBEDDED_SIGNUP_URL is deliberately not a NEXT_PUBLIC_ variable.
  const signupUrl = embeddedSignupUrl(env.WHATSAPP_EMBEDDED_SIGNUP_URL);

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

                  {/* Owners only. `settings` holds an entry for exactly the
                      Stations whose Organization this caller owns, so the
                      absence of one is the gate — no second check here that
                      could disagree with the one that built the map. */}
                  {settings.has(c.id) && (
                    <div className="flex justify-end">
                      <StationSettings
                        companyName={c.name}
                        signupUrl={signupUrl}
                        status={settings.get(c.id) ?? null}
                      />
                    </div>
                  )}

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
 * Which of these Stations the caller owns, and what each one's WhatsApp
 * connection looks like. Block 29a.
 *
 * A MAP WHOSE KEYS ARE THE GATE. Membership answers "may this caller open the
 * settings dialog for this Station"; the value answers "and what does it say".
 * One structure rather than two, so the button and its contents can never be
 * built from two checks that disagree — the shape of accident this codebase
 * names in `templates/permissions.ts` for its own pair of predicates.
 *
 * OWNERSHIP IS READ ONCE, FROM THE CALLER'S OWN MEMBERSHIPS, and the first
 * version of this helper got that wrong in a way worth recording because it
 * survived every gate and was caught by a log line.
 *
 * THE DEFECT: it collected the distinct `organization_id` of every company on
 * screen and called `is_owner` for each, filtering afterwards. That reads as
 * "one call per group" and is not: the list this screen renders is whatever RLS
 * shows the caller, which for a platform admin is EVERY Station on the platform
 * — so the number of round trips was bounded by the size of the installation,
 * not by anything the caller owns. On a database with a few dozen Organizations
 * it produced `TypeError: fetch failed / SocketError: other side closed` on some
 * of them, and each failure silently hid a Settings button.
 *
 * ONE SELECT INSTEAD. `organization_memberships_select` (0024) opens on
 * `user_id = auth.uid()` before any of its other arms, so a caller can always
 * read their OWN memberships — one query, constant, whatever the platform's
 * size. The `user_id` filter is load-bearing rather than defensive: without it
 * the same policy's later arms would hand a platform admin every owner
 * membership in the installation, and the map below would put a Settings button
 * on every card.
 *
 * THAT SELECT IS A BOUND, NOT THE GATE, and the distinction is the second thing
 * this helper got wrong. `is_owner_for` (the predicate under
 * `is_owner_of_company`, which 0218 checks) requires more than an owner
 * membership: it also requires `organizations.suspended_at is null` — Block 16's
 * D5, the group's lock, deliberately written in one function rather than in
 * twenty policies. A membership read that stopped at "owner" was therefore WIDER
 * than the door, and the owner of a suspended group got a Settings button whose
 * panel answered 42501 every time.
 *
 * The fix is not to restate `suspended_at` here — restating a predicate beside
 * the one that owns it is how the two drift, and this file would then carry a
 * copy of a rule Block 16 centralised on purpose. Instead the RPC IS the gate:
 * a company earns an entry in the map by the door ANSWERING, and a 42501 is the
 * database saying no, which this reads as no. The membership select only decides
 * which companies are worth asking about, which is all a bound has to do.
 *
 * THE STATUS READS STAY ONE RPC PER OWNED STATION, and that bound is now real —
 * "Stations this caller owns" rather than "Stations this caller can see". Said
 * plainly rather than left implied: a group of fifty radios is fifty parallel
 * calls on this page, which is affordable and is not free. `station_whatsapp_status`
 * (0218) takes one company id; the day that group exists, widening it to take an
 * array is the fix, and this paragraph is the note that says so.
 *
 * THEY ARE ALSO INDIVIDUALLY FALLIBLE. A failure yields `null` for that Station
 * rather than taking the page with it: the dialog says the status could not be
 * read and the pairing button is still there. The alternative — one rejected
 * promise failing the whole grid — would mean a Station with a broken
 * integration row hides every other Station's card.
 */
async function stationSettings(
  supabase: UserClient,
  companies: { id: string; organization_id: string }[],
): Promise<Map<string, WhatsAppStatus | null>> {
  const settings = new Map<string, WhatsAppStatus | null>();
  if (companies.length === 0) return settings;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return settings;

  const { data: memberships, error: membershipError } = await supabase
    .from('organization_memberships')
    .select('organization_id')
    .eq('user_id', user.id)
    .eq('role', 'owner')
    .is('deleted_at', null);

  if (membershipError) {
    // Hides the button, which is the safe direction — but logged, because an
    // owner who silently loses the pairing control has no way to tell that from
    // the feature having been removed.
    logger.error({ err: membershipError }, 'could not read organization ownership');
    return settings;
  }

  const owned = new Set((memberships ?? []).map((m) => m.organization_id));
  const ownedCompanies = companies.filter((c) => owned.has(c.organization_id));
  await Promise.all(
    ownedCompanies.map(async (company) => {
      const { data, error } = await supabase.rpc('station_whatsapp_status', {
        p_company_id: company.id,
      });
      if (error) {
        // 42501 is the door saying this caller is not the owner of this Station
        // — a suspended group is the case that reaches here (see this function's
        // header). NO ENTRY, so no button: the database answered the question
        // and this agrees with it rather than showing a control that cannot
        // work. Not logged either, because it is an ordinary answer and a log
        // line per suspended Station on every page load is noise that would
        // bury the errors below it.
        if (error.code === '42501') return;
        logger.error({ err: error, companyId: company.id }, 'could not read whatsapp status');
        settings.set(company.id, null);
        return;
      }
      // 0218 returns exactly one row for a live Station, so an empty result is
      // a Station deleted between the two reads rather than a Station without
      // an integration — which that function answers with connected = false.
      const row = data?.[0];
      settings.set(
        company.id,
        row
          ? {
              connected: row.connected,
              displayPhoneNumber: row.display_phone_number,
              enabled: row.enabled,
            }
          : null,
      );
    }),
  );

  return settings;
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
