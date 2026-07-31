import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import {
  listParticipationsPage,
  PARTICIPATION_SEARCH_MAX_LENGTH,
} from '@/services/participations';
import type { ParticipationListPage } from '@/services/participations';
import { listPromotionsPage } from '@/services/promotions';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../inventory/station-access';
import type { SuspendedCompany, ViewableCompany } from '../inventory/station-access';
import { StationSearchForm } from '../inventory/station-search-form';
import { canSearchByListener } from './access';
import { describeParticipationsReadError } from './errors';
import {
  ANY_STATUS,
  DEFAULT_PARTICIPATION_STATUS,
  participationsHref,
  parseParticipationCursor,
  parseParticipationListState,
  SEARCH_NOTE_ID,
} from './list-params';
import type { ParticipationSearchParams } from './list-params';
import { ParticipationsFilters } from './participations-filters';
import type { PromotionOption } from './participations-filters';
import { ParticipationsGrid } from './participations-grid';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function ParticipationsPage({
  searchParams,
}: {
  searchParams: Promise<ParticipationSearchParams>;
}) {
  const params = await searchParams;
  // The same bound listCompanyAccess enforces on its own argument, imported
  // rather than copied.
  const stationSearch = params.station?.trim().slice(0, STATION_SEARCH_MAX_LENGTH) || undefined;

  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  let viewable: ViewableCompany[];
  let suspended: SuspendedCompany[];
  let capped: boolean;
  try {
    ({ viewable, suspended, capped } = await listCompanyAccess(
      supabase,
      'participations.view',
      stationSearch,
    ));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve participations access');
    return <LoadError message={describeParticipationsReadError(cause)} />;
  }

  const first = viewable[0];

  // A Station search that matches nothing leaves this caller with no Station to
  // show, which is not the same as holding participations.view nowhere: the
  // redirect below would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: record_participation and import_participations
  // re-check has_permission themselves, and 0053's policies already filter every
  // read to exactly the Stations resolved above.
  if (!first) redirect('/app');

  // A stale or tampered companyId that is not in `viewable` — access revoked
  // since the link was generated, or a hand-edited URL — falls back to the
  // first Station this caller can actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  const state = parseParticipationListState(params, selected.id);
  const cursorParam = parseParticipationCursor(params);
  // An unreadable cursor means "start from the beginning", never an error page.
  const cursor = decodeCursor(cursorParam?.value);

  // Read here rather than inside the try below, because `redirect` works by
  // throwing and a catch would swallow it — the same placement members/page.tsx
  // uses for its own session read.
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) redirect('/login');
  const accessToken = sessionData.session.access_token;

  // Bounded once, here, and used both as the query's argument and as the text
  // the note below quotes back. The same number the service enforces on its own
  // argument, imported rather than copied so a URL parameter cannot drift the
  // two apart — and a pasted essay in `?q=` cannot become a paragraph of page
  // copy either.
  const searchTerm = state.search?.slice(0, PARTICIPATION_SEARCH_MAX_LENGTH);

  let canSearch: boolean;
  let page: ParticipationListPage;
  try {
    // Resolved BEFORE the list read, because its answer decides whether the
    // search term is sent at all. See ./access.ts: without members.view the
    // searched select returns nothing, and an empty page reads as "no listener
    // matched" rather than as a permission this caller does not hold.
    canSearch = await canSearchByListener(supabase, selected.id);

    page = await listParticipationsPage(
      {
        companyId: selected.id,
        promotionId: state.promotionId,
        // ANY_STATUS is this screen's word for "do not narrow", and the service
        // has no such value: an absent status is how the query says it. The
        // constant rather than the literal, so the URL vocabulary lives in one
        // module and this comparison cannot quietly stop matching it.
        status: state.status === ANY_STATUS ? undefined : state.status,
        source: state.source,
        from: state.from,
        to: state.to,
        // Dropped rather than forwarded when this caller cannot search. The
        // alternative — send it anyway and render whatever comes back — is
        // precisely the empty list the notice below exists to prevent.
        search: canSearch ? searchTerm : undefined,
        cursor,
        cursorSide: cursorParam?.side ?? 'after',
      },
      // The token, not the cookie jar: Task 6 moved this read to asCaller so it
      // could be driven from tests/isolation, which a next/headers function
      // cannot be. Both reach the database as the same user and RLS decides
      // identically either way.
      accessToken,
    );
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the participations list');
    return <LoadError message={describeParticipationsReadError(cause)} />;
  }

  // The promotion picker's options: ONE page of promotions by name, never the
  // whole Station. A picker that walked the cursor to the end would grow without
  // bound on a control nobody scrolls, and the house rule is not that a list may
  // not be bounded — it is that a bounded list must be able to say it was cut.
  // `nextCursor` is that answer, read as a signal and never rendered as an
  // option, and the copy further down says so.
  //
  // A DELIBERATELY narrower failure than the list read above, too: this screen's
  // purpose is the list, so losing the names that dress one filter should not
  // take the whole page down. Said out loud rather than swallowed, though —
  // members/page.tsx logs its equivalent and shows nothing, which leaves an
  // operator staring at an empty picker with no reason given.
  let promotionOptions: PromotionOption[] = [];
  let promotionsCapped = false;
  let promotionsError: string | null = null;
  try {
    const promotions = await listPromotionsPage({
      companyId: selected.id,
      sort: 'name',
      direction: 'asc',
      cursor: null,
      cursorSide: 'after',
    });
    promotionOptions = promotions.rows.map((promotion) => ({
      id: promotion.id,
      name: promotion.name,
    }));
    // The extra row read past the page, surfaced rather than dropped.
    promotionsCapped = promotions.nextCursor !== null;
  } catch (cause) {
    logger.error(
      { err: cause, companyId: selected.id },
      'could not read the promotions for the participations filter',
    );
    promotionsError = describeParticipationsReadError(cause, 'the promotions in this Station');
  }

  // A promotion filter pointing at something the picker did not offer — a
  // promotion past the cap, an archived one, or a link from that promotion's own
  // record — would otherwise leave the control showing no selection at all, and
  // the next change to any other filter would silently drop the promotion the
  // operator came here for. Its name comes off the rows already fetched, which
  // costs nothing; when the filter matches no row there is no name to be had, so
  // the option says what it is instead of inventing one.
  if (state.promotionId && !promotionOptions.some((p) => p.id === state.promotionId)) {
    promotionOptions.unshift({
      id: state.promotionId,
      name: page.rows[0]?.promotionName ?? 'The promotion this list is filtered to',
    });
  }

  return (
    <>
      <PageHeader
        title="Participations"
        description="Every entry recorded in the Station — the ones that counted, and the ones that did not."
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              Showing {viewable.length + suspended.length} of the Stations you can reach. Search by
              name to reach one that is not listed.
            </p>
          )}
          <StationSearchForm
            action="/participations"
            value={stationSearch ?? ''}
            preserve={{}}
            label="Find a Station"
          />
        </div>
      )}

      {viewable.length + suspended.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {viewable.map((company) => (
            <Link
              key={company.id}
              href={{ pathname: '/participations', query: { companyId: company.id } }}
              aria-current={company.id === selected.id ? 'page' : undefined}
              className={
                company.id === selected.id
                  ? 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground'
                  : 'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent'
              }
            >
              {company.name}
            </Link>
          ))}
          {suspended.map((company) => (
            <span
              key={company.id}
              title="Suspended — no data is available while the subscription is inactive."
              className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground"
            >
              {company.name} (suspended)
            </span>
          ))}
        </div>
      )}

      {/* `currentHref` is this render's own address, cursor included, built by
          the same helper the filter bar navigates with. The filter bar cancels a
          pending keystroke when the address changes for a reason that was not
          itself, and it can only do that if it is told the address — a Station
          chip, Clear filters, Previous/Next and Back all leave the search term
          untouched, so the term alone cannot report them. */}
      <ParticipationsFilters
        state={state}
        currentHref={participationsHref(state, cursorParam)}
        timeZone={selected.timezone}
        promotions={promotionOptions}
        canSearchByListener={canSearch}
      />

      {/* Rendered only when it has something to say, so the list does not sit
          three millimetres lower for a container that turned out to be empty. */}
      {(state.status === DEFAULT_PARTICIPATION_STATUS ||
        !canSearch ||
        promotionsCapped ||
        promotionsError) && (
        <div className="mt-3 flex flex-col gap-1.5">
          {/*
            The default says so, beside the list rather than only in the control.
            Design spec D5's whole point is that a refused attempt is written down
            instead of being thrown away, and an operator who never learns a
            filter is narrowing the list would conclude from this screen that the
            refusals were never recorded at all — which is the one wrong idea this
            screen must not leave anybody with. members/page.tsx puts its own
            "this filter behaves unusually" note in exactly this position.
          */}
          {state.status === DEFAULT_PARTICIPATION_STATUS && (
            <p className="text-xs text-muted-foreground" data-testid="participation-status-note">
              Showing only the entries that counted. An attempt that was refused — already
              entered, came back too soon, past their limit — is recorded too, with the reason it
              did not count. Pick “Any status” to see those as well.
            </p>
          )}

          {/*
            The search asymmetry, told rather than demonstrated. Plain listing
            needs participations.view; searching by listener goes through a join
            that also needs permission to see the audience at this Station, so a
            caller without it would otherwise get an empty result indistinguishable
            from "nobody matched".

            `id` rather than only a test id: the control it explains is rendered
            disabled, and this is what points a screen reader from one to the
            other. The constant comes from ./list-params, which both this Server
            Component and the client filter bar can read — see its own comment for
            why it is not exported from the filter bar itself.
          */}
          {!canSearch && (
            <p
              id={SEARCH_NOTE_ID}
              className="text-xs text-muted-foreground"
              data-testid="participation-search-note"
            >
              You cannot search by listener at this Station: that needs permission to see the
              audience here, which you do not hold.{' '}
              {searchTerm
                ? `Your search for “${searchTerm}” was not applied, so the list below is every entry matching the other filters rather than an empty set of matches.`
                : 'Every other filter still works.'}
            </p>
          )}

          {promotionsCapped && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="participation-promotions-capped"
            >
              The promotion picker lists the first promotions by name and this Station has more, so
              it is not the whole list.
            </p>
          )}

          {promotionsError && (
            <p className="text-xs text-destructive" data-testid="participation-promotions-error">
              {promotionsError}
            </p>
          )}
        </div>
      )}

      <ParticipationsGrid
        rows={page.rows}
        total={page.total}
        timeZone={selected.timezone}
        previousHref={
          page.previousCursor
            ? participationsHref(state, { side: 'before', value: page.previousCursor })
            : null
        }
        nextHref={
          page.nextCursor
            ? participationsHref(state, { side: 'after', value: page.nextCursor })
            : null
        }
      />
    </>
  );
}

function NoStationMatch({ search }: { search: string }) {
  return (
    <>
      <PageHeader title="Participations" />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            No Station you can reach matches “{search}”.
          </p>
          <Link href="/participations" className="text-sm text-primary underline underline-offset-2">
            Clear the Station search
          </Link>
        </CardContent>
      </Card>
    </>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <>
      <PageHeader title="Participations" />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
