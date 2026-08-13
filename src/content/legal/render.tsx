import type { LegalBlock, LegalDocument } from './types';

/**
 * The only file in this feature that knows markup.
 *
 * The `<main>` wrapper belongs to the PAGE, not here: /delete-data puts a form
 * beside this article, and only the page knows that.
 */
function Block({ block }: { block: LegalBlock }) {
  if (block.kind === 'list') {
    return (
      <ul className="ml-5 flex list-disc flex-col gap-1">
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }
  if (block.kind === 'link') {
    // The period trails the anchor, in the renderer rather than in any
    // module's `text`. A link block's grammar is fixed -- prose, then a URL,
    // always at the end of the sentence -- so the full stop belongs to the
    // shape, not to nine copies of it repeated across languages and
    // documents. Placed as its own JSX text child (not inside the <a>) so it
    // renders outside the underline, and JSX collapses the whitespace-only
    // lines around it, so it abuts the link with no injected space.
    return (
      <p>
        {block.text}{' '}
        <a href={block.link.href} className="text-primary underline underline-offset-2">
          {block.link.label}
        </a>
        .
      </p>
    );
  }
  return <p>{block.text}</p>;
}

export function LegalArticle({
  document,
  locale,
}: {
  document: LegalDocument;
  locale: string;
}) {
  // Formatted here rather than written into the prose, so one ISO date in the
  // content serves three languages and cannot disagree with itself.
  const updated = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(
    new Date(`${document.updated}T00:00:00Z`),
  );

  return (
    <article className="flex flex-col gap-6 text-sm leading-relaxed">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{document.title}</h1>
        <p className="text-muted-foreground">{updated}</p>
      </header>

      {document.intro?.map((block, i) => <Block key={i} block={block} />)}

      {document.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-3">
          <h2 id={section.id} className="text-lg font-semibold">
            {section.heading}
          </h2>
          {section.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </section>
      ))}
    </article>
  );
}
