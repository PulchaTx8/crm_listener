import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DevMailer, SmtpMailer } from '@/lib/mailer';

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn(async (options: unknown) => ({
        messageId: '<mocked@example.com>',
        __sentOptions: options,
      })),
    })),
  },
}));

describe('DevMailer', () => {
  it('records the messages sent and returns an id', async () => {
    const mailer = new DevMailer();
    const res = await mailer.send({ to: 'a@b.com', subject: 'hi', text: 'body' });
    expect(res.id).toMatch(/^dev-/);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('a@b.com');
  });

  it('records messages with custom headers', async () => {
    // Verifies that DevMailer preserves headers in its sent array.
    const mailer = new DevMailer();
    await mailer.send({
      to: 'a@b.test',
      subject: 'x',
      text: 'y',
      headers: { 'List-Unsubscribe': '<https://app.test/unsubscribe/abc>' },
    });
    expect(mailer.sent[0]?.headers?.['List-Unsubscribe']).toBe(
      '<https://app.test/unsubscribe/abc>',
    );
  });
});

describe('SmtpMailer', () => {
  it('passes custom headers through to the transport', async () => {
    // List-Unsubscribe is the difference between Gmail showing a one-tap
    // unsubscribe and Gmail treating the sender as one with no exit. It costs
    // two lines here and it is deliverability, not decoration.
    const nodemailer = await import('nodemailer');
    const mailer = new SmtpMailer('smtp://localhost', 'test@example.com');

    await mailer.send({
      to: 'a@b.test',
      subject: 'x',
      text: 'y',
      headers: { 'List-Unsubscribe': '<https://app.test/unsubscribe/abc>' },
    });

    const mockTransport = (nodemailer.default.createTransport as any).mock.results[0]?.value;
    const sendMailCall = (mockTransport.sendMail as any).mock.calls[0];
    expect(sendMailCall[0].headers?.['List-Unsubscribe']).toBe(
      '<https://app.test/unsubscribe/abc>',
    );
  });
});
