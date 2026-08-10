'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * Block 17a, spec §8: "The menu has two buttons, disabled until 17b and 17c
 * land."
 *
 * BOTH ARE PLACEHOLDERS AND BOTH ARE `disabled`, and there is deliberately no
 * music search and no promotion list behind either of them. 17b is the Deezer
 * search and the request recorded with channel `WEB`; 17c is the promotion list
 * and the step walker. Building either here would put a screen in the block
 * that does not test it.
 *
 * WHAT THE TOOLTIP SAYS IS A DEVIATION FROM THE BRIEF, recorded rather than
 * slipped in: it asked for a `title` "naming the block that will enable them".
 * A block number is this project's vocabulary, not a listener's — the person
 * reading this tooltip is somebody's mother on a radio station's website, in
 * one of three languages, and "Block 17b" is not a sentence in any of them. The
 * block numbers are in the paragraph above, where the developer who needs them
 * looks; the tooltip says what a visitor needs to know, which is that the
 * button is not broken.
 */
export function WidgetMenu() {
  const t = useTranslations('widget');

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
        {/* Block 17b. */}
        <Button type="button" variant="outline" disabled title={t('comingSoon')} data-testid="widget-request-song">
          {t('requestASong')}
        </Button>
        {/* Block 17c. */}
        <Button type="button" variant="outline" disabled title={t('comingSoon')} data-testid="widget-enter-promotion">
          {t('enterAPromotion')}
        </Button>
      </div>
    </div>
  );
}
