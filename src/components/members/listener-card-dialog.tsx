'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DOTS, maskedPhone } from '@/lib/members/mask';
import { formatCalendarDate, formatDate } from '@/app/(app)/members/format';
import {
  getListenerCardAction,
  revealListenerFieldAction,
  type ListenerCard,
  type RevealableField,
} from '@/app/(app)/members/listener-card';

/**
 * Block 30a. One listener, read from a screen whose job is something else.
 *
 * READ-ONLY BY CONSTRUCTION. MemberRecordDialog stays the place a listener is
 * administered: it is reached from the screen whose whole purpose is that, by a
 * caller who already holds members.edit. This window is reached from Pickups,
 * Participations and Requests, where the operator is doing an errand about a
 * prize, an entry or a song and needs to know who they are talking to.
 *
 * EVERY SENSITIVE VALUE ARRIVES MASKED (listener-card.ts) and is revealed one
 * at a time, each reveal leaving an audit row. The screen therefore cannot
 * disclose what it was never sent, which is the property a React-side mask
 * would not have had.
 */

/** Which fields have been revealed, and what came back for each. */
type Revealed = Partial<Record<RevealableField, string | null>>;

export function ListenerCardDialog({
  memberId,
  onClose,
}: {
  memberId: string;
  onClose: () => void;
}) {
  // ONE NAMESPACE. Everything this window renders — including the gender
  // labels, which are `members` keys and not `vocab` ones — comes from
  // `members`, so there is no second `useTranslations` here.
  const t = useTranslations('members');
  const titleId = useId();

  const [card, setCard] = useState<ListenerCard | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Revealed>({});
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealing, startReveal] = useTransition();

  // Whole-branch review F7. anonymize_member (0034) scrubs but does not
  // soft-delete, so an erased listener is still selectable from all three
  // calling screens, and every field on this card comes back masked-to-null
  // for one -- the same "nothing" a listener who never filled anything in
  // would show. Without this line the two are indistinguishable here, even
  // though requests-grid.tsx already draws the same distinction for the same
  // fact with `members.thisListenerHasSinceExercisedTheir`.
  const erased = Boolean(card?.anonymizedAt);

  useEffect(() => {
    let current = true;
    setCard(null);
    setFailure(null);
    setRevealed({});
    void getListenerCardAction(memberId).then((result) => {
      // The answer to a listener the operator has already moved past must not
      // land -- the guard every read-on-open dialog in this product carries.
      if (!current) return;
      if (result.status === 'ok') setCard(result.card);
      else
        setFailure(
          result.status === 'not-found' ? t('noSuchListenerOrYouDo') : result.message,
        );
    });
    return () => {
      current = false;
    };
  }, [memberId, t]);

  function reveal(field: RevealableField) {
    // Cleared up front, not only on the next success: a field that reveals
    // must not keep showing the error from the attempt before it.
    setRevealError(null);
    startReveal(async () => {
      const result = await revealListenerFieldAction(memberId, field);
      if (result.status === 'ok') setRevealed((current) => ({ ...current, [field]: result.value }));
      else setRevealError(result.message);
    });
  }

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-xl">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('theListener')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {failure && <p className="text-sm text-destructive">{failure}</p>}
        {!card && !failure && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
        {card && erased && (
          <p className="mb-3 text-sm text-muted-foreground" data-testid="listener-card-erased">
            {t('thisListenerHasSinceExercisedTheir')}
          </p>
        )}
        {card && (
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-3 text-sm">
            <Row label={t('name')} value={card.fullName ?? '—'} />

            <MaskedRow
              label={t('phone')}
              field="phone"
              masked={card.phoneLast4 === null ? null : maskedPhone(card.phoneLast4)}
              revealed={revealed}
              revealing={revealing}
              onReveal={reveal}
              showLabel={t('showTheNumber')}
              erasedLabel={t('thisListenerHasSinceExercisedTheir')}
            />
            <MaskedRow
              label={t('email')}
              field="email"
              masked={card.emailMasked}
              revealed={revealed}
              revealing={revealing}
              onReveal={reveal}
              showLabel={t('show')}
              erasedLabel={t('thisListenerHasSinceExercisedTheir')}
            />
            <MaskedRow
              label={t('passport')}
              field="passport"
              masked={card.passportMasked}
              revealed={revealed}
              revealing={revealing}
              onReveal={reveal}
              showLabel={t('show')}
              erasedLabel={t('thisListenerHasSinceExercisedTheir')}
            />
            <MaskedRow
              label={t('address')}
              field="address"
              masked={card.addressMasked}
              revealed={revealed}
              revealing={revealing}
              onReveal={reveal}
              showLabel={t('show')}
              erasedLabel={t('thisListenerHasSinceExercisedTheir')}
            />

            {/*
              NOT MASKED AND NOT REVEALABLE. The column holds only the last
              digits; the CPF itself is a hash (0031), so there is no whole
              value in this system to disclose.
            */}
            {card.cpfLastDigits && <Row label={t('cpf')} value={`${DOTS} ${card.cpfLastDigits}`} />}

            {card.birthDate && (
              <Row label={t('birthDate')} value={formatCalendarDate(card.birthDate)} />
            )}
            {/*
              The gender labels live under `members`, NOT under `vocab` — the
              namespace most enum labels in this product use. Verified:
              messages/en.json holds members.gender_M / _F / _N, and vocab holds
              no gender key at all. `GenderSelect` reads them the same way.
            */}
            {card.gender && <Row label={t('gender')} value={t(`gender_${card.gender}`)} />}
            <Row
              label={t('where')}
              value={[card.neighbourhood, card.city, card.state, card.country]
                .filter(Boolean)
                .join(', ') || '—'}
            />
            <Row label={t('registered')} value={formatDate(card.createdAt)} />
          </dl>
        )}
        {revealError && <p className="mt-3 text-sm text-destructive">{revealError}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/**
 * One masked field and its button.
 *
 * THE THREE STATES ARE KEPT APART, and the third is the one that is easy to
 * lose: `revealed[field]` being `undefined` means nobody has asked, while
 * `null` means somebody asked and there was nothing there -- a listener who
 * exercised erasure between the list read and this click. Folding them together
 * leaves the mask up and the button offered, so a second click spends another
 * audit row to learn the same nothing. attend-dialog.tsx carries this same
 * distinction as `phoneErased`, for the same reason.
 */
function MaskedRow({
  label,
  field,
  masked,
  revealed,
  revealing,
  onReveal,
  showLabel,
  erasedLabel,
}: {
  label: string;
  field: RevealableField;
  masked: string | null;
  revealed: Revealed;
  revealing: boolean;
  onReveal: (field: RevealableField) => void;
  showLabel: string;
  erasedLabel: string;
}) {
  // Nothing on file: the row does not render at all, rather than rendering
  // dots over an absence and offering a button that would reveal nothing.
  if (masked === null) return null;

  const asked = field in revealed;
  const value = revealed[field];

  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2">
        <span data-testid={`listener-card-${field}`}>
          {asked ? (value ?? erasedLabel) : masked}
        </span>
        {!asked && (
          <button
            type="button"
            onClick={() => onReveal(field)}
            disabled={revealing}
            className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`listener-card-reveal-${field}`}
          >
            {showLabel}
          </button>
        )}
      </dd>
    </>
  );
}
