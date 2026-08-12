import { beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = { get: vi.fn(), set: vi.fn() };
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }));

describe('signOutAction', () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.set.mockReset();
  });

  it('clears the session cookie with the five attributes it was minted with', async () => {
    const { signOutAction } = await import('@/app/(widget)/w/[publicKey]/actions');
    await signOutAction();

    expect(cookieStore.set).toHaveBeenCalledWith('pw_session', '', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      path: '/w',
      maxAge: 0,
    });
  });

  it('clears it without reading, verifying or caring what was presented', async () => {
    // A listener whose token already expired still pressed "Sair", and they are
    // entitled to the same answer. Making the clear conditional on a valid
    // session is how a dead cookie survives the one interaction meant to remove
    // it — the defect `expireDeadSession` has to work around on every submit.
    const { signOutAction } = await import('@/app/(widget)/w/[publicKey]/actions');
    await signOutAction();

    expect(cookieStore.get).not.toHaveBeenCalled();
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
  });
});
