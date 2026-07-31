import { describe, it, expect } from 'vitest';
import { importRowSchema, participationFormSchema } from '@/schemas/participations';

/**
 * Every negative case below asserts `issues[0].message`, not merely
 * `success === false`. Block 4b shipped a schema test that pinned only the
 * boolean and had to come back for the message: a pinned boolean goes on
 * passing after the checks are reordered, while the operator starts reading a
 * sentence written for a different mistake.
 *
 * Each negative fixture is built so exactly one issue can arise — a field-level
 * failure short-circuits the object before `.superRefine` runs at all, and the
 * cross-field cases below leave every field valid — so `issues[0]` is the issue
 * under test rather than whichever one happened to be produced first.
 */

const manual = {
  promotionId: '11111111-1111-1111-1111-111111111111',
  fullName: 'Ana Maria',
  phone: '11988887777',
  participatedAt: '2026-08-01T14:30:00.000Z',
  answers: [],
};

describe('participationFormSchema', () => {
  it('accepts a listener identified by phone', () => {
    expect(participationFormSchema.safeParse(manual).success).toBe(true);
  });

  // resolve_or_create_member (0054) REGISTERS the listener when it finds none,
  // so a form with neither identifier does not fail — it silently creates a new
  // listener on every submission, none of which can ever be deduplicated
  // against. The message names both fields because either one is enough.
  it('refuses a form carrying neither a phone nor a CPF', () => {
    const result = participationFormSchema.safeParse({
      ...manual,
      phone: undefined,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'Enter a phone number or a CPF so the listener can be found or registered.',
    );
  });

  // The other door into the same form: the operator picked somebody from the
  // search box, so the listener is already resolved and there is nothing left
  // to identify them by (design spec §5).
  it('accepts a listener already picked from the search box, with no identifier at all', () => {
    const result = participationFormSchema.safeParse({
      promotionId: manual.promotionId,
      memberId: '22222222-2222-2222-2222-222222222222',
      participatedAt: manual.participatedAt,
      answers: [],
    });
    expect(result.success).toBe(true);
  });

  // Mirrors participation_answers_shape (0052). Without this the row reaches
  // Postgres, trips the CHECK, and comes back as a bare 23514 naming a
  // constraint the operator has never heard of.
  it('refuses an answer that carries both a chosen option and written text', () => {
    const result = participationFormSchema.safeParse({
      ...manual,
      answers: [
        {
          questionId: '33333333-3333-3333-3333-333333333333',
          optionId: '44444444-4444-4444-4444-444444444444',
          answerText: 'Brazil',
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'An answer is either a chosen option or written text, never both.',
    );
  });
});

const row = {
  line: 2,
  fullName: 'Bruno Costa',
  phone: '11955554444',
  participatedAt: '2026-08-01T14:30:00.000Z',
};

describe('importRowSchema', () => {
  it('accepts a row with a name, an identifier and an instant', () => {
    expect(importRowSchema.safeParse(row).success).toBe(true);
  });

  // D7: the timestamp is not decoration. The minimum interval measures against
  // it, so a historical spreadsheet whose dates could not be read and were
  // stamped "now" instead would refuse its own second entry for a person and
  // give a reason that is not true.
  it('refuses a row whose entry instant cannot be read', () => {
    const result = importRowSchema.safeParse({ ...row, participatedAt: '01/08/2026 14:30' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Could not read when this person entered.');
  });

  it('refuses a CPF that is not eleven digits', () => {
    const result = importRowSchema.safeParse({ ...row, cpf: '1234567890' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('A CPF has eleven digits.');
  });

  // Deliberately accepted rather than refused here. import_participations
  // (0054) skips a row with no phone and no CPF and reports it with its line
  // number and the reason; refusing it in this schema would make that branch
  // unreachable through the screen and cost the operator the per-line report
  // the whole import exists to give them.
  it('accepts a row with no identifier, because the RPC reports that one per line', () => {
    const result = importRowSchema.safeParse({ ...row, phone: undefined });
    expect(result.success).toBe(true);
  });
});
