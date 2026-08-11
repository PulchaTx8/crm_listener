import { z } from 'zod';

/**
 * Block 18. What the programme form posts.
 *
 * STRICT, the rule the other schemas here state: a field name this product does
 * not know did not come from the form this product renders.
 *
 * The four required fields are D3 and D7's, and they are required HERE and in
 * `save_show` while the columns themselves stay nullable — production holds four
 * programmes carrying nothing but a name, and a NOT NULL column would have to
 * invent a kind for each of them.
 */

export const SHOW_KINDS = ['MUSICAL', 'NEWS', 'TALK_SHOW', 'SPORTS', 'ENTERTAINMENT'] as const;
export const SHOW_AGE_RATINGS = ['L', '10', '12', '14', '16', '18'] as const;

/** `HH:MM`, the shape both the form and `save_show` speak. */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'not a time of day');

/**
 * One band, as the schedule editor holds it and as `save_show` receives it —
 * the same three field names on both sides, so nothing translates between them.
 *
 * `ends` EARLIER THAN `starts` IS VALID, and that is the whole point: it is the
 * overnight case, split into two rows on write (D5). Only equal hours are
 * refused, because they are a mistake in either direction and the database has
 * no CHECK that would catch them — `ends_at > starts_at` is satisfied by each
 * half of a split band and says nothing about the band itself.
 */
const bandSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1, 'a band needs at least one day'),
    starts: clock,
    ends: clock,
  })
  .strict()
  .refine((band) => band.starts !== band.ends, {
    message: 'a band cannot start and end at the same minute',
    path: ['ends'],
  });

/** An ISO date from a date input, or undefined when the box is empty. */
const optionalDate = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional()
  .refine((value) => value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value), {
    message: 'not a date',
  });

export const showFormSchema = z
  .object({
    companyId: z.string().uuid(),
    showId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(200),
    kind: z.enum(SHOW_KINDS),
    ageRating: z.enum(SHOW_AGE_RATINGS),
    presenterName: z.string().trim().max(200).nullish(),
    producerName: z.string().trim().max(200).nullish(),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'not a date'),
    /** D7: blank is the indeterminate case, not a missing value. */
    endsOn: optionalDate,
    bands: z.array(bandSchema).min(1, 'a programme needs at least one band in its schedule'),
  })
  .strict()
  .refine((show) => show.endsOn === undefined || show.endsOn >= show.startsOn, {
    message: 'a programme cannot end before it begins',
    path: ['endsOn'],
  });

export type ShowFormInput = z.infer<typeof showFormSchema>;
