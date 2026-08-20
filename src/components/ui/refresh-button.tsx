'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Block 30b D1. Ask the same question again.
 *
 * `router.refresh()` RATHER THAN A NAVIGATION TO THE SAME URL: Next treats
 * navigating to an identical URL as a no-op, while `refresh()` re-fetches the
 * Server Components for the current route and re-renders them with client state
 * intact. It also drives the effect each grid already has — every one of them
 * resets its locally patched rows from `initialRows` when a new page arrives —
 * so nothing new has to be taught about when local state yields to server
 * state.
 *
 * IT PRESERVES THE CURSOR, and that is the decision rather than an omission. An
 * operator three pages into a list who presses this is asking about THIS page;
 * returning them to the first one would lose their place to answer a question
 * they did not ask.
 *
 * The pending state is not decoration. A refresh that looks like nothing
 * happened gets pressed again, and again.
 */
export function RefreshButton() {
  // `shell`, verified: it is this product's cross-cutting UI namespace — it
  // already holds `sortedAscending`, `noPictureYet`, `settings` and the theme
  // labels, all strings that belong to no one screen. There is no `common`
  // namespace in this repository.
  const t = useTranslations('shell');
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      disabled={pending}
      className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
      data-testid="refresh"
    >
      {pending ? t('refreshing') : t('refresh')}
    </button>
  );
}
