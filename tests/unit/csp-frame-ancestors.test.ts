import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy } from '@/lib/security/csp';

// Block 17a. buildContentSecurityPolicy's fourth parameter is the only new
// surface this task adds to the policy builder itself; tests/unit/security/
// csp.test.ts (Block 11b/13a) already covers every other directive and is left
// unmodified on purpose -- its frame-ancestors assertion calls the function
// with three arguments and must still see 'none' from the new default.
describe('the policy', () => {
  it('still refuses framing when nobody passes an allowlist', () => {
    const policy = buildContentSecurityPolicy('n0nce', 'https://x.supabase.co', false);
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('names the origins it was given', () => {
    const policy = buildContentSecurityPolicy(
      'n0nce', 'https://x.supabase.co', false, 'https://radio.com.br',
    );
    expect(policy).toContain('frame-ancestors https://radio.com.br');
    expect(policy).not.toContain("frame-ancestors 'none'");
  });
});
