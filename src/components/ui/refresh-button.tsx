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
 * intact. Nothing new has to be taught about when local state yields to server
 * state, but not for the same reason on all three screens: MembersGrid mirrors
 * `initialRows` into state and has an effect that resets it whenever a new page
 * arrives (members-grid.tsx), so `refresh()` drives that effect exactly as any
 * other navigation would. ParticipationsGrid and RequestsGrid hold no row state
 * at all — they render `rows` straight from props (participations-grid.tsx,
 * requests-grid.tsx) — so there is nothing for `refresh()` to reconcile there;
 * the new props it delivers are simply what renders next. Both classes yield to
 * the new props `refresh()` delivers; only one of them does it by resetting.
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
