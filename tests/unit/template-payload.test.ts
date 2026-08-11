import { describe, expect, it } from 'vitest';
import {
  TemplateLimitError,
  buildTemplatePayload,
  parseTemplate,
} from '@/lib/integrations/whatsapp/template';

/**
 * The template payload, against real values rather than mocks — the same way
 * tests/unit/interactive-payload.test.ts holds its pair.
 *
 * This module has no other proof available to it and will not have one for a
 * long time: no reminder can be sent until Meta approves a template, which
 * happens outside this system and takes days. So the wire shape is asserted
 * here, whole, and the refusals are asserted one rule at a time.
 */

const reminder = {
  name: 'lembrete_retirada',
  language: 'pt_BR',
  variables: ['Maria', 'Caneca PulchaTX', '12/08/2026'],
  otpButton: false,
};

/**
 * The widget's verification code, whose template is registered with Meta under
 * the AUTHENTICATION category — the shape that produced `(#131008) Required
 * parameter is missing` in production on 2026-08-11 and sent nobody a code.
 *
 * Meta's authentication templates are not free text: the body is a preset the
 * operator cannot edit, and since May 2023 every one of them carries an OTP
 * button (copy code, one-tap, or zero-tap). The send has to name that button,
 * repeating the code as its parameter, or the API refuses the whole message.
 */
const verification = {
  name: 'pulchtx_widgetcode',
  language: 'en_US',
  variables: ['580984'],
  otpButton: true,
};

describe('buildTemplatePayload', () => {
  it('maps a template onto the Cloud API shape, with the variables in order', () => {
    expect(buildTemplatePayload(reminder)).toEqual({
      type: 'template',
      template: {
        name: 'lembrete_retirada',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Maria' },
              { type: 'text', text: 'Caneca PulchaTX' },
              { type: 'text', text: '12/08/2026' },
            ],
          },
        ],
      },
    });
  });

  it('names the OTP button beside the body for an authentication template', () => {
    // THE WIRE SHAPE META REQUIRES, whole. The button repeats the code the body
    // already carries — that is not redundancy in the payload, it is what the
    // button copies to the clipboard when the listener taps it.
    expect(buildTemplatePayload(verification)).toEqual({
      type: 'template',
      template: {
        name: 'pulchtx_widgetcode',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '580984' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '580984' }],
          },
        ],
      },
    });
  });

  it('sends index as the string "0", which is what the Cloud API takes', () => {
    // A number here is a 400. Asserted on its own because `toEqual` above would
    // pass just as happily against 0 if this ever drifted, and the failure would
    // come back as an unexplained refusal from Meta rather than from a test.
    const built = buildTemplatePayload(verification) as {
      template: { components: Array<Record<string, unknown>> };
    };
    expect(built.template.components[1]?.index).toBe('0');
  });

  it('refuses an authentication template with no code to put in the button', () => {
    // Meta's own rule is that the authentication body carries exactly one
    // variable. Reaching the API without it would be a 131008 — the very error
    // this pair exists to stop — so it is refused here, where the row is parked
    // with a reason instead.
    expect(() => buildTemplatePayload({ ...verification, variables: [] })).toThrow(
      TemplateLimitError,
    );
  });

  it('omits components entirely for an approved fixed-text template', () => {
    const built = buildTemplatePayload({
      name: 'lembrete_fixo',
      language: 'pt_BR',
      variables: [],
      otpButton: false,
    }) as { template: Record<string, unknown> };

    // `not.toHaveProperty` and not `toBeUndefined`: a key present with an
    // undefined value still reads as present to anything checking for it, and
    // a components array carrying an empty parameters list is itself a 400.
    expect(built.template).not.toHaveProperty('components');
    expect(built.template).toEqual({ name: 'lembrete_fixo', language: { code: 'pt_BR' } });
  });

  it('refuses a variable carrying a newline, naming the placeholder', () => {
    // The realistic way this happens: a prize name pasted with a line break in
    // it. Meta refuses the send; refusing here parks the row with a reason.
    expect(() =>
      buildTemplatePayload({ ...reminder, variables: ['Maria', 'Caneca\nPulchaTX', '12/08/2026'] }),
    ).toThrow(TemplateLimitError);

    expect(() =>
      buildTemplatePayload({ ...reminder, variables: ['Maria', 'Caneca\nPulchaTX', '12/08/2026'] }),
    ).toThrow('{{2}}');
  });

  it('refuses a variable carrying more than four consecutive spaces', () => {
    expect(() =>
      buildTemplatePayload({ ...reminder, variables: ['Maria', 'Caneca     grande', '12/08/2026'] }),
    ).toThrow(TemplateLimitError);
  });

  it('accepts exactly four consecutive spaces, which Meta allows', () => {
    // The boundary in the other direction, so the rule cannot quietly become
    // "no repeated spaces at all" and start refusing sends Meta would take.
    expect(() =>
      buildTemplatePayload({ ...reminder, variables: ['Maria', 'Caneca    grande', '12/08/2026'] }),
    ).not.toThrow();
  });

  it('refuses a variable longer than a thousand characters', () => {
    expect(() =>
      buildTemplatePayload({ ...reminder, variables: ['Maria', 'x'.repeat(1025), '12/08/2026'] }),
    ).toThrow(TemplateLimitError);
  });

  it('accepts a variable of exactly a thousand and twenty-four characters', () => {
    expect(() =>
      buildTemplatePayload({ ...reminder, variables: ['Maria', 'x'.repeat(1024), '12/08/2026'] }),
    ).not.toThrow();
  });

  it('refuses an empty variable', () => {
    // 0111 renders the audit body from these same values, so an empty one
    // would have produced a sentence with a hole in it as well as a 400.
    expect(() => buildTemplatePayload({ ...reminder, variables: ['Maria', '', '12/08/2026'] })).toThrow(
      TemplateLimitError,
    );
  });
});

describe('parseTemplate', () => {
  it('reads back the columns the outbox stores', () => {
    expect(
      parseTemplate({
        name: 'lembrete_retirada',
        language: 'pt_BR',
        variables: ['Maria', 'Caneca PulchaTX', '12/08/2026'],
        otpButton: false,
      }),
    ).toEqual(reminder);
  });

  it('reads back an authentication row, button and all', () => {
    expect(
      parseTemplate({
        name: 'pulchtx_widgetcode',
        language: 'en_US',
        variables: ['580984'],
        otpButton: true,
      }),
    ).toEqual(verification);
  });

  it('treats an absent otpButton as no button, for a row claimed mid-deploy', () => {
    // 0165 writes the column NOT NULL, so the database cannot produce this. A
    // worker running the new code against a claim from the old one can: the
    // column simply is not in the row it was handed. Reading that as `false` is
    // the behaviour every send had before 0165 — degrading to the old shape,
    // not parking a message a listener is waiting for.
    expect(
      parseTemplate({ name: 'lembrete_fixo', language: 'pt_BR', variables: [] }),
    ).toEqual({ name: 'lembrete_fixo', language: 'pt_BR', variables: [], otpButton: false });
  });

  it('returns null for a null name, the shape a plain text row carries', () => {
    expect(
      parseTemplate({ name: null, language: null, variables: null, otpButton: null }),
    ).toBeNull();
  });

  it('returns null when variables is not an array', () => {
    // 0110's check constraint holds this for the REGISTRY; the outbox column
    // has no such constraint, and this is what stands in its place.
    expect(
      parseTemplate({ name: 'lembrete', language: 'pt_BR', variables: { '1': 'Maria' } }),
    ).toBeNull();
  });

  it('returns null when a variable is not a string', () => {
    expect(parseTemplate({ name: 'lembrete', language: 'pt_BR', variables: ['Maria', 7] })).toBeNull();
  });

  it('returns null for a blank language, which would send under no registration at all', () => {
    expect(parseTemplate({ name: 'lembrete', language: '', variables: ['Maria'] })).toBeNull();
  });

  it('returns null for an authentication row with no code in it', () => {
    // The same rule buildTemplatePayload throws for, answered the way this
    // function answers everything: drainOutbox parks the row with a reason,
    // rather than the transport throwing and taking the batch with it.
    expect(
      parseTemplate({ name: 'pulchtx_widgetcode', language: 'en_US', variables: [], otpButton: true }),
    ).toBeNull();
  });

  it('returns null rather than throwing for a value Meta would refuse', () => {
    // THE POINT OF PARSING THE RULES HERE. drainOutbox parks an unparseable
    // row with a reason on it; a throw from inside the transport would instead
    // abort the batch and take the other forty-nine messages with it.
    expect(parseTemplate({ name: 'lembrete', language: 'pt_BR', variables: ['Maria\nSilva'] })).toBeNull();
  });
});
