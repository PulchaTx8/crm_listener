import type { WhatsAppTransport } from '@/lib/integrations/whatsapp/transport';
import type { MessagingProvider, SendJob, SendOutcome } from './provider';

/**
 * Sends the campaign's registered template through the Cloud API — the same
 * `WhatsAppTransport.sendTemplate` `src/services/whatsapp.ts`'s pickup
 * reminder already calls, never a second path to Meta.
 */
export class WhatsAppMessagingProvider implements MessagingProvider {
  constructor(private readonly transport: WhatsAppTransport) {}

  async send(job: SendJob): Promise<SendOutcome> {
    if (job.channel !== 'WHATSAPP') {
      // See EmailMessagingProvider's identical guard: a routing bug in the
      // caller, not a fact about a listener's send, so it is not something
      // SendOutcome has a shape for.
      throw new TypeError(`WhatsAppMessagingProvider cannot send an ${job.channel} job`);
    }

    if (job.template === null) {
      // Refused HERE, before any call to the transport — the same reasoning
      // drainOutbox uses to park a stored template it cannot parse
      // (src/services/whatsapp.ts, "stored template payload is not
      // sendable"): nobody is waiting at a screen for a campaign send, so a
      // template this campaign's own row never resolved would otherwise
      // spend a paid Graph API call, and a 400 from Meta, learning something
      // already knowable from the row itself.
      return {
        ok: false,
        retryable: false,
        code: 'no_template',
        description: 'no WhatsApp template resolved for this recipient',
      };
    }

    // The array travels exactly as the drain snapshotted it
    // (message_campaign_recipients.variables, 0242's own warning: "BUILT
    // ONCE, AT SNAPSHOT, AND NEVER RE-ORDERED AFTER"). This provider has no
    // other source for a template's variables and never re-reads
    // message_templates.variables' current order — doing so would let a
    // template edited while a campaign drains scramble a later recipient's
    // values into the wrong {{n}} slots, silently, because nothing about a
    // jsonb array says which index used to mean what.
    const result = await this.transport.sendTemplate({
      phoneNumberId: job.phoneNumberId,
      to: job.address,
      template: job.template,
    });

    if (result.ok) {
      return { ok: true, providerMessageId: result.externalId };
    }

    // `retryable` IS graph.ts's own taxonomy, not a second opinion of it:
    // SendResult already carries the verdict GraphTransport computed from the
    // HTTP status this provider never sees, and it is passed through
    // unchanged.
    //
    // `code` is NOT Meta's. graph.ts's own `extractError` reads only
    // `error.message` out of the Graph API's response body and has no field
    // that reads Meta's own machine code (e.g. "(#131008)") at all — that
    // value never reaches this provider, or graph.ts's caller, in the first
    // place. A code invented here by parsing the message for something that
    // looks like one would be a value nobody in this codebase could actually
    // trace back to what Meta said, so `code` names only what this provider
    // honestly knows: whether the drain should retry it. `description`
    // carries the one thing the transport does give — its raw message,
    // unmodified.
    return {
      ok: false,
      retryable: result.retryable,
      code: result.retryable ? 'whatsapp_retryable_error' : 'whatsapp_permanent_error',
      description: result.error,
    };
  }
}
