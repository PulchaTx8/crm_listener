/**
 * Block 19a. The URL a WhatsApp hashtag becomes, and the message it arrives in.
 *
 * IT LIVES HERE TO BE TESTABLE. Building the message link and content
 * requires no database, no network, and no framework — just pure string
 * manipulation of the Station's configured base URL and the link code the
 * visitor generates. Keeping this pure means testing it with nothing running,
 * and catching URL encoding and message assembly mistakes early.
 */

export interface ServiceLinkIntent {
  publicKey: string;
  code: string;
  purpose: 'MUSIC' | 'MENU' | 'PROMOTION';
  promotionId: string | null;
}

/**
 * Builds the URL a WhatsApp hashtag response carries.
 *
 * USES `URL` AND `URLSearchParams` FOR ESCAPING, not string concatenation.
 * This ensures every parameter is escaped once and correctly, and the path
 * fragments are never misread because a parameter happened to contain a
 * character that resembles punctuation.
 *
 * A TRAILING SLASH ON THE BASE URL IS REMOVED to avoid a double slash at
 * the join point — a configured site URL may have one, and the code path
 * is `/:publicKey/enter` inside the installation's own router, so no
 * slash before the `:` — the join is `baseUrl` then `/:publicKey/enter`
 * and if baseUrl ends with `/` that becomes `//`.
 *
 * The `open` query parameter NAMES a DESTINATION without visiting it: the
 * visitor's browser will navigate to this URL in this widget, and ONCE the
 * widget loads it will open a panel or dialogue named by `open`. The MENU
 * purpose names no destination, so no `open` parameter at all. MUSIC opens
 * the search panel; PROMOTION opens the panel for one specific promotion
 * identified by `id`.
 */
export function buildServiceLink(baseUrl: string, intent: ServiceLinkIntent): string {
  const url = new URL(baseUrl);
  // Remove trailing slash to avoid double slash when joining the path
  const base = url.toString().replace(/\/$/, '');

  const service = new URL(`${base}/w/${intent.publicKey}/enter`);
  service.searchParams.append('k', intent.code);

  if (intent.purpose === 'MUSIC') {
    service.searchParams.append('open', 'music');
  } else if (intent.purpose === 'PROMOTION') {
    service.searchParams.append('open', 'promotion');
    if (intent.promotionId !== null) {
      service.searchParams.append('id', intent.promotionId);
    }
  }
  // MENU purpose adds no 'open' parameter

  return service.toString();
}

/**
 * Builds the WhatsApp message that carries the link.
 *
 * THE LINK IS APPENDED ON ITS OWN LINE rather than interpolated into a
 * placeholder. A placeholder is text an operator can delete, and nothing on
 * any screen would show if it arrived without its link. Putting it on its
 * own line makes the separation visible and mistakes recoverable.
 *
 * TRAILING WHITESPACE IN THE STATION'S CONFIGURED TEXT IS TRIMMED before
 * joining with the link — a configured string may have trailing spaces or
 * newlines by accident, and a blank line between the message and the link
 * should never become a line of whitespace that looks like a gap but is
 * not. The `.trim()` ensures the output is `text\n\nlink`, never
 * `text   \n\nlink` or `text\n\n\nlink`.
 */
export function buildServiceMessage(text: string, link: string): string {
  return `${text.trim()}\n\n${link}`;
}
