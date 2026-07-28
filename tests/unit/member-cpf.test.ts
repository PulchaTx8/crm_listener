import { describe, expect, it } from 'vitest';
import { cpfLastDigits, hashCpf, normalizeCpf } from '@/services/members';

describe('CPF hashing', () => {
  // The equality deduplication rests on: 0031_members.sql's cpf_hash unique
  // index only catches a repeat CPF if two spellings of the same number hash
  // identically. If they did not, the same person could register twice under
  // two different punctuation styles and the partial unique index would
  // never see the collision. Covers more than the two formats the brief
  // named (dotted-and-dashed, bare) because the property has to hold against
  // whatever a real operator types, not only the two canonical shapes — and
  // it has to agree with find_member_by_identifier's own SQL-side
  // normalisation (normalize_phone/normalize_email's sibling reasoning,
  // 0031), where the two disagreeing is the silent-dedup-death mode this
  // block has already named twice (0031's own comment on hand-copied
  // normalisation, and 0031's own extraction of normalize_phone/
  // normalize_email into shared, immutable functions for exactly this
  // reason — 0033's find_member_by_identifier only calls them, at
  // 0033_member_dedup.sql:97-98).
  //
  // Every row here compares a written CPF against the canonical bare-digit
  // form, never against itself — 'bare digits' would otherwise assert
  // hashCpf('12345678909') === hashCpf('12345678909'), a value equal to
  // itself regardless of whether normalizeCpf does anything at all. Kept out
  // for that reason: this project has shipped a test that cannot fail
  // whichever way the code is written three times already, and a fourth was
  // not worth the extra row.
  it.each([
    ['123.456.789-09', 'dotted and dashed'],
    ['123 456 789 09', 'space separated'],
    ['123 456.789-09', 'mixed spaces and punctuation'],
  ])('hashes %s (%s) the same as the canonical bare-digit form', (written) => {
    expect(hashCpf(written)).toBe(hashCpf('12345678909'));
  });

  it('hashes a different CPF to a different value', () => {
    expect(hashCpf('123.456.789-09')).not.toBe(hashCpf('987.654.321-00'));
  });

  it('produces a sixty-four character lower-case hex digest', () => {
    // 0031_members.sql's own CHECK constraint: cpf_hash ~ '^[0-9a-f]{64}$'.
    // Verifying against that exact pattern, not merely "looks like a hash",
    // is what proves this function's output is something the database's own
    // constraint would accept rather than merely something that looks close.
    expect(hashCpf('123.456.789-09')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not contain the raw CPF', () => {
    const raw = '123.456.789-09';
    expect(hashCpf(raw)).not.toContain(raw);
    expect(hashCpf(raw)).not.toContain('12345678909');
  });

  it('normalises to digits only', () => {
    expect(normalizeCpf('123.456.789-09')).toBe('12345678909');
    expect(normalizeCpf('12345678909')).toBe('12345678909');
  });

  it('takes the last three digits — cpf_last_digits\' own format', () => {
    // 0031_members.sql's own CHECK constraint: cpf_last_digits ~ '^[0-9]{3}$'.
    expect(cpfLastDigits('123.456.789-09')).toBe('909');
    expect(cpfLastDigits('12345678909')).toBe('909');
    expect(cpfLastDigits('123.456.789-09')).toMatch(/^[0-9]{3}$/);
  });
});
