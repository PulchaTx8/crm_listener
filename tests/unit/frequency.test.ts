import { describe, expect, it } from 'vitest';
import { formatFrequency, khzFromInput, inputFromKhz } from '@/lib/frequency';

describe('formatFrequency', () => {
  it('shows FM in MHz with one decimal', () => {
    expect(formatFrequency('FM', 98500, 'pt')).toBe('98,5 FM');
    expect(formatFrequency('FM', 98500, 'en')).toBe('98.5 FM');
  });

  it('shows AM in whole kHz, because that is how a dial is read', () => {
    expect(formatFrequency('AM', 1200, 'pt')).toBe('1200 AM');
  });

  it('shows nothing for a band with no frequency', () => {
    // WEB is a real band with no dial position; a null frequency beside it is
    // the truth rather than a gap.
    expect(formatFrequency('WEB', null, 'pt')).toBeNull();
    expect(formatFrequency('FM', null, 'pt')).toBeNull();
    expect(formatFrequency(null, 98500, 'pt')).toBeNull();
  });

  it('keeps a decimal that is not .5', () => {
    expect(formatFrequency('FM', 107900, 'pt')).toBe('107,9 FM');
  });
});

describe('khzFromInput', () => {
  it('reads FM as MHz and stores kHz', () => {
    expect(khzFromInput('FM', '98.5')).toBe(98500);
    // Somebody typing on a Brazilian keyboard uses a comma.
    expect(khzFromInput('FM', '98,5')).toBe(98500);
  });

  it('reads AM as kHz and stores it unchanged', () => {
    expect(khzFromInput('AM', '1200')).toBe(1200);
  });

  it('reads a blank as absent rather than as zero', () => {
    // frequency_khz > 0 is a CHECK (0153); a 0 would be refused by the database
    // with a constraint name where the operator meant "I do not know".
    expect(khzFromInput('FM', '')).toBeNull();
    expect(khzFromInput('FM', '   ')).toBeNull();
    expect(khzFromInput('WEB', '98.5')).toBeNull();
  });

  it('reads nonsense as absent rather than as NaN', () => {
    expect(khzFromInput('FM', 'ninety-eight')).toBeNull();
  });
});

describe('inputFromKhz', () => {
  it('round-trips through the form', () => {
    expect(inputFromKhz('FM', khzFromInput('FM', '98.5'))).toBe('98.5');
    expect(inputFromKhz('AM', khzFromInput('AM', '1200'))).toBe('1200');
  });

  it('is empty when there is nothing stored', () => {
    expect(inputFromKhz('FM', null)).toBe('');
    expect(inputFromKhz(null, 98500)).toBe('');
  });
});
