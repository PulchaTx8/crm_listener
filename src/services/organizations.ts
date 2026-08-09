import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { InternalError, NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { normaliseTaxId } from '@/lib/tax-id';
import { generateProvisionalPassword } from '@/services/provisioning';
import type { Database } from '@/lib/supabase/database.types';
import type { ProvisionOrganizationInput, UpdateOrganizationInput } from '@/schemas/organizations';

/**
 * The customer group: provisioning it, editing its record, listing them, and
 * shutting one down.
 *
 * A client bound to the CALLER'S JWT, never the service key. Every RPC below is
 * SECURITY DEFINER and re-checks is_platform_admin() against auth.uid(), so the
 * service key would defeat the check the function exists to make.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function mapOrganizationError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '22023' || code === '23514') return new ValidationError(message);
  return new InternalError(message);
}

export interface OrganizationRow {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  municipalRegistration: string | null;
  fiscalEmail: string | null;
  billingEntity: 'ORGANIZATION' | 'STATIONS';
  addressLine: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  neighbourhood: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  createdAt: string;
  stationCount: number;
  owner: { userId: string; email: string } | null;
}

export interface ProvisionOrganizationResult {
  userId: string;
  organizationId: string;
  provisionalPassword: string;
}

/**
 * Creates the owner's account and then the group, and NO Station.
 *
 * Creating the auth user is the Supabase Admin API; creating the tenant is SQL.
 * There is no transaction spanning the two, so the user is created first and
 * deleted if the RPC fails — an account that can authenticate and belongs to no
 * tenant is worse than an outright failure, because it only surfaces when
 * somebody tries to sign in. That is provisionCustomer's compensating delete,
 * carried over unchanged; what changed is only what the RPC creates.
 */
export async function provisionOrganization(
  input: ProvisionOrganizationInput,
  accessToken: string,
): Promise<ProvisionOrganizationResult> {
  const admin = createServiceClient();
  const provisionalPassword = generateProvisionalPassword();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: input.ownerEmail,
    password: provisionalPassword,
    email_confirm: true,
    user_metadata: input.ownerName ? { full_name: input.ownerName } : undefined,
  });

  if (createError || !created.user) {
    throw new ValidationError(`Could not create the user: ${createError?.message ?? 'unknown'}`);
  }

  const userId = created.user.id;

  try {
    const { error: profileError } = await admin
      .from('profiles')
      .insert({ id: userId, email: input.ownerEmail, full_name: input.ownerName ?? null });
    if (profileError) throw new Error(profileError.message);

    const { data, error } = await asCaller(accessToken).rpc('provision_organization', {
      p_user_id: userId,
      p_organization_name: input.organizationName,
    });
    if (error) {
      await recordDeniedProvisioning(admin, accessToken, input, error.message);
      throw new Error(error.message);
    }
    if (typeof data !== 'string') throw new Error('provision_organization returned no id');

    return { userId, organizationId: data, provisionalPassword };
  } catch (cause) {
    // Compensating action: remove the orphan before surfacing the failure.
    await admin.auth.admin.deleteUser(userId).catch(() => {
      logger.error({ userId }, 'orphaned auth user could not be deleted after failed provisioning');
    });
    throw new InternalError('Provisioning failed and was rolled back', { cause });
  }
}

/**
 * Writes the whole record.
 *
 * EVERY FIELD ON EVERY CALL. The RPC blanks what it is not given, so every field
 * is sent — `?? undefined` here means "send SQL null", which is the clearing the
 * convention intends, not "leave alone". The one field that is transformed is
 * the CNPJ: the column takes fourteen bare digits, and normaliseTaxId returns
 * null for anything that is not fourteen digits, so a half-typed number is
 * stored as absent rather than as a stub no invoice can be raised against.
 */
export async function updateOrganization(
  input: UpdateOrganizationInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_organization', {
    p_organization_id: input.organizationId,
    p_name: input.name,
    p_legal_name: input.legalName ?? undefined,
    p_tax_id: normaliseTaxId(input.taxId) ?? undefined,
    p_municipal_registration: input.municipalRegistration ?? undefined,
    p_fiscal_email: input.fiscalEmail ?? undefined,
    p_billing_entity: input.billingEntity,
    p_address_line: input.addressLine ?? undefined,
    p_address_number: input.addressNumber ?? undefined,
    p_address_complement: input.addressComplement ?? undefined,
    p_neighbourhood: input.neighbourhood ?? undefined,
    p_city: input.city ?? undefined,
    p_state: input.state ?? undefined,
    p_postal_code: input.postalCode ?? undefined,
  });
  if (error) throw mapOrganizationError(error.code, error.message);
}

export async function listOrganizations(accessToken: string): Promise<OrganizationRow[]> {
  const { data, error } = await asCaller(accessToken).rpc('list_organizations');
  if (error) throw mapOrganizationError(error.code, error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    taxId: row.tax_id,
    municipalRegistration: row.municipal_registration,
    fiscalEmail: row.fiscal_email,
    billingEntity: row.billing_entity,
    addressLine: row.address_line,
    addressNumber: row.address_number,
    addressComplement: row.address_complement,
    neighbourhood: row.neighbourhood,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    suspendedAt: row.suspended_at,
    suspensionReason: row.suspension_reason,
    createdAt: row.created_at,
    stationCount: Number(row.station_count ?? 0),
    // The lateral join yields nulls for a group whose owner was removed. A row
    // with a user id and no e-mail cannot be acted on, so both must be present.
    owner:
      row.owner_user_id && row.owner_email
        ? { userId: row.owner_user_id, email: row.owner_email }
        : null,
  }));
}

/**
 * Shuts a whole customer down: the owner and every member, across every Station.
 *
 * The enforcement is in 0156, in is_owner_for and has_company_access_for, so
 * this function has nothing to cascade — there is no list of Stations to walk,
 * which is precisely why the condition went into the shared predicates rather
 * than into a loop somebody has to keep complete.
 */
export async function blockOrganization(
  organizationId: string,
  reason: string,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('block_organization', {
    p_organization_id: organizationId,
    p_reason: reason,
  });
  if (error) throw mapOrganizationError(error.code, error.message);
}

export async function unblockOrganization(
  organizationId: string,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('unblock_organization', {
    p_organization_id: organizationId,
  });
  if (error) throw mapOrganizationError(error.code, error.message);
}

/**
 * The RPC cannot audit its own refusals: it raises, and the raise rolls back
 * anything it just inserted. It writes the refusal to the server log instead,
 * and this records the row from out here, where the failed transaction cannot
 * take it with it.
 */
async function recordDeniedProvisioning(
  admin: ReturnType<typeof createServiceClient>,
  accessToken: string,
  input: ProvisionOrganizationInput,
  reason: string,
): Promise<void> {
  try {
    const { data } = await admin.auth.getUser(accessToken);
    await admin.from('audit_logs').insert({
      actor_id: data.user?.id ?? null,
      action: 'provision_organization.denied',
      succeeded: false,
      detail: { reason, organization_name: input.organizationName },
    });
  } catch (cause) {
    // Never let the audit write mask the original failure.
    logger.error({ err: cause }, 'could not record a denied provisioning attempt');
  }
}
