import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import {
  listParticipationsPage,
  PARTICIPATION_SEARCH_MAX_LENGTH,
} from '@/services/participations';
import type { ParticipationListPage } from '@/services/participations';
import { getPromotionRecord, listPromotionsPage, promotionThumbs } from '@/services/promotions';
import { getPromotionShowSchedule } from '@/services/shows';
import type { PromotionSchedule } from '@/services/shows';
import { bandsOnDay } from '@/lib/shows/programme-bands';
import type { PromotionDetail } from '@/services/promotions';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../inventory/station-access';
import type { SuspendedCompany, ViewableCompany } from '../inventory/station-access';
import { StationSearchForm } from '../inventory/station-search-form';
import { canRunDraw, canSearchByListener } from './access';
import { canManageMessagingAt } from '@/components/send-lists/access';
import { CreateSendListDialog } from '@/components/send-lists/create-list-dialog';
import type { ParticipationSendListFilters } from '@/schemas/send-lists';
import { DrawPanel } from './draw-panel';
import { describeParticipationsReadError } from './errors';
import {
  ANY_STATUS,
  DEFAULT_PARTICIPATION_STATUS,
  participationsHref,
  parseParticipationCursor,
  parseParticipationListState,
  SEARCH_NOTE_ID,
} from './list-params';
import type { ParticipationListState, ParticipationSearchParams } from './list-params';
import { ParticipationsFilters } from './participations-filters';
import { windowFor } from './programme-window';
import type { PromotionOption, QuestionFilterGroup } from './participations-filters';
import { ParticipationsGrid } from './participations-grid';
import { ExportDialog } from '@/components/reports/export-dialog';
import { participationsReportFilters } from '@/lib/reports/list-filters';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function ParticipationsPage({
  searchParams,
}: {
  searchParams: Promise<ParticipationSearchParams>;
}) {
  const t = await getTranslations('participations');
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
    return <LoadError message={describeParticipationsReadError(cause, await getTranslations('participations'))} />;
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
  // A bad cursor starts the list over rather than erroring — decodeCursor
  // (@/lib/keyset) returns null for it, including for a well-formed
  // `{"value":null,"id":"abc"}` whose id is not a uuid. That last case used to
  // reach Postgres as `id.lt."abc"` and come back 22P02, which
  // describeParticipationsReadError renders verbatim; Block 6d closed it in
  // decodeCursor itself, where every keyset screen shares the fix.
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

  /**
   * Block 30e, item 18. The Programme the selected promotion belongs to, if any.
   *
   * A DELIBERATELY NARROW failure, like the promotion picker further down: this
   * screen's purpose is the list, and a Programme schedule that cannot be read
   * must cost the band combo and nothing else. `null` means no Programme, which
   * is the ordinary case; a refusal is logged and treated the same way here,
   * because a screen with two date filters is a working screen.
   */
  let programme: PromotionSchedule | null = null;
  if (state.promotionId) {
    try {
      programme = await getPromotionShowSchedule(state.promotionId);
    } catch (cause) {
      logger.error(
        { err: cause, promotionId: state.promotionId },
        'could not read the promotion programme',
      );
    }
  }

  // The bands that START on the chosen day, and the one the operator is in. With
  // no day chosen there is no window at all: the list behaves as it always did,
  // minus the second date input.
  const dayBands = programme && state.day ? bandsOnDay(programme.rows, state.day) : [];
  const chosenBand = dayBands.find((band) => band.marker === state.bandMarker) ?? dayBands[0] ?? null;
  const programmeWindow =
    chosenBand && state.day ? windowFor(chosenBand, state.day, selected.timezone) : null;

  /**
   * D9. A day the Programme does not air is a window with NOTHING IN IT, not the
   * absence of a filter. The list is not read at all, and the draw is not offered
   * — a hat built from a state with no window would hold the whole promotion,
   * which is the fail-open shape this project keeps finding.
   */
  const programmeSilent = Boolean(programme && state.day && dayBands.length === 0);

  /**
   * D8, D10. The state every consumer downstream reads.
   *
   * `day` and `bandMarker` stay on it, so every link this render produces keeps
   * naming the day and the band; `from`/`to` carry the instants they name, and
   * the list, the draw hat and the send-list filters already read exactly those
   * two fields. That is what makes "eligible participations are only those made
   * inside the band" true of the DRAW as well, with no second mechanism.
   */
  const effective: ParticipationListState = programme
    ? { ...state, from: programmeWindow?.from, to: programmeWindow?.to }
    : state;

  let canSearch: boolean;
  let canDraw: boolean;
  let canCreateSendList: boolean;
  let page: ParticipationListPage;
  try {
    // Resolved BEFORE the list read, because its answer decides whether the
    // search term is sent at all. See ./access.ts: without members.view the
    // searched select returns nothing, and an empty page reads as "no listener
    // matched" rather than as a permission this caller does not hold.
    //
    // draws.execute goes out beside it rather than after, because unlike the
    // search it decides nothing about the read — it only decides whether the
    // Draw button renders — and two single-predicate calls in flight together
    // cost one round trip rather than two. messaging.manage (Block 29d-1,
    // Task 7 — whether the send-list button renders) joins the same batch for
    // the identical reason: a third single-predicate check that decides
    // nothing about the read itself.
    [canSearch, canDraw, canCreateSendList] = await Promise.all([
      canSearchByListener(supabase, selected.id),
      canRunDraw(supabase, selected.id),
      canManageMessagingAt(supabase, selected.id),
    ]);

    // D9. Not read at all when the Programme does not air on the chosen day: a
    // window with nothing in it is not a query worth asking, and asking it
    // WITHOUT the window is how the screen would quietly widen to the whole day.
    page = programmeSilent
      ? { rows: [], nextCursor: null, previousCursor: null, total: 0 }
      : await listParticipationsPage(
      {
        companyId: selected.id,
        promotionId: effective.promotionId,
        // ANY_STATUS is this screen's word for "do not narrow", and the service
        // has no such value: an absent status is how the query says it. The
        // constant rather than the literal, so the URL vocabulary lives in one
        // module and this comparison cannot quietly stop matching it.
        status: effective.status === ANY_STATUS ? undefined : effective.status,
        source: effective.source,
        // Block 30e, D8: the band's two instants when the promotion has a
        // Programme, and the operator's own two when it has not.
        from: effective.from,
        to: effective.to,
        // Dropped rather than forwarded when this caller cannot search. The
        // alternative — send it anyway and render whatever comes back — is
        // precisely the empty list the notice below exists to prevent.
        search: canSearch ? searchTerm : undefined,
        // Block 6c. Forwarded as they are: undefined is a third state, not a
        // default, and list_participations reads it as "both".
        answeredCorrectly: effective.answeredCorrectly,
        optionId: effective.optionId,
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
    return <LoadError message={describeParticipationsReadError(cause, await getTranslations('participations'))} />;
  }

  // Block 29d-1, Task 7. The filters CreateSendListDialog resolves — mirrored
  // field-for-field from the listParticipationsPage call above, including the
  // same two conversions that call itself makes (ANY_STATUS read as "no
  // narrowing", and the search term dropped entirely when canSearch is
  // false): a send list from this screen has to hold exactly what the screen
  // is showing, never a second, independently recomputed reading of `state`.
  const participationSendListFilters: ParticipationSendListFilters = {
    companyId: selected.id,
    promotionId: effective.promotionId,
    status: effective.status === ANY_STATUS ? undefined : effective.status,
    source: effective.source,
    // Block 30e: `effective` rather than `state` here too, for the reason this
    // comment already gives — a send list from this screen holds exactly what
    // the screen is showing, and what it is showing is the band.
    from: effective.from,
    to: effective.to,
    search: canSearch ? searchTerm : undefined,
    answeredCorrectly: effective.answeredCorrectly,
    optionId: effective.optionId,
  };

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
      hasQuiz: promotion.quizQuestionCount > 0,
    }));
    // The extra row read past the page, surfaced rather than dropped.
    promotionsCapped = promotions.nextCursor !== null;
  } catch (cause) {
    logger.error(
      { err: cause, companyId: selected.id },
      'could not read the promotions for the participations filter',
    );
    promotionsError = describeParticipationsReadError(cause, await getTranslations('participations'), 'subjectThePromotionsInThisStation');
  }

  // A promotion filter pointing at something the picker did not offer — a
  // promotion past the cap, an archived one, or a link from that promotion's own
  // record — would otherwise leave the control showing no selection at all, and
  // the next change to any other filter would silently drop the promotion the
  // operator came here for. Its name comes off the rows already fetched, which
  // costs nothing; when the filter matches no row there is no name to be had, so
  // the option says what it is instead of inventing one.
  // The chosen promotion's own record, read only when there is one chosen. It
  // carries the two things this screen needs beyond the list: the options
  // somebody could have picked, for D5's second filter, and the prize links,
  // for the draw. One read for both rather than two, because getPromotionRecord
  // already fetches both and a second narrower read would be a second query for
  // rows that were on the wire anyway.
  //
  // Its own try/catch, and DELIBERATELY quieter than the list's: a promotion
  // record that will not load costs the operator a filter and a button, not the
  // list they came here for. Logged rather than swallowed, and the controls it
  // feeds simply do not render.
  let record: PromotionDetail | null = null;
  if (state.promotionId) {
    try {
      record = await getPromotionRecord(state.promotionId, accessToken);
    } catch (cause) {
      logger.error(
        { err: cause, promotionId: state.promotionId },
        'could not read the promotion behind the participations filter',
      );
    }
  }
  // A promotion at ANOTHER Station, reachable by this caller and named in the
  // URL, would otherwise dress this screen's filters with its questions and
  // offer its prizes to a draw the list cannot be about — the list is narrowed
  // by companyId as well, so the two halves would disagree. Dropped rather than
  // corrected: the promotion picker below already says which promotion this is.
  if (record && record.companyId !== selected.id) record = null;

  const questions: QuestionFilterGroup[] = (record?.questions ?? [])
    .filter((question) => question.options.length > 0)
    .map((question) => ({
      id: question.id,
      prompt: question.prompt,
      options: question.options.map((option) => ({ id: option.id, label: option.label })),
    }));

  // What is left to draw, on the links that still have something — the same
  // shape and the same subtraction the promotion's own draws screen makes.
  const linked = (record?.prizes ?? [])
    .map((prize) => ({
      promotionPrizeId: prize.promotionPrizeId,
      prizeName: prize.prizeName,
      available: prize.linked - prize.drawn,
      requested: prize.linked - prize.drawn,
    }))
    .filter((prize) => prize.available > 0);

  if (state.promotionId && !promotionOptions.some((p) => p.id === state.promotionId)) {
    promotionOptions.unshift({
      id: state.promotionId,
      name: record?.name ?? page.rows[0]?.promotionName ?? t('thePromotionThisListIsFilteredTo'),
      // Read off the record when there is one, and false when there is not.
      // The picker not listing a promotion says nothing about whether it asks a
      // quiz — it says the picker was cut, or the promotion is archived — so
      // the answer comes from the promotion itself, and only falls back to "no"
      // when the record could not be read at all. False is the safe fallback:
      // the correct/wrong filter stays hidden rather than being offered for a
      // promotion that may have nothing to be right about.
      hasQuiz: (record?.questions ?? []).some((question) => question.kind === 'QUIZ'),
    });
  }

  return (
    <>
      <PageHeader
        title={t('participations')}
        description={t('participationsDescription')}
        // Block 8b. The filters ALREADY on this screen, translated into the
        // report's vocabulary by list-filters.ts -- never a second set the
        // dialog asks for. The operator has expressed the question by
        // filtering; asking again in another vocabulary is how the file and
        // the screen come to disagree about what was exported.
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ExportDialog
              reportType="PARTICIPATIONS"
              companyIds={[selected.id]}
              filters={participationsReportFilters(state)}
            />
            {/*
              Both conditions, not either (Task 7 brief): messaging.manage
              alone is not enough — this button is a door to the same data
              the grid below shows, and `viewable` already IS "can see the
              listing itself" (listCompanyAccess('participations.view')
              above, the same read `selected` was drawn from), so it is named
              here explicitly rather than left to the fact that `selected`
              could not exist otherwise.
            */}
            {canCreateSendList && viewable.length > 0 && (
              <CreateSendListDialog
                source="participations"
                filters={participationSendListFilters}
                companyId={selected.id}
                stationOptions={[]}
              />
            )}
          </div>
        }
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')}{' '}{viewable.length + suspended.length} {t('ofTheStationsYouCanReach')}</p>
          )}
          <StationSearchForm
            action="/participations"
            value={stationSearch ?? ''}
            preserve={{}}
            label={t('findAStation')}
          />
        </div>
      )}

      {viewable.length + suspended.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {viewable.map((company) => (
            <Link
              key={company.id}
              href={stationSwitchHref('/participations', company.id, stationSearch)}
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
              title={t('suspendedNoDataIsAvailableWhile')}
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
        state={effective}
        currentHref={participationsHref(effective, cursorParam)}
        timeZone={selected.timezone}
        promotions={promotionOptions}
        questions={questions}
        canSearchByListener={canSearch}
        programme={
          programme
            ? { showName: programme.showName, bands: dayBands, silent: programmeSilent }
            : undefined
        }
      />

      {/* D9, said where the empty list is. Without this line an operator reads a
          screen that found nothing and concludes nobody took part that day. */}
      {programmeSilent && programme && (
        <p
          className="mt-3 text-sm text-muted-foreground"
          data-testid="participation-programme-silent"
        >
          {t('theProgrammeDoesNotAirOnThatDate', { programme: programme.showName })}
        </p>
      )}

      {/* Block 6c: the draw lives beside the list it draws from.
          Rendered only with a promotion chosen and draws.execute in hand — a
          draw belongs to one promotion, and run_draw (0078) refuses without the
          code anyway, so offering the button to somebody who does not hold it
          would only be a longer road to the same refusal.

          AND NOT AT ALL when the Programme is silent (Block 30e, D9): the hat is
          built from this state, and a state with no window would hand the draw
          everyone who ever entered the promotion. */}
      {canDraw && effective.promotionId && record && !programmeSilent && (
        <div className="mt-4" data-testid="participations-draw">
          <DrawPanel
            state={effective}
            promotionId={effective.promotionId}
            promotionName={record.name}
            linked={linked}
          />
        </div>
      )}

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
              {t('showingOnlyTheEntriesThatCounted')}</p>
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
              {t('youCannotSearchByListenerAt')}{' '}
              {searchTerm
                ? t('yourSearchWasNotApplied', { term: searchTerm })
                : t('everyOtherFilterStillWorks')}
            </p>
          )}

          {promotionsCapped && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="participation-promotions-capped"
            >
              {t('thePromotionPickerListsTheFirst')}</p>
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
        // Block 24, item 6. One query for the distinct promotions of THIS page
        // — never one per row, and never a wider list_participations. Its own
        // failure is already swallowed into an empty map (the service says why),
        // so this cannot be the thing that takes the list down.
        promotionThumbs={await promotionThumbs(page.rows.map((row) => row.promotionId))}
        canFindListeners={canSearch}
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

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('participations');
  return (
    <>
      <PageHeader title={t('participations')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link href="/participations" className="text-sm text-primary underline underline-offset-2">
            {t('clearTheStationSearch')}</Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('participations');
  return (
    <>
      <PageHeader title={t('participations')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
