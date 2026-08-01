import type { SendResult, SendTextInput, WhatsAppTransport } from './transport';

/** Records sends instead of making them. The transport CI uses. */
export class FakeTransport implements WhatsAppTransport {
  readonly sent: SendTextInput[] = [];
  private failure: { retryable: boolean } | null = null;
  private counter = 0;

  /** The next send fails once, then normal service resumes. */
  failNext(retryable: boolean): void {
    this.failure = { retryable };
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    if (this.failure) {
      const { retryable } = this.failure;
      this.failure = null;
      return { ok: false, retryable, error: 'fake failure' };
    }
    this.sent.push(input);
    this.counter += 1;
    return { ok: true, externalId: `wamid.FAKE${this.counter}` };
  }
}
