'use client';

import type { FormEvent } from 'react';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import {
  createSendListAction,
  resolveSendListPreviewAction,
} from '@/app/(app)/messages/lists/actions';
import type {
  MemberSendListFilters,
  ParticipationSendListFilters,
  RequestSendListFilters,
  SendListSource,
} from '@/schemas/send-lists';

type SendListFilters = MemberSendListFilters | ParticipationSendListFilters | RequestSendListFilters;

type ResolveState =
  | { status: 'loading' }
  | { status: 'ok'; ids: string[] }
  | { status: 'capped'; message: string }
  | { status: 'error'; message: string };

export interface StationOption {
  id: string;
  name: string;
}

/**
 * Block 29d-1, Task 7. One component, mounted on the three screens that
 * already filter (Members, Participations, Requests) -- the campaign screen
 * this feeds has no filter panel of its own, on purpose, because a fourth one
 * would have to learn all three screens' own vocabularies and would drift
 * from all three (design spec's own reasoning). This dialog therefore takes
 * FILTERS ALREADY DECIDED by whichever screen mounts it and asks only for
 * what the filtered result cannot answer by itself: a name, fixed or living,
 * and -- when the screen has no Station of its own -- which one (D3).
 *
 * PERMISSION IS THE CALLER'S JOB, NOT THIS COMPONENT'S. Each of the three
 * screens mounts this only behind `canManageMessagingAt(...) && <the
 * screen's own view permission>` -- see page.tsx in members/participations/
 * music/requests for where those two are combined -- so this component
 * itself has no visibility gate to get wrong; it is either mounted or it
 * is not.
 *
 * NEVER REMOUNTED BETWEEN OPENINGS, unlike TemplateDialog's own "always a
 * fresh mount" shape: this component IS the trigger button, so it has to
 * exist on the page before anything is clicked, the same way ExportDialog
 * (components/reports/export-dialog.tsx) manages its own `open` boolean
 * rather than being conditionally mounted by a parent. `openDialog` below is
 * therefore what resets every field, every time -- there is no fresh mount to
 * do it for free.
 */
export function CreateSendListDialog({
  source,
  filters,
  companyId,
  stationOptions,
}: {
  source: SendListSource;
  filters: SendListFilters;
  /** The Station this list will belong to, when the source screen already has one chosen. Null for Members, which is Organization-wide (D3) -- see `stationOptions` below. */
  companyId: string | null;
  /** Stations this caller holds messaging.manage at -- the only ones the picker offers when `companyId` is null. Ignored (never rendered) when `companyId` is already known. */
  stationOptions: StationOption[];
}) {
  const t = useTranslations('templates');
  const titleId = useId();
  const formId = useId();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'living' | 'fixed'>('living');
  const [pickedCompanyId, setPickedCompanyId] = useState('');
  const [resolve, setResolve] = useState<ResolveState>({ status: 'loading' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const needsStationChoice = companyId === null;
  const effectiveCompanyId = companyId ?? pickedCompanyId;

  /**
   * Resolved ONCE per opening, independent of `kind` and of the Station
   * choice below: resolveListMembers (Task 4) answers "who matches these
   * filters", and neither which Station the list will belong to nor whether
   * it freezes that answer or re-asks it later changes what the filters
   * themselves match right now. Re-run on every open (never once for the
   * component's whole lifetime, which spans many openings) because this
   * component is never remounted between them -- see the header above.
   */
  async function openDialog() {
    setName('');
    setKind('living');
    setPickedCompanyId('');
    setSaveError(null);
    setOpen(true);
    setResolve({ status: 'loading' });

    const result = await resolveSendListPreviewAction(source, filters);
    if (result.status === 'ok') {
      setResolve({ status: 'ok', ids: result.ids });
    } else if (result.status === 'capped') {
      setResolve({ status: 'capped', message: result.message });
    } else {
      setResolve({ status: 'error', message: result.message });
    }
  }

  const resolvedCount = resolve.status === 'ok' ? resolve.ids.length : null;
  // A FIXED list needs at least one person (create_send_list's own 22023) --
  // caught here so the operator sees why Save stays disabled rather than
  // meeting the database's refusal after clicking it.
  const fixedWithNobody = kind === 'fixed' && resolvedCount === 0;

  const canSave =
    !saving &&
    resolve.status === 'ok' &&
    name.trim().length > 0 &&
    effectiveCompanyId !== '' &&
    !fixedWithNobody;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave || resolve.status !== 'ok') return;

    setSaving(true);
    setSaveError(null);

    const result = await createSendListAction({
      companyId: effectiveCompanyId,
      name: name.trim(),
      source,
      kind,
      filters,
      // Shown-but-not-stored for a LIVING list (see the count paragraph
      // below): a living list is resolved again from `filters` on every
      // future read (Task 4/5's own design), so what it holds today is never
      // written down as its membership -- only as this preview's number.
      memberIds: kind === 'fixed' ? resolve.ids : [],
    });

    setSaving(false);
    if (result.status === 'error') {
      setSaveError(result.message);
      return;
    }
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void openDialog();
        }}
        data-testid="create-send-list-button"
      >
        {t('createSendListButton')}
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} labelledBy={titleId} className="max-w-lg">
        <DialogHeader>
          <DialogTitle id={titleId}>{t('newSendListTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form id={formId} onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t('sendListBuiltFromCurrentFilters')}</p>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('listNameLabel')}</span>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus -- opened by an explicit click, never on page load */}
              <Input
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
                autoFocus
                data-testid="create-send-list-name"
              />
            </label>

            {needsStationChoice && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">{t('listStationLabel')}</span>
                <Select
                  name="companyId"
                  value={pickedCompanyId}
                  onChange={(e) => setPickedCompanyId(e.target.value)}
                  required
                  data-testid="create-send-list-station"
                >
                  <option value="" disabled>
                    {t('chooseAStation')}
                  </option>
                  {stationOptions.map((station) => (
                    <option key={station.id} value={station.id}>
                      {station.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm text-muted-foreground">{t('kindColumnLabel')}</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === 'living'}
                  onChange={() => setKind('living')}
                  data-testid="create-send-list-kind-living"
                />
                <span className="flex flex-col">
                  <span>{t('listKindLiving')}</span>
                  <span className="text-xs text-muted-foreground">{t('listKindLivingHelp')}</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === 'fixed'}
                  onChange={() => setKind('fixed')}
                  data-testid="create-send-list-kind-fixed"
                />
                <span className="flex flex-col">
                  <span>{t('listKindFixed')}</span>
                  <span className="text-xs text-muted-foreground">{t('listKindFixedHelp')}</span>
                </span>
              </label>
            </fieldset>

            {/*
              The resolved count, shown before Save can ever be pressed --
              D3's own rule that the operator sees what they are about to
              keep. For a LIVING list this number is NEVER what gets stored
              (only `filters` is -- see `memberIds` above); it is shown here
              purely so a living list gets the identical "here is what this
              means right now" preview a fixed one does, even though what
              happens to the number afterward differs completely.
            */}
            <div className="text-sm" data-testid="create-send-list-count">
              {resolve.status === 'loading' && (
                <span className="text-muted-foreground">{t('resolvingSendListCount')}</span>
              )}
              {resolve.status === 'ok' && <span>{t('sendListWillHold', { count: resolve.ids.length })}</span>}
              {resolve.status === 'capped' && <span className="text-destructive">{resolve.message}</span>}
              {resolve.status === 'error' && <span className="text-destructive">{resolve.message}</span>}
            </div>

            {fixedWithNobody && (
              <p className="text-sm text-destructive" data-testid="create-send-list-fixed-empty">
                {t('sendListFixedNeedsAtLeastOne')}
              </p>
            )}

            {saveError && (
              <p className="text-sm text-destructive" role="alert">
                {saveError}
              </p>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={saving}
            key="cancel"
          >
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!canSave}
            key="submit"
            data-testid="create-send-list-save"
          >
            {saving ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
