import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/supabase/user-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import {
  BusinessRuleError,
  ConflictError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import type { Database } from '@/lib/supabase/database.types';
import type { RoleFormInput } from '@/schemas/roles';

export interface PermissionEntry {
  code: string;
  module: string;
  label: string;
  scope: 'organization' | 'company';
}

export interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  permissionCodes: string[];
  holders: number;
}

/**
 * A client bound to the caller's JWT. The role RPCs re-check has_org_permission
 * against auth.uid(), so calling them with the service key would defeat the
 * check they exist to make.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The catalogue is reference data; RLS lets any signed-in user read it. */
export async function listPermissionCatalogue(): Promise<PermissionEntry[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('permissions')
    .select('code, module, label, scope')
    .order('module')
    .order('display_order')
    .order('label');

  if (error) throw new InternalError(`Could not read the permission catalogue: ${error.message}`);
  return (data ?? []) as PermissionEntry[];
}

export async function listRoles(organizationId: string): Promise<RoleSummary[]> {
  const supabase = await createUserClient();

  const { data: roles, error: rolesError } = await supabase
    .from('roles')
    .select('id, name, description')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .order('name');

  if (rolesError) throw new InternalError(`Could not read roles: ${rolesError.message}`);

  const roleIds = (roles ?? []).map((r) => r.id);
  if (roleIds.length === 0) return [];

  // Three reads rather than one embed. Block 1a hit a PostgREST embed that could
  // not resolve the relationship it needed and had to be unwound; counting
  // holders in JavaScript is duller and does not depend on that resolution.
  const [
    { data: grants, error: grantsError },
    { data: memberships, error: membershipsError },
  ] = await Promise.all([
    supabase.from('role_permissions').select('role_id, permission_code').in('role_id', roleIds),
    supabase
      .from('company_memberships')
      .select('role_id')
      .eq('organization_id', organizationId)
      .is('deleted_at', null),
  ]);

  // Both discarded previously. A failed role_permissions read would render the
  // edit form with every checkbox unchecked — pressing Save then calls
  // update_role, which replaces the set wholesale and wipes the role's real
  // permissions with no warning at all. A failed company_memberships read
  // silently reports holders: 0, which (a) enables Delete for a role still in
  // use, (b) blanks the "reassign N holders first" caption, and (c) suppresses
  // role-record-dialog.tsx's instant-effect warning — the one mitigation spec
  // §3 names for editing a role in place. Neither failure may pass for success.
  if (grantsError) throw new InternalError(`Could not read role permissions: ${grantsError.message}`);
  if (membershipsError) {
    throw new InternalError(`Could not read role holders: ${membershipsError.message}`);
  }

  const holders = new Map<string, number>();
  for (const row of memberships ?? []) {
    // A Station's OWNER holds no role -- 0278 made role_id optional precisely
    // so ownership could say what they may do without inventing one. They count
    // toward no role's tally, and skipping them here is what keeps "reassign N
    // holders first" honest: the owner is not a holder to reassign.
    if (row.role_id === null) continue;
    holders.set(row.role_id, (holders.get(row.role_id) ?? 0) + 1);
  }

  return (roles ?? []).map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    permissionCodes: (grants ?? [])
      .filter((g) => g.role_id === role.id)
      .map((g) => g.permission_code),
    holders: holders.get(role.id) ?? 0,
  }));
}

export async function createRole(input: RoleFormInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_role', {
    p_organization_id: input.organizationId,
    p_name: input.name,
    p_description: input.description,
    p_permission_codes: input.permissionCodes,
  });
  if (error) throw mapRoleError(error.code, error.message);
  if (typeof data !== 'string') {
    throw new InternalError('create_role returned no id');
  }
  return data;
}

export async function updateRole(
  roleId: string,
  input: RoleFormInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_role', {
    p_role_id: roleId,
    p_name: input.name,
    p_description: input.description,
    p_permission_codes: input.permissionCodes,
  });
  if (error) throw mapRoleError(error.code, error.message);
}

export async function deleteRole(roleId: string, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('delete_role', { p_role_id: roleId });
  if (error) throw mapRoleError(error.code, error.message);
}

/**
 * The error taxonomy in lib/errors.ts exists so that a caller can tell these
 * apart; collapsing them into one class throws that away. In particular, a stale
 * role id is a 404, not a refusal — telling someone they lack permission when
 * the row simply no longer exists sends them to fix the wrong thing.
 */
function mapRoleError(code: string | undefined, message: string): Error {
  // The partial unique index on (organization_id, lower(name)).
  if (code === '23505') return new ConflictError('There is already a role with that name.');
  // delete_role refusing a role somebody holds. The message carries the holder
  // count, which is what the screen needs to say.
  if (code === '23503') return new BusinessRuleError(message);
  if (code === '22023') return new ValidationError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  // Anything else is ours, not the caller's. Labelling an unexpected database
  // error a refusal hides a real fault behind a plausible-looking permission
  // message.
  return new InternalError(message);
}
