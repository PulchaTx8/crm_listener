'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ShowOption } from '@/services/shows';
import { createPromotionAction, type PromotionFormState } from './actions';
import { PromotionFields } from './promotion-fields';
import { WhatsappFields } from './whatsapp-fields';

const INITIAL: PromotionFormState = { status: 'idle' };

/**
 * Registering a promotion asks for the same two tabs the record shows, in one
 * form, because create_promotion takes the same fields update_promotion does.
 * The quiz is not here: a question needs a promotion to hang off, so it is
 * added in the record that opens the moment this succeeds.
 */
export function RegisterPromotionForm({
  open,
  companyId,
  timeZone,
  shows,
  onClose,
  onCreated,
}: {
  open: boolean;
  companyId: string;
  timeZone: string;
  /** This Station's live Programmes (item 17), read by the page — see PromotionFields' own prop doc. */
  shows: ShowOption[];
  onClose: () => void;
  onCreated: (promotionId: string) => void;
}) {
  const t = useTranslations('promotions');
  const titleId = useId();
  const [state, action, pending] = useActionState(createPromotionAction, INITIAL);
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [webEnabled, setWebEnabled] = useState(false);
  const [repeats, setRepeats] = useState(false);

  useEffect(() => {
    if (state.status === 'saved' && state.promotionId) onCreated(state.promotionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{t('registerAPromotion')}</DialogTitle>
      </DialogHeader>
      <form action={action}>
        <DialogBody>
          <input type="hidden" name="companyId" value={companyId} />

          <div className="flex flex-col gap-8">
            <PromotionFields
              record={null}
              timeZone={timeZone}
              disabled={false}
              repeats={repeats}
              onRepeatsChange={setRepeats}
              onDirty={() => undefined}
              shows={shows}
            />

            <div className="border-t pt-6">
              <WhatsappFields
                record={null}
                enabled={whatsappEnabled}

                webEnabled={webEnabled}

                onWebEnabledChange={setWebEnabled}
                onEnabledChange={setWhatsappEnabled}
                disabled={false}
                onDirty={() => undefined}
              />
            </div>
          </div>

          {state.status === 'error' && (
            <p className="mt-4 text-sm text-destructive" data-testid="promotion-create-error">
              {state.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('cancel')}</Button>
          <Button type="submit" disabled={pending} data-testid="promotion-create-submit">
            {pending ? t('registering') : t('registerAction')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
