import { z } from 'zod';

/**
 * The LGPD deletion request from the public /delete-data page.
 *
 * Modelled on src/schemas/contact.ts, and it differs from that one in three
 * ways, all of them because this form is a statutory request rather than an
 * enquiry:
 *
 *   - `phone` is REQUIRED here and optional there. A listener's record in this
 *     product is keyed by their telephone number -- it is what a Station's
 *     operator will search on to find them -- so a request without one names
 *     nobody, and answering it would mean writing back to ask.
 *   - `confirmed` exists at all, and is `z.literal(true)`: not a boolean, not
 *     `.default(false)`, and not optional. An unchecked box posts NOTHING, so
 *     the absent key has to fail rather than fall through to a default. It is
 *     the difference between somebody typing a telephone number and somebody
 *     stating a request.
 *   - `station` and `notes` carry the wording the form uses, not the column
 *     names they land in (`company_name`, `message`). The columns match
 *     contact_requests because 0188 deliberately mirrors that table's shape;
 *     the person filling this in has never heard of either word.
 */
export const dataDeletionRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(1).max(40),
  email: z.string().trim().email(),
  station: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
  confirmed: z.literal(true),
});

export type DataDeletionRequestInput = z.infer<typeof dataDeletionRequestSchema>;
