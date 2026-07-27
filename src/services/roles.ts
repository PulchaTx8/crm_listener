import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/supabase/user-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { UnauthorizedError, ValidationError } from '@/lib/errors';
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

  if (error) throw new UnauthorizedError(`Could not read the permission catalogue: ${error.message}`);
  return (data ?? []) as PermissionEntry[];
}

export async function listRoles(organizationId: string): Promise<RoleSummary[]> {
  const supabase = await createUserClient();

  // Two reads rather than one embed. Block 1a hit a PostgREST embed that could
  // not resolve the relationship it needed and had to be unwound; counting
  // holders in JavaScript is duller and does not depend on that resolution.
  const [{ data: roles, error: rolesError }, { data: grants }, { data: memberships }] =
    await Promise.all([
      supabase
        .from('roles')
        .select('id, name, description')
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .order('name'),
      supabase.from('role_permissions').select('role_id, permission_code'),
      supabase
        .from('company_memberships')
        .select('role_id')
        .eq('organization_id', organizationId)
        .is('deleted_at', null),
    ]);

  if (rolesError) throw new UnauthorizedError(`Could not read roles: ${rolesError.message}`);

  const holders = new Map<string, number>();
  for (const row of memberships ?? []) {
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
  return data as string;
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
 * 23505 is a duplicate name, 23503 a role still assigned, 22023 a bad argument.
 * Each is the caller's mistake and gets a sentence they can act on; anything
 * else is a refusal.
 */
function mapRoleError(code: string | undefined, message: string): Error {
  if (code === '23505') return new ValidationError('There is already a role with that name.');
  if (code === '23503') return new ValidationError(message);
  if (code === '22023') return new ValidationError(message);
  return new UnauthorizedError(message);
}
