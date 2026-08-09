import { describe, expect, it } from 'vitest';
import { identifySchema, verifySchema } from '@/schemas/widget';

/**
 * Block 17a, Task 10. What the widget's two server actions refuse before they
 * spend anything.
 *
 * THE CASE THIS FILE EXISTS FOR IS THE LEADING ZERO. `generateCode`
 * (src/lib/widget/code.ts) pads to six characters precisely because one draw in
 * ten lands below 100000, so '000123' is a code this product really issues —
 * and any validation that goes through `Number()` on the way turns it into 123,
 * which hashes to nothing the database stored. That failure is invisible: the
 * message arrives, the visitor types what it says, and the widget answers
 * "wrong code" to a correct one, for a tenth of everybody.
 */
describe('what the widget accepts from a visitor', () => {
  const good = { phone: '+55 11 99999-8888', name: 'Ana Souza', code: '123456' };

  it('keeps a code whose first digit is a zero', () => {
    const parsed = verifySchema.safeParse({ ...good, code: '000123' });
    expect(parsed.success).toBe(true);
    // Not merely "accepted" — accepted UNCHANGED. A schema that trimmed it into
    // a number and back would pass the line above and still hash '123'.
    expect(parsed.success && parsed.data.code).toBe('000123');
  });

  it('refuses five digits', () => {
    expect(verifySchema.safeParse({ ...good, code: '12345' }).success).toBe(false);
  });

  it('refuses seven digits', () => {
    expect(verifySchema.safeParse({ ...good, code: '1234567' }).success).toBe(false);
  });

  // Pasted out of a WhatsApp message that spaced the digits for legibility.
  // Trimming the ends is not enough, and the anchored pattern is what refuses
  // it rather than silently hashing a string with spaces in it.
  it('refuses digits with a space between them', () => {
    expect(verifySchema.safeParse({ ...good, code: '12 34 56' }).success).toBe(false);
  });

  it('trims the ends before deciding', () => {
    const parsed = verifySchema.safeParse({ ...good, code: '  123456  ' });
    expect(parsed.success && parsed.data.code).toBe('123456');
  });

  it('refuses a code made of something other than digits', () => {
    expect(verifySchema.safeParse({ ...good, code: 'abcdef' }).success).toBe(false);
  });

  it('takes a phone and a name for the first step', () => {
    const parsed = identifySchema.safeParse({ phone: '+55 11 99999-8888', name: '  Ana  ' });
    expect(parsed.success && parsed.data).toEqual({ phone: '+55 11 99999-8888', name: 'Ana' });
  });

  // The door registers an unknown visitor under this name (0161, step 8), and
  // refuses with `name_required` when it has none. Refusing here means the
  // visitor is told by the form instead of by a round trip that spent a code.
  it('refuses a blank name', () => {
    expect(identifySchema.safeParse({ phone: '+5511999998888', name: '   ' }).success).toBe(false);
  });

  it('refuses a phone too short to be one', () => {
    expect(identifySchema.safeParse({ phone: '119', name: 'Ana' }).success).toBe(false);
  });

  // Strictness, asserted rather than assumed: a form field this product does
  // not know about did not come from the form this product renders.
  it('refuses a field it does not know', () => {
    expect(
      identifySchema.safeParse({ phone: '+5511999998888', name: 'Ana', isAdmin: true }).success,
    ).toBe(false);
  });
});
