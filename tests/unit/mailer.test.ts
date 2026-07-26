import { describe, it, expect } from 'vitest';
import { DevMailer } from '@/lib/mailer';

describe('DevMailer', () => {
  it('registra as mensagens enviadas e devolve id', async () => {
    const mailer = new DevMailer();
    const res = await mailer.send({ to: 'a@b.com', subject: 'oi', text: 'corpo' });
    expect(res.id).toMatch(/^dev-/);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('a@b.com');
  });
});
