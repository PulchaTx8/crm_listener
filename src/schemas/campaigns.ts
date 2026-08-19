import { z } from 'zod';

/**
 * Block 29d-2, Task 7. The three writes the campaigns screen offers:
 * creating a campaign, cancelling one, and the test send that leaves no
 * trace. `channel` is hand-copied as the two-value literal
 * marketingTemplateSchema (schemas/templates.ts) already uses for the
 * identical reason that file gives -- this screen only ever sends on one of
 * the two, never on a third value message_channel might someday grow.
 */

export const createCampaignSchema = z.object({
  listId: z.string().uuid(),
  channel: z.enum(['WHATSAPP', 'EMAIL']),
  templateId: z.string().uuid(),
});
export type CreateCampaignFormInput = z.infer<typeof createCampaignSchema>;

export const cancelCampaignSchema = z.object({
  campaignId: z.string().uuid(),
  // Optional and free text, the same shape cancel_campaign's own p_reason
  // takes (0243): an operator cancelling a campaign they know is wrong may
  // have nothing more to say than that it should stop.
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => (value ? value : undefined)),
});
export type CancelCampaignFormInput = z.infer<typeof cancelCampaignSchema>;

/**
 * The test send's own field. Validated per channel, the same
 * channel-conditional shape marketingTemplateSchema's own superRefine takes:
 * an e-mail address for EMAIL, and for WHATSAPP just enough digits to be a
 * real phone number -- not a stricter format check than normalize_phone
 * (0031) itself applies, which strips non-digits and asks nothing more.
 *
 * FIX ROUND 1, F9: BOTH addIssue messages BELOW ARE UNUSED BY THE ONE
 * CALLER THIS SCHEMA HAS TODAY. testSendCampaignAction (messages/
 * campaigns/actions.ts) never reads parsed.error on a failed safeParse; it
 * picks testSendInvalidEmailDestination/testSendInvalidWhatsappDestination
 * by rawChannel alone -- DELIBERATELY, not an oversight: those are
 * TRANSLATED catalogue sentences, and showing this schema's own English
 * text instead (the way saveMarketingTemplateAction, messages/templates/
 * actions.ts, does read parsed.error.issues[0]?.message for
 * marketingTemplateSchema) would put untranslated prose in front of an
 * operator reading Portuguese or Spanish -- a worse outcome than an unused
 * string. They stay anyway, on the house exception every schema's own
 * messages already claim ("Zod messages inside src/schemas/ are the
 * established exception"), so that a FUTURE caller of this schema that
 * reads parsed.error directly -- there is none today, and this is the one
 * schema in this project where that caller does not yet exist -- finds an
 * honest sentence rather than Zod's own generic default.
 */
export const testSendCampaignSchema = z
  .object({
    listId: z.string().uuid(),
    channel: z.enum(['WHATSAPP', 'EMAIL']),
    templateId: z.string().uuid(),
    destination: z.string().trim().min(1).max(200),
  })
  .superRefine((value, ctx) => {
    if (value.channel === 'EMAIL') {
      if (!z.string().email().safeParse(value.destination).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['destination'],
          message: 'Give a valid e-mail address.',
        });
      }
      return;
    }

    const digits = value.destination.replace(/[^0-9]/g, '');
    if (digits.length < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'Give a WhatsApp number with the country code.',
      });
    }
  });
export type TestSendCampaignFormInput = z.infer<typeof testSendCampaignSchema>;
