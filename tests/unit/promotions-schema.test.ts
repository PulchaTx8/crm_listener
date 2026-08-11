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
  // Block 17c: the sister flag. Required like the one above, because the form
  // always posts a checkbox and a promotion always answers the question.
  webEnabled: false,
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

  // The per-person ceiling (D1), mirroring promotions_entry_ceiling_shape in
  // 0052: `max_entries_per_member is null or (allow_multiple_entries and
  // max_entries_per_member >= 2)`. The two must agree — the constraint is the
  // one no caller can skip, and a form that accepted what it refuses would send
  // an operator a constraint name instead of a sentence.
  // The parsed VALUE is asserted, not merely `success`. A z.object strips keys
  // it does not declare, so a schema with no ceiling field at all accepts this
  // input happily and reports success — which is exactly the state this whole
  // change exists to leave behind, and a case that cannot see it is a case that
  // would have passed before the field existed.
  it('accepts a ceiling when repetition is on, and carries it through', () => {
    const r = promotionFormSchema.safeParse({
      ...base,
      allowMultipleEntries: true,
      minHoursBetweenEntries: 24,
      maxEntriesPerMember: 3,
    });
    expect(r.success).toBe(true);
    expect(r.data?.maxEntriesPerMember).toBe(3);
  });

  // One schema, one field set, both doors. promotionFormSchema is what
  // createPromotion and updatePromotion both parse, and promotionRpcArgs builds
  // both calls from it — so a ceiling that parsed for an edit and not for a
  // registration would be an asymmetry with no rule behind it. 0055 recreates
  // create_promotion with the same seventeenth argument for exactly that reason;
  // this case is what notices if the schema ever grows a create/update split.
  it('accepts a ceiling on a promotion being registered, not only on one being edited', () => {
    const r = promotionFormSchema.safeParse({
      ...base,
      companyId: base.companyId,
      allowMultipleEntries: true,
      minHoursBetweenEntries: 6,
      maxEntriesPerMember: 2,
    });
    expect(r.success).toBe(true);
    expect(r.data?.companyId).toBe(base.companyId);
    expect(r.data?.maxEntriesPerMember).toBe(2);
  });

  it('refuses a ceiling when repetition is off', () => {
    const r = promotionFormSchema.safeParse({ ...base, maxEntriesPerMember: 3 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(
      'There is no ceiling to set while only one entry per listener is allowed.',
    );
  });

  // A ceiling of one is what "no repeats" already says, and two ways to say one
  // thing is one way too many — 0052's own comment on the column. The message is
  // pinned rather than the boolean because the obvious wrong refusal here is the
  // one above ("no ceiling while repeats are off"), which would pass a
  // boolean-only assertion while telling the operator to untick a box they have
  // correctly ticked.
  it('refuses a ceiling of one', () => {
    const r = promotionFormSchema.safeParse({
      ...base,
      allowMultipleEntries: true,
      minHoursBetweenEntries: 24,
      maxEntriesPerMember: 1,
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(
      'A ceiling of one is what turning repeat entries off already says, so set two or more.',
    );
  });

  it('requires a hashtag when WhatsApp is on', () => {
    const r = promotionFormSchema.safeParse({ ...base, whatsappEnabled: true });
    expect(r.success).toBe(false);
  });

  /**
   * Block 17c. Requested fields used to belong to WhatsApp because WhatsApp was
   * the only thing that could ask a listener anything. The widget asks the same
   * fields through another door, so the rule is now "some door".
   */
  it('accepts requested fields on a promotion that only uses the web', () => {
    const r = promotionFormSchema.safeParse({
      ...base,
      webEnabled: true,
      requestedFields: ['city'],
    });
    expect(r.success).toBe(true);
  });

  it('still refuses requested fields when the promotion converses nowhere', () => {
    const r = promotionFormSchema.safeParse({ ...base, requestedFields: ['city'] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(
      'Turn WhatsApp or the web on for this promotion, or leave these empty.',
    );
  });

  /** The hashtag did NOT move with them: it is an object of that conversation. */
  it('still refuses a hashtag on a web-only promotion', () => {
    const r = promotionFormSchema.safeParse({
      ...base,
      webEnabled: true,
      hashtag: '#EUQUERO',
    });
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

  // FOUR CASES ABOUT THE BANNER USED TO SIT HERE — the tick without an address,
  // the address without the tick, http refused, https accepted — and Block 14
  // removed them rather than reworded them. The banner is no longer a field of
  // this form: it is uploaded, and set_promotion_art is its only writer (0144).
  //
  // The rules did not disappear with the cases. `promotions_art_shape` still
  // forces use_art and art_url to agree, and set_promotion_art is what sets both
  // — from the presence of the address, so they cannot disagree. The refusal a
  // promotion with WhatsApp off gets is asserted in
  // supabase/tests/30_promotion_images.test.sql, where it can be asserted
  // against the function that actually enforces it.
  //
  // Deleted rather than left passing vacuously: two of these four went on
  // reporting success against a schema that no longer looks at the field, which
  // is the shape of a test that guards nothing.

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
