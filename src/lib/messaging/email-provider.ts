import type { Mailer, MailMessage } from '@/lib/mailer';
import { renderCampaignEmail } from '@/lib/mailer/frame';
import type { EmailSenderIdentity, MessagingProvider, SendJob, SendOutcome } from './provider';

/**
 * The frame is `renderCampaignEmail`'s (29b-1) and this provider never
 * assembles HTML of its own. That module escapes the operator's text on the way
 * in, which is the whole reason this codebase depends on no sanitiser and uses
 * `dangerouslySetInnerHTML` nowhere. A second place that builds e-mail markup
 * would be a second place to get that wrong.
 */
export class EmailMessagingProvider implements MessagingProvider {
  constructor(private readonly mailer: Mailer) {}

  async send(job: SendJob): Promise<SendOutcome> {
    if (job.channel !== 'EMAIL') {
      // A routing bug in whoever called this, not a fact about a listener's
      // send — the drain (Task 6) picks a provider from the campaign's own
      // `channel` column before it ever builds a job, so reaching this means
      // the two disagreed. SendOutcome has no state for "the caller made a
      // mistake"; that is not a `failed` recipient, it is a defect this
      // provider should not silently paper over by guessing which channel
      // was meant.
      throw new TypeError(`EmailMessagingProvider cannot send a ${job.channel} job`);
    }

    const { html, text } = renderCampaignEmail({
      stationName: job.stationName,
      logoUrl: job.logoUrl,
      body: job.body,
      unsubscribe: job.unsubscribe,
    });

    const headers: Record<string, string> = {};
    if (job.unsubscribe) {
      // RFC 8058's one-click pair. Without List-Unsubscribe-Post a client
      // offering the one-tap button still falls back to opening the link —
      // which is the same URL this same object already carries, so there is
      // nothing here to keep in step between the two headers.
      headers['List-Unsubscribe'] = `<${job.unsubscribe.url}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    if (job.sender?.replyTo) {
      // MailMessage (src/lib/mailer/index.ts) carries no first-class replyTo
      // field, only `headers` — forwarded to nodemailer's sendMail verbatim —
      // so a Reply-To header is the only way to carry this without widening
      // that type for a field only campaigns use.
      headers['Reply-To'] = job.sender.replyTo;
    }

    const message: MailMessage = {
      to: job.address,
      subject: job.subject,
      text,
      html,
      ...(job.sender ? { from: formatFrom(job.sender) } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };

    try {
      const result = await this.mailer.send(message);
      return { ok: true, providerMessageId: result.id };
    } catch (cause) {
      return classifyMailFailure(cause);
    }
  }
}

/**
 * `from` is OMITTED ENTIRELY, never a second fallback computed here, when the
 * job carries no sender identity. `SmtpMailer` already sends
 * `from: msg.from ?? this.defaultFrom` (src/lib/mailer/index.ts), where
 * `defaultFrom` is the installation's `MAIL_FROM`. Reading `MAIL_FROM` in this
 * provider would break the rule this module's own contract states — a
 * provider reading an environment variable for tenant data — and a second
 * fallback written here would be a second place for it to disagree with
 * `SmtpMailer`'s.
 */
function formatFrom(sender: EmailSenderIdentity): string {
  return sender.fromName ? `${sender.fromName} <${sender.fromAddress}>` : sender.fromAddress;
}

/** nodemailer's own SMTP error codes that only ever fire before any server exchange happened at all. */
const CONNECTION_STAGE_CODES = new Set(['ECONNECTION', 'ESOCKET', 'EDNS', 'ETIMEDOUT']);

/**
 * WHERE THIS EVIDENCE CAME FROM: graph.ts has an HTTP status to read from
 * Meta's own response; nodemailer's SMTP transport hands this provider no
 * such thing directly. What a rejected `SmtpMailer.send` actually throws, read
 * from `node_modules/nodemailer/lib/smtp-connection/index.js`'s own
 * `_formatError`, is an `Error` carrying `.code` — one of nodemailer's own
 * short vocabulary (ECONNECTION, ESOCKET, EDNS, ETIMEDOUT, EENVELOPE,
 * EMESSAGE, EAUTH; `_formatError` always overwrites whatever Node's own
 * network errno was with one of these) — and, ONLY when a real SMTP
 * conversation produced a reply, `.responseCode`: the numeric three-digit
 * code the server itself sent back.
 *
 * THE RULE, IN ORDER:
 *
 * 1. A `responseCode` is the server's own word, and RFC 5321 §4.2.1 gives it
 *    a meaning this provider does not have to guess at: 4yz is a TRANSIENT
 *    negative completion (the request may succeed if repeated) and 5yz is
 *    PERMANENT. `code` here is the literal `smtp_<responseCode>`, not a
 *    manufactured label — this is the one branch where the far side did hand
 *    this provider a real code, the same way an HTTP status is a real code.
 *
 * 2. No `responseCode`, but `.code` is one of the four nodemailer only ever
 *    sets before any server exchange happens (a DNS failure, a refused or
 *    reset connection, a socket error, a timeout waiting for a greeting).
 *    Nothing about the MESSAGE was refused — the network was unavailable —
 *    which is the identical reasoning graph.ts's own comment states for its
 *    connection-failure branch ("a connection that failed says nothing about
 *    the request being wrong"). Retryable.
 *
 * 3. No `responseCode` and anything else. EENVELOPE ("No recipients
 *    defined", "Invalid sender ...") and EMESSAGE ("Empty message", a message
 *    over the size limit) also reach here with no `responseCode` exactly when
 *    nodemailer refused the message before it ever reached the server — a
 *    shape this installation itself built wrong, and resending the identical
 *    job fails identically. Not retryable.
 *
 * THE ONE CALL THIS COMMENT IS NOT FULLY CONFIDENT ABOUT: EAUTH with no
 * `responseCode` fires when the transport was never given credentials to
 * authenticate with at all ("Missing credentials for ...") — an
 * installation-wide SMTP_URL misconfiguration, not a fact about this one
 * message. It falls under rule 3 above (not retryable), on a cost this
 * comment can name rather than a confident classification: getting this
 * wrong costs a batch of rows marked `failed` that an operator has to notice
 * on the history screen and resend once SMTP_URL is fixed, against the
 * alternative — burning the retry ladder, roughly six minutes per row, on
 * every recipient of a campaign that cannot succeed until the identical
 * config fix happens either way. Failing fast and visibly reads as the
 * cheaper mistake of the two.
 */
function classifyMailFailure(cause: unknown): SendOutcome {
  const err = cause instanceof Error ? cause : new Error(String(cause));
  const responseCode = extractResponseCode(err);

  if (responseCode !== null) {
    return {
      ok: false,
      retryable: responseCode < 500,
      code: `smtp_${responseCode}`,
      description: err.message,
    };
  }

  const nodeCode = extractNodeCode(err);
  return {
    ok: false,
    retryable: nodeCode !== null && CONNECTION_STAGE_CODES.has(nodeCode),
    code: nodeCode ? nodeCode.toLowerCase() : 'smtp_error',
    description: err.message,
  };
}

function extractResponseCode(err: Error): number | null {
  const value = (err as { responseCode?: unknown }).responseCode;
  return typeof value === 'number' ? value : null;
}

function extractNodeCode(err: Error): string | null {
  const value = (err as { code?: unknown }).code;
  return typeof value === 'string' ? value : null;
}
