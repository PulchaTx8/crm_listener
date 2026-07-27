import { describe, it, expect } from 'vitest';
import { generateProvisionalPassword } from '@/services/provisioning';

describe('generateProvisionalPassword', () => {
  it('is long enough for the configured minimum', () => {
    expect(generateProvisionalPassword().length).toBeGreaterThanOrEqual(16);
  });

  it('does not repeat across calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateProvisionalPassword()));
    expect(seen.size).toBe(50);
  });

  it('avoids characters that are ambiguous when read aloud', () => {
    const joined = Array.from({ length: 50 }, () => generateProvisionalPassword()).join('');
    expect(joined).not.toMatch(/[0OIl1]/);
  });
});
