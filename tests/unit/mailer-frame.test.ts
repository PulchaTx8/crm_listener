import { describe, expect, it } from 'vitest';
import { renderCampaignEmail } from '@/lib/mailer/frame';

const base = { stationName: 'Rádio Pulcha FM', logoUrl: null, body: 'Oi Ana!' };

describe('the campaign email frame', () => {
  it('ESCAPES the operator text — the assertion this module exists for', () => {
    // The whole security argument of Block 29b-1's D2: the operator writes
    // text, the frame is ours, and the text is escaped on the way in. There is
    // no path by which third-party HTML reaches a recipient, which is why this
    // codebase still needs no sanitiser.
    const { html } = renderCampaignEmail({
      ...base,
      body: '<script>alert(1)</script> & "quoted"',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('escapes the Station name too, which is operator-typed as well', () => {
    const { html } = renderCampaignEmail({ ...base, stationName: 'Rádio <b>X</b>' });
    expect(html).not.toContain('<b>X</b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('keeps the operator line breaks, because a paragraph is what they typed', () => {
    const { html } = renderCampaignEmail({ ...base, body: 'linha um\nlinha dois' });
    expect(html).toContain('linha um<br />linha dois');
  });

  it('carries the Station name as the logo alt, so a blocked image still reads', () => {
    // Email clients block remote images by default. Without this the header is
    // an empty box on the first open of most campaigns ever sent.
    const { html } = renderCampaignEmail({ ...base, logoUrl: 'https://cdn/x.png' });
    expect(html).toContain('alt="Rádio Pulcha FM"');
  });

  it('renders no image tag at all when the Station has no logo', () => {
    const { html } = renderCampaignEmail(base);
    expect(html).not.toContain('<img');
    expect(html).toContain('Rádio Pulcha FM');
  });

  it('returns the operator text unframed as the plain-text half', () => {
    // MailMessage carries both (src/lib/mailer/index.ts). The text half is what
    // a client refusing HTML shows, and it is the operator's own words.
    const { text } = renderCampaignEmail({ ...base, body: 'Oi Ana!\nTudo bem?' });
    expect(text).toBe('Oi Ana!\nTudo bem?');
  });

  it('leaves the unsubscribe seam empty until something fills it', () => {
    // 29c fills this. The slot ships empty because reopening the frame later is
    // dearer than leaving the seam.
    const { html } = renderCampaignEmail(base);
    // No anchor at all, rather than "no such word": the seam is empty when the
    // frame renders no link, and only that is checkable without naming copy
    // this module does not own.
    expect(html).not.toContain('<a ');
  });

  it('renders the unsubscribe link with the caller-supplied label', () => {
    // The label is the caller's, never ours: this module has no access to the
    // i18n catalogues, and a word hardcoded here would be the one piece of
    // untranslated copy in a message otherwise entirely in the reader's
    // language.
    const { html } = renderCampaignEmail({
      ...base,
      unsubscribe: { url: 'https://app.example/u/abc', label: 'Cancelar inscrição' },
    });
    expect(html).toContain('https://app.example/u/abc');
    expect(html).toContain('Cancelar inscrição');
  });
});
