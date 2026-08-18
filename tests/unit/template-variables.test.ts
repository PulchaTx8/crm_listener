import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_RESOLVABLE,
  CAMPAIGN_VARIABLES,
  TEMPLATE_VARIABLES,
  namedPlaceholder,
  variableFromPlaceholder,
} from '@/lib/templates/variables';
import { marketingTemplateSchema } from '@/schemas/templates';

describe('the template variable vocabulary', () => {
  it('says which family every value is in', () => {
    // Totality is the compiler's job; this asserts the SPLIT, which the
    // compiler cannot check. A value moved to the wrong family would let 29d
    // offer a campaign something no campaign can resolve.
    expect(CAMPAIGN_RESOLVABLE.LISTENER_FIRST_NAME).toBe(true);
    expect(CAMPAIGN_RESOLVABLE.STATION_NAME).toBe(true);
    expect(CAMPAIGN_RESOLVABLE.PRIZE_NAME).toBe(false);
    expect(CAMPAIGN_RESOLVABLE.PICKUP_DEADLINE).toBe(false);
    expect(CAMPAIGN_RESOLVABLE.VERIFICATION_CODE).toBe(false);
  });

  it('offers a campaign exactly the resolvable four', () => {
    expect(CAMPAIGN_VARIABLES).toEqual([
      'LISTENER_FIRST_NAME',
      'LISTENER_FULL_NAME',
      'LISTENER_CITY',
      'STATION_NAME',
    ]);
  });

  it('offers the SYSTEM screen all seven, in the enum\'s own order', () => {
    // Block 29b-1, Task 9. The system registration screen has to be able to
    // name PRIZE_NAME, PICKUP_DEADLINE and VERIFICATION_CODE -- exactly the
    // three CAMPAIGN_VARIABLES leaves out, and exactly what a purpose's own
    // caller supplies (enqueue_pickup_reminder, widget_request_code). Offering
    // only the campaign four here would make the widget's verification
    // template -- the one row production actually holds -- impossible to
    // register.
    expect(TEMPLATE_VARIABLES).toEqual([
      'LISTENER_FIRST_NAME',
      'LISTENER_FULL_NAME',
      'LISTENER_CITY',
      'STATION_NAME',
      'PRIZE_NAME',
      'PICKUP_DEADLINE',
      'VERIFICATION_CODE',
    ]);
  });

  it('derives CAMPAIGN_VARIABLES as a filter over TEMPLATE_VARIABLES, not a second list', () => {
    // Asserts the RELATIONSHIP the two exports are supposed to have, which
    // the two tests above (each pinning its own array) cannot catch on their
    // own: two lists that happened to agree would pass both of those and
    // still have drifted apart in the source.
    expect(CAMPAIGN_VARIABLES).toEqual(TEMPLATE_VARIABLES.filter((v) => CAMPAIGN_RESOLVABLE[v]));
  });

  it('derives the email notation from the enum rather than declaring it twice', () => {
    expect(namedPlaceholder('LISTENER_FIRST_NAME')).toBe('{{listener_first_name}}');
    expect(namedPlaceholder('STATION_NAME')).toBe('{{station_name}}');
  });

  it('reads a placeholder back to its value', () => {
    expect(variableFromPlaceholder('listener_city')).toBe('LISTENER_CITY');
  });

  it('answers null for a placeholder that names nothing', () => {
    // The screen offers a closed list, so this is a hand-edited body -- and it
    // must be refused rather than substituted with an empty string, which is
    // how a listener reads "Oi !" and nobody finds out.
    expect(variableFromPlaceholder('listener_shoe_size')).toBeNull();
  });

  it('round-trips every value in the vocabulary', () => {
    for (const value of Object.keys(CAMPAIGN_RESOLVABLE) as (keyof typeof CAMPAIGN_RESOLVABLE)[]) {
      const placeholder = namedPlaceholder(value).slice(2, -2);
      expect(variableFromPlaceholder(placeholder)).toBe(value);
    }
  });
});

describe('marketingTemplateSchema', () => {
  const base = {
    companyId: '11111111-1111-1111-1111-111111111111',
    internalName: 'natal_2026',
    body: 'Oi {{listener_first_name}}!',
  };

  it('accepts an email template with a subject', () => {
    const r = marketingTemplateSchema.safeParse({
      ...base, channel: 'EMAIL', subject: 'Feliz Natal',
    });
    expect(r.success).toBe(true);
  });

  it('refuses an email template with no subject', () => {
    // The database CHECK refuses it too; catching it here is what turns a 23514
    // naming a constraint into a message beside the field that is empty.
    const r = marketingTemplateSchema.safeParse({ ...base, channel: 'EMAIL' });
    expect(r.success).toBe(false);
  });

  // Two different failures, both worth having: an unknown name proves the
  // guard rejects gibberish, and a KNOWN-but-unresolvable one proves it is
  // checking CAMPAIGN_RESOLVABLE and not merely `variableFromPlaceholder(...)
  // !== null` -- the weaker check a body naming {{prize_name}} would pass.
  it('refuses an email body naming something outside the vocabulary', () => {
    const r = marketingTemplateSchema.safeParse({
      ...base, channel: 'EMAIL', subject: 'Oi', body: 'Oi {{listener_shoe_size}}!',
    });
    expect(r.success).toBe(false);
  });

  it('refuses an email body naming a value no campaign can resolve', () => {
    // {{prize_name}} is a real value in the vocabulary -- variableFromPlaceholder
    // resolves it -- but PRIZE_NAME comes from the caller that enqueues a
    // system message, and a campaign has no source for it. Sending this body
    // would read "Oi Ana, você ganhou !" to every listener on the list.
    const r = marketingTemplateSchema.safeParse({
      ...base, channel: 'EMAIL', subject: 'Oi', body: 'Oi {{listener_first_name}}, você ganhou {{prize_name}}!',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((issue) => issue.path.join('.') === 'body')).toBe(true);
    }
  });

  it('refuses a WhatsApp template with no name or language', () => {
    const r = marketingTemplateSchema.safeParse({ ...base, channel: 'WHATSAPP' });
    expect(r.success).toBe(false);
  });
});
