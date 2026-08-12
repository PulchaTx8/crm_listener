import { describe, expect, it } from 'vitest';
import { choosePresentation } from '@/lib/widget/presentation';

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
