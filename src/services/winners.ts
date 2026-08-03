import 'server-only';
import { createClient } from '@supabase/supabase-js';
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

/** The bucket 0086 created. Named once, here, so a typo is one place. */
export const RECEIPT_BUCKET = 'delivery-receipts';

/** How long a receipt link lives. Long enough to look at, short enough not to be a link. */
const RECEIPT_URL_TTL_SECONDS = 60;

function asCaller(accessToken: string) {
  return createClient<Database>(getUserSupabaseConfig().url, getUserSupabaseConfig().anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * The codes 0084/0085/0086 raise. `22023` is every refusal those functions make
 * with a sentence -- a prize already delivered, a delivery that never happened,
 * a blank reason, a prize that cannot go back to stock, a second receipt.
 */
function mapWinnerError(code: string | undefined, message: string): Error {
  if (code === '22023') return new ValidationError(message);
  if (code === '23514') return new BusinessRuleError(message);
  if (code === '23505') return new ConflictError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}

export async function deliverPrize(
  accessToken: string,
  input: { winnerId: string; note?: string | null },
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('deliver_prize', {
    p_winner_id: input.winnerId,
    // The RPC's own default is null; undefined is what PostgREST wants for
    // "leave it out", and null would be sent as a JSON null either way.
    p_note: input.note ?? undefined,
  });
  if (error) throw mapWinnerError(error.code, error.message);
}

export async function cancelDelivery(
  accessToken: string,
  input: { winnerId: string; reason: string },
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('cancel_delivery', {
    p_winner_id: input.winnerId,
    p_reason: input.reason,
  });
  if (error) throw mapWinnerError(error.code, error.message);
}

export async function returnPrize(
  accessToken: string,
  input: { winnerId: string; reason: string },
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('return_prize', {
    p_winner_id: input.winnerId,
    p_reason: input.reason,
  });
  if (error) throw mapWinnerError(error.code, error.message);
}

export async function writeOffPrize(
  accessToken: string,
  input: { winnerId: string; reason: string },
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('write_off_prize', {
    p_winner_id: input.winnerId,
    p_reason: input.reason,
  });
  if (error) throw mapWinnerError(error.code, error.message);
}

/**
 * Uploads the object and then files it, IN THAT ORDER, and never before the
 * delivery itself (D1).
 *
 * The upload runs on the caller's own token rather than the service key: the
 * bucket's write policy checks winners.deliver against the Station in the path
 * (0086), and using the service key here would bypass the policy this block
 * wrote and leave it proved by nothing.
 */
export async function attachDeliveryReceipt(
  accessToken: string,
  input: { winnerId: string; companyId: string; file: File },
): Promise<void> {
  const client = asCaller(accessToken);
  const extension = input.file.name.includes('.')
    ? input.file.name.slice(input.file.name.lastIndexOf('.'))
    : '';
  // <company_id>/<winner_id>/<uuid><ext> — the first segment is what both the
  // bucket policies and attach_delivery_receipt read to prove the Station.
  const path = `${input.companyId}/${input.winnerId}/${crypto.randomUUID()}${extension}`;

  const uploaded = await client.storage.from(RECEIPT_BUCKET).upload(path, input.file, {
    contentType: input.file.type || 'application/octet-stream',
    upsert: false,
  });
  if (uploaded.error) {
    throw new InternalError(`Could not upload the receipt: ${uploaded.error.message}`);
  }

  const { error } = await client.rpc('attach_delivery_receipt', {
    p_winner_id: input.winnerId,
    p_path: path,
  });
  if (error) throw mapWinnerError(error.code, error.message);
}

/**
 * A short-lived signed URL. The bucket is private, so a path is not a link --
 * and minting this server-side is what keeps it that way.
 */
export async function signReceiptUrl(
  accessToken: string,
  path: string,
): Promise<string | null> {
  const { data, error } = await asCaller(accessToken)
    .storage.from(RECEIPT_BUCKET)
    .createSignedUrl(path, RECEIPT_URL_TTL_SECONDS);

  // A receipt that cannot be signed is not worth failing a whole screen over:
  // the winner, the deadline and the history are all still readable, and the
  // row simply shows no link.
  if (error) return null;
  return data?.signedUrl ?? null;
}
