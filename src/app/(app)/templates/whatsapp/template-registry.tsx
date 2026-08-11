'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { countPlaceholders, TEMPLATE_PURPOSES } from '@/schemas/templates';
import type { TemplatePurpose } from '@/schemas/templates';
import type { RegisteredTemplate } from '@/services/templates';
import { formatInstant } from '../../promotions/format';
import {
  archiveTemplateAction,
  registerTemplateAction,
  type ArchiveTemplateState,
  type RegisterTemplateState,
} from './actions';

const INITIAL_REGISTER: RegisterTemplateState = { status: 'idle' };
const INITIAL_ARCHIVE: ArchiveTemplateState = { status: 'idle' };

/**
 * What each purpose is, and — the part that matters — what this system puts in
 * each position when it sends one.
 *
 * `sends` is a CONTRACT, not a suggestion. `enqueue_pickup_reminder` (0112)
 * builds `jsonb_build_array(first_name, prize_name, deadline)` in exactly this
 * order, and `enqueue_whatsapp_outbound` (0111) substitutes them positionally
 * into whatever body was registered here. An approved body that means something
 * else by `{{2}}` will send a prize name where a date belongs, and nothing in
 * this stack can detect that — the count agrees, so every check passes and the
 * listener reads nonsense. Printing the contract beside the form is the only
 * place that mismatch can be caught, which is why it is on the screen and not
 * only in the runbook.
 *
 * TOTAL over `TemplatePurpose`, so a second purpose added to 0110 fails to
 * compile here rather than rendering as a bare enum value with no contract.
 * That sentence was FALSE between 0160 and Block 17a's fix wave, because
 * `TemplatePurpose` was derived from a hand-written array rather than from the
 * generated enum — see the type's own comment in `@/schemas/templates` for what
 * that cost. It is true now, and the record below is what it buys.
 *
 * `nameExample` is the placeholder in the "Name at Meta" field and is a Meta
 * template NAME, not prose: it is per-purpose because one example for two
 * purposes is an example that is wrong for one of them, and it stays identical
 * in all three locales for the same reason `ptBr` does — it is an identifier a
 * Station types into Meta's console, not a sentence.
 */
function purposeDetails(
  t: (key: string) => string,
): Record<
  TemplatePurpose,
  { title: string; when: string; nameExample: string; sends: string[] }
> {
  return {
    PICKUP_REMINDER: {
      title: t('purposePickupReminderTitle'),
      when: t('purposePickupReminderWhen'),
      nameExample: t('pickupReminder'),
      sends: [
        t('purposePickupReminderSendsFirstName'),
        t('purposePickupReminderSendsPrize'),
        t('purposePickupReminderSendsDeadline'),
      ],
    },
    // Block 17a. ONE variable, and 0161's widget_request_code is what makes
    // that a contract rather than a description: it calls
    // enqueue_whatsapp_outbound with `jsonb_build_array(p_code_plain)` and
    // nothing else, and 0111 refuses a body whose placeholder count disagrees.
    // A body approved with two placeholders registers here and then fails at
    // every send, in a server log, for as long as the registration stands.
    WEB_VERIFICATION: {
      title: t('purposeWebVerificationTitle'),
      when: t('purposeWebVerificationWhen'),
      nameExample: t('webVerification'),
      sends: [t('purposeWebVerificationSendsCode')],
    },
  };
}

/**
 * One card per purpose this system can send, registered or not.
 *
 * A card per PURPOSE rather than a row per registered template, for the same
 * reason the Messages screen renders ten rows rather than the overrides it
 * found: 0110 allows one live registration per (Station, purpose), so a purpose
 * with nothing registered is a real, expected state that has to be visible and
 * actionable. Listing only what came back would show a Station that has
 * registered nothing an empty page and no way to learn what it is missing.
 */
export function TemplateRegistry({
  templates,
  companyId,
  timeZone,
  manage,
}: {
  templates: RegisteredTemplate[];
  companyId: string;
  /** The Station's own zone — `updatedAt` renders there, never the reader's (spec L2). */
  timeZone: string;
  /** Whether the caller holds templates.manage at this Station. */
  manage: boolean;
}) {
  return (
    <ul className="flex flex-col gap-4" data-testid="template-registry">
      {TEMPLATE_PURPOSES.map((purpose) => (
        <li key={purpose}>
          <PurposeCard
            purpose={purpose}
            // `find` rather than a map built once: TEMPLATE_PURPOSES has two
            // entries today and the registry one live row per purpose, so this
            // is a scan of at most a handful either way.
            existing={templates.find((t) => t.purpose === purpose) ?? null}
            companyId={companyId}
            timeZone={timeZone}
            manage={manage}
          />
        </li>
      ))}
    </ul>
  );
}

function PurposeCard({
  purpose,
  existing,
  companyId,
  timeZone,
  manage,
}: {
  purpose: TemplatePurpose;
  existing: RegisteredTemplate | null;
  companyId: string;
  timeZone: string;
  manage: boolean;
}) {
  const t = useTranslations('templates');
  const detail = purposeDetails(t)[purpose];
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4" data-testid={`purpose-${purpose}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">{detail.title}</h2>
          <p className="text-xs text-muted-foreground">{detail.when}</p>
        </div>
        {existing ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {t('registered')}</span>
        ) : (
          <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {t('notRegisteredNothingSends')}</span>
        )}
      </div>

      <div className="flex flex-col gap-1 rounded-md border border-dashed p-3">
        <span className="text-xs font-medium">{t('whatThisSystemPutsInEach')}</span>
        <ol className="flex flex-col gap-0.5">
          {detail.sends.map((value, index) => (
            <li key={value} className="text-xs text-muted-foreground">
              <code className="font-mono text-foreground">{`{{${index + 1}}}`}</code> — {value}
            </li>
          ))}
        </ol>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('theBodyYouHadApprovedMust')}{' '}{detail.sends.length} {t('placeholdersInThisOrder')}</p>
      </div>

      {existing && (
        <RegisteredDetails template={existing} timeZone={timeZone} />
      )}

      {manage && (
        <RegistrationForm
          // Remounts only once a save has LANDED and the fresh row has been
          // re-read (updated_at moves on every upsert). A failed save leaves
          // the database untouched, so this key does not change and the
          // operator's transcription stays on screen beside the error.
          key={existing ? `${existing.id}:${existing.updatedAt}` : 'unregistered'}
          purpose={purpose}
          companyId={companyId}
          existing={existing}
          expected={detail.sends.length}
          nameExample={detail.nameExample}
        />
      )}

      {manage && existing && (
        <div>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setConfirmingArchive(true)}
          >
            {t('removeThisRegistration')}</Button>
        </div>
      )}

      {confirmingArchive && existing && (
        <ArchiveTemplateDialog
          template={existing}
          title={detail.title}
          onClose={() => setConfirmingArchive(false)}
        />
      )}
    </div>
  );
}

/**
 * What was transcribed, laid out so it can be read against the approval in
 * Meta's console side by side — the whole job of this screen (D4: this system
 * records, it does not submit).
 */
function RegisteredDetails({
  template,
  timeZone,
}: {
  template: RegisteredTemplate;
  timeZone: string;
}) {
  const t = useTranslations('templates');
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{t('nameAtMeta')}</dt>
          <dd className="font-mono">{template.name}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{t('language')}</dt>
          <dd className="font-mono">{template.language}</dd>
        </div>
        {/*
          Shown either way, never only when true: "this registration says it has
          no OTP button" is exactly the fact an operator needs in front of them
          when codes are not arriving, and a row that simply omits the line
          reads as a screen that does not know about buttons at all.
        */}
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{t('otpButtonRecorded')}</dt>
          <dd>{template.otpButton ? t('otpButtonYes') : t('otpButtonNo')}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{t('lastRecorded')}</dt>
          <dd>{formatInstant(template.updatedAt, timeZone)}</dd>
        </div>
      </dl>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t('approvedBody')}</span>
        {/*
          Placeholders left exactly as written, in a monospace block: `{{2}}`
          rendered as prose is the one detail a reader has to be able to count.
        */}
        <p className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs">
          {template.body}
        </p>
      </div>

      {template.variables.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t('whatEachPositionMeans')}</span>
          <ol className="flex flex-col gap-0.5">
            {template.variables.map((description, index) => (
              <li key={`${index}-${description}`} className="text-xs">
                <code className="font-mono text-muted-foreground">{`{{${index + 1}}}`}</code>{' '}
                {description}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/**
 * Registers a purpose, or replaces what is registered for it — one form for
 * both, because `register_message_template` (0113) is one upsert for both.
 *
 * The body is controlled state rather than an uncontrolled input, and that is
 * the one thing this component needs state for: the number of description
 * fields is derived from the body's own highest `{{n}}` as it is typed, so the
 * cross-field rule schemas/templates.ts enforces on submit cannot be violated
 * by the form in the first place. An operator who pastes a two-placeholder body
 * sees two boxes, not a rejection.
 */
function RegistrationForm({
  purpose,
  companyId,
  existing,
  expected,
  nameExample,
}: {
  purpose: TemplatePurpose;
  companyId: string;
  existing: RegisteredTemplate | null;
  /** How many placeholders this purpose's contract will actually fill. */
  expected: number;
  /** A plausible Meta template name FOR THIS PURPOSE, shown as the placeholder. */
  nameExample: string;
}) {
  const t = useTranslations('templates');
  const [state, action, pending] = useActionState(registerTemplateAction, INITIAL_REGISTER);
  const [body, setBody] = useState(existing?.body ?? '');
  const placeholders = countPlaceholders(body);

  return (
    <form action={action} className="flex flex-col gap-3 border-t pt-4">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="purpose" value={purpose} />

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('nameAtMeta')}</span>
          <Input
            name="name"
            defaultValue={existing?.name ?? ''}
            required
            maxLength={512}
            className="h-9 w-72 font-mono"
            placeholder={nameExample}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('language')}</span>
          <Input
            name="language"
            defaultValue={existing?.language ?? ''}
            required
            maxLength={32}
            className="h-9 w-40 font-mono"
            placeholder={t('ptBr')}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">
          {t('approvedBodyCopiedFromMetaExactly')}</span>
        <Textarea
          name="body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          required
          maxLength={4096}
          rows={4}
          className="font-mono"
          data-testid={`template-body-${purpose}`}
        />
      </label>

      {/*
        THE QUESTION THAT WAS NEVER ASKED, until a day of production silence
        asked it. Meta's Authentication category carries an OTP button on every
        template created since May 2023, and a send that does not name that
        button is refused whole — `(#131008) Required parameter is missing`,
        which reaches nobody but the queue. It is transcribed here beside the
        name and the language for the reason D4 gives for those: the answer is a
        fact about Meta's records, and this system records rather than guesses.
      */}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="otpButton"
          defaultChecked={existing?.otpButton ?? false}
          className="mt-0.5 h-4 w-4 shrink-0"
          data-testid={`template-otp-button-${purpose}`}
        />
        <span className="flex flex-col gap-0.5">
          <span>{t('otpButtonLabel')}</span>
          <span className="text-xs text-muted-foreground">{t('otpButtonHelp')}</span>
        </span>
      </label>

      {/*
        Not a refusal, and deliberately not one: a count that disagrees with the
        contract is refused by nothing in this stack — 0111 compares the
        variables SENT against the body's own placeholders, and the sweep always
        sends this purpose's full set, so a short body fails at enqueue with a
        22023 that lands in a server log, hourly, for as long as the wrong
        registration stands. The operator is the only reader who can catch it,
        and this is the moment they are looking.
      */}
      {body.trim() !== '' && placeholders !== expected && (
        <p className="text-sm text-destructive" data-testid={`template-contract-warning-${purpose}`}>
          {t('thisBodyUses')}{' '}{placeholders} {t('placeholderSButThisSystemAlways')}{' '}{expected}.
          Registered as it stands, no message for this purpose will ever go out. Check the body
          against the approval before saving.
        </p>
      )}

      {placeholders > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-muted-foreground">{t('whatEachPositionMeans')}</span>
          {Array.from({ length: placeholders }, (_, index) => (
            <label key={index} className="flex items-center gap-2 text-sm">
              <code className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                {`{{${index + 1}}}`}
              </code>
              <Input
                name="variables"
                defaultValue={existing?.variables[index] ?? ''}
                required
                maxLength={200}
                className="h-9 max-w-md"
                aria-label={`What {{${index + 1}}} means`}
              />
            </label>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t('saving') : existing ? t('replaceWhatIsRecorded') : t('recordThisTemplate')}
        </Button>
        {state.status === 'error' && (
          <span className="text-sm text-destructive">{state.message}</span>
        )}
      </div>
    </form>
  );
}

/**
 * The removal confirmation, on the shape ArchiveReferenceDialog
 * (music/catalog/reference-panel.tsx) established: a styled `<Dialog>` with a
 * stable `data-testid`, never `window.confirm`.
 *
 * The wording is deliberately not "this cannot be undone": unlike an archived
 * catalogue record, this one CAN be put back by transcribing the same approval
 * again, because Meta holds the original and this table only ever held a copy.
 * What is actually lost is the sending — which is the consequence worth saying.
 */
function ArchiveTemplateDialog({
  template,
  title,
  onClose,
}: {
  template: RegisteredTemplate;
  title: string;
  onClose: () => void;
}) {
  const t = useTranslations('templates');
  const titleId = useId();
  const [state, action, pending] = useActionState(archiveTemplateAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('removeThisRegistration2')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {t('thisStationStopsSending')}{' '}<strong>{title}</strong> {t('messagesEntirelySilentlyBecauseAStation')}</p>
        <p className="mt-3 text-sm text-muted-foreground">
          {t('messagesAlreadySentKeepTheirOwn')}{' '}<span className="font-mono">{template.name}</span>, so recording it again is
          a matter of transcribing it — no new approval is needed.
        </p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('cancel')}</Button>
        <form action={action}>
          <input type="hidden" name="templateId" value={template.id} />
          <Button type="submit" disabled={pending} data-testid="template-archive-confirm">
            {pending ? t('removing') : t('removeAnyway')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}
