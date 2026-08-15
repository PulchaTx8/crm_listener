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

  it('rejects an entryType outside the four entry kinds', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'DELIVERY',
      quantity: 5,
    });
    expect(parsed.success).toBe(false);
  });

  // Block 23, Task 4 fix round 1 (I4): BARTER_ENTRY and the invoice trio were
  // widened directly into this schema rather than left as a TypeScript-only
  // intersection in services/inventory.ts. A TypeScript intersection type
  // checks at compile time but Zod's discriminatedUnion strips (its default,
  // with no .strict() anywhere in this file) any key the schema itself does
  // not name — so the ONLY way to prove these fields actually survive
  // parsing, rather than being silently dropped by a schema nobody widened,
  // is to parse them and read them back off parsed.data.
  it('accepts BARTER_ENTRY, the fourth entry kind (design D4)', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'BARTER_ENTRY',
      quantity: 5,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts and keeps the invoice trio on an entry, not stripped', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'PURCHASE_ENTRY',
      quantity: 5,
      invoiceNumber: 'NF-1001',
      unitAmount: 2.5,
      totalAmount: 12.5,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'entry') {
      expect(parsed.data.invoiceNumber).toBe('NF-1001');
      expect(parsed.data.unitAmount).toBe(2.5);
      expect(parsed.data.totalAmount).toBe(12.5);
    }
  });

  it('omits the invoice trio entirely when none is given, rather than stripping it to null', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'MANUAL_ENTRY',
      quantity: 5,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'entry') {
      expect(parsed.data.invoiceNumber).toBeUndefined();
      expect(parsed.data.unitAmount).toBeUndefined();
      expect(parsed.data.totalAmount).toBeUndefined();
    }
  });

  it('rejects a negative unitAmount — inventory_movements_amounts_nonnegative, checked before the round trip', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'PURCHASE_ENTRY',
      quantity: 5,
      unitAmount: -1,
    });
    expect(parsed.success).toBe(false);
  });

  // The other bound: unit_amount/total_amount are numeric(12,2) (0193), so
  // 9,999,999,999.99 is the largest figure the column can hold. Past it, a
  // save reaches PostgreSQL's own numeric-overflow check (22003) instead of
  // this field-level message — a fix-round finding, since every other bound
  // in this file (internalCode, description, optionalInvoiceNumber) already
  // had a ceiling and this one did not.
  it('rejects a totalAmount past what numeric(12,2) can hold', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'PURCHASE_ENTRY',
      quantity: 5,
      totalAmount: 10_000_000_000,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the largest totalAmount numeric(12,2) can hold', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'entry',
      companyId,
      prizeId,
      entryType: 'PURCHASE_ENTRY',
      quantity: 5,
      totalAmount: 9_999_999_999.99,
    });
    expect(parsed.success).toBe(true);
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

// Block 23, Task 4 fix round 1 (I4): the three fields below, one per kind,
// are the same class of case as the invoice trio above — each widened
// straight into movementFormSchema so a form that posts it gets it back,
// rather than a TypeScript-only field that Zod's default strip behaviour
// silently discards.

describe('movementFormSchema — exit (record_stock_exit: the type option)', () => {
  it('accepts and keeps TRANSFER_EXIT, not stripped', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'exit',
      companyId,
      prizeId,
      quantity: 3,
      note: 'Sent to another station',
      type: 'TRANSFER_EXIT',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'exit') {
      expect(parsed.data.type).toBe('TRANSFER_EXIT');
    }
  });

  it('omits type entirely when none is given, so record_stock_exit falls back to its own MANUAL_EXIT default', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'exit',
      companyId,
      prizeId,
      quantity: 3,
      note: 'Damaged in transit',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'exit') {
      expect(parsed.data.type).toBeUndefined();
    }
  });
});

describe('movementFormSchema — reserve (reserve_stock: the showId option)', () => {
  it('accepts and keeps showId, not stripped', () => {
    const showId = '44444444-4444-4444-4444-444444444444';
    const parsed = movementFormSchema.safeParse({
      kind: 'reserve',
      companyId,
      prizeId,
      quantity: 2,
      note: 'Held for the afternoon show',
      showId,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'reserve') {
      expect(parsed.data.showId).toBe(showId);
    }
  });

  it('omits showId entirely when none is given — an anonymous hold, not a programme hold with a missing id', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'reserve',
      companyId,
      prizeId,
      quantity: 2,
      note: 'Anonymous hold',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'reserve') {
      expect(parsed.data.showId).toBeUndefined();
    }
  });
});

describe('movementFormSchema — release (release_reservation: the reservationId option)', () => {
  it('accepts and keeps reservationId, not stripped', () => {
    const reservationId = '55555555-5555-5555-5555-555555555555';
    const parsed = movementFormSchema.safeParse({
      kind: 'release',
      companyId,
      prizeId,
      quantity: 2,
      note: 'Partial release',
      reservationId,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'release') {
      expect(parsed.data.reservationId).toBe(reservationId);
    }
  });

  it('omits reservationId entirely when none is given', () => {
    const parsed = movementFormSchema.safeParse({
      kind: 'release',
      companyId,
      prizeId,
      quantity: 2,
      note: 'Release with no reservation to attribute it to',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'release') {
      expect(parsed.data.reservationId).toBeUndefined();
    }
  });
});

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
