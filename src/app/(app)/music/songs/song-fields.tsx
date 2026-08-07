import { useTranslations } from 'next-intl';
import { Input, Select } from '@/components/ui/input';
import { MUSIC_NATIONALITIES, MUSIC_VOCALS } from '@/schemas/music';
import type { ReferenceSummary, SongSummary } from '@/services/music';
import { NATIONALITY_LABEL_KEYS, VOCAL_LABEL_KEYS } from '../format';

/**
 * The song fields, shared between the create dialog (songs-grid.tsx) and the
 * edit form (song-record-dialog.tsx) so the two cannot silently drift apart —
 * one set of labels, bounds and select options rather than two. Renders bare
 * `<label>` blocks with no `<form>`/submit of its own: the caller supplies
 * both, since a create form and an edit form differ in what wraps this and
 * what happens on submit, not in the fields themselves.
 */
export function SongFields({
  song,
  artists,
  labels,
  genres,
  disabled,
}: {
  /** Absent when registering a new song; present when editing one already in the catalogue. */
  song?: SongSummary;
  artists: ReferenceSummary[];
  labels: ReferenceSummary[];
  genres: ReferenceSummary[];
  /**
   * True when the caller can read this song but not save it — no music.manage
   * at this Station. Every field below is disabled rather than left
   * interactive with nowhere to submit: an editable-looking control with no
   * save path is the false affordance this flag exists to avoid. legacyId
   * (below) is disabled unconditionally for a different reason — see its own
   * comment.
   */
  disabled?: boolean;
}) {
  const t = useTranslations('music');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('title')}</span>
        <Input
          name="title"
          defaultValue={song?.title ?? ''}
          required
          maxLength={200}
          disabled={disabled}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('artist')}</span>
        <Select name="artistId" defaultValue={song?.artistId ?? ''} required disabled={disabled}>
          <option value="" disabled>
            {t('chooseAnArtist')}</option>
          {artists.map((artist) => (
            <option key={artist.id} value={artist.id}>
              {artist.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('label')}</span>
        <Select name="labelId" defaultValue={song?.labelId ?? ''} disabled={disabled}>
          <option value="">{t('noLabel')}</option>
          {labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('genre')}</span>
        <Select name="genreId" defaultValue={song?.genreId ?? ''} disabled={disabled}>
          <option value="">{t('noGenre')}</option>
          {genres.map((genre) => (
            <option key={genre.id} value={genre.id}>
              {genre.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('nationality')}</span>
        <Select name="nationality" defaultValue={song?.nationality ?? ''} disabled={disabled}>
          <option value="">{t('unspecified')}</option>
          {MUSIC_NATIONALITIES.map((value) => (
            <option key={value} value={value}>
              {tv(NATIONALITY_LABEL_KEYS[value])}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('vocal')}</span>
        <Select name="vocal" defaultValue={song?.vocal ?? ''} disabled={disabled}>
          <option value="">{t('unspecified')}</option>
          {MUSIC_VOCALS.map((value) => (
            <option key={value} value={value}>
              {tv(VOCAL_LABEL_KEYS[value])}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('durationSeconds')}</span>
        <Input
          type="number"
          name="durationSeconds"
          defaultValue={song?.durationSeconds ?? ''}
          min={1}
          step={1}
          placeholder={t('optional')}
          disabled={disabled}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('internalCode')}</span>
        <Input
          name="internalCode"
          defaultValue={song?.internalCode ?? ''}
          maxLength={40}
          disabled={disabled}
        />
      </label>

      {/*
        legacy_id is Block 9's ETL idempotency handle (design spec D7), not an
        operator's field — a hand-edited value would let a second import run
        fail to recognise this row and duplicate it. Read-only, and shown only
        once a song exists to ask the question of: "why did the import skip
        this" has no meaning before the row does.

        No `name` attribute, deliberately: this field must never reach the
        edit form's FormData at all, on this side or a hand-crafted one. That
        used to be the ONLY guard, and it was not enough — an update form that
        simply never carries this value forward is indistinguishable, to the
        RPC it calls, from an operator who cleared it, and update_song used
        to take an omitted p_legacy_id as "set it to null" and apply that
        unconditionally. 0102 closed the actual hole by removing update_song's
        p_legacy_id parameter entirely, so there is no longer a write path to
        this column for any update payload, forged or not. This field staying
        un-named is defence in depth on top of that, not the boundary itself.
      */}
      {song && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('legacyId')}</span>
          <Input
            value={song.legacyId ?? ''}
            disabled
            readOnly
            placeholder={t('notLinkedToAnImport')}
            data-testid="song-legacy-id"
          />
          <span className="text-xs text-muted-foreground">
            {t('setByTheCatalogueImportNot')}</span>
        </label>
      )}
    </>
  );
}
