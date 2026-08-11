import { describe, expect, it } from 'vitest';
import { SYSTEM_MESSAGE_DEFAULTS } from '@/lib/conversation/engine';
import {
  SYSTEM_MESSAGE_KEYS,
  countPlaceholders,
  clearSystemMessageSchema,
  systemMessageFormSchema,
  templateRegistrationSchema,
} from '@/schemas/templates';

const COMPANY = '11111111-1111-1111-1111-111111111111';

const registration = {
  companyId: COMPANY,
  purpose: 'PICKUP_REMINDER' as const,
  name: 'lembrete_retirada',
  language: 'pt_BR',
  body: 'Oi {{1}}, seu prêmio {{2}} te espera até {{3}}.',
  variables: ['nome do ouvinte', 'prêmio', 'prazo'],
  otpButton: false,
};

describe('SYSTEM_MESSAGE_KEYS', () => {
  it('is the ten keys, derived from the defaults rather than listed again', () => {
    // Derived, so an eleventh key added to the enum arrives here with no edit.
    // A hand-written list would be a second place to forget.
    expect(SYSTEM_MESSAGE_KEYS).toHaveLength(10);
    expect(SYSTEM_MESSAGE_KEYS).toEqual(Object.keys(SYSTEM_MESSAGE_DEFAULTS));
    expect(SYSTEM_MESSAGE_KEYS[0]).toBe('REFUSAL');
  });
});

describe('systemMessageFormSchema', () => {
  it('accepts a Station rewriting one of the ten', () => {
    const parsed = systemMessageFormSchema.parse({
      companyId: COMPANY,
      key: 'REFUSAL',
      body: '  Beleza! Fica pra próxima.  ',
    });
    // Trimmed here as well as in the door, so the value the operator sees
    // saved is the value that was stored.
    expect(parsed.body).toBe('Beleza! Fica pra próxima.');
  });

  it('refuses a blank body, so clearing cannot be expressed as an empty save', () => {
    const result = systemMessageFormSchema.safeParse({
      companyId: COMPANY,
      key: 'REFUSAL',
      body: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a key that is not one of the ten', () => {
    const result = systemMessageFormSchema.safeParse({
      companyId: COMPANY,
      key: 'INACTIVITY',
      body: 'Você ainda está aí?',
    });
    // D3: the legacy screen also had Inatividade, Aguarde, Rejeita Áudio and
    // Rejeita Ligação. None of those BEHAVIOURS exists, so a key for one would
    // be a field that configures nothing.
    expect(result.success).toBe(false);
  });

  it('clearing takes no body at all', () => {
    expect(clearSystemMessageSchema.safeParse({ companyId: COMPANY, key: 'CITY' }).success).toBe(
      true,
    );
  });
});

describe('countPlaceholders', () => {
  it('is the HIGHEST index, not the number of occurrences', () => {
    // {{1}} twice is still one variable. Counting occurrences would demand two
    // descriptions for a body that takes one value.
    expect(countPlaceholders('Oi {{1}}, tudo bem {{1}}?')).toBe(1);
  });

  it('reads a two-digit index rather than stopping at the first digit', () => {
    expect(countPlaceholders('{{9}} e {{10}}')).toBe(10);
  });

  it('is zero for an approved fixed-text template', () => {
    expect(countPlaceholders('Seu prêmio já está te esperando!')).toBe(0);
  });

  it('ignores something that merely looks like a placeholder', () => {
    expect(countPlaceholders('Use {{um}} ou {1} assim')).toBe(0);
  });
});

describe('templateRegistrationSchema', () => {
  it('accepts a registration whose descriptions match its placeholders', () => {
    expect(templateRegistrationSchema.safeParse(registration).success).toBe(true);
  });

  it('REFUSES A DESCRIPTION COUNT THAT DISAGREES WITH THE BODY', () => {
    // The rule this schema exists for. 0113's door refuses it with 22023 and
    // 0111 refuses it again at send time — where the only reader is a server
    // log 0112's sweep writes hourly, for as long as the wrong registration
    // stands.
    const result = templateRegistrationSchema.safeParse({
      ...registration,
      variables: ['nome do ouvinte', 'prêmio'],
    });
    expect(result.success).toBe(false);
    // Attached to the field the operator can act on: the body is Meta's
    // approved text and has to be transcribed exactly.
    expect(result.error?.issues[0]?.path).toEqual(['variables']);
  });

  it('refuses descriptions given for a body with no placeholders', () => {
    const result = templateRegistrationSchema.safeParse({
      ...registration,
      body: 'Seu prêmio já está te esperando!',
      variables: ['nome do ouvinte'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an approved fixed-text template with no variables at all', () => {
    // A real shape Meta allows — 0110's own reasoning for defaulting the
    // column to '[]' — so this branch must not be refused by the count rule.
    expect(
      templateRegistrationSchema.safeParse({
        ...registration,
        body: 'Seu prêmio já está te esperando!',
        variables: [],
      }).success,
    ).toBe(true);
  });

  it('accepts an authentication template, whose one placeholder is the code', () => {
    expect(
      templateRegistrationSchema.safeParse({
        ...registration,
        purpose: 'WEB_VERIFICATION' as const,
        name: 'pulchtx_widgetcode',
        language: 'en_US',
        body: '*{{1}}* is your verification code.',
        variables: ['código de verificação'],
        otpButton: true,
      }).success,
    ).toBe(true);
  });

  it('REFUSES AN OTP BUTTON ON A BODY WITH NO CODE IN IT', () => {
    // The button's parameter is the code, and the code is what the placeholder
    // holds — so this pairing describes a send nothing could build. 0113's door
    // refuses it with 22023 and buildTemplatePayload throws for it; refused
    // here it is a message beside the checkbox the operator just ticked.
    const result = templateRegistrationSchema.safeParse({
      ...registration,
      body: 'Your code is ready.',
      variables: [],
      otpButton: true,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['otpButton']);
  });

  it('refuses a blank description among otherwise valid ones', () => {
    const result = templateRegistrationSchema.safeParse({
      ...registration,
      variables: ['nome do ouvinte', '   ', 'prazo'],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a blank name or language, which cannot match what Meta approved', () => {
    expect(templateRegistrationSchema.safeParse({ ...registration, name: '  ' }).success).toBe(
      false,
    );
    expect(templateRegistrationSchema.safeParse({ ...registration, language: '' }).success).toBe(
      false,
    );
  });

  it('refuses a purpose the database has no value for', () => {
    const result = templateRegistrationSchema.safeParse({ ...registration, purpose: 'DRAW_RESULT' });
    // A second purpose is a later block adding a value to the enum, not this
    // form accepting a string the column would reject.
    expect(result.success).toBe(false);
  });
});
