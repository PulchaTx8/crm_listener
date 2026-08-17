import { z } from 'zod';
import type { Enums } from '@/lib/supabase/database.types';

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
 * Every value of `promotion_requested_field` (0040), as the boundary's allowed
 * key set.
 *
 * IT EARNS ITS PLACE: without it a payload naming a field no promotion can
 * request would reach a door that silently ignores it, and "the entry went
 * through but the answer vanished" is the least debuggable outcome available.
 *
 * WHAT IT MAY NOT BE IS HAND-WRITTEN, AND IT WAS, UNTIL THE GENDER BLOCK MADE
 * THE COST REAL. This list had nine values spelled out; 0219 added a tenth to
 * the database, every screen and every other list learned about it — and this
 * one did not, because a `z.enum` over a hand-written array is perfectly valid
 * TypeScript. The result was not a compile error and not a validation message:
 * `enterPromotionSchema` refused the whole payload, `enterPromotionAction`
 * answered `invalid`, and the widget said "Something went wrong. Try again."
 * to a listener who had done nothing wrong, on a field the widget itself had
 * just drawn.
 *
 * DERIVED FROM THE GENERATED ENUM, therefore, exactly as `REQUESTED_FIELD_ORDER`
 * in `schemas/promotions.ts` now is — and for the sharper reason: that one at
 * least renders a checkbox somebody would notice was missing. This one is
 * invisible until a listener meets it.
 *
 * `Object.keys` over a total record rather than `enum_range` in TypeScript: the
 * generated types give the union, and a record over it is the only construct
 * the compiler refuses to leave incomplete.
 */
const REQUESTED_FIELD_SET: Record<Enums<'promotion_requested_field'>, true> = {
  full_name: true,
  address: true,
  city: true,
  neighbourhood: true,
  country: true,
  age: true,
  gender: true,
  cpf: true,
  passport: true,
  discovery_source: true,
};

export const REQUESTED_FIELDS = Object.keys(REQUESTED_FIELD_SET) as [
  Enums<'promotion_requested_field'>,
  ...Enums<'promotion_requested_field'>[],
];

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
