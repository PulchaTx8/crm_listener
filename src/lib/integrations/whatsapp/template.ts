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
}

/**
 * Builds the JSON body the Cloud API's `/messages` endpoint expects for a
 * template message. A pure mapping: it knows nothing about `to` or
 * `phoneNumberId` — see `sendTemplate` on `WhatsAppTransport` for that.
 */
export function buildTemplatePayload(template: Template): unknown {
  validateParameters(template.variables);
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
      ...(template.variables.length > 0
        ? {
            components: [
              {
                type: 'body',
                parameters: template.variables.map((value) => ({ type: 'text', text: value })),
              },
            ],
          }
        : {}),
    },
  };
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
}): Template | null {
  const parsed = templateSchema.safeParse(row);
  if (!parsed.success) return null;
  try {
    validateParameters(parsed.data.variables);
  } catch {
    return null;
  }
  return parsed.data;
}

const templateSchema: z.ZodType<Template> = z.object({
  name: z.string().min(1),
  language: z.string().min(1),
  variables: z.array(z.string()),
});
