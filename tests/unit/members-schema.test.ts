import { describe, expect, it } from 'vitest';
import {
  addMemberNoteSchema,
  blockMemberSchema,
  createMemberSchema,
  liftMemberBlockSchema,
  linkMemberToCompanySchema,
  recordMemberConsentSchema,
  updateMemberSchema,
} from '@/schemas/members';

const companyId = '11111111-1111-1111-1111-111111111111';
const memberId = '22222222-2222-2222-2222-222222222222';
const blockId = '33333333-3333-3333-3333-333333333333';
const promotionId = '44444444-4444-4444-4444-444444444444';

describe('createMemberSchema', () => {
  it('accepts a fully specified listener', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      phone: '(11) 91234-5678',
      email: 'Maria@Example.com',
      cpf: '123.456.789-09',
      passport: 'AB123456',
      birthDate: '1990-05-20',
      addressLine: 'Rua das Flores',
      addressNumber: '100',
      addressComplement: 'Apto 4',
      neighbourhood: 'Centro',
      city: 'Sao Paulo',
      state: 'SP',
      postalCode: '01000-000',
      discoverySource: 'Instagram',
      firstContactAt: '2026-01-01T12:00:00Z',
      firstContactOrigin: 'WhatsApp',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.fullName).toBe('Maria Silva');
      expect(parsed.data.email).toBe('maria@example.com');
      expect(parsed.data.cpf).toBe('12345678909');
    }
  });

  it('accepts a minimal listener with only a name and a Station', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.phone).toBeUndefined();
      expect(parsed.data.email).toBeUndefined();
      expect(parsed.data.cpf).toBeUndefined();
      expect(parsed.data.birthDate).toBeUndefined();
      expect(parsed.data.addressLine).toBeUndefined();
    }
  });

  it('rejects a blank name', () => {
    const parsed = createMemberSchema.safeParse({ companyId, fullName: '   ' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing companyId', () => {
    const parsed = createMemberSchema.safeParse({ fullName: 'Maria Silva' });
    expect(parsed.success).toBe(false);
  });

  // --- phone: a value that normalises to nothing is rejected, blank is not ---

  it('rejects a phone that normalises to nothing', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      phone: '----',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an absent phone', () => {
    const parsed = createMemberSchema.safeParse({ companyId, fullName: 'Maria Silva' });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty-string phone as "not supplied"', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      phone: '',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.phone).toBeUndefined();
  });

  it('accepts a real phone with punctuation', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      phone: '(11) 91234-5678',
    });
    expect(parsed.success).toBe(true);
  });

  // --- email: bounded and lowercased ---

  it('lower-cases the e-mail', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      email: 'MARIA@EXAMPLE.COM',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe('maria@example.com');
  });

  it('rejects an e-mail exceeding 320 characters', () => {
    const localPart = 'a'.repeat(310);
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      email: `${localPart}@example.com`,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed e-mail', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      email: 'not-an-email',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an absent e-mail', () => {
    const parsed = createMemberSchema.safeParse({ companyId, fullName: 'Maria Silva' });
    expect(parsed.success).toBe(true);
  });

  // --- cpf: eleven digits after stripping ---

  it('accepts a CPF written with punctuation, stripped to eleven digits', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      cpf: '123.456.789-09',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.cpf).toBe('12345678909');
  });

  it('accepts a CPF written as eleven bare digits', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      cpf: '12345678909',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.cpf).toBe('12345678909');
  });

  it('rejects a CPF with fewer than eleven digits after stripping', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      cpf: '123.456.789',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a CPF with more than eleven digits after stripping', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      cpf: '123.456.789-091',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an absent CPF', () => {
    const parsed = createMemberSchema.safeParse({ companyId, fullName: 'Maria Silva' });
    expect(parsed.success).toBe(true);
  });

  // --- birth date: cannot be in the future ---

  it('accepts a birth date in the past', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      birthDate: '1990-05-20',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a birth date in the future', () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      birthDate: future.toISOString().slice(0, 10),
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an absent birth date', () => {
    const parsed = createMemberSchema.safeParse({ companyId, fullName: 'Maria Silva' });
    expect(parsed.success).toBe(true);
  });

  // --- address fields: optional ---

  it('accepts every address field absent', () => {
    const parsed = createMemberSchema.safeParse({ companyId, fullName: 'Maria Silva' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.addressLine).toBeUndefined();
      expect(parsed.data.addressNumber).toBeUndefined();
      expect(parsed.data.addressComplement).toBeUndefined();
      expect(parsed.data.neighbourhood).toBeUndefined();
      expect(parsed.data.city).toBeUndefined();
      expect(parsed.data.state).toBeUndefined();
      expect(parsed.data.postalCode).toBeUndefined();
    }
  });

  it('accepts every address field supplied', () => {
    const parsed = createMemberSchema.safeParse({
      companyId,
      fullName: 'Maria Silva',
      addressLine: 'Rua das Flores',
      addressNumber: '100',
      addressComplement: 'Apto 4',
      neighbourhood: 'Centro',
      city: 'Sao Paulo',
      state: 'SP',
      postalCode: '01000-000',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('updateMemberSchema', () => {
  it('accepts a wholesale replacement keyed on memberId', () => {
    const parsed = updateMemberSchema.safeParse({
      memberId,
      fullName: 'Maria Silva',
      phone: '11987654321',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a missing memberId', () => {
    const parsed = updateMemberSchema.safeParse({ fullName: 'Maria Silva' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a blank name', () => {
    const parsed = updateMemberSchema.safeParse({ memberId, fullName: '' });
    expect(parsed.success).toBe(false);
  });

  it('carries no companyId or first-contact fields', () => {
    // update_member (0034) takes no company_id and cannot touch
    // first_contact_at/first_contact_origin — write-once evidence through
    // create_member only. Asserting the parsed shape has no such keys is
    // what would catch a copy-paste of createMemberSchema's fields.
    const parsed = updateMemberSchema.safeParse({ memberId, fullName: 'Maria Silva' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('companyId' in parsed.data).toBe(false);
      expect('firstContactAt' in parsed.data).toBe(false);
      expect('firstContactOrigin' in parsed.data).toBe(false);
    }
  });
});

describe('linkMemberToCompanySchema', () => {
  it('accepts a member and a Station', () => {
    const parsed = linkMemberToCompanySchema.safeParse({ memberId, companyId });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-uuid memberId', () => {
    const parsed = linkMemberToCompanySchema.safeParse({ memberId: 'not-a-uuid', companyId });
    expect(parsed.success).toBe(false);
  });
});

describe('recordMemberConsentSchema — consent_type is one of the three', () => {
  it.each(['rules', 'image_use', 'sponsor_communication'] as const)(
    'accepts %s',
    (consentType) => {
      const parsed = recordMemberConsentSchema.safeParse({
        memberId,
        companyId,
        consentType,
        granted: true,
      });
      expect(parsed.success).toBe(true);
    },
  );

  it('rejects a consent type outside the three', () => {
    const parsed = recordMemberConsentSchema.safeParse({
      memberId,
      companyId,
      consentType: 'whatsapp',
      granted: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing granted flag', () => {
    const parsed = recordMemberConsentSchema.safeParse({
      memberId,
      companyId,
      consentType: 'rules',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an optional origin and promotionId', () => {
    const parsed = recordMemberConsentSchema.safeParse({
      memberId,
      companyId,
      consentType: 'rules',
      granted: true,
      origin: 'Registration form',
      promotionId,
    });
    expect(parsed.success).toBe(true);
  });

  it('treats an absent origin and promotionId as optional', () => {
    const parsed = recordMemberConsentSchema.safeParse({
      memberId,
      companyId,
      consentType: 'rules',
      granted: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.origin).toBeUndefined();
      expect(parsed.data.promotionId).toBeUndefined();
    }
  });
});

describe('addMemberNoteSchema', () => {
  it('accepts a real note', () => {
    const parsed = addMemberNoteSchema.safeParse({
      memberId,
      companyId,
      body: 'Called about the draw, will call back tomorrow.',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a whitespace-only body', () => {
    const parsed = addMemberNoteSchema.safeParse({ memberId, companyId, body: '   ' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing body', () => {
    const parsed = addMemberNoteSchema.safeParse({ memberId, companyId });
    expect(parsed.success).toBe(false);
  });
});

describe('blockMemberSchema', () => {
  it.each(['draw_ban', 'suspension'] as const)('accepts kind %s', (kind) => {
    const parsed = blockMemberSchema.safeParse({ memberId, kind, reason: 'Repeated abuse' });
    expect(parsed.success).toBe(true);
  });

  it('rejects a kind outside the two', () => {
    const parsed = blockMemberSchema.safeParse({
      memberId,
      kind: 'ban',
      reason: 'Repeated abuse',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing reason', () => {
    const parsed = blockMemberSchema.safeParse({ memberId, kind: 'draw_ban' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a whitespace-only reason', () => {
    const parsed = blockMemberSchema.safeParse({ memberId, kind: 'draw_ban', reason: '   ' });
    expect(parsed.success).toBe(false);
  });

  it('accepts an absent companyId as an Organization-wide block', () => {
    const parsed = blockMemberSchema.safeParse({
      memberId,
      kind: 'draw_ban',
      reason: 'Repeated abuse',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.companyId).toBeUndefined();
  });

  it('accepts a Station-scoped block with an end date', () => {
    const parsed = blockMemberSchema.safeParse({
      memberId,
      companyId,
      kind: 'suspension',
      reason: 'Missed pickup twice',
      endsAt: '2026-12-31T23:59:59Z',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('liftMemberBlockSchema', () => {
  it('accepts a block id and a reason', () => {
    const parsed = liftMemberBlockSchema.safeParse({ blockId, reason: 'Called and apologised' });
    expect(parsed.success).toBe(true);
  });

  it('rejects a missing reason', () => {
    const parsed = liftMemberBlockSchema.safeParse({ blockId });
    expect(parsed.success).toBe(false);
  });
});
