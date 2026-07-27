import { describe, it, expect } from 'vitest';
import { generateInvitationToken, hashInvitationToken } from '@/services/invitations';

describe('invitation tokens', () => {
  it('are long enough to resist guessing', () => {
    expect(generateInvitationToken().length).toBeGreaterThanOrEqual(32);
  });

  it('do not repeat across calls', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateInvitationToken()));
    expect(seen.size).toBe(100);
  });

  it('are URL-safe, since they travel in a link', () => {
    const joined = Array.from({ length: 50 }, () => generateInvitationToken()).join('');
    expect(joined).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hash to a value that does not contain the token', () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).not.toContain(token);
  });

  it('hash stably, so the lookup by hash finds the row', () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
  });
});
