'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { CAMPAIGN_VARIABLES, namedPlaceholder } from '@/lib/templates/variables';
import type { TemplateVariable } from '@/lib/templates/variables';
import { countPlaceholders } from '@/schemas/templates';
import type { RegisteredTemplate } from '@/services/templates';
import {
  previewCampaignEmailAction,
  saveMarketingTemplateAction,
  type PreviewCampaignEmailState,
  type SaveMarketingTemplateState,
} from './actions';

const INITIAL_SAVE: SaveMarketingTemplateState = { status: 'idle' };

/**
 * One marketing template's whole record, over the grid — created here or
 * edited here, one component for both the same way RoleRecordDialog and
 * SongRecordDialog already split "create" from "edit" only by whether
 * `existing` is null.
 *
 * ALWAYS A FRESH MOUNT: MarketingGrid renders this component only while
 * something is actually being edited or created (`{editing !== null && (...)}`
 * — see its own header), never keeping one instance around with `open`
 * toggling. That is what lets every field below use `useState(existing?.… )`
 * as its initializer safely: a different row opened for editing is a new
 * component instance, not a prop change under an old one, so there is no
 * stale `channel`/`body`/override state to reset by hand.
 *
 * Channel is asked FIRST because every field below depends on the answer
 * (Task 9 brief). Switching it after some fields are filled is allowed —
 * `save_marketing_template` (0225) itself accepts a channel change on an
 * edit — and is cheap to allow: the fields exclusive to the OTHER channel
 * simply unmount, and the two the door writes unconditionally regardless of
 * channel (`from_name`, `from_email`, `reply_to`) never live inside that
 * unmounted subtree — see the sender-override block below for why.
 */
export function TemplateDialog({
  companyId,
  existing,
  onClose,
}: {
  companyId: string;
  existing: RegisteredTemplate | null;
  onClose: () => void;
}) {
  const t = useTranslations('templates');
  const titleId = useId();
  const formId = useId();
  const [state, action, pending] = useActionState(saveMarketingTemplateAction, INITIAL_SAVE);
  const [dirty, setDirty] = useState(false);
  const [channel, setChannel] = useState<'WHATSAPP' | 'EMAIL'>(existing?.channel ?? 'EMAIL');
  const [body, setBody] = useState(existing?.body ?? '');
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  // Open whenever an existing row already carries an override, so an
  // operator editing one sees it without a click — never derived from
  // `overrideOpen` on every render, only read once at mount (this component
  // never keeps one instance across two different `existing` values; see the
  // header above), which is exactly what a plain `useState` initializer gives.
  const [overrideOpen, setOverrideOpen] = useState(
    Boolean(existing?.fromName || existing?.fromEmail || existing?.replyTo),
  );
  const [preview, setPreview] = useState<
    { status: 'idle' } | { status: 'loading' } | PreviewCampaignEmailState
  >({ status: 'idle' });

  useEffect(() => {
    if (state.status === 'saved') {
      setDirty(false);
      onClose();
    }
    // onClose is stable for this dialog's lifetime (MarketingGrid passes a
    // fresh closure each render, but this effect only cares that a save
    // landed) — including it would re-run this on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function requestClose() {
    if (dirty && !window.confirm(t('discardUnsavedChanges'))) return;
    onClose();
  }

  const placeholders = channel === 'WHATSAPP' ? countPlaceholders(body) : 0;

  /**
   * Inserts a named placeholder at the cursor, or at the end when the
   * textarea has never been focused — the palette's whole job, and the
   * reason `body` is controlled state rather than an uncontrolled Textarea:
   * the cross-field rule marketingTemplateSchema enforces on submit (every
   * `{{name}}` must be one of CAMPAIGN_VARIABLES) cannot be violated by a
   * click here, because every button on this palette inserts exactly one.
   */
  function insertPlaceholder(value: TemplateVariable) {
    const token = namedPlaceholder(value);
    const el = bodyRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    setDirty(true);
    setPreview({ status: 'idle' });
    // Cursor restored after the DOM has the new value, not before — setting
    // selectionRange synchronously here would place it against the textarea's
    // OLD value and React would then overwrite the field on the next paint.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function runPreview() {
    setPreview({ status: 'loading' });
    const result = await previewCampaignEmailAction(companyId, body);
    setPreview(result);
  }

  return (
    <Dialog open onClose={requestClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>
          {existing ? existing.internalName : t('newMarketingTemplate')}
        </DialogTitle>
      </DialogHeader>

      <DialogBody>
        <form
          id={formId}
          action={action}
          onChange={() => setDirty(true)}
          data-testid="marketing-template-form"
          className="flex flex-col gap-4"
        >
          <input type="hidden" name="companyId" value={companyId} />
          {existing && <input type="hidden" name="templateId" value={existing.id} />}

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('channelLabel')}</span>
            <Select
              name="channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value as 'WHATSAPP' | 'EMAIL')}
              className="h-9 w-48"
              data-testid="marketing-template-channel"
            >
              <option value="EMAIL">{t('channelEmail')}</option>
              <option value="WHATSAPP">{t('channelWhatsapp')}</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('internalNameLabel')}</span>
            <Input
              name="internalName"
              defaultValue={existing?.internalName ?? ''}
              required
              maxLength={120}
              data-testid="marketing-template-internal-name"
            />
            <span className="text-xs text-muted-foreground">{t('internalNameHelp')}</span>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('descriptionLabel')}</span>
            <Textarea
              name="description"
              defaultValue={existing?.description ?? ''}
              maxLength={500}
              rows={2}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('bodyLabel')}</span>
            <Textarea
              ref={bodyRef}
              name="body"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setPreview({ status: 'idle' });
              }}
              required
              maxLength={4096}
              rows={6}
              className="font-mono"
              data-testid="marketing-template-body"
            />
          </label>

          {/*
            EMAIL. `hidden`, not unmounted, for subject and the sender
            override — the shape role-record-dialog.tsx's own tabs use, and
            for the same two reasons: a `required` field inside a `hidden`
            ancestor is exempt from constraint validation (so `subject`
            staying `required` costs nothing while WhatsApp is chosen), and
            every field the door writes UNCONDITIONALLY regardless of channel
            (`from_name`, `from_email`, `reply_to` — save_marketing_template's
            own INSERT/UPDATE never guards these on `p_channel`) must stay in
            the DOM the whole time or a channel toggle mid-edit would submit
            them blank and silently clear a Station's own override.
          */}
          <div hidden={channel !== 'EMAIL'} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('subjectLabel')}</span>
              <Input
                name="subject"
                defaultValue={existing?.subject ?? ''}
                required={channel === 'EMAIL'}
                maxLength={200}
                data-testid="marketing-template-subject"
              />
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-sm text-muted-foreground">{t('insertVariableLabel')}</span>
              <div className="flex flex-wrap gap-2">
                {CAMPAIGN_VARIABLES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => insertPlaceholder(value)}
                    title={namedPlaceholder(value)}
                    className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  >
                    {t(`variable_${value}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-dashed p-3">
              <button
                type="button"
                onClick={() => setOverrideOpen((v) => !v)}
                className="text-sm font-medium underline-offset-2 hover:underline"
                data-testid="marketing-template-override-toggle"
              >
                {t('overrideStationSender')}
              </button>
              <div hidden={!overrideOpen} className="mt-2 flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">{t('overrideStationSenderHelp')}</p>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t('senderNameLabel')}</span>
                  <Input name="fromName" defaultValue={existing?.fromName ?? ''} maxLength={120} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t('senderAddressLabel')}</span>
                  <Input
                    name="fromEmail"
                    type="email"
                    defaultValue={existing?.fromEmail ?? ''}
                    maxLength={200}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t('senderReplyToLabel')}</span>
                  <Input
                    name="replyTo"
                    type="email"
                    defaultValue={existing?.replyTo ?? ''}
                    maxLength={200}
                  />
                </label>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={runPreview}
                  disabled={preview.status === 'loading' || body.trim() === ''}
                  data-testid="marketing-template-preview-button"
                >
                  {preview.status === 'loading' ? t('buildingPreview') : t('previewButton')}
                </Button>
              </div>
              {preview.status === 'error' && (
                <p className="text-sm text-destructive">{preview.message}</p>
              )}
              {preview.status === 'ok' && (
                <iframe
                  sandbox=""
                  srcDoc={preview.html}
                  title={t('previewFrameTitle')}
                  data-testid="marketing-template-preview-frame"
                  className="h-96 w-full rounded-md border bg-white"
                />
              )}
            </div>
          </div>

          {/*
            WHATSAPP. In 29b-1 this is still a TRANSCRIPTION of something Meta
            approved in its own console, the same act the system half performs
            — the notice that used to sit at the top of page.tsx moved here
            with the reason: an e-mail template is written on this screen, a
            WhatsApp one is copied onto it, and a notice on the page body could
            not say which one an operator was about to fill in.
          */}
          <div hidden={channel !== 'WHATSAPP'} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 rounded-md border border-dashed p-3">
              <p className="text-sm">
                {t('templatesAreCreatedAndApprovedIn')}{' '}
                <strong>{t('metaSOwnConsole')}</strong>, {t('notHereApprovalNotice')}
              </p>
              <p className="text-xs text-muted-foreground">{t('aRevokedOrEditedApprovalIs')}</p>
            </div>

            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">{t('nameAtMeta')}</span>
                <Input
                  name="name"
                  defaultValue={existing?.name ?? ''}
                  required={channel === 'WHATSAPP'}
                  maxLength={512}
                  className="w-72 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">{t('language')}</span>
                <Input
                  name="language"
                  defaultValue={existing?.language ?? ''}
                  required={channel === 'WHATSAPP'}
                  maxLength={20}
                  className="w-40 font-mono"
                  placeholder={t('ptBr')}
                />
              </label>
            </div>

            {channel === 'WHATSAPP' && placeholders > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-sm text-muted-foreground">{t('whatEachPositionMeans')}</span>
                {Array.from({ length: placeholders }, (_, index) => (
                  <label key={index} className="flex items-center gap-2 text-sm">
                    <code className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                      {`{{${index + 1}}}`}
                    </code>
                    <Select
                      name="variables"
                      defaultValue={existing?.variables[index] ?? ''}
                      required
                      className="h-9 max-w-md"
                      aria-label={`What {{${index + 1}}} means`}
                    >
                      <option value="" disabled>
                        {t('chooseWhatThisPositionCarries')}
                      </option>
                      {CAMPAIGN_VARIABLES.map((value) => (
                        <option key={value} value={value}>
                          {t(`variable_${value}`)}
                        </option>
                      ))}
                    </Select>
                  </label>
                ))}
              </div>
            )}
          </div>
        </form>
      </DialogBody>

      <DialogFooter>
        {state.status === 'error' && (
          <span className="mr-auto text-sm text-destructive">{state.message}</span>
        )}
        <Button type="button" variant="outline" onClick={requestClose} key="cancel">
          {t('cancel')}
        </Button>
        <Button type="submit" form={formId} disabled={pending} key="submit" data-testid="marketing-template-save">
          {pending ? t('saving') : existing ? t('saveTemplateChanges') : t('createTemplate')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
