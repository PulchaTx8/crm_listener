import { z } from 'zod';

/**
 * Block 17a, spec §6. What a visitor on a Station's own website types, and the
 * only shapes the two server actions in `src/app/(widget)/w/[publicKey]/` will
 * act on.
 *
 * STRICT, the same rule `src/schemas/api.ts` states for the machine boundary
 * and for the same reason: a field name this product does not know did not
 * come from the form this product renders, and accepting it silently is how a
 * later rename disappears for six months instead of failing on the first run.
 * There is no third-party payload here to make an exception for, so unlike
 * `api.ts` there is no `.passthrough()` anywhere in this file.
 *
 * NOTHING HERE VALIDATES A TELEPHONE NUMBER, and that is deliberate. The
 * authority on what a phone number is, in this system, is `normalize_phone`
 * (0031) — digits only — and `members.phone_normalized` is GENERATED from it,
 * so any second opinion written here could only disagree with the column that
 * decides identity. What these bounds do is refuse obvious rubbish and cap the
 * length of a string that is about to become a rate-limit key and an RPC
 * argument. A country-by-country parser was the rejected alternative: it would
 * refuse a real listener somewhere in the world in exchange for nothing this
 * product actually needs.
 */

/** Phone plus name: what the first screen of the widget asks for. */
export const identifySchema = z
  .object({
    phone: z.string().trim().min(5).max(40),
    name: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * The same, plus the six digits that arrived by WhatsApp.
 *
 * `name` travels again rather than being remembered on the server between the
 * two steps: `widget_verify_code`'s `p_name` is what `apply_member_creation`
 * registers an unknown visitor with (0161, step 8), and the alternative —
 * stashing it on the verification row, or in a second cookie — would put a
 * visitor's name in the database before they had proved the number is theirs.
 *
 * THE CODE IS A STRING WITH A REGEX, NEVER A NUMBER. `z.coerce.number()` and a
 * six-digit range check read like the same rule and are not: `Number('000123')`
 * is `123`, which stringifies to three characters, hashes to something that
 * matches nothing, and refuses a code this product genuinely issues — one draw
 * in ten from `generateCode` starts with a zero, which is precisely why that
 * function pads rather than trusting `String(randomInt(...))`. `\d{6}` anchored
 * at both ends keeps the leading zeros intact and refuses five digits, seven
 * digits, and anything with a space in the middle that a visitor pasted out of
 * a message.
 */
export const verifySchema = z
  .object({
    phone: z.string().trim().min(5).max(40),
    name: z.string().trim().min(1).max(200),
    code: z.string().trim().regex(/^\d{6}$/, 'a code is six digits'),
  })
  .strict();

export type IdentifyInput = z.infer<typeof identifySchema>;
export type VerifyInput = z.infer<typeof verifySchema>;
