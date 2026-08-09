import { describe, expect, it } from 'vitest';
import { mintSession, readSession, type WidgetClaims } from '@/lib/widget/session';

const SECRET = 'a'.repeat(48);
const claims: WidgetClaims = {
  installationId: '11111111-1111-1111-1111-111111111111',
  companyId: '22222222-2222-2222-2222-222222222222',
  organizationId: '33333333-3333-3333-3333-333333333333',
  memberId: '44444444-4444-4444-4444-444444444444',
  phone: '+5511999998888',
  exp: 2_000_000_000,
};

describe('the visitor session', () => {
  it('round-trips its own token', () => {
    expect(readSession(mintSession(claims, SECRET), SECRET)).toEqual(claims);
  });

  // The whole point of signing it. Without this assertion the session is a
  // base64 blob a visitor can edit into somebody else's Station.
  it('refuses a token whose payload was edited', () => {
    const token = mintSession(claims, SECRET);
    const [payload, signature] = token.split('.');
    // noUncheckedIndexedAccess types `payload` as possibly-undefined even
    // though `token` is always `<payload>.<signature>` here (mintSession's
    // own shape) -- the `?? ''` is satisfying the compiler about a case that
    // cannot actually occur, the same idiom src/app/(app)/music/permissions.ts
    // already uses.
    const tampered = Buffer.from(
      Buffer.from(payload ?? '', 'base64url').toString('utf8').replace(claims.companyId, claims.organizationId),
      'utf8',
    ).toString('base64url');
    expect(readSession(`${tampered}.${signature}`, SECRET)).toBeNull();
  });

  it('refuses a token signed with a different secret', () => {
    expect(readSession(mintSession(claims, SECRET), 'b'.repeat(48))).toBeNull();
  });

  it('refuses an expired token', () => {
    expect(readSession(mintSession(claims, SECRET), SECRET, 2_000_000_001_000)).toBeNull();
  });

  it('refuses a token that is not two parts', () => {
    expect(readSession('nonsense', SECRET)).toBeNull();
  });
});
