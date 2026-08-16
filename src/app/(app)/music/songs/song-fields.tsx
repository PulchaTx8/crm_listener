import { useTranslations } from 'next-intl';
import { Input, Select } from '@/components/ui/input';
import { MUSIC_NATIONALITIES, MUSIC_VOCALS } from '@/schemas/music';
import type { ReferenceSummary, SongSummary } from '@/services/music';
import { SongThumb } from '@/components/music/song-thumb';
import { NATIONALITY_LABEL_KEYS, VOCAL_LABEL_KEYS } from '../format';

/**
 * What the Deezer tab found. Everything a track and its album can contribute,
 * resolved BEFORE this form is shown — the album lookup happens on the
 * Register click in the tab, not on submit, precisely so that the label and
 * the genre are visible and editable here rather than appearing out of the
 * write.
 */
export interface DeezerPrefill {
  title: string;
  artistName: string;
  labelName: string | null;
  genreName: string | null;
  albumTitle: string | null;
  durationSeconds: number;
  isrc: string | null;
  deezerTrackId: number;
  deezerAlbumId: number | null;
  coverMd5: string | null;
  upc: string | null;
  releaseDate: string | null;
}

/**
 * The song fields, shared between the create dialog (songs-grid.tsx) and the
 * edit form (song-record-dialog.tsx) so the two cannot silently drift apart —
 * one set of labels, bounds and select options rather than two. Renders bare
 * `<label>` blocks with no `<form>`/submit of its own: the caller supplies
 * both, since a create form and an edit form differ in what wraps this and
 * what happens on submit, not in the fields themselves.
 *
 * BLOCK 13a SPLITS FOUR OF THE FIELDS IN TWO, and the reason is worth stating
 * because it looks like duplication and is not.
 *
 * On the ordinary path, artist, label, genre and album are `<select>`s over
 * this Station's catalogue: the operator picks something that exists, and the
 * form posts ids.
 *
 * On the Deezer path they are TEXT INPUTS holding names, and the form posts
 * names, which create_song_from_deezer (0139) resolves or creates atomically.
 * They must be, and a select would be a lie: the artist Deezer names very
 * often does not exist in this Station yet, so there is no option to select —
 * and if the field stayed a select, an operator who changed it would watch
 * their change be discarded, because the write goes by name. Two controls, two
 * honest behaviours, rather than one control that means different things
 * depending on how the dialog was opened.
 */
export function SongFields({
  song,
  artists,
  labels,
  genres,
  albums,
  prefill,
  disabled,
}: {
  /** Absent when registering a new song; present when editing one already in the catalogue. */
  song?: SongSummary;
  artists: ReferenceSummary[];
  labels: ReferenceSummary[];
  genres: ReferenceSummary[];
  albums: ReferenceSummary[];
  /**
   * Set when the operator clicked Register on the Deezer tab.
   *
   * NOTHING IS SAVED WHEN THIS ARRIVES. It fills the form; the operator
   * reviews it and submits. That was the owner's description of the flow, and
   * it is why this is a prop rather than a write.
   */
  prefill?: DeezerPrefill | null;
  /**
   * True when the caller can read this song but not save it — no music.manage
   * at this Station. Every field below is disabled rather than left
   * interactive with nowhere to submit: an editable-looking control with no
   * save path is the false affordance this flag exists to avoid. legacyId and
   * the Deezer code (below) are disabled unconditionally for their own
   * reasons — see their comments.
   */
  disabled?: boolean;
}) {
  const t = useTranslations('music');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');

  /** Does this Station already hold a reference by this name? Only used to decide whether to warn that one will be created. */
  const known = (list: ReferenceSummary[], name: string | null) =>
    name !== null && list.some((entry) => entry.name.toLowerCase() === name.toLowerCase());

  return (
    <>
      {prefill && (
        <>
          {/*
            What no visible field carries and the register action needs. Hidden
            rather than rendered: a Deezer track id is not something a person
            types, and design D6 keeps it out of every editable surface — the
            code and the cover travel together, and a hand-typed code would
            leave the cover pointing at another album with nothing noticing.
          */}
          <input type="hidden" name="deezerTrackId" value={prefill.deezerTrackId} />
          <input type="hidden" name="deezerAlbumId" value={prefill.deezerAlbumId ?? ''} />
          <input type="hidden" name="coverMd5" value={prefill.coverMd5 ?? ''} />
          <input type="hidden" name="upc" value={prefill.upc ?? ''} />
          <input type="hidden" name="releaseDate" value={prefill.releaseDate ?? ''} />

          <div className="flex items-center gap-3 rounded-md bg-muted px-3 py-2">
            <SongThumb coverMd5={prefill.coverMd5} size="md" />
            <p className="text-sm text-muted-foreground">
              {t('filledFromDeezerReviewBeforeSaving')}
            </p>
          </div>
        </>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('title')}</span>
        <Input
          name="title"
          defaultValue={prefill?.title ?? song?.title ?? ''}
          required
          maxLength={200}
          disabled={disabled}
        />
      </label>

      {prefill ? (
        <ReferenceByName
          field="artistName"
          label={t('artist')}
          value={prefill.artistName}
          notice={
            known(artists, prefill.artistName)
              ? null
              : t('theArtistWillBeCreated', { name: prefill.artistName })
          }
          required
          disabled={disabled}
        />
      ) : (
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
      )}

      {prefill ? (
        <ReferenceByName
          field="labelName"
          label={t('label')}
          value={prefill.labelName ?? ''}
          notice={
            prefill.labelName && !known(labels, prefill.labelName)
              ? t('theLabelWillBeCreated', { name: prefill.labelName })
              : null
          }
          disabled={disabled}
        />
      ) : (
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
      )}

      {prefill ? (
        <ReferenceByName
          field="genreName"
          label={t('genre')}
          value={prefill.genreName ?? ''}
          notice={
            prefill.genreName && !known(genres, prefill.genreName)
              ? t('theGenreWillBeCreated', { name: prefill.genreName })
              : null
          }
          disabled={disabled}
        />
      ) : (
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
      )}

      {prefill ? (
        <ReferenceByName
          field="albumTitle"
          label={t('album')}
          value={prefill.albumTitle ?? ''}
          notice={
            prefill.albumTitle && !known(albums, prefill.albumTitle)
              ? t('theAlbumWillBeCreated', { name: prefill.albumTitle })
              : null
          }
          disabled={disabled}
        />
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('album')}</span>
          <Select name="albumId" defaultValue={song?.albumId ?? ''} disabled={disabled}>
            <option value="">{t('noAlbum')}</option>
            {albums.map((album) => (
              <option key={album.id} value={album.id}>
                {album.name}
              </option>
            ))}
          </Select>
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('nationality')}</span>
        {/*
          Not filled from Deezer, ever, and neither is the vocal below: Deezer
          carries neither fact. Left for the operator rather than guessed —
          Block 8's indicators count over these, and a guessed value produces a
          number that looks right and is not.
        */}
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
          // Deezer answers in whole seconds already, so there is no conversion
          // here to get wrong.
          defaultValue={prefill?.durationSeconds || song?.durationSeconds || ''}
          min={1}
          step={1}
          placeholder={t('optional')}
          disabled={disabled}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('isrc')}</span>
        {/*
          Hand-editable, unlike the Deezer code below (design D7/D8). Not every
          song comes from Deezer and the ISRC is the code the radio industry
          actually uses, so 0138 gives it a format check and deliberately no
          unique index — a unique would turn one typo into a door nobody can
          open.
        */}
        <Input
          name="isrc"
          defaultValue={prefill?.isrc ?? song?.isrc ?? ''}
          maxLength={12}
          placeholder="BRPGD9800678"
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
        The Deezer code, read-only for the reason design D6 gives and 0102
        already paid for once with legacy_id: the code and the cover travel
        together, and a hand-typed code would leave the cover pointing at
        another album with nothing in the system noticing.

        No `name` attribute — but that is defence in depth, not the boundary.
        The boundary is that update_song (0138) HAS NO PARAMETER for this
        column, so no submission, hand-crafted or otherwise, can reach it.
        0139's two doors are the only write path. Shown only once a song
        exists, because "where did this come from" has no meaning before the
        row does.
      */}
      {song && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('deezerCode')}</span>
          <Input
            value={song.deezerTrackId !== null ? String(song.deezerTrackId) : ''}
            disabled
            readOnly
            placeholder={t('notLinkedToDeezer')}
            data-testid="song-deezer-id"
          />
          <span className="text-xs text-muted-foreground">{t('setByTheDeezerTabNot')}</span>
        </label>
      )}

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

/**
 * A reference the Deezer path posts BY NAME rather than by id, with a warning
 * when this Station does not hold one yet.
 *
 * Editable on purpose. The operator correcting "Universal Music Mexico" to
 * "Universal" before saving is a correction the write respects, because
 * create_song_from_deezer resolves whatever name arrives — which is exactly
 * what a `<select>` here could not have offered.
 */
function ReferenceByName({
  field,
  label,
  value,
  notice,
  required,
  disabled,
}: {
  field: 'artistName' | 'labelName' | 'genreName' | 'albumTitle';
  label: string;
  value: string;
  notice: string | null;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input
        name={field}
        defaultValue={value}
        required={required}
        maxLength={160}
        disabled={disabled}
      />
      {notice && <span className="text-xs text-warning">{notice}</span>}
    </label>
  );
}
