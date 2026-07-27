'use client';

import { useActionState } from 'react';
import { saveRoleAction, type RoleFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import type { PermissionEntry, RoleSummary } from '@/services/roles';

const INITIAL: RoleFormState = { status: 'idle' };

/**
 * One component for both creating and editing. `role` absent means create; the
 * hidden roleId is what saveRoleAction reads to tell them apart, so the two
 * paths cannot drift into rendering different catalogues.
 */
export function RoleForm({
  organizationId,
  catalogue,
  role,
}: {
  organizationId: string;
  catalogue: PermissionEntry[];
  role?: RoleSummary;
}) {
  const [state, action, pending] = useActionState(saveRoleAction, INITIAL);

  const modules = [...new Set(catalogue.map((p) => p.module))];
  const held = new Set(role?.permissionCodes ?? []);
  const hasOrgScoped = catalogue.some((p) => p.scope === 'organization');

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      {role && <input type="hidden" name="roleId" value={role.id} />}

      <label className="flex flex-col gap-1 text-sm">
        Name
        <Input name="name" required maxLength={60} defaultValue={role?.name ?? ''} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Description
        <Textarea name="description" maxLength={240} defaultValue={role?.description ?? ''} />
      </label>

      {hasOrgScoped && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Roles are assigned per Station, but permissions tagged{' '}
          <strong>whole Organization</strong> below reach every Station regardless of which one
          this role is assigned in. That is deliberate, not a bug — pick them with that in mind.
        </p>
      )}

      <div className="flex flex-col gap-4">
        {modules.map((module) => (
          <fieldset key={module} className="flex flex-col gap-2 rounded-md border p-3">
            <legend className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {module}
            </legend>
            {catalogue
              .filter((p) => p.module === module)
              .map((p) => (
                <label key={p.code} className="flex flex-wrap items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="permissionCodes"
                    value={p.code}
                    defaultChecked={held.has(p.code)}
                  />
                  {p.label}
                  {/* Roles are assigned per Station, so a permission that reaches
                      the whole Organization has to say so where it is chosen. */}
                  {p.scope === 'organization' && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                      whole Organization
                    </span>
                  )}
                </label>
              ))}
          </fieldset>
        ))}
      </div>

      {/* Unchecking a box cuts its holders off on their next request, with no
          sign-out. Saying how many people that is, right beside the button, is
          the whole mitigation for how sharp that edge is. */}
      {role && role.holders > 0 && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
          {role.holders} user(s) currently hold this role. Saving applies these changes to them
          immediately — they will not be signed out and do not need to sign back in.
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : role ? 'Save changes' : 'Create role'}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">Role saved.</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
