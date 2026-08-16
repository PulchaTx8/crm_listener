import { z } from 'zod';

/**
 * Block 17c. What the widget's promotion panel posts.
 *
 * STRICT, the rule `src/schemas/widget.ts` states for the same boundary: a
 * field name this product does not know did not come from the form this product
 * renders.
 *
 * THERE IS NO SCHEMA FOR THE LIST. `listPromotionsAction` takes a public key
 * and nothing else, and `publicKeySchema` (0159's shape) already owns that.
 */

/**
 * The eight values of `promotion_requested_field` (0040), in the enum's own
 * declaration order.
 *
 * WRITTEN OUT HERE is the fourth place this list exists — after the enum,
 * `member_field_value` (0065, extended by 0213) and `apply_member_field_values`
 * (0171, extended by 0213). It earns
 * its place: without it a payload naming a field no promotion can request would
 * reach a door that silently ignores it, and "the entry went through but the
 * answer vanished" is the least debuggable outcome available.
 */
export const REQUESTED_FIELDS = [
  'full_name',
  'address',
  'city',
  'neighbourhood',
  'country',
  'age',
  'cpf',
  'passport',
  'discovery_source',
] as const;

/**
 * Parses a JSON string that arrived in a form field, failing the schema rather
 * than throwing. `z.string().transform()` cannot report a failure on its own,
 * which is what `superRefine` with `ctx.addIssue` is for.
 */
function jsonString<T extends z.ZodTypeAny>(inner: T) {
  return z
    .string()
    .max(20_000)
    .transform((raw, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not valid JSON' });
        return z.NEVER;
      }
      const result = inner.safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not the shape this door accepts' });
        return z.NEVER;
      }
      return result.data as z.infer<T>;
    });
}

/**
 * One answer, in the shape the DATABASE uses.
 *
 * `question_id` and not `questionId`, deliberately: this object is passed
 * through to `apply_participation` (0069) unchanged, and 0071's own call builds
 * exactly these three keys. Renaming them here to match TypeScript convention
 * would mean a mapping step whose only purpose is to undo itself.
 */
const answerSchema = z
  .object({
    question_id: z.string().uuid(),
    option_id: z.string().uuid().nullable().optional(),
    answer_text: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const enterPromotionSchema = z
  .object({
    promotionId: z.string().uuid(),
    /**
     * An unchecked box posts NOTHING — the field is absent, not empty — so this
     * is optional and compared against the value a checked one sends. Declining
     * is a real path in this block, not an abandonment, so `false` here is an
     * answer rather than a missing input.
     */
    consent: z.literal('on').optional(),
    fields: jsonString(z.record(z.enum(REQUESTED_FIELDS), z.string().max(500))),
    answers: jsonString(z.array(answerSchema).max(50)),
  })
  .strict()
  .transform((value) => ({
    promotionId: value.promotionId,
    consent: value.consent === 'on',
    fields: value.fields,
    answers: value.answers,
  }));

export type EnterPromotionInput = z.infer<typeof enterPromotionSchema>;
