import { describe, expect, it } from 'vitest';
import { readStationIdentity, whatsappHref } from '@/lib/widget/station-identity';

describe('whatsappHref', () => {
  it('reduces an operator-typed number to the digits wa.me takes', () => {
    expect(whatsappHref('+55 11 98888-7777')).toBe('https://wa.me/5511988887777');
  });

  it('passes bare digits through unchanged', () => {
    expect(whatsappHref('5511988887777')).toBe('https://wa.me/5511988887777');
  });

  it('answers null for no number at all', () => {
    expect(whatsappHref(null)).toBeNull();
  });

  it('answers null rather than a dead link when nothing survives the reduction', () => {
    // An operator who typed a note into the number box. A `wa.me/` with no
    // digits is a link that opens an error, which is worse than no button.
    expect(whatsappHref('(a definir)')).toBeNull();
  });
});

describe('readStationIdentity', () => {
  const found = {
    found: true,
    name: 'Radio Identity',
    thumb_url: 'https://example.test/thumb.png',
    whatsapp_number: '+55 11 98888-7777',
  };

  it('maps a found answer, address included', () => {
    expect(readStationIdentity(found)).toEqual({
      name: 'Radio Identity',
      thumbUrl: 'https://example.test/thumb.png',
      whatsappHref: 'https://wa.me/5511988887777',
    });
  });

  it('keeps the identity when there is no picture and no number', () => {
    expect(readStationIdentity({ ...found, thumb_url: null, whatsapp_number: null })).toEqual({
      name: 'Radio Identity',
      thumbUrl: null,
      whatsappHref: null,
    });
  });

  it('answers null for a refusal', () => {
    expect(
      readStationIdentity({ found: false, name: null, thumb_url: null, whatsapp_number: null }),
    ).toBeNull();
  });

  it('answers null for a shape it does not know, rather than an identity with a hole in it', () => {
    expect(readStationIdentity({ found: true, name: null })).toBeNull();
    expect(readStationIdentity(null)).toBeNull();
    expect(readStationIdentity([])).toBeNull();
    expect(readStationIdentity('found')).toBeNull();
  });
});
