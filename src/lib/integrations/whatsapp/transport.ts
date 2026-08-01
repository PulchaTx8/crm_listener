/** What happened to one outbound message. */
export type SendResult =
  | { ok: true; externalId: string }
  | { ok: false; retryable: boolean; error: string };

export interface SendTextInput {
  phoneNumberId: string;
  to: string;
  body: string;
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
}
