/**
 * The words that stop a Station's campaigns, typed into WhatsApp.
 *
 * WHY THESE EXIST AT ALL: without them Block 29d would send marketing through a
 * channel with no exit. Meta measures that as a complaint rate against the
 * number, and a number with a poor quality rating stops delivering to everyone
 * — so this is not only the listener's right, it is the deliverability of every
 * other message the Station sends.
 *
 * WHOLE MESSAGE, NOT SUBSTRING. A listener answering "which city" with "quero
 * cancelar minha participacao" is talking about a promotion, not withdrawing
 * consent, and unsubscribing them for a word inside a sentence would be a
 * withdrawal nobody asked for.
 *
 * "SAIR" IS DELIBERATELY ABSENT. The widget has carried a "Sair" since Block
 * 19b meaning end-the-session; giving the same word a second meaning in the
 * conversation would make the two indistinguishable in a bug report.
 */
const STOP_WORDS = new Set(['parar', 'cancelar', 'descadastrar']);

/**
 * Accents stripped and case folded before comparison, because the alternative
 * is a listener who typed "PARAR!" on a phone keyboard staying subscribed.
 * Trailing punctuation goes the same way for the same reason.
 */
export function isStopWord(text: string): boolean {
  const normalised = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return STOP_WORDS.has(normalised);
}
