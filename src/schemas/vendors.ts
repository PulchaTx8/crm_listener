import { z } from 'zod';

/**
 * Block 24, item 7. What the vendor form posts.
 *
 * STRICT, the rule the other schemas here state: a field name this product does
 * not know did not come from the form this product renders.
 *
 * ONE REQUIRED FIELD, and the asymmetry is deliberate rather than lax. An
 * operator recording a purchase at eight in the evening should be able to write
 * down who it came from without first finding their CNPJ; the paperwork arrives
 * at a different time from the supplier. `save_vendor` (`0199`) holds the same
 * rule, and `vendors_name_not_blank` (`0198`) holds it whether or not either
 * ran.
 *
 * The lengths mirror nothing in the database — the columns are plain `text`,
 * because none of these is an identifier this product parses. They are here so a
 * paste of an entire contract into the notes box is refused on the screen rather
 * than stored.
 */

/** A box the operator may leave empty. Blank becomes undefined, which the door writes as null. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === null || value === '' ? undefined : value));
}

export const vendorFormSchema = z
  .object({
    companyId: z.string().uuid(),
    /** Absent when registering; present when editing. `save_vendor` decides insert-or-update from exactly this. */
    vendorId: z.string().uuid().optional(),

    name: z.string().trim().min(1, 'Name the vendor.').max(200),
    legalName: optionalText(200),
    /**
     * CNPJ or CPF, as typed. Unvalidated and unformatted on purpose — `0198`'s
     * own column comment argues it: the field is for matching an invoice by eye,
     * and a format rule refuses the foreign supplier and the one whose paperwork
     * has not arrived.
     */
    document: optionalText(40),

    contactName: optionalText(200),
    phone: optionalText(40),
    /**
     * Not `z.string().email()`. A supplier's contact is often a department
     * mailbox typed from a business card, and this product never sends to it —
     * nothing here mails a vendor. Refusing an address nobody will send to, on a
     * form somebody is filling in from a card, buys nothing.
     */
    email: optionalText(200),

    addressLine: optionalText(300),
    city: optionalText(120),
    state: optionalText(60),
    postalCode: optionalText(20),
    website: optionalText(300),

    notes: optionalText(2000),
  })
  .strict();

export type VendorFormInput = z.infer<typeof vendorFormSchema>;
