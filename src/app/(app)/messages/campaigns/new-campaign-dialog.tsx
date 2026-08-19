'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import type { ListReach } from '@/services/send-lists';
import type { CampaignTemplateOption } from '@/services/campaigns';
import {
  createCampaignAction,
  getCampaignReachAction,
  listCampaignTemplatesAction,
  testSendCampaignAction,
  type CreateCampaignState,
  type TestSendCampaignState,
} from './actions';

/** One list this caller may build a campaign from -- page.tsx's own subset of `listSendLists`' first page. */
export interface CampaignListOption {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
}

const INITIAL_CREATE: CreateCampaignState = { status: 'idle' };
const INITIAL_TEST_SEND: TestSendCampaignState = { status: 'idle' };

type Channel = 'WHATSAPP' | 'EMAIL';
type Translator = (key: string, values?: Record<string, string>) => string;

type ReachState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; reach: ListReach }
  | { status: 'error'; message: string };

type TemplatesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; templates: CampaignTemplateOption[] }
  | { status: 'error'; message: string };

/**
 * Block 29d-2, Task 7, Step 1-2. The trigger and the dialog it opens --
 * visible to every caller who reached this page at all (messaging.view
 * already gates the page itself, page.tsx's own comment), the same courtesy
 * `CreateSendListDialog`'s own trigger extends. The SEND button inside is
 * gated separately, on messaging.send (Task 7 addendum §5): opening this
 * dialog and drafting a choice is not the act of approving a send.
 *
 * The dialog's own body unmounts entirely on close (`{open && ...}`), the
 * same shape `RenameSendListDialog`/`DeleteSendListDialog` (lists-grid.tsx)
 * use for theirs -- every field, every fetched reach and template list,
 * starts fresh the next time this is opened rather than carrying stale
 * state from a previous list.
 */
export function NewCampaignDialog({
  lists,
  sendableCompanyIds,
}: {
  lists: CampaignListOption[];
  sendableCompanyIds: string[];
}) {
  const t = useTranslations('templates');
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} data-testid="new-campaign-open">
        {t('newCampaignButton')}
      </Button>
      {open && (
        <NewCampaignDialogBody
          lists={lists}
          sendableCompanyIds={new Set(sendableCompanyIds)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function NewCampaignDialogBody({
  lists,
  sendableCompanyIds,
  onClose,
}: {
  lists: CampaignListOption[];
  sendableCompanyIds: Set<string>;
  onClose: () => void;
}) {
  const t = useTranslations('templates');
  const titleId = useId();
  const createFormId = useId();

  const [listId, setListId] = useState('');
  const [channel, setChannel] = useState<Channel>('WHATSAPP');
  const [templateId, setTemplateId] = useState('');

  const [reachState, setReachState] = useState<ReachState>({ status: 'idle' });
  const [templatesState, setTemplatesState] = useState<TemplatesState>({ status: 'idle' });

  const selectedList = lists.find((list) => list.id === listId) ?? null;
  const selectedCompanyId = selectedList?.companyId ?? null;
  const canSend = selectedList ? sendableCompanyIds.has(selectedList.companyId) : false;

  // The reach number this dialog shows, from THE SAME resolver listReach
  // itself uses (Task 7 addendum §2) -- re-fetched whenever the chosen list
  // changes; channel does not trigger a re-fetch because listReach already
  // returns both channels' numbers in one call.
  useEffect(() => {
    if (!listId) {
      setReachState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setReachState({ status: 'loading' });
    getCampaignReachAction(listId).then((result) => {
      if (cancelled) return;
      setReachState(
        result.status === 'ok' ? { status: 'ok', reach: result.reach } : { status: 'error', message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [listId]);

  // The template dropdown, re-fetched whenever the Station (through the
  // chosen list) or the channel changes -- a template is always one
  // Station's and one channel's, never a candidate for either the wrong
  // Station or the wrong channel.
  useEffect(() => {
    setTemplateId('');
    if (!selectedCompanyId) {
      setTemplatesState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setTemplatesState({ status: 'loading' });
    listCampaignTemplatesAction(selectedCompanyId, channel).then((result) => {
      if (cancelled) return;
      setTemplatesState(
        result.status === 'ok'
          ? { status: 'ok', templates: result.templates }
          : { status: 'error', message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId, channel]);

  const [createState, createAction, createPending] = useActionState(createCampaignAction, INITIAL_CREATE);

  useEffect(() => {
    if (createState.status === 'created') onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createState]);

  const channelReach =
    reachState.status === 'ok' ? reachState.reach[channel === 'WHATSAPP' ? 'whatsapp' : 'email'] : null;

  // The SEND button appears only once every one of these is true; anything
  // false already has its own sentence rendered above it in the body
  // (ReachDisplay's zero-reach/forbidden text, or campaignSendNoPermission)
  // -- Task 7 brief's own rule, "say why rather than disabling a button
  // silently", applies to withholding it entirely just as much as it would
  // to a disabled one.
  const canSubmit = canSend && templateId !== '' && typeof channelReach === 'number' && channelReach > 0;

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('newCampaignTitle')}</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <form id={createFormId} action={createAction} className="flex flex-col gap-4">
          <input type="hidden" name="listId" value={listId} />
          <input type="hidden" name="channel" value={channel} />
          <input type="hidden" name="templateId" value={templateId} />

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('campaignListLabel')}</span>
            {lists.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('campaignNoListsAvailable')}</p>
            ) : (
              <Select
                value={listId}
                onChange={(event) => setListId(event.target.value)}
                required
                data-testid="campaign-list-select"
              >
                <option value="">{t('campaignChooseAList')}</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name} — {list.companyName}
                  </option>
                ))}
              </Select>
            )}
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('channelLabel')}</span>
            <Select
              value={channel}
              onChange={(event) => setChannel(event.target.value as Channel)}
              data-testid="campaign-channel-select"
            >
              <option value="WHATSAPP">{t('channelWhatsapp')}</option>
              <option value="EMAIL">{t('channelEmail')}</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('campaignTemplateLabel')}</span>
            {templatesState.status === 'ok' && templatesState.templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('campaignNoTemplatesForChannel')}</p>
            ) : templatesState.status === 'error' ? (
              <p className="text-sm text-destructive">{templatesState.message}</p>
            ) : (
              <Select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                disabled={templatesState.status !== 'ok'}
                required
                data-testid="campaign-template-select"
              >
                <option value="">{t('campaignChooseATemplate')}</option>
                {templatesState.status === 'ok' &&
                  templatesState.templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.internalName}
                    </option>
                  ))}
              </Select>
            )}
          </label>

          <p className="text-sm">
            <span className="text-muted-foreground">{t('campaignReachLabel')}: </span>
            <ReachDisplay reachState={reachState} channel={channel} t={t} />
          </p>
        </form>

        {createState.status === 'error' && <p className="text-sm text-destructive">{createState.message}</p>}

        {selectedList && !canSend && (
          <p className="text-sm text-muted-foreground">{t('campaignSendNoPermission')}</p>
        )}

        <TestSendSection listId={listId} channel={channel} templateId={templateId} t={t} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} key="close">
          {t('cancel')}
        </Button>
        {canSubmit && (
          <Button
            type="submit"
            form={createFormId}
            disabled={createPending}
            key="send"
            data-testid="campaign-send"
          >
            {createPending ? t('campaignSending') : t('campaignSendButton')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/**
 * One channel's reach, or the reason there is no usable number: still
 * loading, a read failure, 'forbidden' (this caller lacks members.view here,
 * the identical state `ChannelReachValue` in lists-grid.tsx renders for the
 * Lists screen's own reach column), or zero -- which gets its OWN sentence,
 * naming the reason rather than the symptom (Task 7 brief's own words),
 * because "0" alone reads as a data problem when the real story is "nobody
 * has consented yet" (WHATSAPP) or "nobody is left to write to" (EMAIL).
 */
function ReachDisplay({ reachState, channel, t }: { reachState: ReachState; channel: Channel; t: Translator }) {
  if (reachState.status === 'idle') return <span className="text-muted-foreground">—</span>;
  if (reachState.status === 'loading') return <span className="text-muted-foreground">{t('reachLoading')}</span>;
  if (reachState.status === 'error') return <span className="text-destructive">{reachState.message}</span>;

  const value = reachState.reach[channel === 'WHATSAPP' ? 'whatsapp' : 'email'];

  if (value === 'forbidden') {
    return (
      <span className="text-muted-foreground" title={t('reachNotPermittedHelp')}>
        {t('reachNotPermitted')}
      </span>
    );
  }
  if (value === 0) {
    return (
      <span className="text-destructive">
        {channel === 'WHATSAPP' ? t('campaignZeroReachWhatsapp') : t('campaignZeroReachEmail')}
      </span>
    );
  }
  return <span>{value.toLocaleString()}</span>;
}

/**
 * Block 29d-2, Task 7, Step 3. The test send: a destination the OPERATOR
 * types and a button of its own, entirely separate from the create form
 * above -- testSendCampaignAction (actions.ts) creates no recipient row, no
 * campaign, no history entry and mints no unsubscribe token
 * (testSendCampaign's own header, services/campaigns.ts, says why for each).
 *
 * Its OWN `<form>`, carrying its OWN hidden copies of listId/channel/templateId:
 * a FormData object belongs to exactly one `<form>` element, so these three
 * values cannot be shared with the create form above them -- the same reason
 * `RenameSendListDialog` and `DeleteSendListDialog` never share one form for
 * two different actions either.
 */
function TestSendSection({
  listId,
  channel,
  templateId,
  t,
}: {
  listId: string;
  channel: Channel;
  templateId: string;
  t: Translator;
}) {
  const formId = useId();
  const [destination, setDestination] = useState('');
  const [state, action, pending] = useActionState(testSendCampaignAction, INITIAL_TEST_SEND);

  const ready = listId !== '' && templateId !== '';

  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      <h3 className="text-sm font-medium">{t('testSendTitle')}</h3>
      <form id={formId} action={action} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <input type="hidden" name="listId" value={listId} />
        <input type="hidden" name="channel" value={channel} />
        <input type="hidden" name="templateId" value={templateId} />
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('testSendDestinationLabel')}</span>
          <Input
            name="destination"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            disabled={!ready}
            data-testid="campaign-test-send-destination"
          />
          <span className="text-xs text-muted-foreground">
            {channel === 'WHATSAPP' ? t('testSendDestinationHelpWhatsapp') : t('testSendDestinationHelpEmail')}
          </span>
        </label>
        <Button
          type="submit"
          variant="outline"
          disabled={!ready || pending || destination.trim() === ''}
          key="test-send"
          data-testid="campaign-test-send-button"
        >
          {pending ? t('testSendSending') : t('testSendButton')}
        </Button>
      </form>
      {state.status === 'sent' && <p className="text-sm text-muted-foreground">{t('testSendSuccess')}</p>}
      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </div>
  );
}
