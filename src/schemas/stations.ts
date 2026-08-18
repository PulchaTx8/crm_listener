import { z } from 'zod';

/**
 * A Station's own settings forms (Block 29b-1, Task 7 is the first).
 *
 * NOT `dashboards.ts`'s `stationSchema` -- that one shapes a dashboard row,
 * a different concern that happens to share the noun. Every action in this
 * codebase imports its schema from `src/schemas/`, and until this task
 * nothing here covered a Station's own record forms; this file is where the
 * next one lands too, rather than folding into a module about something else.
 */

/**
 * What `saveStationEmailIdentityAction` (app/actions.ts) parses before it
 * calls `saveStationEmailIdentity` (services/company-profile.ts), which in
 * turn calls `save_station_email_identity` (0226).
 *
 * ALL THREE OPTIONAL FIELDS ACCEPT THE EMPTY STRING, and that is not a gap
 * left in validation -- it is the form's only way to say "clear this field".
 * The door's own comment states the contract this schema has to honour: "the
 * form sets every field it takes on every call, so a blank means fall back
 * to the installation's MAIL_FROM". A schema that refused '' for fromAddress
 * or replyTo would make those two fields impossible to clear once set, which
 * is why `.email()` is paired with `.or(z.literal(''))` on both -- the same
 * escape valve `updateOrganizationSchema.fiscalEmail` already uses for an
 * optional address of its own (organizations.ts).
 *
 * `fromName` carries no format check to fight with a blank value in the first
 * place, so `.optional()` alone already accepts '' -- pairing it with
 * `.or(z.literal(''))` as well would be a second door onto the same room.
 */
export const stationEmailIdentitySchema = z.object({
  companyId: z.string().uuid(),
  fromName: z.string().trim().max(120).optional(),
  fromAddress: z.string().trim().email().max(200).optional().or(z.literal('')),
  replyTo: z.string().trim().email().max(200).optional().or(z.literal('')),
});

export type StationEmailIdentityFormInput = z.infer<typeof stationEmailIdentitySchema>;
