import type { SendInteractiveInput, SendResult, SendTextInput, WhatsAppTransport } from './transport';
import { buildInteractivePayload } from './interactive';

const GRAPH_VERSION = 'v21.0';

/**
 * The real Meta Graph API client.
 *
 * This method sends free-form text with no approved template, which the Graph
 * API only accepts inside WhatsApp's 24-hour customer service window (design
 * spec D5). It is the caller's job to only invoke this as a reply to an
 * inbound message — this class has no way to check that and does not try. An
 * out-of-window call is not rejected here; it comes back from Meta as a 400
 * and lands in the permanent bucket below, same as any other request Meta
 * refuses. Block 6's first Station-initiated message — a draw result — will
 * need a template, and this method is not it.
 */
export class GraphTransport implements WhatsAppTransport {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText({ phoneNumberId, to, body }: SendTextInput): Promise<SendResult> {
    return this.post(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: false },
    });
  }

  /**
   * Builds the interactive payload before doing anything else, so a shape
   * `buildInteractivePayload` refuses (too many buttons, a title too long)
   * throws here, outside the `post` helper's try/catch, rather than being
   * folded into a retryable/permanent SendResult it is not.
   */
  async sendInteractive({ phoneNumberId, to, interactive }: SendInteractiveInput): Promise<SendResult> {
    const built = buildInteractivePayload(interactive) as Record<string, unknown>;
    return this.post(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      ...built,
    });
  }

  private async post(phoneNumberId: string, body: Record<string, unknown>): Promise<SendResult> {
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
          body: JSON.stringify(body),
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

    // retryable means the same request may succeed later: a rate limit (429),
    // a server fault (5xx), a timeout (408), or a credential that can be
    // repaired (401, 403 — ops rotates or restores it and the identical
    // request then succeeds). Permanent means the request is wrong and will
    // stay wrong: a malformed number, a body Meta rejects outright.
    //
    // A genuinely dead token still resolves: it burns the retry ladder (five
    // attempts, roughly six minutes per row) and then parks as FAILED, visible
    // to an operator. That is the right trade against the more likely case —
    // a rotation or a temporary revocation — recovering on its own with no one
    // paged. The residual cost is real: a credential outage that outlives the
    // ladder leaves FAILED rows needing manual reprocessing, and a worker that
    // sees 401 could in principle abort the whole batch instead of burning the
    // ladder on every row in it — Task 12 territory, not this module's.
    const retryable =
      response.status === 408 ||
      response.status === 429 ||
      response.status === 401 ||
      response.status === 403 ||
      response.status >= 500;
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
