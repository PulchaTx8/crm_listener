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
