'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  requestCodeAction,
  verifyCodeAction,
  type RequestCodeState,
  type VerifyState,
} from './actions';

const REQUEST_IDLE: RequestCodeState = { status: 'idle' };
const VERIFY_IDLE: VerifyState = { status: 'idle' };

/**
 * Block 17a. Two steps in one component: a number and a name, then the six
 * digits that arrived by WhatsApp.
 *
 * ONE COMPONENT RATHER THAN TWO ROUTES, because the second step needs what the
 * first one collected. `widget_verify_code` registers an unknown visitor under
 * `p_name` (0161, step 8), so the name has to travel again with the code — and
 * the alternatives were to stash it on the verification row or in a second
 * cookie, both of which would put a visitor's name in this system BEFORE they
 * had proved the telephone number is theirs.
 *
 * The inputs are controlled and the values re-submitted as hidden fields
 * rather than kept on the server between the two POSTs, for the same reason.
 */
export function IdentifyForm({ publicKey }: { publicKey: string }) {
  const t = useTranslations('widget');
  const router = useRouter();

  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false);

  const [requestState, requestCode, requesting] = useActionState(requestCodeAction, REQUEST_IDLE);
  const [verifyState, verifyCode, verifying] = useActionState(verifyCodeAction, VERIFY_IDLE);

  /**
   * The verification result that belongs to a code the visitor has ALREADY
   * MOVED ON FROM, and it exists because `useActionState` has no reset.
   *
   * The sequence that needs it: a wrong code, then "use another number", then a
   * second number, then send. `requestState` becomes `sent` — which is not a
   * refusal, so the request branch says nothing — and `verifyState` is still
   * sitting on `wrong_code` from the abandoned attempt, so "That code is not
   * right." renders on a fresh code screen the visitor has not typed a single
   * digit into. Each state object from `useActionState` is a new reference, so
   * remembering the one that is spent and comparing by identity is enough: the
   * next real submission produces a different object and speaks again.
   */
  const [spentVerify, setSpentVerify] = useState<VerifyState>(VERIFY_IDLE);

  /**
   * Which `requestState` this component has already acted on.
   *
   * Without it the effect below cannot list `verifyState` in its dependencies
   * honestly: it would re-run every time a verification returns, and mark that
   * BRAND NEW refusal as spent — silencing the message it was written to show.
   * Comparing identities first makes the effect fire once per request result,
   * which is what it means.
   */
  const [handledRequest, setHandledRequest] = useState<RequestCodeState>(REQUEST_IDLE);

  useEffect(() => {
    if (requestState === handledRequest) return;
    setHandledRequest(requestState);
    if (requestState.status !== 'sent') return;
    setAwaitingCode(true);
    setSpentVerify(verifyState);
  }, [requestState, handledRequest, verifyState]);

  useEffect(() => {
    // THE SESSION COOKIE IS ALREADY SET when this state arrives — the action
    // wrote it on the response that carried the state back. What is stale is
    // the PAGE, which decided between this form and the menu before the cookie
    // existed. `router.refresh()` re-runs the server component with the cookie
    // the browser now holds; the menu replaces this form and nothing here
    // renders again.
    if (verifyState.status === 'identified') router.refresh();
  }, [verifyState, router]);

  const problem = refusal();

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex flex-col gap-1">
        <h1 className="text-base font-semibold">{t('identifyTitle')}</h1>
        <p className="text-sm text-muted-foreground">
          {awaitingCode ? t('codeSent') : t('identifyIntro')}
        </p>
      </div>

      {awaitingCode ? (
        <form action={verifyCode} className="flex flex-col gap-3" data-testid="widget-code-form">
          <input type="hidden" name="publicKey" value={publicKey} />
          <input type="hidden" name="phone" value={phone} />
          <input type="hidden" name="name" value={name} />

          <label className="flex flex-col gap-1 text-sm" htmlFor="widget-code">
            {t('codeLabel')}
            <Input
              id="widget-code"
              name="code"
              // `inputMode` numeric rather than `type="number"`: a number input
              // strips a leading zero in several browsers, and one code in ten
              // starts with one (src/lib/widget/code.ts pads for exactly that
              // reason). `autoComplete="one-time-code"` is what lets a phone
              // offer the code it just received.
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              autoFocus
            />
          </label>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={verifying}>
              {verifying ? t('confirming') : t('confirm')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              // The code being abandoned takes its verdict with it — see
              // `spentVerify` above for the sequence this closes.
              onClick={() => {
                setSpentVerify(verifyState);
                setAwaitingCode(false);
              }}
              disabled={verifying}
            >
              {t('useAnotherNumber')}
            </Button>
          </div>
        </form>
      ) : (
        <form action={requestCode} className="flex flex-col gap-3" data-testid="widget-identify-form">
          <input type="hidden" name="publicKey" value={publicKey} />

          <label className="flex flex-col gap-1 text-sm" htmlFor="widget-phone">
            {t('phoneLabel')}
            <Input
              id="widget-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          </label>

          <label className="flex flex-col gap-1 text-sm" htmlFor="widget-name">
            {t('nameLabel')}
            <Input
              id="widget-name"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>

          <Button type="submit" disabled={requesting}>
            {requesting ? t('sending') : t('sendCode')}
          </Button>
        </form>
      )}

      {problem && (
        // `role="alert"` so a screen reader announces a refusal that appears
        // without the page navigating anywhere.
        <p className="text-sm text-destructive" role="alert" data-testid="widget-problem">
          {problem}
        </p>
      )}
    </div>
  );

  /**
   * One sentence per named refusal, EVERY BRANCH A LITERAL KEY.
   *
   * Not a template literal keyed on the reason, which would be shorter and is
   * exactly the shape tests/unit/i18n/usage.test.ts cannot see: it matches
   * single-quoted literal keys only, so a key composed at runtime is checked by
   * nothing, and next-intl renders the key itself when a message is missing.
   * Earlier in this very block a key referenced in code and absent from all
   * three catalogues passed typecheck, lint and 1586 database assertions and
   * broke a real screen.
   *
   * (That same test reads COMMENTS as well as code — it scans the file's text,
   * not its AST, for the call shape — so an example of the call written out in
   * a sentence here would be reported as a missing key. This paragraph is
   * deliberately written without one.)
   *
   * EACH BRANCH IS GATED ON THE STEP THE VISITOR IS ACTUALLY ON, and that gate
   * is structural rather than sequential: whatever order the two states arrive
   * in, the screen showing a telephone box can only ever explain a telephone
   * box, and the screen showing six digits can only ever explain six digits.
   * `spentVerify` above handles the remaining case, where the message is about
   * the RIGHT step but the wrong attempt.
   */
  function refusal(): string | null {
    if (awaitingCode) return codeRefusal();
    return identifyRefusal();
  }

  function identifyRefusal(): string | null {
    if (requestState.status === 'refused') {
      switch (requestState.reason) {
        case 'invalid':
          return t('checkWhatYouTyped');
        case 'rate_limited':
          return t('tooManyRequests');
        case 'unavailable':
          return t('temporarilyUnavailable');
        case 'unknown_installation':
          return t('widgetUnavailable');
        // Both are the operator's to fix and neither is anything a listener can
        // act on differently, so they share a sentence rather than inventing a
        // distinction that changes nobody's next step.
        case 'no_integration':
        case 'no_template':
          return t('stationCannotSendCodes');
        case 'failed':
          return t('somethingWentWrong');
      }
    }

    return null;
  }

  function codeRefusal(): string | null {
    // The verdict on a code the visitor has already abandoned says nothing
    // about the one on screen.
    if (verifyState === spentVerify) return null;

    if (verifyState.status === 'refused') {
      switch (verifyState.reason) {
        case 'invalid':
          return t('codeIsSixDigits');
        case 'rate_limited':
          return t('tooManyRequests');
        case 'unavailable':
          return t('temporarilyUnavailable');
        case 'unknown_installation':
          return t('widgetUnavailable');
        // ONE SENTENCE FOR BOTH, AND THE DIFFERENCE IS DELIBERATELY NOT SHOWN.
        // `no_pending_code` means no code was ever asked for on this number at
        // this Station; `expired` means one was and its ten minutes ran out.
        // Told apart, they answer "does this telephone number have a live code
        // here right now?" for anybody who cares to ask — an oracle a visitor
        // never needs, since the advice is identical: ask for a new code.
        //
        // NOT FOLDED FURTHER, and that is the deliberate half of the trade.
        // `expired` and `too_many_attempts` keep their own sentences even
        // though collapsing them into `wrong_code` would close the oracle
        // completely, because a typo is the overwhelmingly common case and the
        // three pieces of advice genuinely differ: somebody who waited eleven
        // minutes has to be told to ask for a new code, and somebody who burned
        // five attempts has to be told that retrying is pointless. Closing it
        // completely would cost every real visitor an actionable message in
        // order to deny an attacker a signal they can only use if they ALREADY
        // KNOW the telephone number. What is left after this — that a live code
        // exists for a number the attacker already holds — is a thinner signal,
        // and it is an accepted trade rather than an oversight.
        case 'no_pending_code':
        case 'expired':
          return t('codeExpired');
        case 'too_many_attempts':
          return t('tooManyWrongCodes');
        case 'wrong_code':
          return t('wrongCode');
        case 'name_required':
          return t('nameRequired');
        // 0034's erasure. The listener asked to be forgotten, and this is the
        // one refusal that is permanent: the door never recreates them, so a
        // sentence that invites a retry would be a lie.
        case 'listener_anonymized':
          return t('numberCannotBeUsed');
        case 'failed':
          return t('somethingWentWrong');
      }
    }

    return null;
  }
}
