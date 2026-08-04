import { Input, Select } from '@/components/ui/input';
import { MUSIC_NATIONALITIES, MUSIC_VOCALS } from '@/schemas/music';
import type { ReferenceSummary, SongSummary } from '@/services/music';
import { NATIONALITY_LABELS, VOCAL_LABELS } from '../format';

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
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Title</span>
        <Input
          name="title"
          defaultValue={song?.title ?? ''}
          required
          maxLength={200}
          disabled={disabled}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Artist</span>
        <Select name="artistId" defaultValue={song?.artistId ?? ''} required disabled={disabled}>
          <option value="" disabled>
            Choose an artist
          </option>
          {artists.map((artist) => (
            <option key={artist.id} value={artist.id}>
              {artist.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Label</span>
        <Select name="labelId" defaultValue={song?.labelId ?? ''} disabled={disabled}>
          <option value="">No label</option>
          {labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Genre</span>
        <Select name="genreId" defaultValue={song?.genreId ?? ''} disabled={disabled}>
          <option value="">No genre</option>
          {genres.map((genre) => (
            <option key={genre.id} value={genre.id}>
              {genre.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Nationality</span>
        <Select name="nationality" defaultValue={song?.nationality ?? ''} disabled={disabled}>
          <option value="">Unspecified</option>
          {MUSIC_NATIONALITIES.map((value) => (
            <option key={value} value={value}>
              {NATIONALITY_LABELS[value]}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Vocal</span>
        <Select name="vocal" defaultValue={song?.vocal ?? ''} disabled={disabled}>
          <option value="">Unspecified</option>
          {MUSIC_VOCALS.map((value) => (
            <option key={value} value={value}>
              {VOCAL_LABELS[value]}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Duration (seconds)</span>
        <Input
          type="number"
          name="durationSeconds"
          defaultValue={song?.durationSeconds ?? ''}
          min={1}
          step={1}
          placeholder="Optional"
          disabled={disabled}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Internal code</span>
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
      */}
      {song && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Legacy id</span>
          <Input
            value={song.legacyId ?? ''}
            disabled
            readOnly
            placeholder="Not linked to an import"
            data-testid="song-legacy-id"
          />
          <span className="text-xs text-muted-foreground">
            Set by the catalogue import; not editable here.
          </span>
        </label>
      )}
    </>
  );
}
