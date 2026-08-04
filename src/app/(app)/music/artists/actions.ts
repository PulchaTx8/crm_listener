'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { referenceFormSchema, referenceUpdateSchema } from '@/schemas/music';
import { archiveMusicReference, createMusicReference, getArtistById, updateMusicReference } from '@/services/music';
import type { ArtistSummary } from '@/services/music';
import { logger } from '@/lib/logger';
import { describeMusicWriteError } from '../errors';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately — the same rule
// songs/actions.ts, inventory/actions.ts and members/actions.ts all carry,
// for the same reason.
//
// Every write below is invoked from the artist record dialog (or the create
// dialog over the grid), and revalidatePath returns a fresh render of the
// current route alongside the action's result — which re-runs the Artists
// list's keyset query, rebuilds the grid and throws away the operator's
// place in it. The grid patches its own row instead (src/lib/row-patch.ts),
// which is why the actions that change an artist return what was stored.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export interface ArtistFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /**
   * The artist that was just created. The grid opens its record on this id
   * and takes the row from that read, the same shape createSongAction uses.
   */
  artistId?: string;
}

export async function createArtistAction(
  _prev: ArtistFormState,
  formData: FormData,
): Promise<ArtistFormState> {
  const parsed = referenceFormSchema.safeParse({
    companyId: formData.get('companyId'),
    kind: 'ARTIST',
    name: formData.get('name'),
    legacyId: formData.get('legacyId') || null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    const artistId = await createMusicReference(parsed.data, token);
    return { status: 'saved', artistId };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'create artist failed');
    return { status: 'error', message: describeMusicWriteError(cause, 'register artists') };
  }
}

export interface ArtistSaveState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** What the database actually stored, for the grid to patch its row with. */
  artist?: ArtistSummary;
}

/**
 * `legacyId` is deliberately not read from `formData` here — the edit form's
 * legacy-id field renders read-only with no `name` attribute (same shape as
 * song-fields.tsx's own), so it never reaches this FormData either way — and
 * referenceUpdateSchema no longer has a `legacyId` field at all to parse it
 * into: 0102 removed update_music_reference's matching RPC parameter after
 * exactly this omission used to be read as "clear it" (see updateSong's
 * identical comment in songs/actions.ts, and services/music.ts's own).
 */
export async function updateArtistAction(
  _prev: ArtistSaveState,
  formData: FormData,
): Promise<ArtistSaveState> {
  const parsed = referenceUpdateSchema.safeParse({
    kind: 'ARTIST',
    id: formData.get('artistId'),
    name: formData.get('name'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await updateMusicReference(parsed.data, token);
    // Re-read rather than echo the form: nothing here forbids it, but staying
    // consistent with updateSongAction's own shape (songs/actions.ts) means
    // the row the grid patches always reflects what the database stored.
    const found = await getArtistById(parsed.data.id);
    return found ? { status: 'saved', artist: found.artist } : { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, artistId: parsed.data.id }, 'update artist failed');
    return { status: 'error', message: describeMusicWriteError(cause, 'save this artist') };
  }
}

export interface ArchiveArtistState {
  status: 'idle' | 'archived' | 'error';
  message?: string;
}

/**
 * Unlike archive_song, archive_music_reference can refuse this: a live song
 * still naming the artist answers 23503, which services/music.ts's
 * mapMusicError turns into a BusinessRuleError, and describeMusicWriteError
 * (music/errors.ts) turns into an instruction the operator can act on rather
 * than the RPC's own row-count sentence.
 */
export async function archiveArtistAction(
  _prev: ArchiveArtistState,
  formData: FormData,
): Promise<ArchiveArtistState> {
  const artistId = String(formData.get('artistId') ?? '');
  if (!artistId) return { status: 'error', message: 'Missing artist.' };

  const token = await requireAccessToken();

  try {
    await archiveMusicReference('ARTIST', artistId, token);
    return { status: 'archived' };
  } catch (cause) {
    logger.error({ err: cause, artistId }, 'archive artist failed');
    return { status: 'error', message: describeMusicWriteError(cause, 'archive this artist') };
  }
}
