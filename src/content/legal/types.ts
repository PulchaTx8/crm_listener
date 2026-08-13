/**
 * The whole vocabulary a legal document needs, and deliberately no more.
 *
 * NO ARBITRARY HTML AND NO RICH-TEXT PARSER (spec §3.2). These three pages are
 * the ones where what is displayed must equal what was written, and a renderer
 * that can be handed markup is a renderer nobody can audit. Headings,
 * paragraphs, lists and links is the entire grammar of the owner's text.
 */
export interface LegalLink {
  readonly label: string;
  readonly href: string;
}

export type LegalBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  /** A paragraph whose whole point is the address it carries, e.g. the deletion page. */
  | { readonly kind: 'link'; readonly text: string; readonly link: LegalLink };

export interface LegalSection {
  /**
   * Stable across languages, and NOT derived from the heading — the heading is
   * translated and the id is what the structural test compares and what an
   * anchor cites.
   */
  readonly id: string;
  readonly heading: string;
  readonly blocks: readonly LegalBlock[];
}

export interface LegalDocument {
  readonly title: string;
  /** ISO date. Formatted per locale at render time rather than written as prose. */
  readonly updated: string;
  readonly intro?: readonly LegalBlock[];
  readonly sections: readonly LegalSection[];
}
