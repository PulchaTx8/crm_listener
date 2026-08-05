import type { Interactive } from './interactive';
import type { Template } from './template';

/** What happened to one outbound message. */
export type SendResult =
  | { ok: true; externalId: string }
  | { ok: false; retryable: boolean; error: string };

export interface SendTextInput {
  phoneNumberId: string;
  to: string;
  body: string;
}

export interface SendInteractiveInput {
  phoneNumberId: string;
  to: string;
  interactive: Interactive;
}

export interface SendTemplateInput {
  phoneNumberId: string;
  to: string;
  template: Template;
}

/**
 * The seam the master spec means by a "decoupled" integration layer: a module
 * boundary, not a network hop. It is what lets CI prove the whole block with no
 * production secret anywhere near it.
 *
 * `retryable` is why SendResult is not a boolean. A rejected recipient never
 * becomes a good one and must not be retried; a 429 or a 5xx must not be
 * discarded.
 */
export interface WhatsAppTransport {
  sendText(input: SendTextInput): Promise<SendResult>;
  /** Buttons for the consent step, a list for a promotion's multiple-choice questions. */
  sendInteractive(input: SendInteractiveInput): Promise<SendResult>;
  /**
   * The only one of the three the Cloud API accepts OUTSIDE the 24-hour
   * customer service window, and so the only one this system can use to start
   * a conversation rather than continue one — which is the whole reason the
   * pickup reminder could not be built before the registry existed.
   */
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
}
