import { describe, expect, it } from 'vitest';
import { stationEmailIdentitySchema } from '@/schemas/stations';

const COMPANY = '11111111-1111-1111-1111-111111111111';

describe('stationEmailIdentitySchema', () => {
  it('accepts a full, valid identity', () => {
    const parsed = stationEmailIdentitySchema.parse({
      companyId: COMPANY,
      fromName: '  Rádio Voz  ',
      fromAddress: 'contato@radiovoz.com.br',
      replyTo: 'atendimento@radiovoz.com.br',
    });
    // Trimmed here as well as at the door, so the value the operator sees
    // saved is the value that was stored.
    expect(parsed.fromName).toBe('Rádio Voz');
    expect(parsed.fromAddress).toBe('contato@radiovoz.com.br');
    expect(parsed.replyTo).toBe('atendimento@radiovoz.com.br');
  });

  it('refuses an address with no @ in it', () => {
    const result = stationEmailIdentitySchema.safeParse({
      companyId: COMPANY,
      fromAddress: 'not-an-address',
    });
    expect(result.success).toBe(false);
  });

  // save_station_email_identity's own comment (0226): "the form sets every
  // field it takes on every call, so a blank means fall back to the
  // installation's MAIL_FROM" -- a blank address is the ONLY way this form
  // can clear one already set, so the schema must accept it rather than
  // refuse it as a bad e-mail.
  it('accepts a blank address as a clear, not as a bad e-mail', () => {
    const result = stationEmailIdentitySchema.safeParse({
      companyId: COMPANY,
      fromAddress: '',
      replyTo: '',
    });
    expect(result.success).toBe(true);
  });
});
