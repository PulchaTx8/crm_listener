/**
 * Meta's Embedded Signup flow — where a Station pairs its own WhatsApp Business
 * account with this product, so the two can coexist on the same number.
 *
 * The address lives in `WHATSAPP_EMBEDDED_SIGNUP_URL` rather than in this file
 * because it carries the Meta app id, which differs between the deployment that
 * runs this code and any other. Server-only, deliberately: `NEXT_PUBLIC_*` is
 * inlined at `next build` time, so a corrected app id would need the whole
 * image rebuilt, while this one is read on each render of a screen that is
 * already `force-dynamic`.
 *
 * This module exists — instead of `env.WHATSAPP_EMBEDDED_SIGNUP_URL ?? null` at
 * the call site — for one reason worth the file: the value goes straight into
 * an anchor's `href`, and `z.string().url()` in src/lib/env.ts is `new URL()`,
 * which accepts EVERY scheme, `javascript:` included. The env schema proves the
 * value parses; only this function proves it is safe to click.
 */
export function embeddedSignupUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  // Absent and blank are the same answer. Docker turns an `ARG` with no value
  // into `ENV NAME=`, so a deployment that simply forgot this variable arrives
  // as an empty string rather than as nothing — the case src/lib/env.ts strips
  // before parsing, restated here because this function is also called with
  // values that never went through that schema.
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  // https only. Meta serves this flow nowhere else, so anything that is not
  // https is a mistake or an attack, and both deserve the same answer the
  // screen gives for "never configured": no button at all.
  if (parsed.protocol !== 'https:') return null;

  return trimmed;
}

/**
 * The rectangle the pairing window opens in.
 *
 * THERE IS NO OFFICIAL SIZE TO COPY, and that is worth stating rather than
 * implying one: Meta's own documentation launches Embedded Signup through
 * `FB.login()` in its JavaScript SDK, which sizes the window itself and
 * publishes no dimensions. Opening the address directly — which is what this
 * product does, deliberately, rather than loading Meta's SDK into the console
 * — means the rectangle is our choice.
 *
 * So it is chosen from the content: the flow is a multi-step wizard with a
 * side panel, and below roughly 1000 wide it starts scrolling inside itself
 * while the operator is reading a confirmation code off their telephone.
 * Hence 1100x800 — then clamped, because the preference matters far less than
 * the clamp does. A window taller than the screen puts the wizard's own
 * buttons past the bottom edge, where no scrollbar reaches them.
 */
/**
 * The BROWSER WINDOW's own box — `outerWidth`/`outerHeight` and
 * `screenX`/`screenY`, every one of them standard and typed.
 *
 * Measured against the browser window rather than the display on purpose.
 * Sizing against the display would need `screen.availLeft`/`availTop` to place
 * the result, and those are non-standard — absent from TypeScript's own DOM
 * types and from some browsers. Centring over the window costs nothing and
 * lands on the right monitor for free, because the window is already on it.
 */
export type WindowBox = { width: number; height: number; left: number; top: number };

const PREFERRED_WIDTH = 1100;
const PREFERRED_HEIGHT = 800;
/** Leaves room for the browser's own chrome around the wizard. */
const OF_THE_HOST = 0.9;

export function signupPopupFeatures(host: WindowBox): string {
  const width = Math.round(Math.min(PREFERRED_WIDTH, host.width * OF_THE_HOST));
  const height = Math.round(Math.min(PREFERRED_HEIGHT, host.height * OF_THE_HOST));
  // `host.left`/`host.top` are NOT ZERO on any machine with a second monitor,
  // and dropping them is the classic version of this bug: the window opens
  // centred on the primary screen, which to an operator working on the other
  // one is indistinguishable from a button that does nothing.
  const left = Math.round(host.left + (host.width - width) / 2);
  const top = Math.round(host.top + (host.height - height) / 2);

  // `popup=yes` is the explicit ask. Without it a browser is free to answer
  // window.open with a tab, which is the behaviour this exists to replace.
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}
