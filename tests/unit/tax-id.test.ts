import { describe, expect, it } from 'vitest';
import { formatTaxId, normaliseTaxId } from '@/lib/tax-id';

describe('normaliseTaxId', () => {
  it('strips the punctuation people actually type', () => {
    expect(normaliseTaxId('12.345.678/0001-99')).toBe('12345678000199');
  });

  it('accepts digits already bare', () => {
    expect(normaliseTaxId('12345678000199')).toBe('12345678000199');
  });

  it('reads a blank as absent rather than as empty string', () => {
    expect(normaliseTaxId('   ')).toBeNull();
  });

  it('refuses the wrong number of digits rather than storing a stub', () => {
    // organizations_tax_id_shape would refuse it anyway, with a constraint name
    // where the operator needs a sentence.
    expect(normaliseTaxId('123')).toBeNull();
  });

  it('refuses fifteen digits as firmly as three', () => {
    expect(normaliseTaxId('123456780001999')).toBeNull();
  });

  it('does NOT verify the check digits', () => {
    // Deliberate (spec §6.1): a well-formed but wrong CNPJ is a data-entry
    // problem a human notices, not a corruption the database must prevent.
    // Mod-11 belongs in a validator somebody can choose to run, not in the
    // function that decides what gets stored.
    expect(normaliseTaxId('00000000000000')).toBe('00000000000000');
  });
});

describe('formatTaxId', () => {
  it('renders what a person recognises', () => {
    expect(formatTaxId('12345678000199')).toBe('12.345.678/0001-99');
  });

  it('renders nothing for nothing', () => {
    expect(formatTaxId(null)).toBe('');
  });

  it('hands back anything it cannot mask, rather than mangling it', () => {
    // Nothing but normaliseTaxId writes this column, so the only way a value of
    // the wrong length reaches here is a database somebody edited by hand.
    // Showing it unformatted is how an operator sees that; silently slicing it
    // into a CNPJ-shaped string is how they never do.
    expect(formatTaxId('123')).toBe('123');
  });
});
