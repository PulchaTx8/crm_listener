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
 * An optional e-mail address that a BLANK clears rather than fails.
 *
 * TRIMMED BEFORE THE UNION, not inside one arm of it, and that ordering is
 * load-bearing rather than style: `z.literal('')` compares the RAW value, so
 * a union of `z.string().trim().email()` and `z.literal('')` sees `'   '`
 * fail both arms at once -- the left one trims its own copy to `''` and then
 * rejects it as an invalid e-mail, and the right one checks the untrimmed
 * `'   '` against the literal and finds no match either. `z.preprocess` runs
 * BEFORE the union is evaluated, so both arms see the same already-trimmed
 * value and a whitespace-only field reaches `z.literal('')` as the blank it
 * is. `organizations.ts`'s `fiscalEmail` still trims inside its own left arm
 * rather than before its union, and still has that hole -- copy THIS file's
 * shape for a new blank-clearable address, not that one, or the hole comes
 * back.
 */
function optionalStationEmail(max: number) {
  return z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.union([z.literal(''), z.string().email().max(max)]),
  );
}

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
 * is why both go through `optionalStationEmail` above rather than a bare
 * `.email().optional()`.
 *
 * `fromName` carries no format check to fight with a blank value in the first
 * place, so a plain `.optional()` already accepts both `''` and `'   '` --
 * `.trim()` alone is enough, with no union to put it on the wrong side of.
 */
export const stationEmailIdentitySchema = z.object({
  companyId: z.string().uuid(),
  fromName: z.string().trim().max(120).optional(),
  fromAddress: optionalStationEmail(200).optional(),
  replyTo: optionalStationEmail(200).optional(),
});

export type StationEmailIdentityFormInput = z.infer<typeof stationEmailIdentitySchema>;
