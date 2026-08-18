'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { STATUS_LABEL_KEYS } from '@/lib/participation-status';
import { SOURCE_LABEL_KEYS } from '../../participations/list-params';
import {
  memberSendListFiltersSchema,
  participationSendListFiltersSchema,
  requestSendListFiltersSchema,
} from '@/schemas/send-lists';
import type {
  MemberSendListFilters,
  ParticipationSendListFilters,
  RequestSendListFilters,
  SendListSource,
} from '@/schemas/send-lists';
import type { ListReach } from '@/services/send-lists';
import {
  deleteSendListAction,
  getSendListReachAction,
  renameSendListAction,
  type DeleteSendListState,
  type RenameSendListState,
} from './actions';

const INITIAL_RENAME: RenameSendListState = { status: 'idle' };
const INITIAL_DELETE: DeleteSendListState = { status: 'idle' };

/** How many columns the empty-state row has to span, Actions included. */
const COLUMN_COUNT = 9;

/**
 * A translator bound to one namespace, the shape every describe*Error function
 * in this section already takes (messages/errors.ts) -- used here for the same
 * reason: a function that receives its translator as a parameter cannot be
 * resolved back to a namespace by tests/unit/i18n/usage.test.ts's own static
 * scan, so that test skips it rather than guessing (its own comment says so).
 */
type Translator = (key: string, values?: Record<string, string>) => string;

/**
 * One row of the grid. NO `reach` FIELD (fix round 1, F5, Critical) -- page.tsx
 * no longer computes it for any row before rendering; `ReachCells` below asks
 * for one row's reach only when that row's own button is pressed, keyed on
 * `id` alone.
 */
export interface SendListGridRow {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
  kind: 'fixed' | 'living';
  source: SendListSource;
  filters: unknown;
  /** Whether this caller holds messaging.manage at THIS row's own Station -- see page.tsx's own comment for why this cannot be one flag for the whole grid. */
  canManage: boolean;
}

/** MANUAL/IMPORT only -- requestSendListFiltersSchema's own `channel` is narrower than the database's four-value enum for the reason schemas/send-lists.ts gives; the same two vocab keys participations reuses for its own equivalent field (requests-filters.tsx's own CHANNEL_LABEL_KEYS). */
const REQUEST_CHANNEL_LABEL_KEYS: Record<'MANUAL' | 'IMPORT', string> = {
  MANUAL: 'sourceManual',
  IMPORT: 'sourceImport',
};

const READ_STATUS_LABEL_KEYS: Record<'UNREAD' | 'READ' | 'CANCELLED', string> = {
  UNREAD: 'readUnread',
  READ: 'readRead',
  CANCELLED: 'readCancelled',
};

const PLAY_STATUS_LABEL_KEYS: Record<'NOT_PLAYED' | 'PLAYED' | 'CANCELLED', string> = {
  NOT_PLAYED: 'playNotPlayed',
  PLAYED: 'playPlayed',
  CANCELLED: 'playCancelled',
};

/**
 * Every translator this grid reaches into, gathered once so `formatFilters`
 * below can stay a plain function rather than a hook -- it is called from
 * inside a `.map()`, where a hook is not allowed to live.
 */
interface FilterTranslators {
  t: Translator;
  tv: Translator;
  tm: Translator;
  tp: Translator;
  tmu: Translator;
}

/**
 * The first eight characters of an id, never the whole thing: a send list's
 * filters can name a promotion, a song, a show or a question option by id
 * (`promotionId`, `songId`, `showId`, `optionId`), and resolving any of those
 * to a NAME would mean reading a table this screen's own caller may not hold
 * the permission for (music.view, promotions.view) -- messaging.view says
 * nothing about either. The id fragment is honest about being an id rather
 * than inventing a name nobody asked this caller whether they may see.
 */
function idFragment(id: string): string {
  return `#${id.slice(0, 8)}`;
}

function formatMemberFilters(filters: MemberSendListFilters, tr: FilterTranslators): string[] {
  const parts: string[] = [];
  if (filters.search) parts.push(`${tr.tm('search')}: ${filters.search}`);
  if (filters.ageMin !== undefined) parts.push(`${tr.tm('ageFrom')}: ${filters.ageMin}`);
  if (filters.ageMax !== undefined) parts.push(`${tr.tm('ageTo')}: ${filters.ageMax}`);
  if (filters.blockedOnly) parts.push(tr.tm('blockedListenersOnly'));
  if (filters.hasRulesConsent === true) parts.push(tr.tm('consentedToTheRules'));
  if (filters.hasRulesConsent === false) parts.push(tr.tm('hasNotConsented'));
  if (filters.gender === 'none') {
    parts.push(`${tr.tm('gender')}: ${tr.tm('genderNotRecorded')}`);
  } else if (filters.gender) {
    parts.push(`${tr.tm('gender')}: ${tr.tm(`gender_${filters.gender}`)}`);
  }
  if (filters.registeredFrom) parts.push(`${tr.tm('registeredFrom')}: ${filters.registeredFrom}`);
  if (filters.registeredTo) parts.push(`${tr.tm('registeredTo')}: ${filters.registeredTo}`);
  return parts;
}

function formatParticipationFilters(
  filters: ParticipationSendListFilters,
  tr: FilterTranslators,
): string[] {
  const parts: string[] = [];
  if (filters.promotionId) parts.push(`${tr.tp('promotion')}: ${idFragment(filters.promotionId)}`);
  if (filters.status) parts.push(`${tr.tp('status')}: ${tr.tv(STATUS_LABEL_KEYS[filters.status])}`);
  if (filters.source) parts.push(`${tr.tp('source')}: ${tr.tv(SOURCE_LABEL_KEYS[filters.source])}`);
  if (filters.from) parts.push(`${tr.tp('enteredFrom')}: ${filters.from}`);
  if (filters.to) parts.push(`${tr.tp('enteredUntil')}: ${filters.to}`);
  if (filters.search) parts.push(`${tr.tp('listener')}: ${filters.search}`);
  if (filters.answeredCorrectly === true) parts.push(tr.tp('answeredCorrectly'));
  if (filters.answeredCorrectly === false) parts.push(tr.tp('answeredWrongly'));
  if (filters.optionId) parts.push(`${tr.tp('chose')}: ${idFragment(filters.optionId)}`);
  return parts;
}

function formatRequestFilters(filters: RequestSendListFilters, tr: FilterTranslators): string[] {
  const parts: string[] = [];
  if (filters.songId) parts.push(`${tr.tmu('song')}: ${idFragment(filters.songId)}`);
  if (filters.showId) parts.push(`${tr.tmu('programme')}: ${idFragment(filters.showId)}`);
  if (filters.channel) {
    parts.push(`${tr.tmu('channel')}: ${tr.tv(REQUEST_CHANNEL_LABEL_KEYS[filters.channel])}`);
  }
  if (filters.search) parts.push(`${tr.tmu('listener')}: ${filters.search}`);
  if (filters.readStatus) {
    parts.push(`${tr.tmu('readStatusColumn')}: ${tr.tv(READ_STATUS_LABEL_KEYS[filters.readStatus])}`);
  }
  if (filters.playStatus) {
    parts.push(`${tr.tmu('playStatusColumn')}: ${tr.tv(PLAY_STATUS_LABEL_KEYS[filters.playStatus])}`);
  }
  return parts;
}

/**
 * The filters a list was cut from, as prose -- spec's own reason for keeping
 * `filters` on every list, FIXED included: "a list named months ago says
 * nothing on its own about who was in it" (0238's column comment).
 *
 * PARSED THROUGH THE SAME THREE SCHEMAS `listReach` itself parses `filters`
 * through (`resolveLivingListPeople`, services/send-lists.ts) -- not a second,
 * looser reading of the same jsonb. `create_send_list` stores whatever shape
 * it is given with nothing enforced at the database (0238's own comment), so
 * a row a future bug wrote with the wrong shape is read defensively here too,
 * rather than trusted.
 */
function formatFilters(row: SendListGridRow, tr: FilterTranslators): string {
  let parts: string[];
  switch (row.source) {
    case 'members': {
      const parsed = memberSendListFiltersSchema.safeParse(row.filters);
      if (!parsed.success) return tr.t('filtersCouldNotBeRead');
      parts = formatMemberFilters(parsed.data, tr);
      break;
    }
    case 'participations': {
      const parsed = participationSendListFiltersSchema.safeParse(row.filters);
      if (!parsed.success) return tr.t('filtersCouldNotBeRead');
      parts = formatParticipationFilters(parsed.data, tr);
      break;
    }
    case 'requests': {
      const parsed = requestSendListFiltersSchema.safeParse(row.filters);
      if (!parsed.success) return tr.t('filtersCouldNotBeRead');
      parts = formatRequestFilters(parsed.data, tr);
      break;
    }
    default: {
      // Exhaustiveness: a fourth send_list_source value added to 0237 without
      // a branch here is a compile error, the same guard resolveListMembers'
      // own switch (services/send-lists.ts) carries for the identical reason.
      const exhaustive: never = row.source;
      throw new Error(`Unknown send list source: ${String(exhaustive)}`);
    }
  }
  return parts.length === 0 ? tr.t('filtersNone') : parts.join(' · ');
}

/**
 * One channel's already-fetched reach. TWO STATES, RENDERED TWO WAYS: a
 * number, and `'forbidden'` (Task 5's own state -- the caller can see this
 * list but not who on it is eligible, because messaging.view and
 * members.view are two permissions a Station can hand to two different
 * people). `'forbidden'` MUST NOT render as `0` -- R5's own ruling, and the
 * reason the check below is `=== 'forbidden'` rather than falsy. There is no
 * third, per-channel `'error'` state any more (fix round 1, F5): a fetch
 * failure is a property of the WHOLE row's reach request, not of one
 * channel, and `ReachCells` below handles that one level up instead.
 */
function ChannelReachValue({ value, t }: { value: number | 'forbidden'; t: Translator }) {
  if (value === 'forbidden') {
    return (
      <span className="text-muted-foreground" title={t('reachNotPermittedHelp')}>
        {t('reachNotPermitted')}
      </span>
    );
  }
  return <span>{value.toLocaleString()}</span>;
}

type ReachState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; reach: ListReach }
  | { status: 'error'; message: string };

/**
 * The three reach columns for ONE row (People, WhatsApp, E-mail), fetched on
 * demand rather than automatically (fix round 1, F5, Critical). The first
 * version of this screen asked Task 5's `listReach` for every row before the
 * page could render at all; `listSendLists`' own header (services/send-lists.ts)
 * has the round-trip count that made that unbounded. Returns three sibling
 * `<TableCell>`s, not a wrapper around them, because it is spliced directly
 * between the Kind and Built-from cells in the row below -- the same reason
 * every other per-row cell in this file is a bare fragment of table markup
 * rather than an element that would nest an extra `<td>`.
 *
 * `getSendListReachAction` is called directly from `reveal`'s `onClick`,
 * never through `useActionState`, the same shape `template-dialog.tsx`'s own
 * `runPreview` uses for `previewCampaignEmailAction` -- a read that is not a
 * form submission has no form to submit.
 */
function ReachCells({ listId, t }: { listId: string; t: Translator }) {
  const [state, setState] = useState<ReachState>({ status: 'idle' });

  async function reveal() {
    setState({ status: 'loading' });
    const result = await getSendListReachAction(listId);
    setState(
      result.status === 'ok'
        ? { status: 'ok', reach: result.reach }
        : { status: 'error', message: result.message },
    );
  }

  if (state.status === 'idle') {
    return (
      <>
        <TableCell>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={reveal}
            key="reveal-reach"
            data-testid="send-list-reveal-reach"
          >
            {t('showReachButton')}
          </Button>
        </TableCell>
        <TableCell />
        <TableCell />
      </>
    );
  }

  if (state.status === 'loading') {
    return (
      <>
        <TableCell className="text-sm text-muted-foreground">{t('reachLoading')}</TableCell>
        <TableCell />
        <TableCell />
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <TableCell colSpan={3} className="text-sm text-destructive">
        {state.message}
      </TableCell>
    );
  }

  const { reach } = state;
  return (
    <>
      <TableCell>{reach.people.toLocaleString()}</TableCell>
      <TableCell>
        <ChannelReachValue value={reach.whatsapp} t={t} />
      </TableCell>
      <TableCell>
        <ChannelReachValue value={reach.email} t={t} />
      </TableCell>
    </>
  );
}

/**
 * Every send list this caller's messaging.view reaches (page.tsx's own
 * comment explains why this is not narrowed to one Station the way
 * marketing-grid.tsx's own read is), ONE BOUNDED PAGE AT A TIME since fix
 * round 1 (F5) -- unlike marketing-grid.tsx's own table, which design D6
 * really does leave unpaginated because a Station's marketing templates are
 * few and never grow without a human writing a new one. Send lists share
 * that "named, hand-built, not one row per event" shape, but nothing stops
 * their count from growing over months the way a Station's templates don't,
 * so `listSendLists` now pages (services/send-lists.ts's own header) and
 * page.tsx renders an "older lists" link when there is another page.
 *
 * Actions: rename, delete -- gated per row on `canManage`, never on a single
 * flag for the whole grid, because messaging.manage is Station-scoped and this
 * grid can hold rows from more than one Station at once.
 */
export function ListsGrid({ rows }: { rows: SendListGridRow[] }) {
  const t = useTranslations('templates');
  const tn = useTranslations('nav');
  const tv = useTranslations('vocab');
  const tm = useTranslations('members');
  const tp = useTranslations('participations');
  const tmu = useTranslations('music');

  const tr: FilterTranslators = { t, tv, tm, tp, tmu };

  const [renaming, setRenaming] = useState<SendListGridRow | null>(null);
  const [deleting, setDeleting] = useState<SendListGridRow | null>(null);

  // Which screen a list was built from, in the SAME words that screen's own
  // sidebar entry uses (shell.ts) -- reusing `nav`'s own three keys rather
  // than a fourth copy of "Members"/"Requests"/"Participations" is what keeps
  // this column and the sidebar from ever disagreeing about what to call one.
  const BUILT_FROM_LABEL: Record<SendListSource, string> = {
    members: tn('members'),
    participations: tn('participations'),
    requests: tn('requests'),
  };

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('listNameLabel')}</TableHead>
            <TableHead>{t('stationColumnLabel')}</TableHead>
            <TableHead>{t('kindColumnLabel')}</TableHead>
            <TableHead>{t('peopleColumnLabel')}</TableHead>
            <TableHead>{t('channelWhatsapp')}</TableHead>
            <TableHead>{t('channelEmail')}</TableHead>
            <TableHead>{t('builtFromColumnLabel')}</TableHead>
            <TableHead>{t('filtersColumnLabel')}</TableHead>
            <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                {t('noSendListsYet', {
                  members: tn('members'),
                  requests: tn('requests'),
                  participations: tn('participations'),
                })}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id} data-testid="send-list-row">
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell>{row.companyName}</TableCell>
                <TableCell>{row.kind === 'fixed' ? t('listKindFixed') : t('listKindLiving')}</TableCell>
                <ReachCells listId={row.id} t={t} />
                <TableCell>{BUILT_FROM_LABEL[row.source]}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatFilters(row, tr)}</TableCell>
                <TableCell className="sticky right-0 bg-background">
                  {row.canManage && (
                    <DropdownMenu
                      label={t('actionsForList', { name: row.name })}
                      trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                    >
                      <DropdownMenuItem onSelect={() => setRenaming(row)}>
                        {t('renameListButton')}
                      </DropdownMenuItem>
                      <DropdownMenuItem destructive onSelect={() => setDeleting(row)}>
                        {t('deleteListButton')}
                      </DropdownMenuItem>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {renaming && <RenameSendListDialog list={renaming} onClose={() => setRenaming(null)} />}
      {deleting && <DeleteSendListDialog list={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

/**
 * The name field lives in `DialogBody`; the submit button lives in
 * `DialogFooter` and reaches it through `form={formId}` rather than nesting
 * the footer inside the form -- the shape `template-dialog.tsx`'s own
 * `formId` already establishes for a dialog with a real field to submit,
 * unlike `ArchiveMarketingTemplateDialog`'s narrower form (a hidden id and
 * nothing else), which `DeleteSendListDialog` below follows instead.
 */
function RenameSendListDialog({ list, onClose }: { list: SendListGridRow; onClose: () => void }) {
  const t = useTranslations('templates');
  const titleId = useId();
  const formId = useId();
  const [state, action, pending] = useActionState(renameSendListAction, INITIAL_RENAME);

  useEffect(() => {
    if (state.status === 'renamed') onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('renameThisSendList')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <form id={formId} action={action}>
          <input type="hidden" name="listId" value={list.id} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('listNameLabel')}</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- opened by an explicit click, never on page load */}
            <Input name="name" defaultValue={list.name} required maxLength={200} autoFocus />
          </label>
        </form>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} key="cancel">
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          form={formId}
          disabled={pending}
          key="submit"
          data-testid="send-list-rename-confirm"
        >
          {pending ? t('saving') : t('save')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The narrower form shape: one hidden id, no visible field, so the form wraps
 * only the submit button the same way `ArchiveMarketingTemplateDialog`'s own
 * does -- no `formId` indirection needed when there is nothing else in the
 * dialog body for the form to hold apart from what it already submits.
 */
function DeleteSendListDialog({ list, onClose }: { list: SendListGridRow; onClose: () => void }) {
  const t = useTranslations('templates');
  const titleId = useId();
  const [state, action, pending] = useActionState(deleteSendListAction, INITIAL_DELETE);

  useEffect(() => {
    if (state.status === 'deleted') onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('deleteThisSendList')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          <strong>{list.name}</strong>: {t('deleteSendListWarning')}
        </p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} key="cancel">
          {t('cancel')}
        </Button>
        <form action={action}>
          <input type="hidden" name="listId" value={list.id} />
          <Button type="submit" disabled={pending} key="delete" data-testid="send-list-delete-confirm">
            {pending ? t('removing') : t('removeAnyway')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}
