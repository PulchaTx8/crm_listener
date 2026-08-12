import { beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = { get: vi.fn(), set: vi.fn() };
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }));

describe('signOutAction', () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.set.mockReset();
  });

  it('clears the session cookie with the five attributes it was minted with, then redirects', async () => {
    const { signOutAction } = await import('@/app/(widget)/w/[publicKey]/actions');

    // redirect() WORKS BY THROWING (Next's own documented mechanism) -- fix
    // round 1's whole point is that the cookie write has to be visible to the
    // browser BEFORE that throw unwinds this function, or a listener who
    // follows the redirect still carries a live session.
    await expect(signOutAction('pw_test')).rejects.toThrow();

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
    await expect(signOutAction('pw_test')).rejects.toThrow();

    expect(cookieStore.get).not.toHaveBeenCalled();
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
  });

  it('redirects to this installation\'s own farewell address, encoded, never a fixed or absolute one', async () => {
    // Fix round 1: the whole reason the farewell now renders at all is that
    // this redirect turns "Sair" into a NAVIGATION `page.tsx` answers with
    // `<Farewell>` (see that file's `left === '1'` branch), rather than a
    // same-page refresh a cookie-driven branch could still win.
    const { signOutAction } = await import('@/app/(widget)/w/[publicKey]/actions');

    const error: unknown = await signOutAction('pw_needs encoding/slash').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    // Next's redirect() encodes the destination into the thrown error's
    // digest as `NEXT_REDIRECT;<type>;<url>;<statusCode>;` -- asserted
    // against that shape rather than mocking `next/navigation` away, so this
    // test fails if the real encoding or the real path ever drifts.
    const digest = (error as { digest?: string }).digest ?? '';
    expect(digest).toContain(';/w/pw_needs%20encoding%2Fslash?left=1;');
  });
});
