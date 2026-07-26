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
});
