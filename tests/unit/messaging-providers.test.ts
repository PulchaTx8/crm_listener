import { describe, expect, it } from 'vitest';
import type { Mailer, MailMessage } from '@/lib/mailer';
import { renderCampaignEmail } from '@/lib/mailer/frame';
import type { SendResult, SendTemplateInput, WhatsAppTransport } from '@/lib/integrations/whatsapp/transport';
import type { Template } from '@/lib/integrations/whatsapp/template';
import { EmailMessagingProvider } from '@/lib/messaging/email-provider';
import { WhatsAppMessagingProvider } from '@/lib/messaging/whatsapp-provider';
import type { EmailSendJob, WhatsAppSendJob } from '@/lib/messaging/provider';

// A minimal Mailer double that records what it was asked to send and can be
// told to reject the next call the way SmtpMailer's nodemailer transport
// would (an Error carrying `.code` and, when the server answered, `.responseCode`).
function fakeMailer(): Mailer & { calls: MailMessage[]; rejectNextWith: (err: Error) => void } {
  let nextError: Error | null = null;
  return {
    calls: [] as MailMessage[],
    rejectNextWith(err: Error) {
      nextError = err;
    },
    async send(msg: MailMessage) {
      if (nextError) {
        const err = nextError;
        nextError = null;
        throw err;
      }
      this.calls.push(msg);
      return { id: `mail-${this.calls.length}` };
    },
  };
}

function smtpError(message: string, opts: { code?: string; responseCode?: number } = {}): Error {
  const err = new Error(message) as Error & { code?: string; responseCode?: number };
  if (opts.code) err.code = opts.code;
  if (opts.responseCode) err.responseCode = opts.responseCode;
  return err;
}

const baseEmailJob: EmailSendJob = {
  channel: 'EMAIL',
  address: 'ana@example.com',
  subject: 'Promoção de agosto',
  stationName: 'Rádio Pulcha FM',
  logoUrl: 'https://cdn.example/logo.png',
  body: 'Oi Ana!\nBoas notícias.',
  unsubscribe: null,
  sender: null,
};

describe('EmailMessagingProvider', () => {
  it('renders through renderCampaignEmail rather than assembling HTML itself', async () => {
    const mailer = fakeMailer();
    const provider = new EmailMessagingProvider(mailer);

    await provider.send(baseEmailJob);

    const expected = renderCampaignEmail({
      stationName: baseEmailJob.stationName,
      logoUrl: baseEmailJob.logoUrl,
      body: baseEmailJob.body,
      unsubscribe: baseEmailJob.unsubscribe,
    });

    expect(mailer.calls).toHaveLength(1);
    expect(mailer.calls[0]?.html).toBe(expected.html);
    expect(mailer.calls[0]?.text).toBe(expected.text);
    expect(mailer.calls[0]?.subject).toBe(baseEmailJob.subject);
    expect(mailer.calls[0]?.to).toBe(baseEmailJob.address);
  });

  it('sets both List-Unsubscribe and List-Unsubscribe-Post from the token it is given', async () => {
    const mailer = fakeMailer();
    const provider = new EmailMessagingProvider(mailer);

    await provider.send({
      ...baseEmailJob,
      unsubscribe: { url: 'https://app.example/u/abc123', label: 'Cancelar inscrição' },
    });

    expect(mailer.calls[0]?.headers?.['List-Unsubscribe']).toBe('<https://app.example/u/abc123>');
    expect(mailer.calls[0]?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('sets no List-Unsubscribe headers when the job carries no unsubscribe token', async () => {
    const mailer = fakeMailer();
    const provider = new EmailMessagingProvider(mailer);

    await provider.send(baseEmailJob);

    expect(mailer.calls[0]?.headers?.['List-Unsubscribe']).toBeUndefined();
    expect(mailer.calls[0]?.headers?.['List-Unsubscribe-Post']).toBeUndefined();
  });

  it("uses the Station's sender identity when one exists", async () => {
    const mailer = fakeMailer();
    const provider = new EmailMessagingProvider(mailer);

    await provider.send({
      ...baseEmailJob,
      sender: { fromName: 'Rádio Pulcha FM', fromAddress: 'campanhas@pulcha.fm', replyTo: 'contato@pulcha.fm' },
    });

    expect(mailer.calls[0]?.from).toBe('"Rádio Pulcha FM" <campanhas@pulcha.fm>');
    expect(mailer.calls[0]?.headers?.['Reply-To']).toBe('contato@pulcha.fm');
  });

  it('quotes a sender name containing a comma so it survives as one address token', async () => {
    // pt-BR writes a frequency's decimal separator as a comma, so
    // "Rádio Alvorada 96,5 FM" is the ordinary shape of this field, not an
    // edge case — an unquoted display name would split on that comma into two
    // address-list entries, the second of which is not an address at all.
    const mailer = fakeMailer();
    const provider = new EmailMessagingProvider(mailer);

    await provider.send({
      ...baseEmailJob,
      sender: { fromName: 'Rádio Alvorada 96,5 FM', fromAddress: 'campanhas@alvorada.fm', replyTo: null },
    });

    expect(mailer.calls[0]?.from).toBe('"Rádio Alvorada 96,5 FM" <campanhas@alvorada.fm>');
  });

  it('escapes an embedded quote in the sender name rather than letting it break the quoting', async () => {
    const mailer = fakeMailer();
    const provider = new EmailMessagingProvider(mailer);

    await provider.send({
      ...baseEmailJob,
      sender: { fromName: 'Rádio "A Voz" FM', fromAddress: 'campanhas@avoz.fm', replyTo: null },
    });

    expect(mailer.calls[0]?.from).toBe('"Rádio \\"A Voz\\" FM" <campanhas@avoz.fm>');
  });

  it('omits `from` entirely when the job carries no sender identity, leaving the installation default', async () => {
    // SmtpMailer (src/lib/mailer/index.ts) already sends
    // `from: msg.from ?? this.defaultFrom`. A second fallback computed here
    // would be a second place to get the installation default wrong.
    const mailer = fakeMailer();
    const provider = new EmailMessagingProvider(mailer);

    await provider.send({ ...baseEmailJob, sender: null });

    expect(mailer.calls[0]).not.toHaveProperty('from');
  });

  it('reports a permanent SMTP rejection (5xx) as not retryable', async () => {
    const mailer = fakeMailer();
    mailer.rejectNextWith(smtpError('550 5.1.1 mailbox unavailable', { code: 'EENVELOPE', responseCode: 550 }));
    const provider = new EmailMessagingProvider(mailer);

    const outcome = await provider.send(baseEmailJob);

    expect(outcome).toMatchObject({ ok: false, retryable: false });
    if (!outcome.ok) {
      expect(outcome.code).toBe('smtp_550');
      expect(outcome.description).toContain('mailbox unavailable');
    }
  });

  it('reports a transient SMTP rejection (4xx) as retryable', async () => {
    const mailer = fakeMailer();
    mailer.rejectNextWith(smtpError('450 4.2.1 mailbox temporarily unavailable', { code: 'EENVELOPE', responseCode: 450 }));
    const provider = new EmailMessagingProvider(mailer);

    const outcome = await provider.send(baseEmailJob);

    expect(outcome).toMatchObject({ ok: false, retryable: true, code: 'smtp_450' });
  });

  it('reports a connection failure with no server response as retryable', async () => {
    const mailer = fakeMailer();
    mailer.rejectNextWith(smtpError('Connection timeout', { code: 'ETIMEDOUT' }));
    const provider = new EmailMessagingProvider(mailer);

    const outcome = await provider.send(baseEmailJob);

    expect(outcome).toMatchObject({ ok: false, retryable: true, code: 'etimedout' });
  });

  it('reports a locally-refused envelope with no server response as not retryable', async () => {
    const mailer = fakeMailer();
    mailer.rejectNextWith(smtpError('No recipients defined', { code: 'EENVELOPE' }));
    const provider = new EmailMessagingProvider(mailer);

    const outcome = await provider.send(baseEmailJob);

    expect(outcome).toMatchObject({ ok: false, retryable: false, code: 'eenvelope' });
  });

  it('reports a TLS handshake failure with no server response as retryable', async () => {
    // nodemailer sets `code: 'ETLS'` with no responseCode for a STARTTLS
    // upgrade that never completes (a cert or cipher mismatch, a connection
    // dropped mid-handshake) — read directly from
    // node_modules/nodemailer/lib/smtp-connection/index.js and
    // smtp-transport/index.js rather than assumed. Nothing about the message
    // was refused; the TLS layer never produced a usable connection.
    const mailer = fakeMailer();
    mailer.rejectNextWith(smtpError('Error initiating TLS - self-signed certificate', { code: 'ETLS' }));
    const provider = new EmailMessagingProvider(mailer);

    const outcome = await provider.send(baseEmailJob);

    expect(outcome).toMatchObject({ ok: false, retryable: true, code: 'etls' });
  });

  it('returns the mailer id as providerMessageId on success', async () => {
    const mailer = fakeMailer();
    const provider = new EmailMessagingProvider(mailer);

    const outcome = await provider.send(baseEmailJob);

    expect(outcome).toEqual({ ok: true, providerMessageId: 'mail-1' });
  });

  it('throws rather than sending when handed a job for the wrong channel', async () => {
    // A later change that quietly turned this guard into a swallowed failure
    // would route an e-mail job through the WhatsApp provider (or vice versa)
    // and lose it silently rather than failing loudly — this case is what
    // would catch that regression.
    const mailer = fakeMailer();
    const provider = new EmailMessagingProvider(mailer);

    await expect(provider.send(baseWhatsAppJob)).rejects.toThrow(TypeError);
    expect(mailer.calls).toHaveLength(0);
  });
});

const registeredTemplate: Template = {
  name: 'pickup_reminder',
  language: 'pt_BR',
  variables: ['Ana', 'Ingressos', '2026-08-20'],
  otpButton: false,
};

const baseWhatsAppJob: WhatsAppSendJob = {
  channel: 'WHATSAPP',
  address: '5511988887777',
  phoneNumberId: '111222333',
  template: registeredTemplate,
};

function fakeTransport(): WhatsAppTransport & { sentTemplates: SendTemplateInput[]; nextResult: SendResult | null } {
  return {
    sentTemplates: [] as SendTemplateInput[],
    nextResult: null as SendResult | null,
    async sendText() {
      throw new Error('not used by this provider');
    },
    async sendInteractive() {
      throw new Error('not used by this provider');
    },
    async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
      this.sentTemplates.push(input);
      if (this.nextResult) return this.nextResult;
      return { ok: true, externalId: 'wamid.FAKE1' };
    },
  };
}

describe('WhatsAppMessagingProvider', () => {
  it('refuses a job with no registered template rather than calling the transport', async () => {
    const transport = fakeTransport();
    const provider = new WhatsAppMessagingProvider(transport);

    const outcome = await provider.send({ ...baseWhatsAppJob, template: null });

    expect(outcome).toMatchObject({ ok: false, retryable: false });
    expect(transport.sentTemplates).toHaveLength(0);
  });

  it('sends the positional variables array exactly as the job carries it', async () => {
    const transport = fakeTransport();
    const provider = new WhatsAppMessagingProvider(transport);

    await provider.send(baseWhatsAppJob);

    expect(transport.sentTemplates[0]?.template.variables).toEqual(['Ana', 'Ingressos', '2026-08-20']);
    expect(transport.sentTemplates[0]?.to).toBe('5511988887777');
    expect(transport.sentTemplates[0]?.phoneNumberId).toBe('111222333');
  });

  it('returns the externalId as providerMessageId on success', async () => {
    const transport = fakeTransport();
    const provider = new WhatsAppMessagingProvider(transport);

    const outcome = await provider.send(baseWhatsAppJob);

    expect(outcome).toEqual({ ok: true, providerMessageId: 'wamid.FAKE1' });
  });

  it("passes graph.ts's own retryable verdict through on a retryable transport failure", async () => {
    const transport = fakeTransport();
    transport.nextResult = { ok: false, retryable: true, error: 'slow down' };
    const provider = new WhatsAppMessagingProvider(transport);

    const outcome = await provider.send(baseWhatsAppJob);

    expect(outcome).toMatchObject({ ok: false, retryable: true, description: 'slow down' });
  });

  it("passes graph.ts's own retryable verdict through on a permanent transport failure", async () => {
    const transport = fakeTransport();
    transport.nextResult = { ok: false, retryable: false, error: 'invalid phone number' };
    const provider = new WhatsAppMessagingProvider(transport);

    const outcome = await provider.send(baseWhatsAppJob);

    expect(outcome).toMatchObject({ ok: false, retryable: false, description: 'invalid phone number' });
  });

  it("does not invent a code that looks like Meta's own", async () => {
    const transport = fakeTransport();
    transport.nextResult = { ok: false, retryable: false, error: '(#131008) Required parameter is missing' };
    const provider = new WhatsAppMessagingProvider(transport);

    const outcome = await provider.send(baseWhatsAppJob);

    if (!outcome.ok) {
      expect(outcome.code).not.toContain('131008');
      expect(outcome.code).not.toMatch(/^#/);
    } else {
      throw new Error('expected a failure outcome');
    }
  });

  it('throws rather than sending when handed a job for the wrong channel', async () => {
    // See EmailMessagingProvider's identical case: a routing bug that quietly
    // became a swallowed failure would route a WhatsApp job through the
    // e-mail provider (or vice versa) and lose it silently.
    const transport = fakeTransport();
    const provider = new WhatsAppMessagingProvider(transport);

    await expect(provider.send(baseEmailJob)).rejects.toThrow(TypeError);
    expect(transport.sentTemplates).toHaveLength(0);
  });
});
