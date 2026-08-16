import { describe, expect, it } from 'vitest';
import { vendorFormSchema } from '@/schemas/vendors';

/**
 * Block 24, item 7. What the vendor form is allowed to post.
 *
 * The rules worth a test here are the ones a reviewer would otherwise assume
 * went the other way: one required field out of thirteen, no format rule on the
 * document, and no e-mail validation. Each is a deliberate loosening with a
 * reason, and a test is what keeps somebody from "fixing" it.
 */

const companyId = '00000000-0000-0000-0000-0000000000a1';

describe('vendorFormSchema', () => {
  it('accepts a vendor carrying nothing but a name', () => {
    const r = vendorFormSchema.safeParse({ companyId, name: 'Camisetas do Sul' });
    expect(r.success).toBe(true);
  });

  it('refuses a blank name', () => {
    expect(vendorFormSchema.safeParse({ companyId, name: '   ' }).success).toBe(false);
    expect(vendorFormSchema.safeParse({ companyId }).success).toBe(false);
  });

  it('trims the name rather than storing what a paste left behind', () => {
    const r = vendorFormSchema.safeParse({ companyId, name: '  Brindes Norte  ' });
    expect(r.success && r.data.name).toBe('Brindes Norte');
  });

  // A box the operator cleared and a box they never filled are the same thing to
  // save_vendor, which writes null for both. Undefined is how that travels.
  it('turns an empty box into undefined so the door writes null', () => {
    const r = vendorFormSchema.safeParse({
      companyId,
      name: 'Brindes Norte',
      document: '',
      phone: null,
      city: '   ',
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.document).toBeUndefined();
    expect(r.data.phone).toBeUndefined();
    expect(r.data.city).toBeUndefined();
  });

  /**
   * DELIBERATELY UNVALIDATED. The field exists to match an invoice by eye, and a
   * CNPJ rule refuses the foreign supplier and the one whose paperwork has not
   * arrived — 0198's own column comment argues it. This test is what stops the
   * next reader from adding a mask.
   */
  it('accepts any shape of document, including a foreign one', () => {
    for (const document of ['12.345.678/0001-90', '12345678000190', 'VAT GB123456789', '—']) {
      expect(vendorFormSchema.safeParse({ companyId, name: 'X', document }).success, document).toBe(
        true,
      );
    }
  });

  /**
   * ALSO DELIBERATE. Nothing in this product mails a vendor, and the address is
   * typed off a business card.
   */
  it('accepts an address that is not a valid e-mail', () => {
    const r = vendorFormSchema.safeParse({
      companyId,
      name: 'X',
      email: 'compras (setor de brindes)',
    });
    expect(r.success).toBe(true);
  });

  it('refuses a field this form does not have', () => {
    const r = vendorFormSchema.safeParse({ companyId, name: 'X', deletedAt: '2026-08-15' });
    expect(r.success).toBe(false);
  });

  it('refuses a name longer than the column expects', () => {
    const r = vendorFormSchema.safeParse({ companyId, name: 'x'.repeat(201) });
    expect(r.success).toBe(false);
  });

  it('carries the vendor id through on an edit and omits it on a registration', () => {
    const edit = vendorFormSchema.safeParse({
      companyId,
      vendorId: '00000000-0000-0000-0000-0000000000b1',
      name: 'X',
    });
    expect(edit.success && edit.data.vendorId).toBe('00000000-0000-0000-0000-0000000000b1');

    const create = vendorFormSchema.safeParse({ companyId, name: 'X' });
    expect(create.success && create.data.vendorId).toBeUndefined();
  });
});
