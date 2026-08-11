'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { RequestSongPanel } from './request-song';

/**
 * Block 17a, spec §8: "The menu has two buttons, disabled until 17b and 17c
 * land."
 *
 * 17b LANDED, so the first one works and this component now owns which panel is
 * open. The second is still a placeholder: 17c is the promotion list and the
 * step walker, and building either here would put a screen in this file that
 * nothing tests.
 *
 * WHAT THE TOOLTIP SAYS IS A DEVIATION FROM THE BRIEF, recorded rather than
 * slipped in: it asked for a `title` "naming the block that will enable them".
 * A block number is this project's vocabulary, not a listener's — the person
 * reading this tooltip is somebody's mother on a radio station's website, in
 * one of three languages, and "Block 17c" is not a sentence in any of them. The
 * block numbers are in the paragraph above, where the developer who needs them
 * looks; the tooltip says what a visitor needs to know, which is that the
 * button is not broken.
 */
export function WidgetMenu({ publicKey }: { publicKey: string }) {
  const t = useTranslations('widget');
  const [panel, setPanel] = useState<'menu' | 'song'>('menu');

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
        {/* Block 17c. */}
        <Button
          type="button"
          variant="outline"
          disabled
          title={t('comingSoon')}
          data-testid="widget-enter-promotion"
        >
          {t('enterAPromotion')}
        </Button>
      </div>
    </div>
  );
}
