'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
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
import { ROLE_TABS, type RoleTab } from '@/lib/record-params';
import type { PermissionEntry, RoleSummary } from '@/services/roles';
import { deleteRoleAction, type DeleteRoleState, type SavedRole } from './actions';
import { RoleRecordDialog } from './role-record-dialog';

/** How many columns the empty-state row has to span, actions included. */
const COLUMN_COUNT = 5;

const INITIAL_DELETE: DeleteRoleState = { status: 'idle' };

/**
 * The roles grid, and the host for the record dialog over it.
 *
 * No paging, deliberately: an Organization composes a handful of roles, and
 * page.tsx reads all of them in one go. What this owns is the row set, so that
 * saving, creating and deleting redraw a row instead of the whole screen —
 * /roles is a route like any other, and re-rendering it is exactly what this
 * block exists to stop.
 */
export function RolesGrid({
  initialRoles,
  organizationId,
  catalogue,
  initialRecord,
}: {
  initialRoles: RoleSummary[];
  organizationId: string;
  catalogue: PermissionEntry[];
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('roles');
  const [grid, setGrid] = useState<RowState<RoleSummary>>({
    rows: initialRoles,
    total: initialRoles.length,
  });

  // A navigation re-runs the server component and hands down a fresh list.
  // That is the one moment local patches stop describing the rows they were
  // made against, so they are dropped rather than merged (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRoles, total: initialRoles.length });
  }, [initialRoles]);

  const { recordId, tab, open, setTab, close } = useRecordDialog(ROLE_TABS, initialRecord);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RoleSummary | null>(null);

  const openRole = recordId ? (grid.rows.find((role) => role.id === recordId) ?? null) : null;

  function patchFromSave(saved: SavedRole, created: boolean) {
    setGrid((current) => {
      if (created) {
        return applyRowPatch(current, { kind: 'create', row: { ...saved, holders: 0 } });
      }
      const existing = current.rows.find((row) => row.id === saved.id);
      // holders comes from the row rather than the action: update_role writes
      // roles and role_permissions only, so the count this grid already holds
      // is still the true one after a save (see SavedRole in actions.ts).
      return applyRowPatch(current, {
        kind: 'save',
        row: { ...saved, holders: existing?.holders ?? 0 },
      });
    });
  }

  return (
    <>
      <div className="mt-4 flex justify-end">
        <Button type="button" onClick={() => setCreating(true)} data-testid="role-create">
          {t('createRole')}</Button>
      </div>

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('description')}</TableHead>
              <TableHead>{t('permissions')}</TableHead>
              <TableHead>{t('holders')}</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {t('noRolesYetCreateOneThen')}</TableCell>
              </TableRow>
            ) : (
              grid.rows.map((role) => (
                <TableRow key={role.id} data-testid="role-row">
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      onClick={() => open(role.id)}
                      className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {role.name}
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{role.description ?? '—'}</TableCell>
                  <TableCell>{role.permissionCodes.length}</TableCell>
                  <TableCell>{t('heldBy')}{' '}{role.holders} {t('userS')}</TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={`Edit ${role.name}`}
                        onClick={() => open(role.id, 'data')}
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      <DropdownMenu
                        label={t('actionsForRole', { name: role.name })}
                        trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                      >
                        {/* Offered even for a role somebody holds, where
                            delete_role will refuse it. The confirmation says so
                            in words and gives no button to press — where a
                            missing menu item would leave an operator hunting for
                            a Delete that is simply not there, with nothing on
                            screen explaining why. */}
                        <DropdownMenuItem destructive onSelect={() => setDeleting(role)}>
                          {t('deleteRole')}</DropdownMenuItem>
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
            {grid.total} {t('rolesLabel', { count: grid.total ?? 0 })}
          </span>
        </TableFooter>
      </div>

      <RoleRecordDialog
        open={recordId !== null}
        role={openRole}
        missing={recordId !== null && openRole === null}
        organizationId={organizationId}
        catalogue={catalogue}
        tab={(tab as RoleTab) ?? 'data'}
        onTab={setTab}
        onClose={close}
        onSaved={patchFromSave}
      />

      <RoleRecordDialog
        open={creating}
        role={null}
        organizationId={organizationId}
        catalogue={catalogue}
        tab="data"
        // The create dialog is not addressable — there is no record to address
        // yet — so its tab is local state rather than the URL's.
        onTab={() => {}}
        onClose={() => setCreating(false)}
        onSaved={(saved, created) => {
          patchFromSave(saved, created);
          setCreating(false);
        }}
      />

      {deleting && (
        <DeleteRoleDialog
          role={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={(id) => {
            setDeleting(null);
            setGrid((current) => applyRowPatch(current, { kind: 'remove', id }));
          }}
        />
      )}
    </>
  );
}

/**
 * The refusal for a role somebody still holds is written here rather than
 * relied on from the database, and both are true: delete_role (0017) counts
 * live company_memberships under a row lock and raises 23503 if there are any.
 * This dialog offers no confirm button in that case, so the RPC's refusal is a
 * second line rather than the only one.
 */
function DeleteRoleDialog({
  role,
  onCancel,
  onDeleted,
}: {
  role: RoleSummary;
  onCancel: () => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations('roles');
  const titleId = useId();
  const [state, action, pending] = useActionState(deleteRoleAction, INITIAL_DELETE);
  const held = role.holders > 0;

  useEffect(() => {
    if (state.status === 'deleted') onDeleted(role.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>
          {held ? t('thisRoleIsInUse') : t('deleteThisRole')}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        {held ? (
          <p className="text-sm">
            {role.holders} {t('userSHold')}{' '}<strong>{role.name}</strong>. Reassign them on the Team
            screen first — deleting a role somebody holds would leave them with no powers and
            nothing on screen to explain why, so the database refuses it.
          </p>
        ) : (
          <p className="text-sm">
            <strong>{role.name}</strong> {t('isHeldByNobodyAndWill')}</p>
        )}
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {held ? t('close') : t('cancel')}
        </Button>
        {!held && (
          <form action={action}>
            <input type="hidden" name="roleId" value={role.id} />
            <Button type="submit" disabled={pending} data-testid="role-delete-confirm">
              {pending ? t('deleting') : t('deleteRoleConfirm')}
            </Button>
          </form>
        )}
      </DialogFooter>
    </Dialog>
  );
}
