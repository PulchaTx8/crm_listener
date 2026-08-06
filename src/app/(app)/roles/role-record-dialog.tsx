'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import type { PermissionEntry, RoleSummary } from '@/services/roles';
// The tab tuple is declared with parseRecordParam rather than here, because the
// page that validates `tab=` against it is a Server Component and cannot import
// a value out of a client module. See src/lib/record-params.ts.
import { ROLE_TABS, type RoleTab } from '@/lib/record-params';
import { saveRoleAction, type RoleFormState, type SavedRole } from './actions';

const TAB_LABELS: Record<RoleTab, string> = {
  data: 'Role data',
  powers: 'Powers',
};

const INITIAL_SAVE: RoleFormState = { status: 'idle' };

/**
 * One role's whole record, over the list rather than in a <details> beside it.
 *
 * The record needs no read of its own: listRoles already returns every field
 * this dialog shows — name, description, permission codes, holder count — so
 * unlike the audience and inventory records there is nothing to fetch when it
 * opens, and moving between tabs plainly cannot reach the server.
 *
 * `role` absent means create. The two paths share one component so they cannot
 * drift into rendering different catalogues, which is the property role-form.tsx
 * carried before this replaced it.
 */
export function RoleRecordDialog({
  open,
  role,
  missing,
  organizationId,
  catalogue,
  tab,
  onTab,
  onClose,
  onSaved,
}: {
  open: boolean;
  role: RoleSummary | null;
  /** An address that named no role on this screen — see the body below. */
  missing?: boolean;
  organizationId: string;
  catalogue: PermissionEntry[];
  tab: RoleTab;
  onTab: (tab: RoleTab) => void;
  onClose: () => void;
  onSaved: (role: SavedRole, created: boolean) => void;
}) {
  const t = useTranslations('roles');
  const titleId = useId();
  const formId = useId();
  const [state, action, pending] = useActionState(saveRoleAction, INITIAL_SAVE);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (state.status === 'saved' && state.role) {
      setDirty(false);
      onSaved(state.role, state.created ?? false);
    }
    // onSaved is stable for the dialog's lifetime; re-running on its identity
    // would re-report a save that already happened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function requestClose() {
    if (dirty && !window.confirm('Discard the changes you have not saved?')) return;
    setDirty(false);
    onClose();
  }

  const modules = [...new Set(catalogue.map((p) => p.module))];
  const held = new Set(role?.permissionCodes ?? []);
  const hasOrgScoped = catalogue.some((p) => p.scope === 'organization');

  if (missing) {
    // This screen lists every live role in the Organization — there is no
    // paging for a row to be hiding on — so an address naming none of them is
    // either a role that does not exist or one belonging to an Organization
    // this caller cannot see. Those two facts collapse into a single sentence
    // on purpose, exactly as the audience record's do: told apart, ?record=
    // would confirm to somebody pasting ids which ones are real.
    return (
      <Dialog open={open} onClose={onClose} labelledBy={titleId} className="max-w-lg">
        <DialogHeader>
          <DialogTitle id={titleId}>{t('role')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-destructive">
            {t('noSuchRoleOrYouDo')}</p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}</Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={requestClose} labelledBy={titleId}>
      <DialogHeader>
        <div className="flex flex-col gap-1">
          <DialogTitle id={titleId}>{role ? role.name : 'New role'}</DialogTitle>
          {role && (
            <p className="text-xs text-muted-foreground">
              {role.permissionCodes.length} {t('permissionSHeldBy')}{' '}{role.holders} {t('userS')}</p>
          )}
        </div>
        <button
          type="button"
          onClick={requestClose}
          aria-label={t('closeRecord')}
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      <div role="tablist" aria-label={t('recordSections')} className="flex gap-1 border-b px-5">
        {ROLE_TABS.map((name) => (
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
        {/* ONE form across both tabs, and the tab that is not showing is hidden
            rather than unmounted. update_role (0017) replaces the permission set
            wholesale — "a diff would be the same result with more ways to be
            wrong", in its own words — so a save sent from the Role data tab with
            the Powers panel unmounted would submit no permissionCodes at all and
            silently strip every power the role has. `hidden` keeps those inputs
            in the form: only `disabled` would take them out of the submission. */}
        <form
          id={formId}
          key={role?.id ?? 'new'}
          action={action}
          onChange={() => setDirty(true)}
          data-testid="role-form"
          className="flex flex-col gap-4"
        >
          <input type="hidden" name="organizationId" value={organizationId} />
          {role && <input type="hidden" name="roleId" value={role.id} />}

          <div hidden={tab !== 'data'} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              {t('name')}<Input name="name" required maxLength={60} defaultValue={role?.name ?? ''} />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              {t('description')}<Textarea name="description" maxLength={240} defaultValue={role?.description ?? ''} />
            </label>

            {/* Unchecking a box cuts its holders off on their next request, with
                no sign-out. Saying how many people that is, beside the record
                itself, is the whole mitigation for how sharp that edge is. */}
            {role && role.holders > 0 && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
                {role.holders} {t('userSCurrentlyHoldThisRole')}</p>
            )}
          </div>

          <div hidden={tab !== 'powers'} className="flex flex-col gap-4">
            {hasOrgScoped && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {t('rolesAreAssignedPerStationBut')}{' '}
                <strong>{t('wholeOrganization')}</strong> {t('belowReachEveryStationRegardlessOf')}</p>
            )}

            {modules.map((module) => (
              <fieldset key={module} className="flex flex-col gap-2 rounded-md border p-3">
                <legend className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {module}
                </legend>
                {catalogue
                  .filter((p) => p.module === module)
                  .map((p) => (
                    <div key={p.code} className="flex flex-col gap-1">
                      <label className="flex flex-wrap items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="permissionCodes"
                          value={p.code}
                          defaultChecked={held.has(p.code)}
                        />
                        {p.label}
                        {/* Roles are assigned per Station, so a permission that
                            reaches the whole Organization has to say so where it
                            is chosen. */}
                        {p.scope === 'organization' && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                            {t('wholeOrganization')}</span>
                        )}
                      </label>
                      {/* I3 (block-1c final review): update_role restricts neither
                          which codes a role may carry nor whether the caller edits
                          the role they themselves hold. Ticking this checkbox is
                          how an owner hands away the ability to grant every other
                          permission — including this one, to anyone, including the
                          delegate themselves. Accepted as a property of the model
                          (spec §2 decision 4), not a defect — but the owner ticking
                          it has no other way to learn what they are handing over. */}
                      {p.code === 'roles.manage' && (
                        <p className="pl-6 text-xs text-muted-foreground">
                          {t('whoeverHoldsThisCanGrantThemselves')}</p>
                      )}
                    </div>
                  ))}
              </fieldset>
            ))}
          </div>
        </form>
      </DialogBody>

      <DialogFooter>
        {state.status === 'error' && (
          <span className="mr-auto text-sm text-destructive">{state.message}</span>
        )}
        {state.status === 'saved' && !pending && (
          <span className="mr-auto text-sm text-muted-foreground">{t('roleSaved')}</span>
        )}
        <Button type="button" variant="outline" onClick={requestClose}>
          {t('close')}</Button>
        {/* "Create", not "Create role": the grid's own button beside the list
            carries that name, and two buttons with one name is a screen that
            cannot be spoken about — by a person or by a test. */}
        <Button type="submit" form={formId} disabled={pending} data-testid="role-save">
          {pending ? t('saving') : role ? t('saveChanges') : t('create')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
