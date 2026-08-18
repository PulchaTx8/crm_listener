import { describe, it, expect } from 'vitest';
import { DevMailer } from '@/lib/mailer';

describe('DevMailer', () => {
  it('records the messages sent and returns an id', async () => {
    const mailer = new DevMailer();
    const res = await mailer.send({ to: 'a@b.com', subject: 'hi', text: 'body' });
    expect(res.id).toMatch(/^dev-/);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('a@b.com');
  });

  it('passes custom headers through to the transport', async () => {
    // List-Unsubscribe is the difference between Gmail showing a one-tap
    // unsubscribe and Gmail treating the sender as one with no exit. It costs
    // two lines here and it is deliverability, not decoration.
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
