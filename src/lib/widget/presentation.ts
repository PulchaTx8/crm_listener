/**
 * Block 19b, D1. Which of the widget's two presentations a request gets.
 *
 * `Sec-Fetch-Dest` AND NOTHING ELSE, and in particular NOT the session's
 * `channel` claim, which was this block's first instinct and is wrong. The
 * cookie's `Path` is `/w` — one path for every installation this deployment
 * serves (session.ts says so at length) — so a browser that arrived from a
 * WhatsApp link and later loads the same Station's website carries a `WHATSAPP`
 * claim into a request that genuinely IS an iframe, and would be drawn as a
 * full-height application inside a sidebar. The header answers the question
 * actually being asked: is there a frame around me.
 *
 * THE HEADER ABSENT IS AN APPLICATION. Every browser this product supports
 * sends `Sec-Fetch-Dest`; something that does not is likelier to be a script or
 * a very old browser opening the address directly than a modern site framing
 * it. The two failures are not symmetric — failing to the application costs a
 * framed widget a header it should not have, and failing to the embed costs a
 * WhatsApp listener a narrow transparent column in an empty tab, which is the
 * complaint this block exists to answer.
 */
export type WidgetPresentation = 'embedded' | 'app';

export function choosePresentation(secFetchDest: string | null): WidgetPresentation {
  return secFetchDest?.toLowerCase() === 'iframe' ? 'embedded' : 'app';
}

/**
 * Block 19b, fix round found by Task 7's own e2e. WHICH REQUESTS `Sec-Fetch-Dest`
 * IS EVEN ANSWERING A QUESTION FOR.
 *
 * A genuine document request is the browser NAVIGATING a frame (main or sub) to
 * a new document — the one case `choosePresentation` above was written for.
 * `identify-form.tsx`'s post-verify `router.refresh()`, and every "Sair"
 * submission, are Server Action POSTs or the RSC fetch a client-side refresh
 * issues; both carry `Sec-Fetch-Dest: empty`, because that is what a script's
 * own `fetch()` call reports REGARDLESS of whether the script happens to be
 * running inside an iframe — a browser has no header that says "the document
 * that is asking is itself framed". Measured directly, against the real
 * cross-origin fixture `tests/e2e/widget.spec.ts` drives: the menu that
 * replaces the identify form after a correct code rendered WITH a header,
 * inside the very iframe D1 says must never have one, because the request that
 * produces that render is the fetch above, not the navigation that loaded the
 * form.
 *
 * `middleware.ts`'s widget branch is the only caller — it already computed
 * this exact condition inline, for the unrelated purpose of deciding whether a
 * request needs `frame-ancestors` at all (a Server Action carries no framing
 * question either), so this is that same check, named and exported rather than
 * kept as two copies that could drift.
 */
export function isDocumentRequest(method: string, accept: string | null): boolean {
  return method === 'GET' && (accept ?? '').includes('text/html');
}

/**
 * Where `middleware.ts` writes the presentation decided for the last genuine
 * document request, and the only thing `page.tsx` trusts for a request that is
 * not one itself — see `isDocumentRequest`'s own comment for why such a
 * request cannot answer the question `choosePresentation` asks. Scoped to
 * `path: '/w'`, `SameSite=None` and `Partitioned`, the same three attributes
 * `WIDGET_SESSION_COOKIE` needs and for the identical reason: the embedded
 * case this cookie exists to fix is, by definition, a third-party iframe, and
 * a cookie missing any one of those three is silently dropped there.
 */
export const WIDGET_PRESENTATION_COOKIE = 'pw_presentation';

/**
 * NOT `WIDGET_SESSION_SECONDS` (`session.ts`), and that is a constraint of
 * where this value is used, not a preference: `middleware.ts` sets this
 * cookie, `middleware.ts` runs on the Edge runtime, and `session.ts` pulls in
 * `node:crypto` for its signing — importing it, even for one unrelated
 * constant, fails the Edge build outright ("Reading from 'node:crypto' is not
 * handled by plugins", measured against `npm run build`). The two numbers
 * happen to agree today because both describe roughly how long a listener's
 * visit lasts; nothing requires them to.
 */
export const WIDGET_PRESENTATION_SECONDS = 1800;
