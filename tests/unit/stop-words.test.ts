import { describe, expect, it } from 'vitest';
import { isStopWord } from '@/lib/consent/stop-words';

describe('the WhatsApp stop words', () => {
  it.each(['PARAR', 'parar', 'Parar', ' parar ', 'PARAR!'])(
    'recognises %j',
    (text) => expect(isStopWord(text)).toBe(true),
  );

  it.each(['CANCELAR', 'cancelar', 'DESCADASTRAR', 'descadastrar'])(
    'recognises %j too',
    (text) => expect(isStopWord(text)).toBe(true),
  );

  it('recognises an accented spelling, because people type it', () => {
    // Somebody typing on a phone keyboard produces "descadastrár" or worse.
    // Comparing without accents costs one normalise and buys the difference
    // between a listener leaving and a listener complaining.
    expect(isStopWord('descadastrár')).toBe(true);
  });

  it('does NOT treat SAIR as a stop word', () => {
    // The widget has carried a "Sair" since Block 19b meaning end-the-session.
    // Two things sharing a name while doing different things is how an
    // afternoon disappears -- and here it would convert somebody closing a
    // conversation into somebody withdrawing consent.
    expect(isStopWord('SAIR')).toBe(false);
  });

  it('does not match a word that merely contains one', () => {
    // "parara" is not "parar", and a listener answering a question about their
    // city must not be unsubscribed by a substring.
    expect(isStopWord('pararam de tocar')).toBe(false);
    expect(isStopWord('quero cancelar minha participacao')).toBe(false);
  });
});
