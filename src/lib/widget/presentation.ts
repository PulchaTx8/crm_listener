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
