'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/input';
import {
  assignCompanyRoleAction,
  changeOrgRoleAction,
  removeCompanyAccessAction,
  type TeamActionState,
} from './actions';

export const TEAM_TABS = ['person', 'access'] as const;
export type TeamTab = (typeof TEAM_TABS)[number];

const TAB_LABELS: Record<TeamTab, string> = {
  person: 'Person',
  access: 'Per-Station access',
};

const IDLE: TeamActionState = { status: 'idle' };

export interface StationOption {
  id: string;
  name: string;
}

export interface RoleOption {
  id: string;
  name: string;
}

/**
 * One line of the Team screen: either somebody who belongs to the Organization
 * or an invitation nobody has accepted yet. They share a grid because they are
 * the same question — who is in this Organization, and what may they do —
 * answered at two stages, and the operations beside them differ rather than
 * their place in the list.
 */
export interface TeamRow {
  /** 'member:<uuid>' or 'invitation:<uuid>': unique across both kinds, which is what applyRowPatch keys on. */
  id: string;
  kind: 'member' | 'invitation';
  /** The organization_memberships id, or the invitations id. */
  entityId: string;
  /** Null for an invitation — there is no account yet. */
  userId: string | null;
  email: string;
  fullName: string | null;
  /** The Organization-level role. Null for an invitation. */
  orgRole: 'owner' | 'member' | null;
  /** An invitation for an owner carries no role. */
  isOwner: boolean;
  /** The role this invitation was sent at. Null for a member row and for an owner invitation. */
  roleId: string | null;
  expiresAt: string | null;
  /** Live company_memberships for this person, one per Station they can reach. */
  access: { companyId: string; roleId: string }[];
}

export function displayPerson(row: TeamRow): string {
  return row.fullName ? `${row.fullName} — ${row.email}` : row.email;
}

/**
 * One person's record, over the roster rather than inline in it.
 *
 * The Person tab has no Save button, and that is a finding rather than an
 * omission: no migration defines a rename or an update_profile, and a person's
 * name and e-mail belong to that person, not to whoever administers them. What
 * the tabs carry instead are the operations — the Organization role here, the
 * per-Station grants next door — each of which is a write in its own right
 * rather than a field of a record being saved.
 *
 * Nothing is fetched when this opens: page.tsx already read every field it
 * shows.
 */
export function TeamRecordDialog({
  open,
  row,
  missing,
  roles,
  manageableStations,
  tab,
  onTab,
  onClose,
  onPatched,
}: {
  open: boolean;
  row: TeamRow | null;
  /** An address that named nobody on this screen. */
  missing?: boolean;
  roles: RoleOption[];
  manageableStations: StationOption[];
  tab: TeamTab;
  onTab: (tab: TeamTab) => void;
  onClose: () => void;
  onPatched: (row: TeamRow) => void;
}) {
  const titleId = useId();

  if (missing || !row) {
    // The Team screen lists everyone in the Organization — no paging for a row
    // to hide on — so an address naming nobody is either a person who is not
    // here or one in an Organization this caller cannot see. The two collapse
    // into one sentence for the same reason the audience record's do.
    return (
      <Dialog open={open} onClose={onClose} labelledBy={titleId} className="max-w-lg">
        <DialogHeader>
          <DialogTitle id={titleId}>Person</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-destructive">
            Nobody here by that address, or you do not have permission to see them.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  const roleNameById = new Map(roles.map((r) => [r.id, r.name]));

  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <div className="flex flex-col gap-1">
          <DialogTitle id={titleId}>{row.fullName ?? row.email}</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {row.kind === 'invitation'
              ? `Invitation pending · expires ${formatDate(row.expiresAt)}`
              : row.orgRole === 'owner'
                ? 'Owner'
                : 'Member'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      <div role="tablist" aria-label="Record sections" className="flex gap-1 border-b px-5">
        {TEAM_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => onTab(name)}
            className={
              tab === name
                ? 'border-b-2 border-primary px-3 py-2 text-sm font-medium'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
            }
          >
            {TAB_LABELS[name]}
          </button>
        ))}
      </div>

      <DialogBody>
        {tab === 'person' && (
          <div className="flex flex-col gap-4">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Name</dt>
                <dd>{row.fullName ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">E-mail</dt>
                <dd>{row.email}</dd>
              </div>
              {row.kind === 'invitation' && (
                <>
                  <div>
                    <dt className="text-xs text-muted-foreground">Invited as</dt>
                    <dd>
                      {row.isOwner
                        ? 'Owner'
                        : (roleNameById.get(row.roleId ?? '') ?? 'Role unavailable')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Expires</dt>
                    <dd>{formatDate(row.expiresAt)}</dd>
                  </div>
                </>
              )}
            </dl>

            {row.kind === 'member' && (
              <OrgRoleControl
                row={row}
                onChanged={(orgRole) =>
                  onPatched({
                    ...row,
                    orgRole,
                    // change_org_role (0017) soft-deletes every company_membership
                    // this person holds when it promotes them: an owner reaches
                    // each Station by ownership and must not also sit under a
                    // role. The record has to show that, or the access tab would
                    // still list grants the database has just retired.
                    access: orgRole === 'owner' ? [] : row.access,
                  })
                }
              />
            )}

            {row.kind === 'invitation' && (
              <p className="text-sm text-muted-foreground">
                Nothing here can be changed. To send this person in at a different role or into
                different Stations, revoke this invitation and send another.
              </p>
            )}
          </div>
        )}

        {tab === 'access' && (
          <>
            {row.kind === 'invitation' ? (
              <p className="text-sm text-muted-foreground">
                Station access is granted when this invitation is accepted — the Stations it was
                sent for are fixed in the invitation itself.
              </p>
            ) : row.orgRole === 'owner' ? (
              // An owner holds no company_memberships row by design: mapping the
              // Station list for them would render every one as "No access",
              // which is false — they reach all of them by ownership. And
              // assign_company_role refuses to give the owner a role at all, so
              // there is nothing here for a control to do.
              <p className="text-sm text-muted-foreground" data-testid="owner-access-label">
                Owner — full access to every Station
              </p>
            ) : roles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No roles yet. Create one on the Roles screen, then grant Station access here.
              </p>
            ) : manageableStations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Station here is one you may administer.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {manageableStations.map((station) => (
                  <StationAccessRow
                    key={station.id}
                    station={station}
                    roles={roles}
                    userId={row.userId as string}
                    assignedRoleId={
                      row.access.find((a) => a.companyId === station.id)?.roleId ?? null
                    }
                    onAssigned={(roleId) =>
                      onPatched({
                        ...row,
                        access: [
                          ...row.access.filter((a) => a.companyId !== station.id),
                          { companyId: station.id, roleId },
                        ],
                      })
                    }
                    onRemoved={() =>
                      onPatched({
                        ...row,
                        access: row.access.filter((a) => a.companyId !== station.id),
                      })
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Owner or Member, for the Organization as a whole. An operation rather than a
 * field being saved — which is why it applies on its own button and reports its
 * own outcome, instead of riding along with a record save this tab does not have.
 */
function OrgRoleControl({
  row,
  onChanged,
}: {
  row: TeamRow;
  onChanged: (role: 'owner' | 'member') => void;
}) {
  const [state, action, pending] = useActionState(changeOrgRoleAction, IDLE);
  const [role, setRole] = useState<'owner' | 'member'>(row.orgRole ?? 'member');

  useEffect(() => {
    if (state.status === 'done') onChanged(role);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 border-t pt-4">
      <input type="hidden" name="membershipId" value={row.entityId} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Role in the Organization</span>
        <Select
          name="role"
          value={role}
          onChange={(event) => setRole(event.target.value as 'owner' | 'member')}
          className="h-9 w-40 text-sm"
        >
          <option value="owner">Owner</option>
          <option value="member">Member</option>
        </Select>
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? 'Applying…' : 'Apply'}
      </Button>
      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}

/** One Station, with the role this person holds there and the two ways to change it. */
function StationAccessRow({
  station,
  roles,
  userId,
  assignedRoleId,
  onAssigned,
  onRemoved,
}: {
  station: StationOption;
  roles: RoleOption[];
  userId: string;
  assignedRoleId: string | null;
  onAssigned: (roleId: string) => void;
  onRemoved: () => void;
}) {
  const [assignState, assign, assigning] = useActionState(assignCompanyRoleAction, IDLE);
  const [removeState, remove, removing] = useActionState(removeCompanyAccessAction, IDLE);
  const [roleId, setRoleId] = useState(assignedRoleId ?? '');

  useEffect(() => {
    if (assignState.status === 'done' && roleId) onAssigned(roleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignState]);

  useEffect(() => {
    if (removeState.status === 'done') {
      setRoleId('');
      onRemoved();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removeState]);

  const failure =
    assignState.status === 'error'
      ? assignState.message
      : removeState.status === 'error'
        ? removeState.message
        : null;

  return (
    <div data-testid="station-access-row" className="flex flex-col gap-1 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="w-40 truncate text-muted-foreground">{station.name}</span>
        <form action={assign} className="flex items-center gap-2">
          <input type="hidden" name="companyId" value={station.id} />
          <input type="hidden" name="userId" value={userId} />
          <Select
            name="roleId"
            aria-label={`Role at ${station.name}`}
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
            className="h-9 w-40 text-sm"
          >
            <option value="" disabled>
              No access
            </option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline" disabled={assigning}>
            {assigning ? 'Applying…' : 'Apply'}
          </Button>
        </form>
        {assignedRoleId ? (
          <form action={remove}>
            <input type="hidden" name="companyId" value={station.id} />
            <input type="hidden" name="userId" value={userId} />
            <Button type="submit" variant="outline" disabled={removing}>
              {removing ? 'Removing…' : 'Remove'}
            </Button>
          </form>
        ) : null}
      </div>
      {failure && <p className="text-sm text-destructive">{failure}</p>}
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB');
}
