import { describe, expect, it } from 'vitest';
import { enterPromotionSchema } from '@/schemas/widget-promotions';

const PROMOTION = '00000000-0000-0000-0000-000000000001';
const QUESTION = '00000000-0000-0000-0000-000000000002';

describe('enterPromotionSchema', () => {
  it('reads the agreement checkbox the way a checkbox actually posts', () => {
    // An unchecked box posts NOTHING, so the field is absent rather than ''.
    expect(
      enterPromotionSchema.parse({ promotionId: PROMOTION, consent: 'on', fields: '{}', answers: '[]' })
        .consent,
    ).toBe(true);
    expect(
      enterPromotionSchema.parse({ promotionId: PROMOTION, fields: '{}', answers: '[]' }).consent,
    ).toBe(false);
  });

  it('reads the marketing checkbox the way a checkbox actually posts', () => {
    // Same wire shape as `consent`: an unchecked box posts nothing at all, so
    // the field is absent rather than ''. Unchecked is the default (Block 29c,
    // Task 9) — a pre-ticked box is not affirmative consent under the LGPD.
    expect(
      enterPromotionSchema.parse({
        promotionId: PROMOTION,
        marketingConsent: 'on',
        fields: '{}',
        answers: '[]',
      }).marketingConsent,
    ).toBe(true);
    expect(
      enterPromotionSchema.parse({ promotionId: PROMOTION, fields: '{}', answers: '[]' })
        .marketingConsent,
    ).toBe(false);
  });

  it('refuses a promotion id that is not a uuid', () => {
    expect(
      enterPromotionSchema.safeParse({ promotionId: 'nope', fields: '{}', answers: '[]' }).success,
    ).toBe(false);
  });

  it('parses the two JSON payloads out of their form strings', () => {
    const parsed = enterPromotionSchema.parse({
      promotionId: PROMOTION,
      consent: 'on',
      fields: '{"city":"Santos"}',
      answers: `[{"question_id":"${QUESTION}","option_id":null,"answer_text":"sim"}]`,
    });

    expect(parsed.fields).toEqual({ city: 'Santos' });
    expect(parsed.answers).toEqual([
      { question_id: QUESTION, option_id: null, answer_text: 'sim' },
    ]);
  });

  /**
   * The eight values of promotion_requested_field and nothing else. A key this
   * product cannot ask for did not come from the form this product renders, and
   * a door that merely ignores it would accept a payload nobody can explain.
   */
  it('refuses a field name no promotion can ask for', () => {
    expect(
      enterPromotionSchema.safeParse({
        promotionId: PROMOTION,
        consent: 'on',
        fields: '{"salary":"9000"}',
        answers: '[]',
      }).success,
    ).toBe(false);
  });

  it('accepts every field a promotion can ask for', () => {
    const every = {
      full_name: 'Ana',
      address: 'Rua A, 1',
      city: 'Santos',
      neighbourhood: 'Gonzaga',
      age: '1990-01-01',
      cpf: '00000000000',
      passport: 'AB123456',
      discovery_source: 'Rádio',
    };
    expect(
      enterPromotionSchema.parse({
        promotionId: PROMOTION,
        consent: 'on',
        fields: JSON.stringify(every),
        answers: '[]',
      }).fields,
    ).toEqual(every);
  });

  it('refuses JSON that is not JSON rather than throwing', () => {
    const result = enterPromotionSchema.safeParse({
      promotionId: PROMOTION,
      consent: 'on',
      fields: 'not json',
      answers: '[]',
    });
    expect(result.success).toBe(false);
  });

  it('refuses an answer without a question id', () => {
    expect(
      enterPromotionSchema.safeParse({
        promotionId: PROMOTION,
        consent: 'on',
        fields: '{}',
        answers: '[{"answer_text":"sim"}]',
      }).success,
    ).toBe(false);
  });

  it('refuses a field this product does not know', () => {
    expect(
      enterPromotionSchema.safeParse({
        promotionId: PROMOTION,
        consent: 'on',
        fields: '{}',
        answers: '[]',
        memberId: 'somebody-else',
      }).success,
    ).toBe(false);
  });
});
