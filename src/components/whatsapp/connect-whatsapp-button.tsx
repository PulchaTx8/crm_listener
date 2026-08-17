'use client';

import { buttonVariants } from '@/components/ui/button';
import { signupPopupFeatures } from '@/lib/integrations/whatsapp/embedded-signup';

/**
 * Named, so a second click focuses the window already open rather than
 * starting a second pairing beside the first.
 */
const WINDOW_NAME = 'pulchatx-whatsapp-embedded-signup';

/**
 * Client for exactly one reason: `window.open`.
 *
 * The label still arrives as a prop, and after Block 29a that is a smaller
 * saving than it was: the card above it is a client component now too, so the
 * translator is already in the bundle. It stays a prop anyway, because this
 * component makes no claim about which namespace the sentence came from — it
 * renders a link and opens a window, and a caller that wants a different label
 * should not have to add a key to somebody else's namespace to get one.
 *
 * STILL AN ANCHOR WITH A REAL href, not a button with a handler, and that is
 * the whole robustness of it. The popup is an enhancement layered on top of a
 * link that already worked:
 *
 *   - a blocked popup falls through to the anchor's own navigation, so the
 *     operator gets a tab instead of nothing;
 *   - ctrl-click, middle-click and "open in new window" keep working, because
 *     the handler stands aside for them;
 *   - the destination is visible in the status bar before the click, which a
 *     <button> cannot offer.
 *
 * `preventDefault` is called ONLY once `window.open` has returned a live
 * handle. Calling it first — the obvious ordering — is what turns a blocked
 * popup into a button that does nothing at all.
 *
 * NO `noopener` IN THE FEATURE STRING, deliberately and against the usual
 * advice: `window.open(..., 'noopener')` returns null, which would make a
 * successful open indistinguishable from a blocked one and break the fallback
 * above. What that leaves open is reverse tabnabbing from the opened page, and
 * the opened page is business.facebook.com — the address an operator is being
 * sent to on purpose. `rel="noreferrer"` still hardens the fallback path.
 */
export function ConnectWhatsAppButton({ url, label }: { url: string; label: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={buttonVariants({ size: 'sm' })}
      data-testid="connect-whatsapp-start"
      onClick={(event) => {
        // A modified click is the reader asking for a tab, a window or a saved
        // link by name. Answering it with our popup would override a choice
        // they made deliberately.
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
          return;
        }

        const opened = window.open(
          url,
          WINDOW_NAME,
          signupPopupFeatures({
            width: window.outerWidth,
            height: window.outerHeight,
            left: window.screenX,
            top: window.screenY,
          }),
        );
        if (!opened) return; // blocked; the anchor's own navigation takes over

        event.preventDefault();
        opened.focus();
      }}
    >
      {label}
    </a>
  );
}
