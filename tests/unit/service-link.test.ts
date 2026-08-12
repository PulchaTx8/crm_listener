import { describe, expect, it } from 'vitest';
import { buildServiceLink, buildServiceMessage } from '@/lib/widget/service-link';

const base = 'https://pulchatx.com';

describe('buildServiceLink', () => {
  it('addresses the music panel', () => {
    expect(
      buildServiceLink(base, { publicKey: 'pw_abc', code: 'xyz', purpose: 'MUSIC', promotionId: null }),
    ).toBe('https://pulchatx.com/w/pw_abc/enter?k=xyz&open=music');
  });

  it('addresses one promotion by id', () => {
    expect(
      buildServiceLink(base, {
        publicKey: 'pw_abc',
        code: 'xyz',
        purpose: 'PROMOTION',
        promotionId: '00000000-0000-0000-0000-000000000009',
      }),
    ).toBe(
      'https://pulchatx.com/w/pw_abc/enter?k=xyz&open=promotion&id=00000000-0000-0000-0000-000000000009',
    );
  });

  it('addresses the menu with no destination at all', () => {
    expect(
      buildServiceLink(base, { publicKey: 'pw_abc', code: 'xyz', purpose: 'MENU', promotionId: null }),
    ).toBe('https://pulchatx.com/w/pw_abc/enter?k=xyz');
  });

  /** A trailing slash on the configured site URL must not produce a double one. */
  it('does not double the slash', () => {
    expect(
      buildServiceLink('https://pulchatx.com/', {
        publicKey: 'pw_abc',
        code: 'xyz',
        purpose: 'MENU',
        promotionId: null,
      }),
    ).toBe('https://pulchatx.com/w/pw_abc/enter?k=xyz');
  });
});

describe('buildServiceMessage', () => {
  /**
   * The link is appended on its OWN LINE rather than interpolated into a
   * placeholder. A placeholder an operator can delete is a message that arrives
   * without its link, and nothing on any screen would show that.
   */
  it('puts the link on its own line under the text', () => {
    expect(buildServiceMessage('Toque para pedir sua música:', 'https://x/y')).toBe(
      'Toque para pedir sua música:\n\nhttps://x/y',
    );
  });

  it('survives a Station whose text ends in whitespace', () => {
    expect(buildServiceMessage('Vamos lá!   \n', 'https://x/y')).toBe('Vamos lá!\n\nhttps://x/y');
  });
});
