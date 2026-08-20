import { describe, expect, it } from 'vitest';
import {
  DOTS,
  lastFourDigits,
  maskedAddress,
  maskedEmail,
  maskedPassport,
  maskedPhone,
} from '@/lib/members/mask';

describe('lastFourDigits', () => {
  it('keeps only digits, so punctuation cannot shorten the answer', () => {
    expect(lastFourDigits('(11) 98595-4985')).toBe('4985');
  });

  it('answers null under four digits, because a mask that reveals a two-digit number is not a mask', () => {
    expect(lastFourDigits('123')).toBeNull();
    expect(lastFourDigits(null)).toBeNull();
  });
});

describe('maskedPhone', () => {
  it('renders the four digits behind dots', () => {
    expect(maskedPhone('4985')).toBe(`${DOTS} 4985`);
  });

  it('renders bare dots when there are no four digits to show', () => {
    expect(maskedPhone(null)).toBe(DOTS);
  });
});

describe('maskedEmail', () => {
  it('keeps the first character and the suffix after the last dot', () => {
    expect(maskedEmail('joao@gmail.com')).toBe('j•••@•••.com');
  });

  it('masks whole anything it cannot take apart, rather than guessing', () => {
    expect(maskedEmail('not-an-address')).toBe(DOTS);
    expect(maskedEmail('@gmail.com')).toBe(DOTS);
    expect(maskedEmail('joao@localhost')).toBe(DOTS);
  });

  it('answers null for nothing, so the screen renders no row at all', () => {
    expect(maskedEmail(null)).toBeNull();
    expect(maskedEmail('   ')).toBeNull();
  });
});

describe('maskedPassport', () => {
  it('shows the last four characters', () => {
    expect(maskedPassport('FX1284821')).toBe(`${DOTS} 4821`);
  });

  it('masks whole under four characters', () => {
    expect(maskedPassport('X12')).toBe(DOTS);
  });
});

describe('maskedAddress', () => {
  it('is dots when any part is on file, because a street is one fact', () => {
    expect(maskedAddress({ line: 'Rua das Flores', number: null, complement: null })).toBe(DOTS);
    expect(maskedAddress({ line: null, number: '221', complement: null })).toBe(DOTS);
  });

  it('is null when nothing is on file, so the screen renders no row at all', () => {
    expect(maskedAddress({ line: null, number: null, complement: '  ' })).toBeNull();
  });
});
