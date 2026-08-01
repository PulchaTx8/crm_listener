import type { SendResult, SendTextInput, WhatsAppTransport } from './transport';

const GRAPH_VERSION = 'v21.0';

/**
 * The real Meta Graph API client.
 *
 * Every reply this block sends is a response to an inbound message, so it falls
 * inside WhatsApp's 24-hour customer service window where free-form text is
 * allowed and no approved template is needed (design spec D5). The first
 * Station-initiated message — a draw result, Block 6 — will need a template,
 * and this method is not it.
 */
export class GraphTransport implements WhatsAppTransport {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText({ phoneNumberId, to, body }: SendTextInput): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { body, preview_url: false },
          }),
        },
      );
    } catch (cause) {
      // A connection that failed says nothing about the request being wrong.
      return { ok: false, retryable: true, error: String(cause) };
    }

    const payload: unknown = await response.json().catch(() => ({}));

    if (response.ok) {
      const id = extractMessageId(payload);
      return id
        ? { ok: true, externalId: id }
        : { ok: false, retryable: true, error: 'accepted without a message id' };
    }

    // 429 and 5xx are the cases that come back on their own. Everything else —
    // a malformed number, a revoked token, a number outside the allowed list —
    // returns the same answer however many times it is asked.
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, retryable, error: extractError(payload) ?? `HTTP ${response.status}` };
  }
}

function extractMessageId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages[0];
  if (typeof first !== 'object' || first === null) return null;
  const id = (first as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function extractError(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}
