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
 * Brazil, prefilled — every Station on this platform broadcasts from it.
 *
 * A DEFAULT, NOT A RULE, and the distinction is the whole design: the box is
 * editable, nothing refuses a value that is not this one, and a listener abroad
 * types theirs. Deriving it from the visitor's locale was the rejected
 * alternative — a Brazilian listening from an airport lounge has a foreign
 * locale and a Brazilian telephone, and that guess is wrong precisely when it
 * is least visible.
 */
const DEFAULT_COUNTRY_CODE = '55';

/**
 * The two boxes as one E.164 number: `+55` and `11985954985` become
 * `+5511985954985`.
 *
 * Every non-digit is dropped from both halves, so a visitor who types
 * `(11) 98595-4985`, or `+55` into the country box, produces the same string as
 * one who types bare digits. THE LEADING `+` IS THIS FUNCTION'S OWN and is the
 * only punctuation that survives: it is what makes the value unambiguous to
 * read in the queue, in an audit row, and in Meta's own console, and
 * `normalize_phone` (0031) strips it again for the column that decides identity.
 */
function composePhone(countryCode: string, localPhone: string): string {
  const digits = `${countryCode.replace(/\D/g, '')}${localPhone.replace(/\D/g, '')}`;
  // No digits at all is the empty string rather than a bare '+': the field is
  // `required`, so this is what the box holds before it is filled, and a lone
  // '+' would be five characters short of the schema's minimum anyway — a
  // refusal phrased as "check what you typed" for a box the visitor has not
  // typed in yet.
  return digits === '' ? '' : `+${digits}`;
}

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

  const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY_CODE);
  const [localPhone, setLocalPhone] = useState('');
  const [name, setName] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false);

  /**
   * What actually travels — and the reason this screen has two boxes instead of
   * one.
   *
   * Until 2026-08-11 the visitor typed a single number and it went to Meta
   * exactly as typed: `11985954985`, no country code, because nobody in São
   * Paulo writes one and nothing between this box and the Cloud API added it.
   * `schemas/widget.ts` says in writing that it does not validate a telephone
   * number and gives good reasons, and `normalize_phone` (0031) keeps only the
   * digits — so no layer was lying, none of them was ever asked to supply the
   * missing half, and the send left for a number that identifies a different
   * subscriber in every country on earth.
   *
   * Composed here rather than repaired on the server BECAUSE THE VISITOR CAN
   * SEE IT. A server-side rule guessing "eleven digits, must be Brazil" would be
   * right almost always and silently wrong for the listener it is not right
   * for; this way the country code is on screen, wrong for nobody by default,
   * and editable by anyone it is wrong for.
   */
  const phone = composePhone(countryCode, localPhone);

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

      {/*
        THE TWO KEYS ARE LOAD-BEARING, and their absence was a real defect: a
        visitor who asked for a code found their own NAME already typed into the
        six-digit box.

        Both forms occupy the same slot of this ternary, so React reconciles
        them against each other child by child rather than unmounting one and
        mounting the other. When the label wrapping the name input and the label
        wrapping the code input come out at the same index — which they did the
        moment the identify form grew its hidden `phone` field — React sees
        `<label>` against `<label>` and REUSES the DOM node underneath. The name
        input is controlled and the code input is not, so React had no value to
        write and the browser kept the one already in the element.

        Distinct keys say these are different elements, not one element with
        different props, which is exactly what they are. Fixing it by shuffling
        the children back into a non-colliding order would work today and break
        again on the next field anybody adds, silently, in the same way.
      */}
      {awaitingCode ? (
        <form
          key="code"
          action={verifyCode}
          className="flex flex-col gap-3"
          data-testid="widget-code-form"
        >
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
        <form
          key="identify"
          action={requestCode}
          className="flex flex-col gap-3"
          data-testid="widget-identify-form"
        >
          <input type="hidden" name="publicKey" value={publicKey} />

          {/*
            The composed value is what the action reads; the two visible boxes
            are how the visitor arrives at it. A hidden field rather than a
            `name` on either box, because neither half is a telephone number on
            its own and the server has no business reassembling one.
          */}
          <input type="hidden" name="phone" value={phone} />

          <div className="flex gap-2">
            <label className="flex w-24 shrink-0 flex-col gap-1 text-sm" htmlFor="widget-country-code">
              {t('countryCodeLabel')}
              <Input
                id="widget-country-code"
                type="tel"
                inputMode="tel"
                // Not `autoComplete="tel-country-code"`: browsers fill that from
                // a saved profile, which would quietly overwrite the default
                // with a country the visitor has since left.
                autoComplete="off"
                maxLength={4}
                value={countryCode}
                onChange={(event) => setCountryCode(event.target.value)}
                required
                data-testid="widget-country-code"
              />
            </label>

            <label className="flex flex-1 flex-col gap-1 text-sm" htmlFor="widget-phone">
              {t('phoneLabel')}
              <Input
                id="widget-phone"
                type="tel"
                inputMode="tel"
                // `tel-national` rather than `tel`: the saved value for `tel` is
                // the full international number in most browsers, which would
                // land the country code in this box a second time.
                autoComplete="tel-national"
                value={localPhone}
                onChange={(event) => setLocalPhone(event.target.value)}
                required
              />
            </label>
          </div>

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

          {/*
            The composed number, shown back. Cheap, and it is the difference
            between a visitor who can SEE that the country code is included and
            one who finds out by not receiving anything.
          */}
          {localPhone.trim() !== '' && (
            <p className="text-xs text-muted-foreground" data-testid="widget-phone-preview">
              {t('weWillSendTo')} <span className="font-mono">{phone}</span>
            </p>
          )}

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
