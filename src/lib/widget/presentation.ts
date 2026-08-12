/**
 * Block 19b, D1. Which of the widget's two presentations a request gets.
 *
 * `Sec-Fetch-Dest`, and in particular NOT the session's `channel` claim,
 * which was this block's first instinct and is wrong. The cookie's `Path` is
 * `/w` — one path for every installation this deployment serves (session.ts
 * says so at length) — so a browser that arrived from a WhatsApp link and
 * later loads the same Station's website carries a `WHATSAPP` claim into a
 * request that genuinely IS an iframe, and would be drawn as a full-height
 * application inside a sidebar. The header answers the question actually
 * being asked: is there a frame around me.
 *
 * THE HEADER ABSENT IS AN APPLICATION. Every browser this product supports
 * sends `Sec-Fetch-Dest`; something that does not is likelier to be a script or
 * a very old browser opening the address directly than a modern site framing
 * it. The two failures are not symmetric — failing to the application costs a
 * framed widget a header it should not have, and failing to the embed costs a
 * WhatsApp listener a narrow transparent column in an empty tab, which is the
 * complaint this block exists to answer.
 *
 * `choosePresentation` BELOW STILL KEYS OFF THAT ONE HEADER AND NOTHING
 * ELSE — it is a pure function, and stays one; this comment used to say so in
 * those words, and a fix round found that the words had gone false one line
 * below without the FUNCTION having changed at all. What changed is WHICH
 * REQUEST'S header `page.tsx` feeds it. Only a genuine document request
 * carries a `Sec-Fetch-Dest` this function can answer meaningfully
 * (`isDocumentRequest`'s own comment has the reason); `middleware.ts` calls
 * this function once, on that request, and carries the answer forward in
 * `WIDGET_PRESENTATION_COOKIE` for every request in between. The decision is
 * still "`Sec-Fetch-Dest`, chosen per request, by the page" (D1's own words)
 * — only the mechanism that carries it from the one request that can answer
 * the question to the many that cannot has grown a name.
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
 * request cannot answer the question `choosePresentation` asks.
 *
 * A SESSION COOKIE — NO `maxAge` SET AT ALL, and that is a correction, not
 * the original choice. The first version carried `maxAge: 1800`, matching
 * `WIDGET_SESSION_SECONDS`, and a fix round's review named exactly the
 * defect that number let through: an embedded widget sitting untouched in a
 * Station's page for longer than that, then touched by ANY Server Action or
 * `router.refresh()`, presents no `pw_presentation` at all — it already
 * expired — so `page.tsx` falls back to the header, gets `empty` on that
 * non-navigation request, and draws the header and full-height chrome this
 * whole mechanism exists to keep OUT of that iframe. The bug the cookie was
 * built to fix, back on a thirty-minute timer.
 *
 * This cookie describes a property of the BROWSING CONTEXT it is set in — is
 * there a frame around this document — and a browsing context does not
 * expire on a clock; it ends when the tab or the frame does. A session
 * cookie is the shape that actually matches: it lives exactly as long as the
 * browser keeps the context open, and every genuine document request
 * rewrites it before `page.tsx` ever reads it, so there is no staleness left
 * for any number, short or long, to trade away.
 *
 * Scoped to `path: '/w'`, `SameSite=None` and `Partitioned`, the same three
 * attributes `WIDGET_SESSION_COOKIE` needs, for two reasons rather than one:
 *
 * 1. Without any one of them, a browser silently drops the cookie in the
 *    embedded case this cookie exists to fix, which is by definition a
 *    third-party iframe — the same reason `WIDGET_SESSION_COOKIE` carries
 *    all three.
 * 2. `Partitioned` ALSO keeps two SIMULTANEOUS presentations from
 *    overwriting one another. `path: '/w'` is one jar for every installation
 *    this deployment serves — the same fact `session.ts` warns about at
 *    length for `pw_session` — so without partitioning, a listener with a
 *    WhatsApp-minted tab open in one browser tab and this Station's own
 *    website framing the widget in another would share ONE
 *    `pw_presentation` cookie, and whichever tab's request landed most
 *    recently would silently decide the other tab's chrome too. Partitioning
 *    keys the jar to the embedding site, so the two tabs never collide. This
 *    cookie carries no personal data — the property that makes `Partitioned`
 *    look like the removable attribute to somebody tidying up later — and it
 *    is not removable for this second reason, independent of the
 *    CHIPS-deprecation one `WIDGET_SESSION_COOKIE`'s own comment gives.
 *
 * `path: '/w'` IS SAFE HERE FOR A DIFFERENT REASON THAN IT IS FOR
 * `pw_session`, and that is worth saying once rather than assuming it
 * follows by analogy. `pw_session`'s claims name WHO the listener is, a fact
 * about one installation — which is exactly why `readSessionFor` exists, to
 * refuse a session minted at Station A when it is presented at Station B's
 * widget. `pw_presentation` names nothing about a listener or a Station at
 * all; it is a fact about the BROWSING CONTEXT — is there a frame around
 * THIS document — which is exactly as true or false for any installation
 * this deployment serves. A shared jar is the leak `session.ts` warns
 * against for one cookie, and the correct, harmless behaviour for the other.
 */
export const WIDGET_PRESENTATION_COOKIE = 'pw_presentation';
