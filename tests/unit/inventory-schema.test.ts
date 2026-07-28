import { describe, expect, it } from 'vitest';
import { movementFormSchema, prizeFormSchema } from '@/schemas/inventory';

const companyId = '11111111-1111-1111-1111-111111111111';
const prizeId = '22222222-2222-2222-2222-222222222222';
const categoryId = '33333333-3333-3333-3333-333333333333';

describe('prizeFormSchema', () => {
  it('accepts a fully specified prize', () => {
    const parsed = prizeFormSchema.safeParse({
      companyId,
      categoryId,
      name: 'Blender',
      internalCode: 'BLEND-01',
      description: 'A countertop blender',
      allowsReturnToStock: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('Blender');
      expect(parsed.data.internalCode).toBe('BLEND-01');
      expect(parsed.data.categoryId).toBe(categoryId);
    }
  });

  it('accepts a minimal prize with no category, code or description', () => {
    const parsed = prizeFormSchema.safeParse({
      companyId,
      categoryId: null,
      name: 'Blender',
      internalCode: null,
      description: null,
      allowsReturnToStock: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.categoryId).toBeUndefined();
      expect(parsed.data.internalCode).toBeUndefined();
      expect(parsed.data.description).toBeUndefined();
    }
  });

  it('rejects a blank name', () => {
    const parsed = prizeFormSchema.safeParse({
      companyId,
      categoryId: null,
      name: '   ',
      internalCode: null,
      description: null,
      allowsReturnToStock: true,
    });
    expect(parsed.success).toBe(false);
  });

  // internal_code is optional but bounded: this pair is the falsifiable case.
  // Deleting the bound would let this 41-char code (below) through; deleting
  // the "optional" half would make the minimal-prize case above fail instead.
  it('rejects an internal_code exceeding 40 characters', () => {
    const parsed = prizeFormSchema.safeParse({
      companyId,
      categoryId: null,
      name: 'Blender',
      internalCode: 'A'.repeat(41),
      description: null,
      allowsReturnToStock: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an internal_code at the 40-character bound', () => {
    const parsed = prizeFormSchema.safeParse({
      companyId,
      categoryId: null,
      name: 'Blender',
      internalCode: 'A'.repeat(40),
      description: null,
      allowsReturnToStock: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.internalCode?.length).toBe(40);
    }
  });

  it('converts an empty internal_code to undefined rather than an empty string', () => {
    const parsed = prizeFormSchema.safeParse({
      companyId,
      categoryId: null,
      name: 'Blender',
      internalCode: '   ',
      description: null,
      allowsReturnToStock: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.internalCode).toBeUndefined();
    }
  });

  it('trims the name and internal_code', () => {
    const parsed = prizeFormSchema.safeParse({
      companyId,
      categoryId: null,
      name: '  Blender  ',
      internalCode: '  BLEND-01  ',
      description: null,
      allowsReturnToStock: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('Blender');
      expect(parsed.data.internalCode).toBe('BLEND-01');
    }
  });

  it('rejects an invalid companyId that is not a UUID', () => {
    const parsed = prizeFormSchema.safeParse({
      companyId: 'not-a-uuid',
      categoryId: null,
      name: 'Blender',
      internalCode: null,
      description: null,
      allowsReturnToStock: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('movementFormSchema — entry (record_stock_entry: note is the one optional note)', () => {
  it('accepts an entry with a quantity and no note', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'MANUAL_ENTRY',
      quantity: 5,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'entry') {
      expect(parsed.data.note).toBeUndefined();
    }
  });

  it('rejects a zero quantity', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'MANUAL_ENTRY',
      quantity: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a negative quantity', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'MANUAL_ENTRY',
      quantity: -1,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a fractional quantity', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'MANUAL_ENTRY',
      quantity: 2.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an entryType outside the three entry kinds', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'DELIVERY',
      quantity: 5,
    });
    expect(parsed.success).toBe(false);
  });
});

describe.each(['exit', 'reserve', 'release'] as const)(
  'movementFormSchema — %s (mandatory note)',
  (kind) => {
    it('accepts a positive quantity with a real note', () => {
      const parsed = movementFormSchema.safeParse({
        kind,
        companyId,
        prizeId,
        quantity: 3,
        note: 'Damaged in transit',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects a zero quantity', () => {
      const parsed = movementFormSchema.safeParse({
        kind,
        companyId,
        prizeId,
        quantity: 0,
        note: 'Damaged in transit',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects a negative quantity', () => {
      const parsed = movementFormSchema.safeParse({
        kind,
        companyId,
        prizeId,
        quantity: -1,
        note: 'Damaged in transit',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects a fractional quantity', () => {
      const parsed = movementFormSchema.safeParse({
        kind,
        companyId,
        prizeId,
        quantity: 2.5,
        note: 'Damaged in transit',
      });
      expect(parsed.success).toBe(false);
    });

    // The falsifiable case for "mandatory": a note of only whitespace must be
    // refused exactly as an absent one would be, matching 0027's own
    // nullif(trim(coalesce(p_note, '')), '') on the database side.
    it('rejects a whitespace-only note', () => {
      const parsed = movementFormSchema.safeParse({
        kind,
        companyId,
        prizeId,
        quantity: 3,
        note: '   ',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects a missing note', () => {
      const parsed = movementFormSchema.safeParse({
        kind,
        companyId,
        prizeId,
        quantity: 3,
      });
      expect(parsed.success).toBe(false);
    });

    it('trims the note', () => {
      const parsed = movementFormSchema.safeParse({
        kind,
        companyId,
        prizeId,
        quantity: 3,
        note: '  Damaged in transit  ',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success && 'note' in parsed.data) {
        expect(parsed.data.note).toBe('Damaged in transit');
      }
    });
  },
);

describe('movementFormSchema — adjustment (adjust_stock: the counted figure)', () => {
  it('accepts a counted figure of zero — a real count of nothing on the shelf', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'adjustment',
      companyId,
      prizeId,
      counted: 0,
      note: 'Physical count, nothing on the shelf',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a positive counted figure', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'adjustment',
      companyId,
      prizeId,
      counted: 12,
      note: 'Physical count',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a negative counted figure', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'adjustment',
      companyId,
      prizeId,
      counted: -1,
      note: 'Physical count',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a fractional counted figure', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'adjustment',
      companyId,
      prizeId,
      counted: 4.5,
      note: 'Physical count',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a whitespace-only note', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'adjustment',
      companyId,
      prizeId,
      counted: 4,
      note: '   ',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('movementFormSchema — idempotencyKey', () => {
  it('is optional', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'exit',
      companyId,
      prizeId,
      quantity: 1,
      note: 'note',
    });
    expect(parsed.success).toBe(true);
  });

  it('converts an empty idempotencyKey to undefined', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'exit',
      companyId,
      prizeId,
      quantity: 1,
      note: 'note',
      idempotencyKey: '',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.idempotencyKey).toBeUndefined();
    }
  });
});
