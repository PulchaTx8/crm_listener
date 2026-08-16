'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MAX_INTEGRATION_FILE_BYTES, parseIntegrationFile } from '@/lib/song-integration-file';
import type { SongIntegration } from '@/services/music';
import type { SongRecord } from './record';
import { saveSongIntegrationAction, type SongIntegrationState } from './integration-actions';

const INITIAL: SongIntegrationState = { status: 'idle' };

/**
 * Block 27. The Integration tab: this song as the customer's own scheduling
 * software describes it.
 *
 * FOUR FIELDS, AND THEY DO NOT BELONG TO THE SAME ROW. The Integration code is
 * the SONG's (`songs.internal_code`, renamed on screen only — see 0207 for why
 * the column keeps its name). The other three are the CARD's
 * (`song_integrations`, keyed by that code), and several songs may resolve one
 * card, which is the whole reason they are a table of their own rather than
 * columns on the song.
 *
 * That split has a consequence this component is responsible for saying out
 * loud: EDITING THE THREE EDITS A SHARED THING. `sharedCodeCount` is how many
 * live songs in this Station carry the same code, this one included, and the
 * warning below appears whenever that is more than one. A screen that quietly
 * rewrote four other records is the defect that sentence exists to prevent.
 *
 * The code field is here rather than on Song data because this is where the
 * three fields explaining it are; the CREATE dialog keeps its own copy, since it
 * has no tabs to put one in (song-fields.tsx says so beside it).
 *
 * SAVING IS TWO WRITES, and the form is one because the operator's intention is
 * one. `set_song_integration_code` (0208) points the song at the code, and
 * `save_song_integration` (0207) registers or corrects the card for it. Two
 * rows, two doors, each resolving its own Station and re-checking music.manage
 * in its own body; integration-actions.ts says why the order matters and why
 * they are not one transaction.
 */
export function IntegrationTab({
  record,
  manage,
  onSaved,
}: {
  record: SongRecord;
  /** Whether the caller holds music.manage at this Station — a courtesy gate; both doors re-check it themselves. */
  manage: boolean;
  /** Everything the write changed, re-read from the database rather than echoed from the form: the card, the code the song now carries, and how many songs share it now. */
  onSaved: (next: {
    integration: SongIntegration | null;
    code: string;
    sharedCodeCount: number;
  }) => void;
}) {
  const t = useTranslations('music');
  const [state, action, pending] = useActionState(saveSongIntegrationAction, INITIAL);

  // Controlled, not defaulted, because Block 27's next task fills these boxes
  // from a JSON file the operator picks — a defaultValue cannot be written to
  // after the first render, so an import would appear to do nothing.
  const [draft, setDraft] = useState({
    code: record.song.internalCode ?? '',
    title: record.integration?.title ?? '',
    artistName: record.integration?.artistName ?? '',
    categoryName: record.integration?.categoryName ?? '',
  });

  useEffect(() => {
    if (state.status !== 'saved' || state.code === undefined) return;
    // `?? null` rather than skipping when absent: a save that CLEARED the card's
    // three words leaves no row, and the record has to learn that too.
    onSaved({
      integration: state.integration ?? null,
      code: state.code,
      sharedCodeCount: state.sharedCodeCount ?? 0,
    });
    // onSaved is stable for this dialog's lifetime, and adding it would re-fire
    // this on every render of the grid above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Both notices below are about the code the record was LOADED with, not what
  // is in the box right now — a half-typed code must not make them flicker
  // between "no card" and a card that was never gone. After a save the record
  // itself is patched with what the database answered, so they follow.
  const savedCode = record.song.internalCode ?? '';
  const codeIsUnchanged = draft.code.trim() === savedCode;
  const others = Math.max(record.sharedCodeCount - 1, 0);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset first, so choosing the SAME file twice fires `change` again — a
    // browser does not report a re-selection of an unchanged value.
    event.target.value = '';
    if (!file) return;

    // Checked against File.size BEFORE reading, so a two-gigabyte file never
    // becomes a string in memory. The `accept` attribute below is a hint to the
    // picker and nothing more; the content decides.
    if (file.size > MAX_INTEGRATION_FILE_BYTES) {
      setImportMessage(t('thatFileIsTooLargeForOneCard'));
      return;
    }

    const result = parseIntegrationFile(await file.text());
    if (!result.ok) {
      setImportMessage(
        result.reason === 'many'
          ? t('thatFileCarriesCards', { count: result.count ?? 0 })
          : t('thatFileCouldNotBeRead'),
      );
      return;
    }

    // IT FILLS THE FORM AND WRITES NOTHING (design D9) — the Deezer prefill's
    // own contract, adopted for the same reason: an import that writes on open
    // is an import the operator cannot decline. The Save button below is the
    // write, and it is the same one a hand-typed edit uses.
    //
    // A whole replacement rather than a merge: the file describes ONE card, and
    // leaving a previous artist in place beside an imported title would produce
    // a card that came from nowhere in particular.
    setDraft({
      code: result.card.code,
      title: result.card.title ?? '',
      artistName: result.card.artistName ?? '',
      categoryName: result.card.categoryName ?? '',
    });
    setImportMessage(t('filledFromTheFileReviewBeforeSaving'));
  }

  const fields = (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('integrationCode')}</span>
        <Input
          name="code"
          value={draft.code}
          onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))}
          maxLength={40}
          required
          disabled={!manage}
          data-testid="integration-code"
        />
        <span className="text-xs text-muted-foreground">{t('savingHereWritesTheCardNotTheSong')}</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('integrationTitle')}</span>
        <Input
          name="title"
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          maxLength={200}
          disabled={!manage}
          data-testid="integration-title"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('integrationArtist')}</span>
        <Input
          name="artistName"
          value={draft.artistName}
          onChange={(e) => setDraft((d) => ({ ...d, artistName: e.target.value }))}
          maxLength={160}
          disabled={!manage}
          data-testid="integration-artist"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('integrationCategory')}</span>
        <Input
          name="categoryName"
          value={draft.categoryName}
          onChange={(e) => setDraft((d) => ({ ...d, categoryName: e.target.value }))}
          maxLength={160}
          disabled={!manage}
          data-testid="integration-category"
        />
        {/* Free text, and deliberately NOT the Category select on the Song data
            tab: this is the other system's vocabulary (0207), and forcing it
            into ours would invent categories nobody asked for. */}
        <span className="text-xs text-muted-foreground">{t('theirWordNotYours')}</span>
      </label>
    </>
  );

  const notices = (
    <>
      {codeIsUnchanged && savedCode !== '' && record.integration === null && (
        <p className="text-sm text-muted-foreground" data-testid="integration-no-card">
          {t('noCardIsRegisteredForThisCode')}
        </p>
      )}
      {/* Hidden the moment the box stops matching the stored code: the count
          belongs to THAT code, and showing it against a code the operator is
          halfway through typing would name a number about a different set of
          songs. It comes back, re-counted by the action, once the save lands. */}
      {codeIsUnchanged && others > 0 && (
        <p className="text-sm text-warning" data-testid="integration-shared">
          {t('thisCodeIsAlsoUsedByOtherSongs', { count: others })}
        </p>
      )}
    </>
  );

  if (!manage) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('youDoNotHoldMusicManage2')}</p>
        {notices}
        {fields}
      </div>
    );
  }

  return (
    <form action={action} data-testid="integration-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={record.companyId} />
      {/* set_song_integration_code resolves its own Station from this row rather
          than trusting the companyId beside it — the shape every write in this
          block uses. Both travel because the two doors need different things. */}
      <input type="hidden" name="songId" value={record.song.id} />

      {notices}

      {/* A visible Button driving a hidden file input, rather than the input
          itself: a bare file control cannot be styled to match the rest of this
          product, and a <label> wrapping one is not reachable as a button by
          keyboard. `type="button"` because it sits inside the form that saves —
          without it, an unqualified <button> submits (a defect this codebase has
          already shipped once). */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => fileInput.current?.click()}
          data-testid="integration-import"
        >
          {t('importFromAFile')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          onChange={onFile}
          className="hidden"
          data-testid="integration-file"
        />
        {importMessage && (
          <span className="text-sm text-muted-foreground" data-testid="integration-import-message">
            {importMessage}
          </span>
        )}
      </div>

      {fields}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} data-testid="integration-save">
          {pending ? t('saving') : t('save')}
        </Button>
        {state.status === 'error' && (
          <span className="text-sm text-destructive">{state.message}</span>
        )}
        {state.status === 'saved' && (
          <span className="text-sm text-muted-foreground">{t('saved')}</span>
        )}
      </div>
    </form>
  );
}
