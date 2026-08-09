import 'server-only';
import { createUserClient } from '@/lib/supabase/user-client';
import { env } from '@/lib/env';
import { ConflictError, InternalError, UnauthorizedError, ValidationError } from '@/lib/errors';

/**
 * Block 10a. The platform administrator's view of who is connected to WhatsApp.
 */

export interface IntegrationRow {
  company_id: string;
  company_name: string;
  organization_id: string;
  organization_name: string;
  company_status: string;
  integration_id: string | null;
  phone_number_id: string | null;
  display_phone_number: string | null;
  waba_id: string | null;
  enabled: boolean | null;
  updated_at: string | null;
}

/**
 * The 23505s, told apart by constraint name.
 *
 * 0130 deliberately does not catch them, because the two unique indexes 0057
 * ships ARE the taxonomy and catching them there would collapse two different
 * problems into one message. `integrations_number_live` is the one that matters:
 * the webhook routes an inbound message by `phone_number_id`, so a number
 * claimed twice would silently deliver a listener's message to the wrong radio.
 */
function mapIntegrationError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === '22023') return new ValidationError(message);
  if (code === '23505') {
    if (message.includes('integrations_number_live')) {
      return new ConflictError(
        'That phone number id already belongs to another Station. A number can only be connected to one.',
      );
    }
    if (message.includes('integrations_one_per_company')) {
      return new ConflictError('This Station already has a WhatsApp integration.');
    }
    return new ConflictError(message);
  }
  return new InternalError(message);
}

export async function listIntegrations(): Promise<IntegrationRow[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc('list_integrations');
  if (error) throw mapIntegrationError(error.code, error.message);
  return (data ?? []) as unknown as IntegrationRow[];
}

/**
 * Block 16. One Station's integration, in listIntegrations' exact columns.
 *
 * The Stations screen reads this for every Station it lists, before knowing
 * which record will be opened — the dialog opens from the page's read rather
 * than fetching on open (spec §9). A Station with no integration comes back as
 * one row of nulls, as the list does, so no caller has to tell an absence apart
 * from an empty record.
 */
export async function getIntegration(companyId: string): Promise<IntegrationRow | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc('get_integration', { p_company_id: companyId });
  if (error) throw mapIntegrationError(error.code, error.message);
  const rows = (data ?? []) as unknown as IntegrationRow[];
  return rows[0] ?? null;
}

export async function upsertIntegration(input: {
  companyId: string;
  phoneNumberId: string;
  wabaId?: string | null;
  displayPhoneNumber?: string | null;
  enabled?: boolean;
}): Promise<string> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc('upsert_integration', {
    p_company_id: input.companyId,
    p_phone_number_id: input.phoneNumberId,
    p_waba_id: input.wabaId ?? undefined,
    p_display_phone_number: input.displayPhoneNumber ?? undefined,
    p_enabled: input.enabled ?? true,
  });
  if (error) throw mapIntegrationError(error.code, error.message);
  return data as string;
}

export async function disableIntegration(companyId: string): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('disable_integration', { p_company_id: companyId });
  if (error) throw mapIntegrationError(error.code, error.message);
}

/**
 * Whether each installation-wide secret is set — **never what it is**.
 *
 * This is the screen's most useful single row, and the reason it is a boolean
 * rather than a masked value: the question an operator brings to this screen is
 * "why does this radio receive no messages", and "the access token is not set"
 * is half the answers. A masked value would invite comparing it against
 * something, which is the beginning of leaking it.
 *
 * Returning booleans computed HERE, on the server, rather than passing `env`
 * anywhere near a component, is what keeps that true by construction.
 */
export function configuredSecrets(): {
  appSecret: boolean;
  verifyToken: boolean;
  accessToken: boolean;
} {
  return {
    appSecret: Boolean(env.WHATSAPP_APP_SECRET),
    verifyToken: Boolean(env.WHATSAPP_VERIFY_TOKEN),
    accessToken: Boolean(env.WHATSAPP_ACCESS_TOKEN),
  };
}
