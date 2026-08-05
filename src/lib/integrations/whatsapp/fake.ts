import type {
  SendInteractiveInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
  WhatsAppTransport,
} from './transport';
import { buildInteractivePayload } from './interactive';
import { buildTemplatePayload } from './template';

/** Records sends instead of making them. The transport CI uses. */
export class FakeTransport implements WhatsAppTransport {
  readonly sent: SendTextInput[] = [];
  readonly sentInteractive: SendInteractiveInput[] = [];
  readonly sentTemplates: SendTemplateInput[] = [];
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

  async sendInteractive(input: SendInteractiveInput): Promise<SendResult> {
    // Not pretending to be a real client: no HTTP, no Graph error shapes.
    // What it does share with GraphTransport is the one contract that is not
    // about the network at all -- a shape Meta would 400 on is refused here
    // too, so a test using the fake catches the same misconfiguration a
    // production send would.
    buildInteractivePayload(input.interactive);
    if (this.failure) {
      const { retryable } = this.failure;
      this.failure = null;
      return { ok: false, retryable, error: 'fake failure' };
    }
    this.sentInteractive.push(input);
    this.counter += 1;
    return { ok: true, externalId: `wamid.FAKE${this.counter}` };
  }

  /**
   * THIS ONE MATTERS MOST OF THE THREE. Every test in this repository that is
   * not a live send runs against this class, and the pickup reminder has no
   * other end-to-end path: nothing can send one until Meta approves a template,
   * which takes days and happens outside this system entirely. So the contract
   * a real send would enforce is enforced here — a variable Meta would refuse
   * (empty, over a thousand characters, carrying a newline) throws from the
   * fake exactly as it would from GraphTransport.
   */
  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    buildTemplatePayload(input.template);
    if (this.failure) {
      const { retryable } = this.failure;
      this.failure = null;
      return { ok: false, retryable, error: 'fake failure' };
    }
    this.sentTemplates.push(input);
    this.counter += 1;
    return { ok: true, externalId: `wamid.FAKE${this.counter}` };
  }
}
