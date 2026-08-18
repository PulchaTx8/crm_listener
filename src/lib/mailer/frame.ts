/**
 * The one HTML frame every campaign e-mail is sent in.
 *
 * WHY THERE IS EXACTLY ONE, and why an operator cannot supply their own
 * (Block 29b-1, D2). The original request asked for an HTML body AND for
 * messages "compatible with e-mail clients"; those pull apart. E-mail HTML is
 * not web HTML — tables, inline CSS, and Outlook deforming what every browser
 * accepts — and an editor that produces browser markup produces mail that
 * arrives broken. One frame, tested once, renders the same way everywhere.
 *
 * ESCAPING IS THE SECURITY PROPERTY, and it is what dispenses with a sanitiser.
 * The operator writes TEXT. It is escaped on its way in and is never
 * interpreted as markup, so there is no path by which third-party HTML reaches
 * a recipient — and this codebase, which uses `dangerouslySetInnerHTML` nowhere
 * and depends on no sanitiser, keeps both of those true.
 *
 * INLINE STYLES ONLY, and no external stylesheet: `<style>` blocks are stripped
 * by several clients and `<link>` by all of them.
 */
export interface FrameInput {
  stationName: string;
  /** `companies.thumb_url`, or null when the Station has no picture. */
  logoUrl: string | null;
  /** The operator's text, with variables already substituted. */
  body: string;
  /**
   * Block 29c fills this. Null or absent leaves the seam empty.
   *
   * The URL and its label travel together in one object so that the compiler
   * refuses a link with no text. The label belongs to the caller because this
   * module cannot reach the i18n catalogues, and the recipient reads the whole
   * message in one language.
   */
  unsubscribe?: { url: string; label: string } | null;
}

/**
 * The five characters that can change the meaning of markup. `'` is escaped as
 * a numeric reference rather than `&apos;`, which Outlook's older engines do
 * not recognise.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderCampaignEmail(input: FrameInput): { html: string; text: string } {
  const station = escapeHtml(input.stationName);

  // Escaped first, then the line breaks the operator typed are restored as
  // markup. The order matters: doing it the other way round would let a body
  // containing the literal text "<br />" become a real line break.
  const body = escapeHtml(input.body).replace(/\r?\n/g, '<br />');

  // The Station's name is the alt text AND appears beside the picture, because
  // e-mail clients block remote images by default: somebody who never unblocks
  // them reads the name rather than an empty box.
  const header = input.logoUrl
    ? `<img src="${escapeHtml(input.logoUrl)}" alt="${station}" width="40" height="40" style="vertical-align:middle;border:0;" /> <span style="vertical-align:middle;">${station}</span>`
    : `<span>${station}</span>`;

  const footer = input.unsubscribe
    ? `<a href="${escapeHtml(input.unsubscribe.url)}" style="color:#666;">${escapeHtml(input.unsubscribe.label)}</a>`
    : '';

  const html = [
    '<!doctype html>',
    '<html><body style="margin:0;padding:0;background:#f4f4f5;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">',
    '<tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;font-family:Arial,Helvetica,sans-serif;">',
    `<tr><td style="padding:16px 24px;border-bottom:1px solid #e4e4e7;font-size:16px;font-weight:bold;color:#18181b;">${header}</td></tr>`,
    `<tr><td style="padding:24px;font-size:15px;line-height:1.5;color:#27272a;">${body}</td></tr>`,
    `<tr><td style="padding:16px 24px;border-top:1px solid #e4e4e7;font-size:12px;color:#71717a;">${station}${footer ? ' · ' + footer : ''}</td></tr>`,
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');

  // The plain-text half of MailMessage (src/lib/mailer/index.ts) is the
  // operator's own words, unframed: it is what a client refusing HTML shows,
  // and a stripped-down copy of the frame would be a second thing to keep in
  // step for no gain.
  return { html, text: input.body };
}
