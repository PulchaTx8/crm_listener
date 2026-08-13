import 'server-only';
import { createServiceClient } from '@/lib/supabase/service-client';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { RateLimitError, InternalError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { DevMailer, SmtpMailer, type Mailer } from '@/lib/mailer';
import { env } from '@/lib/env';
import { hashIpAddress } from '@/services/contact-requests';
import type { DataDeletionRequestInput } from '@/schemas/data-deletion';

const WINDOW_SECONDS = 3600;
const MAX_PER_WINDOW = 5;

/** SMTP when configured, otherwise the recording DevMailer from Block 0. */
function resolveMailer(): Mailer {
  if (env.SMTP_URL && env.MAIL_FROM) return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  return new DevMailer();
}

/**
 * Records a deletion request and returns the protocol the DATABASE generated.
 *
 * IT ERASES NOTHING, and that is the design rather than an omission: no path
 * from here reaches the erasure procedure. A public form that deleted on
 * submission would let anybody erase anybody's record by typing their telephone
 * number. Identity is verified by a person, off this path, and the console
 * screen is where that work is recorded.
 *
 * THE PROTOCOL IS SELECTED BACK, NEVER CONSTRUCTED HERE. 0188 puts
 * new_deletion_protocol() on the column as a default and grants EXECUTE to
 * service_role alone; generating one in this function as well would be two
 * sources for one identifier, which is two identifiers -- and the one printed
 * on the receipt would be the one that is not in the row.
 *
 * Its own rate-limit bucket (`deletion:`), not shared with `contact:`: a person
 * who has just written in to ask a question must not find themselves unable to
 * exercise a legal right because of it.
 */
export async function submitDataDeletionRequest(
  input: DataDeletionRequestInput,
  ipAddress: string,
): Promise<string> {
  const client = createServiceClient();
  const limiter = new PostgresRateLimiter(client);
  const ipHash = hashIpAddress(ipAddress);

  const verdict = await limiter.check(`deletion:${ipHash}`, MAX_PER_WINDOW, WINDOW_SECONDS);
  if (!verdict.allowed) {
    throw new RateLimitError('Too many submissions. Please try again later.');
  }

  const { data, error } = await client
    .from('data_deletion_requests')
    .insert({
      name: input.name,
      email: input.email,
      phone: input.phone,
      company_name: input.station ?? null,
      message: input.notes ?? null,
      ip_hash: ipHash,
    })
    .select('protocol')
    .single();

  if (error || !data) {
    throw new InternalError(`Could not record the deletion request: ${error?.message}`);
  }

  logger.info({ protocol: data.protocol }, 'data deletion request received');

  // Storage is the source of truth; the notification is best-effort. This
  // request carries a statutory deadline, so a failed e-mail losing it would be
  // worse here than anywhere else in the system -- which is exactly why the
  // insert above already happened and this cannot throw past it.
  if (env.MAIL_FROM) {
    try {
      await resolveMailer().send({
        to: env.MAIL_FROM,
        subject: `PulchatX data deletion request ${data.protocol}`,
        text: [
          `Protocol: ${data.protocol}`,
          `Name: ${input.name}`,
          `E-mail: ${input.email}`,
          `Phone: ${input.phone}`,
          `Station: ${input.station ?? '-'}`,
          '',
          input.notes ?? '(no further detail)',
        ].join('\n'),
      });
    } catch (cause) {
      logger.error({ err: cause }, 'deletion request stored but notification failed');
    }
  }

  return data.protocol;
}
