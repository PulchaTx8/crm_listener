'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { albumFormSchema, albumUpdateSchema } from '@/schemas/music';
import {
  archiveAlbum,
  clearAlbumCover,
  createAlbum,
  getAlbumById,
  updateAlbum,
  uploadAlbumCover,
} from '@/services/music';
import type { AlbumSummary } from '@/services/music';
import { logger } from '@/lib/logger';
import { describeMusicWriteError } from '../../music/errors';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately — the same rule
// music/artists/actions.ts and music/songs/actions.ts both carry, for the
// same reason.
//
// Every write below is invoked from the album record dialog (or the create
// dialog over the grid), and revalidatePath returns a fresh render of the
// current route alongside the action's result — which re-runs the Albums
// list's keyset query, rebuilds the grid and throws away the operator's
// place in it. The grid patches its own row instead (src/lib/row-patch.ts),
// which is why the actions that change an album return what was stored.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export interface AlbumFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /**
   * The album that was just created. The grid opens its record on this id
   * and takes the row from that read, the same shape createArtistAction
   * (music/artists/actions.ts) uses — and where the picture control lives,
   * since create_album has no parameter for it (D4: the picture has its own
   * writer, set_album_cover).
   */
  albumId?: string;
}

/**
 * Title, UPC and release date, all three, in ONE call to create_album (0137).
 * Unlike updateAlbumAction below, this does not go through updateAlbum
 * afterwards: create_album's own p_upc/p_release_date already default to
 * null, so a create form leaving either blank is registering a record with
 * fields left blank on purpose — 0187's own reasoning for why create_album
 * kept its defaults while update_album lost its. See createAlbum's comment
 * (services/music.ts).
 */
export async function createAlbumAction(
  _prev: AlbumFormState,
  formData: FormData,
): Promise<AlbumFormState> {
  const parsed = albumFormSchema.safeParse({
    companyId: formData.get('companyId'),
    title: formData.get('title'),
    upc: formData.get('upc'),
    releaseDate: formData.get('releaseDate'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    const albumId = await createAlbum(parsed.data, token);
    return { status: 'saved', albumId };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'create album failed');
    return {
      status: 'error',
      message: describeMusicWriteError(cause, await getTranslations('music'), 'actionRegisterAlbums'),
    };
  }
}

export interface AlbumSaveState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** What the database actually stored, for the grid to patch its row with. */
  album?: AlbumSummary;
}

/**
 * Title, UPC and release date — every one of them, on every call, D6's whole
 * point: update_album (0187) takes no default for the last two, so an
 * omitted one is 42883 at the RPC rather than a silently cleared column.
 * `upc`/`releaseDate` parse to `undefined` when the operator leaves the box
 * blank (albumUpdateSchema, schemas/music.ts) and are coalesced to `null`
 * here — updateAlbum has no fallback of its own to send them to, unlike
 * createAlbum above.
 *
 * `deezer_album_id` and `cover_md5` are absent from this form for the same
 * reason they are absent from update_album itself (D6): they are facts about
 * a third party's catalogue, written by the Deezer registration path alone.
 */
export async function updateAlbumAction(
  _prev: AlbumSaveState,
  formData: FormData,
): Promise<AlbumSaveState> {
  const parsed = albumUpdateSchema.safeParse({
    albumId: formData.get('albumId'),
    title: formData.get('title'),
    upc: formData.get('upc'),
    releaseDate: formData.get('releaseDate'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await updateAlbum(
      {
        albumId: parsed.data.albumId,
        title: parsed.data.title,
        upc: parsed.data.upc ?? null,
        releaseDate: parsed.data.releaseDate ?? null,
      },
      token,
    );
    // Re-read rather than echo the form: the same reasoning updateArtistAction
    // (music/artists/actions.ts) gives for its own — the row the grid patches
    // always reflects what the database stored, thumbUrl and coverMd5 included,
    // neither of which this form carries.
    const found = await getAlbumById(parsed.data.albumId);
    return found ? { status: 'saved', album: found.album } : { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, albumId: parsed.data.albumId }, 'update album failed');
    return {
      status: 'error',
      message: describeMusicWriteError(cause, await getTranslations('music'), 'actionSaveThisAlbum'),
    };
  }
}

export interface ArchiveAlbumState {
  status: 'idle' | 'archived' | 'error';
  message?: string;
}

/**
 * Unlike archive_music_reference, archive_album (0137) never refuses this: a
 * live song keeps pointing at the archived album (that function's own
 * comment), so there is no 23503 for describeMusicWriteError to translate
 * here the way it does for archiveArtistAction.
 */
export async function archiveAlbumAction(
  _prev: ArchiveAlbumState,
  formData: FormData,
): Promise<ArchiveAlbumState> {
  const albumId = String(formData.get('albumId') ?? '');
  if (!albumId) return { status: 'error', message: 'Missing album.' };

  const token = await requireAccessToken();

  try {
    await archiveAlbum(albumId, token);
    return { status: 'archived' };
  } catch (cause) {
    logger.error({ err: cause, albumId }, 'archive album failed');
    return {
      status: 'error',
      message: describeMusicWriteError(cause, await getTranslations('music'), 'actionArchiveThisAlbum'),
    };
  }
}

// ---------------------------------------------------------------------------
// The picture, D4. Its own pair of actions rather than a field bundled into
// updateAlbumAction: set_album_cover (0187) is its own writer for the same
// reason update_album carries no thumb_url parameter at all — a wholesale
// field replacer would delete a cover uploaded a moment before an ordinary
// Save. The upload control (album-record-dialog.tsx) submits the moment a
// file is chosen, rather than waiting on the data form's own Save button.
// ---------------------------------------------------------------------------

export interface AlbumCoverState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** What the bucket now serves, echoed back so the dialog can patch its own state and the grid row without a second read — the shape settlePrizePhoto (inventory/actions.ts) returns for the same reason. */
  thumbUrl?: string;
}

/**
 * Takes the `File` straight off `FormData` and passes it, with the caller's
 * own access token, to uploadAlbumCover — the same shape settlePrizePhoto
 * (inventory/actions.ts) hands `uploadPrizePhoto`. companyId travels in a
 * hidden field because the storage key (artworkKey, src/lib/storage/
 * artwork-keys.ts) is keyed on it, and this action has no other way to reach
 * it — record.ts's read is not repeated here for one field the form already
 * carries.
 */
export async function uploadAlbumCoverAction(
  _prev: AlbumCoverState,
  formData: FormData,
): Promise<AlbumCoverState> {
  const companyId = String(formData.get('companyId') ?? '');
  const albumId = String(formData.get('albumId') ?? '');
  const file = formData.get('file');

  if (!companyId || !albumId) return { status: 'error', message: 'Missing album.' };
  if (!(file instanceof File) || file.size === 0) {
    return { status: 'error', message: 'Choose a picture first.' };
  }

  const token = await requireAccessToken();

  try {
    const thumbUrl = await uploadAlbumCover(token, { companyId, albumId, file });
    return { status: 'saved', thumbUrl };
  } catch (cause) {
    logger.error({ err: cause, albumId }, 'upload album cover failed');
    return {
      status: 'error',
      message: describeMusicWriteError(cause, await getTranslations('music'), 'actionSaveThisAlbum'),
    };
  }
}

export interface AlbumCoverClearState {
  status: 'idle' | 'cleared' | 'error';
  message?: string;
}

/** Clears the column and queues the object for the worker (set_album_cover, 0187) — nothing here deletes anything, the same contract clearPrizePhoto carries. */
export async function clearAlbumCoverAction(
  _prev: AlbumCoverClearState,
  formData: FormData,
): Promise<AlbumCoverClearState> {
  const albumId = String(formData.get('albumId') ?? '');
  if (!albumId) return { status: 'error', message: 'Missing album.' };

  const token = await requireAccessToken();

  try {
    await clearAlbumCover(token, albumId);
    return { status: 'cleared' };
  } catch (cause) {
    logger.error({ err: cause, albumId }, 'clear album cover failed');
    return {
      status: 'error',
      message: describeMusicWriteError(cause, await getTranslations('music'), 'actionSaveThisAlbum'),
    };
  }
}
