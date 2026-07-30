'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  PageControls,
  SortLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import { MEMBER_TABS, type MemberTab } from '@/lib/record-params';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import type { MemberDetail, MemberListRow } from '@/services/members';
import { archiveMemberAction, type ArchiveMemberState } from './actions';
import { ageFromBirthDate, formatDate } from './format';
import { hasActiveFilters, membersHref } from './list-params';
import type { MemberListState } from './list-params';
import { MemberRecordDialog } from './member-record-dialog';
import { RegisterMemberForm } from './register-member-form';
import type { SuspendedCompany, ViewableCompany } from '../inventory/station-access';

/** How many columns the empty-state row has to span, actions included. */
const COLUMN_COUNT = 9;

export interface MemberPowers {
  create: boolean;
  edit: boolean;
  block: boolean;
  archive: boolean;
  erase: boolean;
}

const INITIAL_ARCHIVE: ArchiveMemberState = { status: 'idle' };

/** What the grid shows for a row whose name is absent or erased. */
function displayName(member: MemberListRow): string {
  if (member.anonymizedAt) return 'Personal data erased';
  return member.fullName ?? 'Unnamed listener';
}

/**
 * The audience grid, and the host for everything that opens over it.
 *
 * It owns the rows and the total so that saving, archiving and registering can
 * patch them without the page being re-rendered from the server — the promise
 * this block exists to keep. `page.tsx` still runs the keyset query and hands
 * the first page in; nothing here fetches a list, ever.
 */
export function MembersGrid({
  initialRows,
  initialTotal,
  state,
  previousHref,
  nextHref,
  powers,
  registrableStations,
  suspendedStations,
  initialRecord,
}: {
  initialRows: MemberListRow[];
  initialTotal: number | null;
  state: MemberListState;
  previousHref: string | null;
  nextHref: string | null;
  powers: MemberPowers;
  registrableStations: ViewableCompany[];
  suspendedStations: SuspendedCompany[];
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const [grid, setGrid] = useState<RowState<MemberListRow>>({
    rows: initialRows,
    total: initialTotal,
  });

  // A navigation — a new page, filter or sort — re-runs the server component
  // and hands down a new first page. That is the ONE moment position and
  // filter membership are re-evaluated (src/lib/row-patch.ts), so local
  // patches are dropped here rather than merged into rows they no longer
  // describe.
  useEffect(() => {
    setGrid({ rows: initialRows, total: initialTotal });
  }, [initialRows, initialTotal]);

  const { recordId, tab, open, setTab, close } = useRecordDialog(MEMBER_TABS, initialRecord);
  const [archiving, setArchiving] = useState<MemberListRow | null>(null);
  const [registering, setRegistering] = useState(false);
  /** The listener whose record was opened because they had just been registered. */
  const pendingCreate = useRef<string | null>(null);

  function patchFromDetail(detail: MemberDetail) {
    setGrid((current) => {
      const existing = current.rows.find((row) => row.id === detail.id);
      // blocked and createdAt are not editable and are not re-read here: the
      // save could not have changed either.
      const row: MemberListRow = {
        id: detail.id,
        fullName: detail.fullName,
        phone: detail.phone,
        email: detail.email,
        cpfLastDigits: detail.cpfLastDigits,
        birthDate: detail.birthDate,
        city: detail.city,
        anonymizedAt: detail.anonymizedAt,
        createdAt: detail.createdAt,
        blocked: existing?.blocked ?? false,
      };
      return applyRowPatch(current, { kind: 'save', row });
    });
  }

  /**
   * A listener registered a moment ago. Their record is opened on the id the
   * registration returned, and the row is taken from THAT read rather than
   * from a second one made here — two reads of the same record, fired in the
   * same tick, is one more round trip than the screen needs and leaves the
   * dialog waiting behind its own duplicate.
   */
  function prependFromRecord(detail: MemberDetail) {
    if (pendingCreate.current !== detail.id) return;
    pendingCreate.current = null;
    setGrid((current) =>
      applyRowPatch(current, {
        kind: 'create',
        row: {
          id: detail.id,
          fullName: detail.fullName,
          phone: detail.phone,
          email: detail.email,
          cpfLastDigits: detail.cpfLastDigits,
          birthDate: detail.birthDate,
          city: detail.city,
          anonymizedAt: detail.anonymizedAt,
          createdAt: detail.createdAt,
          // A listener registered a moment ago cannot be blocked yet.
          blocked: false,
        },
      }),
    );
  }

  const nameSorted = state.sort === 'name';
  const registeredSorted = state.sort === 'created';
  const ariaSort = (sorted: boolean) =>
    sorted ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <>
      {powers.create && (
        <div className="mt-4 flex justify-end">
          <Button type="button" onClick={() => setRegistering(true)} data-testid="member-create">
            Register listener
          </Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort(nameSorted)}>
                <SortLink
                  href={sortHrefFor(state, 'name')}
                  active={nameSorted}
                  direction={nameSorted ? state.direction : 'asc'}
                >
                  Name
                </SortLink>
              </TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>E-mail</TableHead>
              <TableHead>CPF</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>City</TableHead>
              <TableHead aria-sort={ariaSort(registeredSorted)}>
                <SortLink
                  href={sortHrefFor(state, 'created')}
                  active={registeredSorted}
                  direction={registeredSorted ? state.direction : 'desc'}
                >
                  Registered
                </SortLink>
              </TableHead>
              <TableHead>Block state</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                {/* Two different facts, kept apart: nobody is registered yet,
                    and nobody matches what was asked for. */}
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {hasActiveFilters(state)
                    ? 'No listener matches these filters.'
                    : 'No listener registered yet at a Station you can reach.'}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((member) => {
                const age = ageFromBirthDate(member.birthDate);
                const name = displayName(member);
                return (
                  <TableRow key={member.id} data-testid="member-row">
                    <TableCell className="font-medium">
                      <button
                        type="button"
                        onClick={() => open(member.id)}
                        className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {name}
                      </button>
                    </TableCell>
                    <TableCell>{member.phone ?? '—'}</TableCell>
                    <TableCell>{member.email ?? '—'}</TableCell>
                    <TableCell>{member.cpfLastDigits ? `···${member.cpfLastDigits}` : '—'}</TableCell>
                    <TableCell>{age === null ? '—' : age}</TableCell>
                    <TableCell>{member.city ?? '—'}</TableCell>
                    <TableCell>{formatDate(member.createdAt)}</TableCell>
                    <TableCell>
                      {member.blocked ? (
                        <span
                          data-testid="member-blocked-badge"
                          className="rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive"
                        >
                          Blocked
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    {/* Pinned: this table scrolls sideways, and actions that
                        scroll out of reach are not actions. */}
                    <TableCell className="sticky right-0 bg-background">
                      <div className="flex items-center justify-end gap-1">
                        {powers.edit && (
                          <button
                            type="button"
                            aria-label={`Edit ${name}`}
                            onClick={() => open(member.id, 'data')}
                            className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          >
                            <Pencil className="size-4" aria-hidden="true" />
                          </button>
                        )}
                        {(powers.block || powers.archive || powers.erase) && (
                          <DropdownMenu
                            label={`Actions for ${name}`}
                            trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                          >
                            {powers.block && (
                              <DropdownMenuItem onSelect={() => open(member.id, 'blocks')}>
                                Block listener…
                              </DropdownMenuItem>
                            )}
                            {powers.archive && (
                              <DropdownMenuItem onSelect={() => setArchiving(member)}>
                                Archive listener…
                              </DropdownMenuItem>
                            )}
                            {powers.erase && (powers.block || powers.archive) && (
                              <DropdownMenuSeparator />
                            )}
                            {powers.erase && (
                              <DropdownMenuItem destructive onSelect={() => open(member.id, 'data')}>
                                Erase personal data…
                              </DropdownMenuItem>
                            )}
                          </DropdownMenu>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        <PageControls
          total={grid.total}
          label={
            grid.total === null
              ? 'Not counted while the rules-consent filter is on'
              : grid.total === 1
                ? 'listener'
                : 'listeners'
          }
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      <MemberRecordDialog
        recordId={recordId}
        tab={(tab as MemberTab) ?? 'data'}
        powers={{ edit: powers.edit, block: powers.block, erase: powers.erase }}
        onTab={setTab}
        onClose={close}
        onSaved={patchFromDetail}
        onLoaded={prependFromRecord}
        onBlocked={(memberId) =>
          setGrid((current) => {
            const row = current.rows.find((candidate) => candidate.id === memberId);
            if (!row) return current;
            return applyRowPatch(current, { kind: 'save', row: { ...row, blocked: true } });
          })
        }
      />

      {archiving && (
        <ArchiveDialog
          member={archiving}
          onCancel={() => setArchiving(null)}
          onArchived={(id) => {
            setArchiving(null);
            setGrid((current) => applyRowPatch(current, { kind: 'remove', id }));
          }}
        />
      )}

      <RegisterDialog
        open={registering}
        stations={registrableStations}
        suspended={suspendedStations}
        onClose={() => setRegistering(false)}
        onRegistered={(memberId) => {
          setRegistering(false);
          // The control that reports this is labelled "View listener", so it
          // opens the listener. Registering somebody is almost always followed
          // by recording their consent, which is a tab of the record that just
          // came into existence — and the record's own read is what puts the
          // new row on the list (prependFromRecord).
          pendingCreate.current = memberId;
          open(memberId);
        }}
        onOpenExisting={(memberId) => {
          setRegistering(false);
          open(memberId);
        }}
      />
    </>
  );
}

/** Kept local so the grid never imports the page's own href helper twice. */
function sortHrefFor(state: MemberListState, sort: 'name' | 'created'): string {
  const direction =
    state.sort === sort ? (state.direction === 'asc' ? 'desc' : 'asc') : sort === 'name' ? 'asc' : 'desc';
  return membersHref({ ...state, sort, direction });
}

/**
 * The confirmation says archiving cannot be undone, and that is literally true:
 * members_select_reachable (0035) hides an archived listener from every read,
 * for every caller, so nothing in this app can show or restore it afterwards.
 * Softening this copy would make it a lie.
 */
function ArchiveDialog({
  member,
  onCancel,
  onArchived,
}: {
  member: MemberListRow;
  onCancel: () => void;
  onArchived: (id: string) => void;
}) {
  const titleId = useId();
  const [state, action, pending] = useActionState(archiveMemberAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onArchived(member.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>Archive this listener?</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {displayName(member)} leaves every list in the app.{' '}
          <strong>This cannot be undone here</strong> — not by you, not by support. Only direct
          database access can restore it.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          To bar someone from draws without archiving, use Block instead.
        </p>
        {state.status === 'error' && (
          <p className="mt-3 text-sm text-destructive">{state.message}</p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <form action={action}>
          <input type="hidden" name="memberId" value={member.id} />
          <Button type="submit" disabled={pending} data-testid="member-archive-confirm">
            {pending ? 'Archiving…' : 'Archive anyway'}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}

function RegisterDialog({
  open,
  stations,
  suspended,
  onClose,
  onRegistered,
  onOpenExisting,
}: {
  open: boolean;
  stations: ViewableCompany[];
  suspended: SuspendedCompany[];
  onClose: () => void;
  onRegistered: (memberId: string) => void;
  onOpenExisting: (memberId: string) => void;
}) {
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>Register a listener</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {/* Still two steps inside the dialog: the duplicate check first, the
            form second. That check is what keeps one person from existing
            twice in an Organization — it is not a step to drop because the
            form moved into a dialog. */}
        <RegisterMemberForm
          stations={stations}
          suspended={suspended}
          onRegistered={onRegistered}
          onOpenExisting={onOpenExisting}
        />
      </DialogBody>
    </Dialog>
  );
}
