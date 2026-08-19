import type { Template } from '@/lib/integrations/whatsapp/template';

/**
 * The seam Task 6's drain calls through instead of the mailer or the WhatsApp
 * transport directly, for one bulk campaign send.
 *
 * NEITHER IMPLEMENTATION TOUCHES THE DATABASE, READS AN ENVIRONMENT VARIABLE
 * FOR TENANT DATA, OR LOOKS ANYTHING UP. Everything a provider needs to send
 * one message arrives already resolved in the `SendJob` it is handed — the
 * Station's sender identity, the template's registered name and variables,
 * the recipient's snapshotted address. A provider that fetched a Station's
 * sender identity itself would do it once per recipient — the N+1 an earlier
 * block in this project already had to undo one layer up (Block 3b's
 * listener-list N+1, 102 queries down to 5). The drain resolves all of it
 * once per campaign and hands the winner over.
 *
 * NEITHER IMPLEMENTATION RETRIES. The drain owns the retry ladder
 * (`BACKOFF_SECONDS`, `MAX_ATTEMPTS`, `src/services/whatsapp.ts`, reused
 * rather than restated per Task 6's brief) and decides, from `retryable`
 * below, whether and when a row comes back around. A provider that retried
 * inside itself would run its own backoff underneath the drain's, and the
 * two together would be a schedule nobody could reason about from either
 * file alone.
 */
export interface MessagingProvider {
  send(job: SendJob): Promise<SendOutcome>;
}

/**
 * What one send attempt produced.
 *
 * `code` and `description` are asked of every failure because
 * `message_campaign_recipients_failed_says_why` (0242) requires a code on
 * every row marked `failed` — "failed, no reason on the row" is exactly the
 * outcome an operator asking "why did nobody get it?" cannot act on. Neither
 * provider invents a code that imitates the far side's own vocabulary where
 * it does not have one — see each provider's own comment for what `code`
 * honestly is in its case.
 */
export type SendOutcome =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; code: string; description: string };

/**
 * Discriminated on `channel` rather than one flat struct, because the two
 * channels share nothing but the resolved address: a WhatsApp job has no
 * subject or sender identity, and an e-mail job has no `phoneNumberId` or
 * template. A flat struct would make every WhatsApp field optional on an
 * e-mail job and vice versa, and "optional" is the wrong word for a
 * `phoneNumberId` an e-mail job could never legitimately carry.
 */
export type SendJob = EmailSendJob | WhatsAppSendJob;

/**
 * The Station's resolved sender identity for this send, or null on
 * `EmailSendJob.sender` when neither the Station (`companies.email_from_*`,
 * 0226) nor the template (`message_templates.from_*`, 0223) named one. The
 * drain resolves which of the two wins, once per campaign, and hands over
 * only the winner — never both, so a provider is never the place that
 * decides precedence.
 */
export interface EmailSenderIdentity {
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
}

export interface EmailSendJob {
  channel: 'EMAIL';
  /** Resolved at snapshot time (`message_campaign_recipients.address`, 0242); a provider never looks one up. */
  address: string;
  subject: string;
  /** `renderCampaignEmail`'s (`src/lib/mailer/frame.ts`) `FrameInput.stationName`. */
  stationName: string;
  /** `FrameInput.logoUrl` — `companies.thumb_url`, or null when the Station has none. */
  logoUrl: string | null;
  /** The operator's text; `renderCampaignEmail` escapes and frames it. */
  body: string;
  /** `FrameInput.unsubscribe`. The label travels with the URL because `frame.ts` cannot reach the i18n catalogues. */
  unsubscribe: { url: string; label: string } | null;
  sender: EmailSenderIdentity | null;
}

export interface WhatsAppSendJob {
  channel: 'WHATSAPP';
  /** Resolved at snapshot time; a provider never looks one up. */
  address: string;
  phoneNumberId: string;
  /**
   * Null when this campaign's own row could not resolve one — a template
   * deleted or unregistered between creation and send.
   * `WhatsAppMessagingProvider` refuses this without calling the transport
   * (see its own comment): a send with no template is not worth spending a
   * paid Graph API call on to learn what the row already says.
   */
  template: Template | null;
}
