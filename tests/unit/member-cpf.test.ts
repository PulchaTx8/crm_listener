import { describe, expect, it } from 'vitest';
import { cpfLastDigits, hashCpf, normalizeCpf } from '@/services/members';

describe('CPF hashing', () => {
  // The equality deduplication rests on: 0031_members.sql's cpf_hash unique
  // index only catches a repeat CPF if two spellings of the same number hash
  // identically. If they did not, the same person could register twice under
  // two different punctuation styles and the partial unique index would
  // never see the collision.
  it('hashes the same CPF written with punctuation and written bare to the same value', () => {
    expect(hashCpf('123.456.789-09')).toBe(hashCpf('12345678909'));
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
