import { z } from 'zod';

/**
 * WhatsApp Cloud API interactive messages: reply buttons and lists.
 *
 * Block 5a's transport speaks plain text only. The conversation this block
 * adds needs two more message shapes the Cloud API defines for structured
 * replies -- see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#interactive-object.
 *
 * Two Cloud API limits are enforced here, at build time, rather than left to
 * surface as a 400 from Meta: at most three reply buttons, and a button
 * title of at most twenty characters. Exceeding either is a request Meta
 * refuses outright -- a message the listener never receives, on a webhook
 * route that answers Meta before it ever tries to send. Refusing here, with
 * a named error, means a promotion misconfigured with (for example) a
 * `yes_button_label` over twenty characters fails loudly where an operator
 * can act on it, instead of silently never reaching anyone.
 */

const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE_LENGTH = 20;

/** Thrown by `buildInteractivePayload` for a shape the Cloud API would reject with a 400. */
export class InteractiveLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractiveLimitError';
  }
}

export type Interactive =
  | {
      kind: 'buttons';
      body: string;
      imageUrl: string | null;
      buttons: { id: string; title: string }[];
    }
  | {
      kind: 'list';
      body: string;
      menuTitle: string;
      buttonLabel: string;
      rows: { id: string; title: string }[];
    };

/**
 * Builds the JSON body the Cloud API's `/messages` endpoint expects for an
 * interactive message. A pure mapping: it knows nothing about `to` or
 * `phoneNumberId` -- see `sendInteractive` on `WhatsAppTransport` for that.
 */
export function buildInteractivePayload(interactive: Interactive): unknown {
  return interactive.kind === 'buttons'
    ? buildButtonsPayload(interactive)
    : buildListPayload(interactive);
}

function buildButtonsPayload(
  interactive: Extract<Interactive, { kind: 'buttons' }>,
): unknown {
  const buttons = validateButtons(interactive.buttons);
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      // Present only when there is art -- Meta's image header requires a
      // link, and one carrying `null` is itself a 400. Omitting the key
      // entirely (rather than setting it to `undefined`) is deliberate: a
      // key present with an undefined value still reads as "present" to
      // anything checking for the header's existence.
      ...(interactive.imageUrl !== null
        ? { header: { type: 'image', image: { link: interactive.imageUrl } } }
        : {}),
      body: { text: interactive.body },
      action: { buttons },
    },
  };
}

function buildListPayload(interactive: Extract<Interactive, { kind: 'list' }>): unknown {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: interactive.body },
      action: {
        button: interactive.buttonLabel,
        sections: [
          {
            title: interactive.menuTitle,
            rows: interactive.rows.map((row) => ({ id: row.id, title: row.title })),
          },
        ],
      },
    },
  };
}

function validateButtons(
  buttons: { id: string; title: string }[],
): { type: 'reply'; reply: { id: string; title: string } }[] {
  if (buttons.length > MAX_BUTTONS) {
    throw new InteractiveLimitError(
      `interactive button message allows at most ${MAX_BUTTONS} buttons, got ${buttons.length}`,
    );
  }
  for (const button of buttons) {
    if (button.title.length > MAX_BUTTON_TITLE_LENGTH) {
      throw new InteractiveLimitError(
        `button title exceeds ${MAX_BUTTON_TITLE_LENGTH} characters: "${button.title}" (${button.title.length})`,
      );
    }
  }
  return buttons.map((button) => ({
    type: 'reply',
    reply: { id: button.id, title: button.title },
  }));
}

/**
 * The consent step's own composition, specified by the owner on 2026-08-01
 * as one message, not three sends:
 *
 *   banner -> promotion name -> call to action -> the two buttons
 *
 * which is exactly the Cloud API's interactive-button shape: an image header
 * carrying `artUrl` when `useArt` is set, a body holding the name and then
 * the call to action (name first, separated by a blank line, so a promotion
 * with no call to action still reads as a complete sentence on its own),
 * and the action with the two reply buttons.
 *
 * Button-label defaults ("Quero!" / "Agora não" when a promotion leaves
 * `yes_button_label` / `no_button_label` blank) are the caller's decision,
 * not this function's -- it sends back whatever buttons it is given, and
 * `buildInteractivePayload` is what refuses a title that is too long.
 */
export interface ConsentPromotion {
  name: string;
  callToAction: string | null;
  useArt: boolean;
  artUrl: string | null;
  buttons: { id: string; title: string }[];
}

export function buildConsentInteractive(promotion: ConsentPromotion): Interactive {
  return {
    kind: 'buttons',
    body: promotion.callToAction
      ? `${promotion.name}\n\n${promotion.callToAction}`
      : promotion.name,
    imageUrl: promotion.useArt && promotion.artUrl ? promotion.artUrl : null,
    buttons: promotion.buttons,
  };
}

/**
 * The same union, read back out of `outbox_messages.interactive`.
 *
 * A boundary schema for the same reason the conversation state has one: the
 * value is written by one process and read by another, possibly a deploy apart,
 * and `Json` says nothing about its shape. What the column's CHECK guarantees is
 * that it is an object -- not that it is one of these two.
 *
 * Returns null rather than throwing, because the caller is the worker draining
 * a batch: a row it cannot render must be parked with a reason, not allowed to
 * take the other forty-nine down with it.
 */
export function parseInteractive(value: unknown): Interactive | null {
  const parsed = interactiveSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const replyOption = z.object({ id: z.string().min(1), title: z.string().min(1) });

const interactiveSchema: z.ZodType<Interactive> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('buttons'),
    body: z.string().min(1),
    imageUrl: z.string().nullable(),
    buttons: z.array(replyOption).min(1),
  }),
  z.object({
    kind: z.literal('list'),
    body: z.string().min(1),
    menuTitle: z.string().min(1),
    buttonLabel: z.string().min(1),
    rows: z.array(replyOption).min(1),
  }),
]);
