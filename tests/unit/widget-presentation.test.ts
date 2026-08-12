import { describe, expect, it } from 'vitest';
import { choosePresentation, isDocumentRequest } from '@/lib/widget/presentation';

describe('choosePresentation', () => {
  it('is embedded inside a frame, which is what the widget was built for', () => {
    expect(choosePresentation('iframe')).toBe('embedded');
  });

  it('is an application for a top-level navigation', () => {
    expect(choosePresentation('document')).toBe('app');
  });

  it('is an application when the header is absent', () => {
    // Failing to the application costs a framed widget a header it should not
    // have; failing to the embed costs a WhatsApp listener the whole block.
    expect(choosePresentation(null)).toBe('app');
  });

  it('is an application for any other destination', () => {
    expect(choosePresentation('empty')).toBe('app');
    expect(choosePresentation('embed')).toBe('app');
  });

  it('does not care about the case a proxy rewrote the value in', () => {
    expect(choosePresentation('IFRAME')).toBe('embedded');
  });
});

/**
 * Block 19b, fix round 1, M-5. `isDocumentRequest` is what `middleware.ts`
 * asks before it trusts `Sec-Fetch-Dest` at all — for `frame-ancestors` and,
 * since the fix round that found the header-inside-the-iframe defect, for
 * whether `WIDGET_PRESENTATION_COOKIE` gets rewritten. A wrong answer here
 * either lets a Server Action decide the presentation (the exact bug this
 * whole mechanism exists to prevent) or stops a genuine navigation from ever
 * refreshing the cookie at all.
 */
describe('isDocumentRequest', () => {
  it('is a document request for GET with an HTML accept header — a real navigation', () => {
    expect(isDocumentRequest('GET', 'text/html,application/xhtml+xml')).toBe(true);
  });

  it('is not a document request for POST, even with an HTML accept header — a Server Action', () => {
    expect(isDocumentRequest('POST', 'text/html,application/xhtml+xml')).toBe(false);
  });

  it('is not a document request for GET with the RSC accept header — a router.refresh() fetch', () => {
    expect(isDocumentRequest('GET', 'text/x-component')).toBe(false);
  });

  it('is not a document request when Accept is absent entirely', () => {
    expect(isDocumentRequest('GET', null)).toBe(false);
  });
});
