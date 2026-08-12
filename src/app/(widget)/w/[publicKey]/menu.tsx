'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { WidgetOpenTarget } from '@/lib/widget/open-target';
import { signOutAction } from './actions';
import { EnterPromotionPanel } from './enter-promotion';
import { RequestSongPanel } from './request-song';

/**
 * Block 17a, spec §8: "The menu has two buttons, disabled until 17b and 17c
 * land."
 *
 * BOTH HAVE LANDED. 17b took the first, 17c the second, and this component's
 * whole job is now which panel is open. What follows is kept as history rather
 * than instruction — it records a deviation from 17a's brief that a reader
 * would otherwise wonder about, and the reasoning is why neither button ever
 * named a block number to a visitor.
 *
 * WHILE THE BUTTONS WERE DISABLED, THEIR TOOLTIP WAS A DEVIATION FROM THE
 * BRIEF, recorded rather than slipped in: it asked for a `title` "naming the
 * block that will enable them".
 * A block number is this project's vocabulary, not a listener's — the person
 * reading this tooltip is somebody's mother on a radio station's website, in
 * one of three languages, and "Block 17c" is not a sentence in any of them. The
 * block numbers are in the paragraph above, where the developer who needs them
 * looks; the tooltip says what a visitor needs to know, which is that the
 * button is not broken.
 *
 * NO `left` STATE HERE ANY MORE, AND NO `exitHref` EITHER — Task 6, fix round
 * 1. The first version held both, rendering `<Farewell>` in place once
 * `signOutAction` resolved; the walkthrough that version's own step 9 asked
 * for caught that this component's local state cannot survive the action's
 * cookie clear (see `signOutAction`'s own comment for the measurement).
 * "Sair" is a `<form action={signOutAction.bind(null, publicKey)}>` now — a
 * real navigation the action's own `redirect()` completes — so there is
 * nothing left for this component to hold once the button is pressed, and
 * `page.tsx` draws the farewell for the `?left=1` request that follows.
 */
export function WidgetMenu({
  publicKey,
  initialOpen,
}: {
  publicKey: string;
  /**
   * Block 19a, Task 7. What `?open=`/`&id=` asked for, already shape-checked
   * by `page.tsx` (`parseOpenTarget`). `undefined` when there was nothing to
   * ask for at all, which is the ordinary case of a listener who opened the
   * widget without arriving from a link.
   */
  initialOpen?: WidgetOpenTarget;
}) {
  const t = useTranslations('widget');
  const [panel, setPanel] = useState<'menu' | 'song' | 'promotion'>(
    initialOpen?.kind === 'music' ? 'song' : initialOpen?.kind === 'promotion' ? 'promotion' : 'menu',
  );

  if (panel === 'promotion') {
    return (
      <EnterPromotionPanel
        publicKey={publicKey}
        onClose={() => setPanel('menu')}
        // WHETHER THIS LISTENER MAY ACTUALLY SEE IT is the panel's own
        // question, not this component's -- it is asked against the exact
        // list `EnterPromotionPanel` already fetches to draw itself. A
        // promotion outside that list, or a list that could not be read at
        // all, calls `onClose` -- the same fallback a click on "Back" gives,
        // which is the menu, never an error screen for a URL somebody may
        // have edited.
        autoOpenId={initialOpen?.kind === 'promotion' ? initialOpen.id : undefined}
      />
    );
  }

  if (panel === 'song') {
    return <RequestSongPanel publicKey={publicKey} onClose={() => setPanel('menu')} />;
  }

  return (
    <div
      className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
      data-testid="widget-menu"
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-base font-semibold">{t('menuTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('menuIntro')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setPanel('song')}
          data-testid="widget-request-song"
        >
          {t('requestASong')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setPanel('promotion')}
          data-testid="widget-enter-promotion"
        >
          {t('enterAPromotion')}
        </Button>
      </div>

      {/* D6. Below the two errands and separated from them: it is a way out,
          not a third thing to do. A FORM, not a button with an onClick,
          because `signOutAction` ends in a `redirect()` — the shape that
          survives a real navigation, unlike a client state flag. */}
      <form action={signOutAction.bind(null, publicKey)} className="self-start">
        <Button type="submit" variant="ghost" data-testid="widget-exit">
          {t('exit')}
        </Button>
      </form>
    </div>
  );
}
