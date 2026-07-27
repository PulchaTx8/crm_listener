import { describe, it, expect } from 'vitest';
import { hashIpAddress } from '@/services/contact-requests';

describe('hashIpAddress', () => {
  it('never returns the raw address', () => {
    expect(hashIpAddress('203.0.113.7')).not.toContain('203.0.113.7');
  });

  it('is stable for the same address', () => {
    expect(hashIpAddress('203.0.113.7')).toBe(hashIpAddress('203.0.113.7'));
  });

  it('differs across addresses', () => {
    expect(hashIpAddress('203.0.113.7')).not.toBe(hashIpAddress('203.0.113.8'));
  });
});
