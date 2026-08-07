'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { songFormSchema, songUpdateSchema } from '@/schemas/music';
import { archiveSong, createSong, getSongById, updateSong } from '@/services/music';
import type { SongSummary } from '@/services/music';
import { logger } from '@/lib/logger';
import { describeMusicWriteError } from '../errors';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately — the same rule
// inventory/actions.ts and members/actions.ts both carry, for the same
// reason.
//
// Every write below is invoked from the song record dialog (or the create
// dialog over the grid), and revalidatePath returns a fresh render of the
// current route alongside the action's result — which re-runs the Songs
// list's keyset query, rebuilds the grid and throws away the operator's
// place in it. The grid patches its own row instead (src/lib/row-patch.ts),
// which is why the actions that change a song return what was stored.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * songFormSchema.durationSeconds is `z.number()...nullable().optional()`,
 * with no empty-string preprocessing — unlike labelId, genreId, nationality
 * and vocal, which all run through `blankToUndefined` (schemas/music.ts)
 * before their own check. A duration `<input type="number">` that the
 * operator clears posts `''` in its FormData entry, and `''` is not a number:
 * passed straight to `safeParse` it fails with an "expected number, received
 * string" issue on a column the database declares nullable
 * (`duration_seconds is null or duration_seconds > 0`, 0098).
 *
 * Converted here, before the schema ever sees it — the same move
 * inventory/actions.ts makes for its own required numeric fields
 * (`quantity: Number(formData.get('quantity'))`) — rather than editing
 * schemas/music.ts, which Task 7 already committed and every other screen in
 * this block also imports. An empty or missing field becomes `null`, which
 * `.nullable()` already accepts; anything else is handed to `Number(...)` and
 * left for the schema's own `.int()`/`.positive()` checks to refuse if it is
 * not a valid duration.
 */
function readDurationSeconds(formData: FormData): number | null {
  const raw = formData.get('durationSeconds');
  if (raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : Number(trimmed);
}

export interface SongFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /**
   * The song that was just created. The grid opens its record on this id and
   * takes the row from that read, the same shape createPrizeAction uses.
   */
  songId?: string;
}

export async function createSongAction(
  _prev: SongFormState,
  formData: FormData,
): Promise<SongFormState> {
  const parsed = songFormSchema.safeParse({
    companyId: formData.get('companyId'),
    title: formData.get('title'),
    artistId: formData.get('artistId'),
    labelId: formData.get('labelId') || null,
    genreId: formData.get('genreId') || null,
    nationality: formData.get('nationality') || null,
    vocal: formData.get('vocal') || null,
    durationSeconds: readDurationSeconds(formData),
    internalCode: formData.get('internalCode') || null,
    legacyId: formData.get('legacyId') || null,
    albumId: formData.get('albumId') || null,
    isrc: formData.get('isrc') || null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    const songId = await createSong(parsed.data, token);
    return { status: 'saved', songId };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'create song failed');
    return { status: 'error', message: describeMusicWriteError(cause, await getTranslations('music'), 'actionRegisterSongs') };
  }
}

export interface SongSaveState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** What the database actually stored, for the grid to patch its row with. */
  song?: SongSummary;
}

/**
 * `legacyId` is deliberately not read from `formData` here — it never was
 * meaningfully readable (the field renders with no `name` attribute, per
 * song-fields.tsx's own comment), but the fix for that is not to start
 * reading it: songUpdateSchema no longer has a `legacyId` field at all (0102
 * removed update_song's matching RPC parameter), so there is nothing here to
 * parse it into even if a hand-crafted submission carried one.
 */
export async function updateSongAction(
  _prev: SongSaveState,
  formData: FormData,
): Promise<SongSaveState> {
  const parsed = songUpdateSchema.safeParse({
    songId: formData.get('songId'),
    title: formData.get('title'),
    artistId: formData.get('artistId'),
    labelId: formData.get('labelId') || null,
    genreId: formData.get('genreId') || null,
    nationality: formData.get('nationality') || null,
    vocal: formData.get('vocal') || null,
    durationSeconds: readDurationSeconds(formData),
    internalCode: formData.get('internalCode') || null,
    // Block 13a. Read here and NOT deezerTrackId, which has no schema field
    // and no RPC parameter — the shape 0102 settled for legacy_id, applied
    // before it could cost anything a second time.
    albumId: formData.get('albumId') || null,
    isrc: formData.get('isrc') || null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await updateSong(parsed.data, token);
    // Re-read rather than echo the form: title/artist/label/genre names on
    // SongSummary come from an embed (services/music.ts's toSongSummary), not
    // from anything this write's own arguments carried by name.
    const found = await getSongById(parsed.data.songId);
    return found ? { status: 'saved', song: found.song } : { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, songId: parsed.data.songId }, 'update song failed');
    return { status: 'error', message: describeMusicWriteError(cause, await getTranslations('music'), 'actionSaveThisSong') };
  }
}

export interface ArchiveSongState {
  status: 'idle' | 'archived' | 'error';
  message?: string;
}

export async function archiveSongAction(
  _prev: ArchiveSongState,
  formData: FormData,
): Promise<ArchiveSongState> {
  const songId = String(formData.get('songId') ?? '');
  if (!songId) return { status: 'error', message: 'Missing song.' };

  const token = await requireAccessToken();

  try {
    await archiveSong(songId, token);
    return { status: 'archived' };
  } catch (cause) {
    logger.error({ err: cause, songId }, 'archive song failed');
    return { status: 'error', message: describeMusicWriteError(cause, await getTranslations('music'), 'actionArchiveThisSong') };
  }
}
