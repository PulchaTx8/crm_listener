import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { parseRecordParam, STATION_TABS } from '@/lib/record-params';
import { PageHeader } from '@/components/layout/app-shell';
import { listApiCredentialsFor, type ApiCredentialRow } from '@/services/api-credentials';
import { configuredSecrets, getIntegration, type IntegrationRow } from '@/services/integrations';
import { listOrganizations } from '@/services/organizations';
import { getWidgetInstallation, type WidgetInstallationRow } from '@/services/widget-installations';
import type { StationRow } from './actions';
import { StationsGrid, type OrganizationOption } from './stations-grid';
import type { StationProfile } from './station-form';

// Renders from the caller's session cookies, so it can never be static. Stated
// explicitly rather than inferred from cookies(): the Supabase client is built
// before cookies() is reached, so during a build with no configuration this page
// would fail as a prerender error instead of being skipped as dynamic.
export const dynamic = 'force-dynamic';

/**
 * The Stations of one customer group.
 *
 * EVERYTHING EVERY RECORD WILL SHOW IS READ HERE, before knowing which record
 * will be opened: each Station's profile columns, each one's keys, each one's
 * WhatsApp integration, each one's widget installation. That is the rule the
 * dialog depends on — the URL changes without a server round trip
 * (use-record-dialog.ts), so a fetch on open would be a second way for one
 * screen to be wrong, which is the defect Block 15 shipped and had to correct.
 * Block 17a's Widget tab follows the same rule rather than fetching its own
 * data when it opens — the one thing that would make it disagree with the rest
 * of this dialog about the same Station.
 *
 * IT IS AFFORDABLE ONLY BECAUSE OF THE FILTER (design D3). A customer group has
 * three or four radios, so this is a handful of reads; the retiring screen
 * listed twenty-five Stations from every group at once and could not have done
 * it. The keys come back in ONE call for all of them (list_api_credentials_for),
 * because per-row is the N+1 Block 3b measured at 102 queries.
 *
 * The integrations and the widget installations are the per-row reads left,
 * and deliberately: get_integration and widget_installation_for each take a
 * single Station, and a bulk sibling for a list that is three or four rows
 * long would be a second function to keep in step with their own list-form
 * siblings for no measurable gain. Both run inside the SAME Promise.all pass
 * below rather than two separate sweeps, for the reason the comment there
 * gives. If a customer ever appears with dozens of radios, this is the line to
 * change.
 */
export default async function StationsPage({
  searchParams,
}: {
  searchParams: Promise<{ organization?: string; record?: string; tab?: string }>;
}) {
  const t = await getTranslations('admin');
  const params = await searchParams;
  const supabase = await createUserClient();

  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) redirect('/login');

  let organizations: OrganizationOption[] = [];
  try {
    organizations = (await listOrganizations(token)).map((organization) => ({
      id: organization.id,
      name: organization.name,
      suspendedAt: organization.suspendedAt,
    }));
  } catch (cause) {
    // Logged and swallowed: an empty combobox with the page around it beats an
    // error page over the whole console.
    logger.error({ err: cause }, 'could not load the organizations for the selector');
  }

  // An address naming a group that does not exist reads as no selection rather
  // than as an error, the contract parseRecordParam carries for its own hostile
  // input.
  const requested = params.organization?.trim();
  const selectedOrganizationId =
    requested && organizations.some((o) => o.id === requested) ? requested : null;

  const rows: StationRow[] = [];
  const profiles: Record<string, StationProfile> = {};
  const credentials: Record<string, ApiCredentialRow[]> = {};
  const integrations: Record<string, IntegrationRow | null> = {};
  const installations: Record<string, WidgetInstallationRow | null> = {};

  if (selectedOrganizationId) {
    const { data: stations, error } = await supabase
      .from('companies')
      // ONE literal string. A concatenation collapses PostgREST's row type to
      // GenericStringError, which typechecks and returns nothing usable.
      // prettier-ignore
      .select('id, name, status, suspension_reason, created_at, organization_id, address_line, address_number, address_complement, neighbourhood, city, state, postal_code, broadcast_band, frequency_khz, latitude, longitude, thumb_url, contact_email, contact_phone, website_url, instagram_url, facebook_url, youtube_url, tagline, description, legal_name, tax_id, municipal_registration, fiscal_email')
      .eq('organization_id', selectedOrganizationId)
      // Archived Stations are not listed beside live ones: an archived Station
      // cannot be suspended or reactivated, so the controls beside it would do
      // nothing.
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    if (error) logger.error({ err: error }, 'could not load the stations of this group');

    for (const station of stations ?? []) {
      rows.push({
        id: station.id,
        name: station.name,
        status: station.status,
        suspensionReason: station.suspension_reason,
        createdAt: station.created_at,
        organizationId: station.organization_id,
      });
      profiles[station.id] = {
        addressLine: station.address_line,
        addressNumber: station.address_number,
        addressComplement: station.address_complement,
        neighbourhood: station.neighbourhood,
        city: station.city,
        state: station.state,
        postalCode: station.postal_code,
        broadcastBand: station.broadcast_band,
        frequencyKhz: station.frequency_khz,
        latitude: station.latitude,
        longitude: station.longitude,
        thumbUrl: station.thumb_url,
        contactEmail: station.contact_email,
        contactPhone: station.contact_phone,
        websiteUrl: station.website_url,
        instagramUrl: station.instagram_url,
        facebookUrl: station.facebook_url,
        youtubeUrl: station.youtube_url,
        tagline: station.tagline,
        description: station.description,
        legalName: station.legal_name,
        taxId: station.tax_id,
        municipalRegistration: station.municipal_registration,
        fiscalEmail: station.fiscal_email,
      };
    }

    if (rows.length > 0) {
      try {
        const grouped = await listApiCredentialsFor(
          rows.map((row) => row.id),
          token,
        );
        for (const [companyId, keys] of grouped) credentials[companyId] = keys;
      } catch (cause) {
        // An empty keys tab beats an error page over the whole console.
        logger.error({ err: cause }, 'could not load the keys of this group');
      }

      // Concurrent rather than sequential: independent reads that wait on each
      // other for no reason would make the screen three or four times slower
      // than it is. The widget installation is read INSIDE this same pass
      // rather than a second sweep over `rows` -- the eager-load argument two
      // paragraphs up ("three or four radios") holds for one more field per
      // row and stops holding the moment the page starts making a second
      // serial pass over the same list. Each row's two RPCs (integration,
      // installation) also run concurrently with each other, and each is
      // caught on its own: a failure reading one Station's integration must
      // not blank out an installation that loaded fine, or the reverse.
      const loaded = await Promise.all(
        rows.map(async (row) => {
          const [integration, installation] = await Promise.all([
            getIntegration(row.id).catch((cause) => {
              logger.error({ err: cause, companyId: row.id }, 'could not load an integration');
              return null;
            }),
            getWidgetInstallation(row.id, token).catch((cause) => {
              logger.error({ err: cause, companyId: row.id }, 'could not load a widget installation');
              return null;
            }),
          ]);
          return [row.id, integration, installation] as const;
        }),
      );
      for (const [companyId, integration, installation] of loaded) {
        integrations[companyId] = integration;
        // Explicitly assigned even when null: an absent key would make "not
        // configured" and "not loaded" the same value, which is exactly what
        // the Widget tab's warning line has to tell apart.
        installations[companyId] = installation;
      }
    }
  }

  const record = parseRecordParam(params, STATION_TABS);

  // NEXT_PUBLIC_SITE_URL, resolved once here rather than inside the client
  // component the snippet renders in -- `invitations.ts`'s own siteUrl()
  // reads the same variable the same way, for its own links.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

  return (
    <>
      <PageHeader title={t('stations')} description={t('stationsDescription')} />
      <StationsGrid
        organizations={organizations}
        selectedOrganizationId={selectedOrganizationId}
        initialRows={rows}
        initialRecord={record}
        profiles={profiles}
        credentials={credentials}
        integrations={integrations}
        installations={installations}
        secrets={configuredSecrets()}
        siteUrl={siteUrl}
      />
    </>
  );
}
