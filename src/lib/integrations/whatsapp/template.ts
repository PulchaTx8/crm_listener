import { z } from 'zod';

/**
 * WhatsApp Cloud API template messages.
 *
 * Block 5a's transport speaks plain text; Block 5b added the interactive
 * shapes. Both are REPLIES, and the Cloud API takes them only inside the
 * 24-hour customer service window — graph.ts's own header says so and says the
 * first Station-initiated message would need a template. This is that shape.
 *
 * The pair here mirrors interactive.ts's: `buildTemplatePayload` maps the
 * application's own shape onto Meta's wire format at send time, and
 * `parseTemplate` reads that shape back out of the columns 0111 added to
 * outbox_messages. Storing our shape rather than Meta's is 0067's ruling —
 * "the worker builds that at send time, so Meta's payload shape stays in one
 * file" — and it is what lets 0111 render the audit body from the same values
 * the send carries (D6).
 *
 * THE PARAMETER RULES ARE ENFORCED HERE, at build time, rather than left to
 * come back as a 400. A template send is not a reply: nobody is waiting at a
 * screen when it goes out. Its caller is 0112's unattended sweep, so a value
 * Meta refuses would be a message a listener never receives, discovered — if
 * at all — in a server log. Refused here, it parks the row with a reason on it,
 * which is where an operator asking "why did nobody get it?" looks.
 */

/** Meta refuses a body parameter longer than this. */
const MAX_PARAMETER_LENGTH = 1024;

/**
 * Meta refuses a body parameter containing a newline, a tab, or more than four
 * consecutive spaces. A prize name pasted with a line break in it is the
 * realistic way this happens, and it would otherwise fail per winner, silently.
 */
const FORBIDDEN_WHITESPACE = /[\n\r\t]|\s{5,}/;

/** Thrown by `buildTemplatePayload` for a shape the Cloud API would reject with a 400. */
export class TemplateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateLimitError';
  }
}

export interface Template {
  /** The name as REGISTERED WITH META, never one chosen here (D4). */
  name: string;
  /** Meta's language code for that registration — `pt_BR`, not `pt`. */
  language: string;
  /** Positional: index 0 fills {{1}}. Empty for an approved fixed-text template. */
  variables: string[];
  /**
   * Whether Meta's registration carries an OTP button — the mark of the
   * AUTHENTICATION category (0165's `message_templates.otp_button`).
   *
   * A PROPERTY OF THE REGISTRATION, not of this product's purpose for it. It is
   * transcribed by the operator from the same Meta screen the name and the
   * language come from, for the reason D4 gives for those: what Meta approved
   * is a fact about Meta's records, and a value derived here from
   * `template_purpose` would be this system guessing at it. A WEB_VERIFICATION
   * template registered under Utility is an unusual thing to do and a legal
   * one; guessed, it would send a button that template does not have, and Meta
   * refuses that just as firmly as the missing one.
   */
  otpButton: boolean;
}

/**
 * Builds the JSON body the Cloud API's `/messages` endpoint expects for a
 * template message. A pure mapping: it knows nothing about `to` or
 * `phoneNumberId` — see `sendTemplate` on `WhatsAppTransport` for that.
 */
export function buildTemplatePayload(template: Template): unknown {
  validateParameters(template.variables);
  const components = buildComponents(template);
  return {
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      // Omitted ENTIRELY when there is nothing to fill in, the same way
      // interactive.ts omits an image header with no link — and for the same
      // reason: a components array carrying an empty parameters list is itself
      // a 400. A fixed-text approved template with no {{n}} at all is a real
      // shape Meta allows (0110's own reasoning for defaulting `variables` to
      // '[]'), so this branch is reachable, not defensive.
      ...(components.length > 0 ? { components } : {}),
    },
  };
}

/**
 * The `components` array, which is one entry for an ordinary template and two
 * for an authentication one.
 *
 * THE SECOND ENTRY IS WHY THIS FUNCTION EXISTS, and it was learned in
 * production: on 2026-08-11 every widget verification came back from Meta as
 * `(#131008) Required parameter is missing` and no listener ever received a
 * code. Meta's authentication templates carry an OTP button — mandatory on
 * every one created since May 2023 — and the send must name that button and
 * repeat the code as its parameter. A payload carrying only the body is not a
 * partially-filled authentication message; it is one Meta refuses whole.
 *
 * The button's parameter is `variables[0]` rather than a value of its own
 * BECAUSE THERE IS NOTHING ELSE IT COULD BE: an authentication body has exactly
 * one placeholder, the code, and the button's job is to put that same code on
 * the listener's clipboard. Two sources for one value is how they drift.
 *
 * `index` is the STRING '0', not the number: the Cloud API answers a 400 to the
 * number, and it is the kind of difference that survives review because both
 * spellings read identically in prose.
 */
function buildComponents(template: Template): unknown[] {
  const code = template.variables[0];
  if (code === undefined) {
    if (template.otpButton) {
      // Refused HERE rather than at Meta, for the reason the file header gives:
      // nobody is waiting at a screen for this send, so a 400 would be a code
      // the listener never receives and an operator never hears about. This is
      // the registration disagreeing with itself — an authentication template
      // whose body was transcribed without its one placeholder — and the row
      // parks with this sentence on it.
      throw new TemplateLimitError(
        'an authentication template needs one variable, the code, and this one has none',
      );
    }
    return [];
  }

  const body = {
    type: 'body',
    parameters: template.variables.map((value) => ({ type: 'text', text: value })),
  };
  if (!template.otpButton) return [body];

  return [
    body,
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
  ];
}

function validateParameters(variables: string[]): void {
  variables.forEach((value, index) => {
    // {{1}} is variables[0]. The message names the placeholder the operator
    // sees on the WhatsApp screen, not the array index nobody sees.
    const position = index + 1;
    if (value.length === 0) {
      throw new TemplateLimitError(`template variable {{${position}}} is empty`);
    }
    if (value.length > MAX_PARAMETER_LENGTH) {
      throw new TemplateLimitError(
        `template variable {{${position}}} exceeds ${MAX_PARAMETER_LENGTH} characters (${value.length})`,
      );
    }
    if (FORBIDDEN_WHITESPACE.test(value)) {
      throw new TemplateLimitError(
        `template variable {{${position}}} contains a newline, a tab, or more than four consecutive spaces`,
      );
    }
  });
}

/**
 * The same shape, read back out of `outbox_messages.template_name`,
 * `.template_language` and `.template_variables`.
 *
 * A boundary schema for the reason parseInteractive has one: the value is
 * written by one process and read by another, possibly a deploy apart, and
 * 0111's shape constraint guarantees only that the three columns are null or
 * non-null together — not that the third is an array of strings.
 *
 * It applies the parameter rules too, so a stored value Meta would refuse
 * comes back as null HERE rather than as a throw from inside the transport.
 * That is not tidiness: drainOutbox already parks an unparseable payload with
 * a reason on the row, and a throw would instead abort the batch and take the
 * other forty-nine messages with it.
 *
 * Returns null rather than throwing, for that same caller.
 */
export function parseTemplate(row: {
  name: unknown;
  language: unknown;
  variables: unknown;
  otpButton?: unknown;
}): Template | null {
  const parsed = templateSchema.safeParse(row);
  if (!parsed.success) return null;
  try {
    // Built and thrown away, ON PURPOSE: "sendable" means exactly "the payload
    // builder accepts it", and asking the builder is the only way to say that
    // which cannot fall behind. Re-listing the rules here was the shape this
    // had before 0165 added one — the OTP button's — and a second list is a
    // list that eventually disagrees with the first.
    buildTemplatePayload(parsed.data);
  } catch {
    return null;
  }
  return parsed.data;
}

/**
 * `otpButton` is the only field here that tolerates being absent, and it is a
 * DEPLOY concern rather than a data one: 0165 writes the column NOT NULL, so no
 * row in the database can omit it, but a worker already running the new code
 * can be handed a row by the old `claim_outbox_batch` during the minutes a
 * deploy takes. Read as `false` that row sends exactly as it did yesterday;
 * read as a parse failure it would park a message somebody is waiting for.
 *
 * The other three stay strict. A missing name or language is not an old shape,
 * it is a broken row, and 0111's constraint says the three travel together.
 */
const templateSchema = z.object({
  name: z.string().min(1),
  language: z.string().min(1),
  variables: z.array(z.string()),
  otpButton: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
}) satisfies z.ZodType<Template, z.ZodTypeDef, unknown>;
