/**
 * The one place that knows how a CNPJ is stored and how it is shown.
 *
 * Stored bare: fourteen digits, no punctuation — `organizations_tax_id_shape`
 * and `companies_tax_id_shape` (0154, 0155) both refuse anything else. That is
 * `normalize_phone`'s rule (0031) applied to a company registration, and for its
 * reason: two people typing the same company two different ways must produce one
 * value, or a search for a customer finds nothing while the customer is right
 * there.
 *
 * THE CHECK DIGITS ARE DELIBERATELY NOT VERIFIED. A CNPJ's last two digits are a
 * mod-11 of the first twelve, and checking them here would refuse a number an
 * operator has read correctly off a contract that itself carries a typo — which
 * is a support call, not a saved record. A well-formed but wrong CNPJ is a
 * data-entry problem a human notices on the invoice; a refusal at the form is a
 * customer who cannot be recorded at all. The database asserts the shape and the
 * application asserts nothing more.
 */

const DIGITS_ONLY = /[^0-9]/g;
const CNPJ_LENGTH = 14;

/**
 * What the operator typed, reduced to what the column accepts.
 *
 * Returns null both for "nothing was entered" and for "what was entered is not
 * a CNPJ". The caller writes null either way, which is right: a partial
 * registration number is not a fact worth keeping, and storing `123` would put
 * a value in an invoicing field that no invoice can be raised against.
 */
export function normaliseTaxId(typed: string | null | undefined): string | null {
  const digits = (typed ?? '').replace(DIGITS_ONLY, '');
  if (digits.length !== CNPJ_LENGTH) return null;
  return digits;
}

/**
 * The stored value in the punctuation a Brazilian reads: 12.345.678/0001-99.
 *
 * A value of the wrong length is handed back untouched rather than sliced into
 * a CNPJ-shaped string. Nothing but normaliseTaxId writes these columns, so the
 * only way one arrives is a database edited by hand — and showing it as it is
 * is how an operator notices that, where a confident-looking mask is how they
 * never do.
 */
export function formatTaxId(stored: string | null | undefined): string {
  if (!stored) return '';
  if (stored.length !== CNPJ_LENGTH) return stored;
  return `${stored.slice(0, 2)}.${stored.slice(2, 5)}.${stored.slice(5, 8)}/${stored.slice(8, 12)}-${stored.slice(12)}`;
}
