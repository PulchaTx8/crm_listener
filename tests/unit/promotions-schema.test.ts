import { describe, it, expect } from 'vitest';
import {
  promotionFormSchema,
  promotionPrizeLinkSchema,
  questionFormSchema,
} from '@/schemas/promotions';

const base = {
  companyId: '00000000-0000-0000-0000-0000000000c1',
  name: 'Galaxy S25 Ultra',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-08-31T00:00:00.000Z',
  allowMultipleEntries: false,
  requireCorrectAnswer: false,
  whatsappEnabled: false,
  useArt: false,
  requestedFields: [],
};

const whatsapp = { ...base, whatsappEnabled: true, hashtag: '#EUQUERO' };

describe('promotionFormSchema', () => {
  it('accepts the minimum promotion', () => {
    expect(promotionFormSchema.safeParse(base).success).toBe(true);
  });

  it('refuses a blank name', () => {
    expect(promotionFormSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
  });

  it('refuses an end before the start', () => {
    const r = promotionFormSchema.safeParse({ ...base, endsAt: '2026-07-01T00:00:00.000Z' });
    expect(r.success).toBe(false);
  });

  // The database says ends_at > starts_at, strictly. A zero-length window would
  // accept nothing at any instant, so the form must not let one through either.
  it('refuses an end exactly equal to the start', () => {
    const r = promotionFormSchema.safeParse({ ...base, endsAt: base.startsAt });
    expect(r.success).toBe(false);
  });

  it('requires an interval when repetition is on', () => {
    const r = promotionFormSchema.safeParse({ ...base, allowMultipleEntries: true });
    expect(r.success).toBe(false);
  });

  it('accepts repetition with an interval', () => {
    const r = promotionFormSchema.safeParse({
      ...base,
      allowMultipleEntries: true,
      minHoursBetweenEntries: 24,
    });
    expect(r.success).toBe(true);
  });

  it('refuses an interval when repetition is off', () => {
    const r = promotionFormSchema.safeParse({ ...base, minHoursBetweenEntries: 24 });
    expect(r.success).toBe(false);
  });

  it('refuses an interval beyond a year', () => {
    const r = promotionFormSchema.safeParse({
      ...base,
      allowMultipleEntries: true,
      minHoursBetweenEntries: 8761,
    });
    expect(r.success).toBe(false);
  });

  it('requires a hashtag when WhatsApp is on', () => {
    const r = promotionFormSchema.safeParse({ ...base, whatsappEnabled: true });
    expect(r.success).toBe(false);
  });

  it('refuses a hashtag without the leading hash', () => {
    const r = promotionFormSchema.safeParse({ ...whatsapp, hashtag: 'EUQUERO' });
    expect(r.success).toBe(false);
  });

  it('refuses a hashtag containing a space', () => {
    const r = promotionFormSchema.safeParse({ ...whatsapp, hashtag: '#EU QUERO' });
    expect(r.success).toBe(false);
  });

  it('refuses a hashtag with WhatsApp off', () => {
    const r = promotionFormSchema.safeParse({ ...base, hashtag: '#EUQUERO' });
    expect(r.success).toBe(false);
  });

  it('requires an art url when the art box is ticked', () => {
    const r = promotionFormSchema.safeParse({ ...whatsapp, useArt: true });
    expect(r.success).toBe(false);
  });

  it('refuses an art url when the art box is unticked', () => {
    const r = promotionFormSchema.safeParse({
      ...whatsapp,
      artUrl: 'https://example.test/b.jpg',
    });
    expect(r.success).toBe(false);
  });

  // The WhatsApp Cloud API fetches this image itself and will not fetch over
  // http, so an http url would validate here, preview fine in the browser, and
  // fail only at send time in Block 5.
  it('refuses an http art url', () => {
    const r = promotionFormSchema.safeParse({
      ...whatsapp,
      useArt: true,
      artUrl: 'http://example.test/b.jpg',
    });
    expect(r.success).toBe(false);
  });

  it('accepts an https art url', () => {
    const r = promotionFormSchema.safeParse({
      ...whatsapp,
      useArt: true,
      artUrl: 'https://example.test/b.jpg',
    });
    expect(r.success).toBe(true);
  });

  it('refuses requested fields while WhatsApp is off', () => {
    const r = promotionFormSchema.safeParse({ ...base, requestedFields: ['city'] });
    expect(r.success).toBe(false);
  });

  it('accepts requested fields while WhatsApp is on', () => {
    const r = promotionFormSchema.safeParse({
      ...whatsapp,
      requestedFields: ['full_name', 'city'],
    });
    expect(r.success).toBe(true);
  });

  it('refuses the same requested field twice', () => {
    const r = promotionFormSchema.safeParse({ ...whatsapp, requestedFields: ['city', 'city'] });
    expect(r.success).toBe(false);
  });

  it('refuses a field the enum does not have', () => {
    const r = promotionFormSchema.safeParse({ ...whatsapp, requestedFields: ['gender'] });
    expect(r.success).toBe(false);
  });
});

describe('questionFormSchema', () => {
  const choice = {
    kind: 'MULTIPLE_CHOICE' as const,
    prompt: 'Favourite genre?',
    menuTitle: 'Choose',
    buttonLabel: 'Options',
    options: [
      { label: 'Rock', isCorrect: false },
      { label: 'Samba', isCorrect: false },
    ],
  };

  it('accepts a poll with two options and no right answer', () => {
    expect(questionFormSchema.safeParse(choice).success).toBe(true);
  });

  it('refuses a choice question with one option', () => {
    const r = questionFormSchema.safeParse({ ...choice, options: [choice.options[0]] });
    expect(r.success).toBe(false);
  });

  it('refuses a right answer on a poll', () => {
    const r = questionFormSchema.safeParse({
      ...choice,
      options: [{ label: 'Rock', isCorrect: true }, choice.options[1]],
    });
    expect(r.success).toBe(false);
  });

  it('refuses a choice question without a menu title', () => {
    const r = questionFormSchema.safeParse({ ...choice, menuTitle: undefined });
    expect(r.success).toBe(false);
  });

  // No index can require a FIRST right answer — a partial unique index only
  // forbids the second. This is the only place that rule exists on the client.
  it('requires exactly one right answer on a quiz', () => {
    const r = questionFormSchema.safeParse({ ...choice, kind: 'QUIZ' });
    expect(r.success).toBe(false);
  });

  it('accepts a quiz with exactly one right answer', () => {
    const r = questionFormSchema.safeParse({
      ...choice,
      kind: 'QUIZ',
      options: [
        { label: 'Brazil', isCorrect: true },
        { label: 'Argentina', isCorrect: false },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('refuses two right answers on a quiz', () => {
    const r = questionFormSchema.safeParse({
      ...choice,
      kind: 'QUIZ',
      options: [
        { label: 'Brazil', isCorrect: true },
        { label: 'Argentina', isCorrect: true },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('accepts an essay question with no options', () => {
    const r = questionFormSchema.safeParse({ kind: 'ESSAY', prompt: 'Why?', options: [] });
    expect(r.success).toBe(true);
  });

  it('refuses options on an essay question', () => {
    const r = questionFormSchema.safeParse({
      kind: 'ESSAY',
      prompt: 'Why?',
      options: [{ label: 'x', isCorrect: false }],
    });
    expect(r.success).toBe(false);
  });

  it('refuses a menu title on an essay question', () => {
    const r = questionFormSchema.safeParse({
      kind: 'ESSAY',
      prompt: 'Why?',
      menuTitle: 'Choose',
      options: [],
    });
    expect(r.success).toBe(false);
  });

  it('refuses a blank option label', () => {
    const r = questionFormSchema.safeParse({
      ...choice,
      options: [{ label: '  ', isCorrect: false }, choice.options[1]],
    });
    expect(r.success).toBe(false);
  });
});

describe('promotionPrizeLinkSchema', () => {
  const valid = {
    promotionId: '11111111-1111-1111-1111-111111111111',
    prizeId: '22222222-2222-2222-2222-222222222222',
    quantity: 3,
  };

  it('accepts a whole number of units', () => {
    expect(promotionPrizeLinkSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses zero, because a link of nothing is not an event', () => {
    const result = promotionPrizeLinkSchema.safeParse({ ...valid, quantity: 0 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('at least one');
  });

  it('refuses a fraction — units are things, not amounts', () => {
    expect(promotionPrizeLinkSchema.safeParse({ ...valid, quantity: 1.5 }).success).toBe(false);
  });

  it('refuses a quantity that arrived as text the form could not read', () => {
    const result = promotionPrizeLinkSchema.safeParse({ ...valid, quantity: Number.NaN });
    expect(result.success).toBe(false);
    // Pins the message, not just the failure: Number('') is 0, which would
    // otherwise reach the schema as a real quantity and be refused with "Link
    // at least one unit" — a sentence about a number the operator never typed.
    // NaN's invalid_type check short-circuits before .int()/.min() ever run
    // (confirmed by hand: exactly one issue is produced for this input), so
    // asserting on issues[0] is safe rather than merely convenient.
    expect(result.error?.issues[0]?.message).toBe('How many units?');
  });

  it('accepts the largest quantity Postgres can hold', () => {
    expect(promotionPrizeLinkSchema.safeParse({ ...valid, quantity: 2_147_483_647 }).success).toBe(
      true,
    );
  });

  it('refuses one past it with a sentence rather than letting 22003 come back', () => {
    // The bound is the RPCs' `p_quantity integer`, not a product rule. Without
    // it a hand-posted 2147483648 reaches Postgres, comes back as 22003, maps to
    // InternalError and reaches the operator as a generic "Could not save" —
    // which says nothing about what to change. The number below is exactly one
    // past the ceiling, so this case fails if the bound is loosened by a single
    // unit and cannot pass on some smaller refusal.
    const result = promotionPrizeLinkSchema.safeParse({ ...valid, quantity: 2_147_483_648 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('That is more units than this system can count.');
  });

  it('refuses an id that is not a uuid, so a hand-edited form cannot reach the RPC', () => {
    expect(promotionPrizeLinkSchema.safeParse({ ...valid, prizeId: 'not-an-id' }).success).toBe(
      false,
    );
  });
});
