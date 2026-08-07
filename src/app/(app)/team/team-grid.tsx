'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import { TEAM_TABS, type TeamTab } from '@/lib/record-params';
import { removeMemberAction, revokeAction, type TeamActionState } from './actions';
import { InviteForm } from './invite-form';
import {
  displayPerson,
  TeamRecordDialog,
  type RoleOption,
  type StationOption,
  type TeamRow,
} from './team-record-dialog';

/** How many columns the empty-state row has to span, actions included. */
const COLUMN_COUNT = 5;

const IDLE: TeamActionState = { status: 'idle' };

/**
 * The roster, and the host for the record dialog over it.
 *
 * No paging, deliberately and unchanged from Block 3b: at the owner's real
 * scale this screen fits, and TEAM_SAFETY_BOUND in page.tsx is a net against an
 * Organization far outside that shape rather than a page size. What this owns
 * is the row set, so that a grant, a promotion, a removal or a fresh invitation
 * redraws one line instead of the whole screen.
 */
export function TeamGrid({
  initialRows,
  organizationId,
  roles,
  manageableStations,
  invitableStations,
  initialRecord,
}: {
  initialRows: TeamRow[];
  organizationId: string;
  roles: RoleOption[];
  manageableStations: StationOption[];
  invitableStations: StationOption[];
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('team');
  const [grid, setGrid] = useState<RowState<TeamRow>>({
    rows: initialRows,
    total: initialRows.length,
  });

  // A navigation re-runs the server component and hands down a fresh roster.
  // That is the one moment local patches stop describing the rows they were
  // made against, so they are dropped rather than merged (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRows, total: initialRows.length });
  }, [initialRows]);

  const { recordId, tab, open, setTab, close } = useRecordDialog(TEAM_TABS, initialRecord);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<TeamRow | null>(null);

  const openRow = recordId ? (grid.rows.find((row) => row.id === recordId) ?? null) : null;
  const roleNameById = new Map(roles.map((r) => [r.id, r.name]));

  return (
    <>
      <div className="mt-4 flex justify-end">
        <Button type="button" onClick={() => setInviting(true)} data-testid="team-invite">
          {t('invite')}</Button>
      </div>

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('person')}</TableHead>
              <TableHead>{t('state')}</TableHead>
              <TableHead>{t('organizationRole')}</TableHead>
              <TableHead>{t('stations')}</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {t('nobodyHereYet')}</TableCell>
              </TableRow>
            ) : (
              grid.rows.map((row) => (
                <TableRow
                  key={row.id}
                  // Two testids, one per kind, because the journeys that drive
                  // this screen ask for one or the other specifically.
                  data-testid={row.kind === 'member' ? 'member-row' : 'invitation-row'}
                >
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      onClick={() => open(row.id)}
                      className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {displayPerson(row)}
                    </button>
                  </TableCell>
                  <TableCell>
                    {row.kind === 'invitation' ? (
                      <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                        {t('invitationPending')}</span>
                    ) : (
                      t('active')
                    )}
                  </TableCell>
                  <TableCell>
                    {row.kind === 'invitation'
                      ? row.isOwner
                        ? t('owner')
                        : // roles_select_org_member filters deleted_at is null, so a
                          // role archived after the invitation was sent comes back
                          // missing here — which is also exactly the case
                          // validate_invitation refuses on acceptance, so this
                          // fallback must not say "Member".
                          (roleNameById.get(row.roleId ?? '') ?? t('roleUnavailable'))
                      : row.orgRole === 'owner'
                        ? t('owner')
                        : t('member')}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.kind === 'invitation'
                      ? t('onAcceptance')
                      : row.orgRole === 'owner'
                        ? t('everyStation')
                        : t('stationsLabel', { count: row.access.length })}
                  </TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      {/* An "open" affordance, not an edit one: there is no
                          editable field on either tab. Same icon and same place
                          as every other grid, because it does the same thing —
                          it opens the record. */}
                      <button
                        type="button"
                        aria-label={`Open ${displayPerson(row)}`}
                        onClick={() => open(row.id, 'person')}
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      <DropdownMenu
                        label={`Actions for ${displayPerson(row)}`}
                        trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                      >
                        {row.kind === 'member' ? (
                          <>
                            <DropdownMenuItem onSelect={() => open(row.id, 'access')}>
                              {t('stationAccess')}</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive onSelect={() => setRemoving(row)}>
                              {t('removeFromOrganization')}</DropdownMenuItem>
                          </>
                        ) : (
                          <DropdownMenuItem destructive onSelect={() => setRemoving(row)}>
                            {t('revokeInvitation')}</DropdownMenuItem>
                        )}
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <TableFooter>
          <span className="text-muted-foreground" data-testid="page-total">
            {grid.total} {t('peopleLabel', { count: grid.total ?? 0 })}
          </span>
        </TableFooter>
      </div>

      <TeamRecordDialog
        open={recordId !== null}
        row={openRow}
        missing={recordId !== null && openRow === null}
        roles={roles}
        manageableStations={manageableStations}
        tab={(tab as TeamTab) ?? 'person'}
        onTab={setTab}
        onClose={close}
        onPatched={(row) => setGrid((current) => applyRowPatch(current, { kind: 'save', row }))}
      />

      <InviteDialog
        open={inviting}
        organizationId={organizationId}
        roles={roles}
        stations={invitableStations}
        onClose={() => setInviting(false)}
        onInvited={(row) => setGrid((current) => applyRowPatch(current, { kind: 'create', row }))}
      />

      {removing && (
        <RemoveDialog
          row={removing}
          onCancel={() => setRemoving(null)}
          onRemoved={(id) => {
            setRemoving(null);
            setGrid((current) => applyRowPatch(current, { kind: 'remove', id }));
          }}
        />
      )}
    </>
  );
}

/**
 * Removal and revocation share a dialog because they are the same shape — one
 * confirmation, one irreversible-enough write, one row leaving the list — and
 * differ only in which sentence is true.
 *
 * Neither is softened. Removing someone cuts their access on their very next
 * request, with no sign-out, because the RLS helpers query these tables on
 * every check (remove_member, 0011). Revoking is final for the link that was
 * sent: the token is stored only as a hash, so a revoked invitation cannot be
 * reinstated, only replaced by a new one.
 */
function RemoveDialog({
  row,
  onCancel,
  onRemoved,
}: {
  row: TeamRow;
  onCancel: () => void;
  onRemoved: (id: string) => void;
}) {
  const t = useTranslations('team');
  const titleId = useId();
  const isInvitation = row.kind === 'invitation';
  const [state, action, pending] = useActionState(
    isInvitation ? revokeAction : removeMemberAction,
    IDLE,
  );

  useEffect(() => {
    if (state.status === 'done') onRemoved(row.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>
          {isInvitation ? t('revokeThisInvitation') : t('removeThisPerson')}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {isInvitation ? (
            <>
              {t('theLinkSentTo')}{' '}<strong>{row.email}</strong> {t('stopsWorkingImmediatelyAndCannotBe')}</>
          ) : (
            <>
              <strong>{displayPerson(row)}</strong> {t('losesEveryStationInThisOrganization')}</>
          )}
        </p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}</Button>
        <form action={action}>
          <input
            type="hidden"
            name={isInvitation ? 'invitationId' : 'membershipId'}
            value={row.entityId}
          />
          <Button type="submit" disabled={pending} data-testid="team-remove-confirm">
            {pending ? t('working') : isInvitation ? t('revokeInvitationAction') : t('remove')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}

function InviteDialog({
  open,
  organizationId,
  roles,
  stations,
  onClose,
  onInvited,
}: {
  open: boolean;
  organizationId: string;
  roles: RoleOption[];
  stations: StationOption[];
  onClose: () => void;
  onInvited: (row: TeamRow) => void;
}) {
  const t = useTranslations('team');
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{t('inviteAColleague')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('theyChooseTheirOwnPasswordSo')}</p>
        {/* The dialog stays open after a successful invitation on purpose: the
            accept URL is shown once and cannot be shown again, so closing over
            it would lose the one copy that exists. */}
        <InviteForm
          organizationId={organizationId}
          roles={roles}
          companies={stations}
          onInvited={(invitation) =>
            onInvited({
              id: `invitation:${invitation.id}`,
              kind: 'invitation',
              entityId: invitation.id,
              userId: null,
              email: invitation.email,
              fullName: null,
              orgRole: null,
              isOwner: invitation.isOwner,
              roleId: invitation.roleId,
              expiresAt: invitation.expiresAt,
              access: [],
            })
          }
        />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
