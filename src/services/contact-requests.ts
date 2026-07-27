import 'server-only';
import { createHash } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/service-client';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { RateLimitError, InternalError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { DevMailer, SmtpMailer, type Mailer } from '@/lib/mailer';
import { env } from '@/lib/env';
import type { ContactRequestInput } from '@/schemas/contact';

const WINDOW_SECONDS = 3600;
const MAX_PER_WINDOW = 5;

/** SMTP when configured, otherwise the recording DevMailer from Block 0. */
function resolveMailer(): Mailer {
  if (env.SMTP_URL && env.MAIL_FROM) return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  return new DevMailer();
}

/** Stored instead of the raw address: enough to rate limit, not enough to identify. */
export function hashIpAddress(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export async function submitContactRequest(
  input: ContactRequestInput,
  ipAddress: string,
): Promise<void> {
  const client = createServiceClient();
  const limiter = new PostgresRateLimiter(client);
  const ipHash = hashIpAddress(ipAddress);

  const verdict = await limiter.check(`contact:${ipHash}`, MAX_PER_WINDOW, WINDOW_SECONDS);
  if (!verdict.allowed) {
    throw new RateLimitError('Too many submissions. Please try again later.');
  }

  const { error } = await client.from('contact_requests').insert({
    name: input.name,
    email: input.email,
    phone: input.phone ?? null,
    company_name: input.companyName ?? null,
    message: input.message ?? null,
    ip_hash: ipHash,
  });

  if (error) {
    throw new InternalError(`Could not record the contact request: ${error.message}`);
  }

  logger.info({ email: input.email }, 'contact request received');

  // Storage is the source of truth; the notification is best-effort. A failed
  // e-mail must never lose a lead, so this cannot throw past the insert.
  if (env.MAIL_FROM) {
    try {
      await resolveMailer().send({
        to: env.MAIL_FROM,
        subject: `New PulchatX contact request from ${input.name}`,
        text: [
          `Name: ${input.name}`,
          `E-mail: ${input.email}`,
          `Phone: ${input.phone ?? '-'}`,
          `Company: ${input.companyName ?? '-'}`,
          '',
          input.message ?? '(no message)',
        ].join('\n'),
      });
    } catch (cause) {
      logger.error({ err: cause }, 'contact request stored but notification failed');
    }
  }
}
