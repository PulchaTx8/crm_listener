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

  useEffect(() => {
    if (requestState.status === 'sent') setAwaitingCode(true);
  }, [requestState]);

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
              onClick={() => setAwaitingCode(false)}
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
   */
  function refusal(): string | null {
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
        case 'no_pending_code':
          return t('askForACodeFirst');
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
