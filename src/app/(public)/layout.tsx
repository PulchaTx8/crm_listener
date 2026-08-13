import { PublicHeader } from './public-header';

/**
 * The bare column every page in this route group renders inside.
 *
 * Gains a header here (task brief): the wordmark, links to the three legal
 * documents, and a language switch. `/contato` shares this layout, so it
 * gains the header too -- an improvement rather than a side effect, since it
 * had no way to reach the documents or change language before.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-3xl px-6 py-16">
      <PublicHeader />
      {children}
    </div>
  );
}
