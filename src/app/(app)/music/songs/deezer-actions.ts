'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { deezerTransport } from '@/lib/integrations/deezer';
import type { DeezerFailureReason, DeezerSearchFilters } from '@/lib/integrations/deezer/transport';
import { InMemoryRateLimiter } from '@/lib/rate-limit';
import { ConflictError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  createSongFromDeezer,
  findSongsByDeezerIds,
  getSongById,
  linkSongToDeezer,
  unlinkSongFromDeezer,
  type SongSummary,
} from '@/services/music';
import { deezerRegistrationSchema } from '@/schemas/music';
import { markRegistered, type DeezerSearchRow } from './deezer-marking';
import type { DeezerPrefill } from './song-fields';
import type { SongFormState } from './actions';
import { describeMusicWriteError } from '../errors';

// ---------------------------------------------------------------------------
// No revalidatePath in this file, the same rule actions.ts beside it carries
// and for the same reason: every write here is invoked from a dialog over the
// Songs grid, and a fresh render of the route would re-run the keyset query
// and throw away the operator's place in the list. The grid patches its own
// row from what these actions return.
// ---------------------------------------------------------------------------

/**
 * Deezer's rate limit is per IP, and every Station shares this server's IP --
 * so nothing Deezer offers isolates one radio from another. This does. Keyed
 * by Station AND person, so one operator holding a key down cannot spend the
 * whole Station's budget either.
 *
 * Module scope, so it survives between requests within an instance. With
 * `output: 'standalone'` there may be several instances, each with its own
 * counter; that is disclosed in the design spec rather than pretended away.
 */
const limiter = new InMemoryRateLimiter();
const SEARCHES_PER_MINUTE = 30;

// Resolved once per module, not per call: the choice cannot change between
// two requests of the same process. See the function's own comment for why
// the fake is opt-IN rather than a fallback.
const client = deezerTransport();

async function requireSession(): Promise<{ userId: string; token: string }> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) redirect('/login');
  return { userId: session.user.id, token: session.access_token };
}

export type DeezerSearchState =
  | { status: 'ok'; tracks: DeezerSearchRow[] }
  | { status: 'error'; message: string };

/**
 * THE PERMISSION IS CHECKED HERE, and it has to be.
 *
 * Every other write in this block ends at an RPC that re-checks music.manage
 * itself, so a courtesy gate in the interface is exactly that. This action
 * ends nowhere near one: it calls an OUTSIDE SERVICE on the Station's behalf,
 * spends that Station's share of a shared rate limit, and reads `songs` to
 * mark duplicates -- and none of those refuses somebody who may only VIEW the
 * catalogue. Without this check, music.view would be enough to make the
 * platform issue Deezer traffic.
 *
 * Block 5a lost three defects at this exact seam, which is why it is spelled
 * out rather than assumed.
 */
export async function searchDeezerAction(
  companyId: string,
  filters: DeezerSearchFilters,
): Promise<DeezerSearchState> {
  const t = await getTranslations('music');
  const { userId } = await requireSession();
  const supabase = await createUserClient();

  const { data: allowed, error: permissionError } = await supabase.rpc('has_permission', {
    p_permission: 'music.manage',
    p_company_id: companyId,
  });

  // A failed check is NOT folded into "not granted": collapsing a transient
  // RPC failure into a refusal would tell somebody who does hold the
  // permission that they do not -- getMusicPermissions makes the same choice
  // for the same reason.
  if (permissionError) {
    logger.error({ err: permissionError, companyId }, 'deezer search permission check failed');
    return { status: 'error', message: t('couldNotLoadTheCatalogue') };
  }
  if (allowed !== true) {
    return { status: 'error', message: t('youDoNotHoldMusicManage2') };
  }

  const gate = await limiter.check(`deezer:${companyId}:${userId}`, SEARCHES_PER_MINUTE, 60);
  if (!gate.allowed) {
    return { status: 'error', message: t('tooManySearchesWaitAMoment') };
  }

  const found = await client.search(filters);
  if (!found.ok) {
    logger.warn({ reason: found.reason, companyId }, 'deezer search failed');
    return { status: 'error', message: describeDeezerFailure(found.reason, t) };
  }

  // One query for the whole page of results, never one per row.
  let existing: Map<number, string>;
  try {
    existing = await findSongsByDeezerIds(
      companyId,
      found.value.map((track) => track.id),
    );
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not check registered songs');
    // The search itself succeeded. Showing its results unmarked is better than
    // showing nothing: the worst case is an operator clicking Register on a
    // track already registered, which songs_deezer_live refuses by name.
    existing = new Map();
  }

  return { status: 'ok', tracks: markRegistered(found.value, existing) };
}

function describeDeezerFailure(
  reason: DeezerFailureReason,
  t: (key: string) => string,
): string {
  switch (reason) {
    case 'quota':
      return t('deezerIsRefusingRequestsRightNow');
    case 'not-found':
      return t('deezerHasNothingForThatSearch');
    default:
      return t('couldNotReachDeezerTryAgain');
  }
}

/**
 * A duplicate recording, told apart BY CONSTRAINT NAME.
 *
 * 0139 deliberately does not catch songs_deezer_live's 23505, so the raw
 * Postgres text reaches here -- and ConflictError's message passes through
 * describeMusicWriteError verbatim, which would put
 * `duplicate key value violates unique constraint "songs_deezer_live"` on
 * screen, in English, in a trilingual product. Named here instead, where a
 * catalogue key exists. The same shape services/integrations.ts uses to tell
 * 0057's two unique indexes apart.
 */
function describeDeezerWriteError(
  cause: unknown,
  t: (key: string, values?: Record<string, string>) => string,
  actionKey: string,
): string {
  if (cause instanceof ConflictError && cause.message.includes('songs_deezer_live')) {
    return t('anotherSongIsAlreadyLinkedToThatRecording');
  }
  return describeMusicWriteError(cause, t, actionKey);
}

export type DeezerPrefillState =
  | { status: 'ok'; prefill: DeezerPrefill }
  | { status: 'error'; message: string };

/**
 * The Register click on a search row, and the ONE place the album lookup
 * happens -- once per click, never once per search result.
 *
 * IT HAPPENS HERE RATHER THAN ON SUBMIT, and that is a deliberate change from
 * the first draft. The album is what carries the record label and the genre,
 * and looking it up at submit time would mean those two arrived out of the
 * write -- filled in by the system, after the operator had reviewed a form
 * that never showed them. Resolved here, they are ordinary fields on the form:
 * visible before saving, and editable, and whatever the operator leaves in
 * them is what gets written.
 *
 * Nothing is stored by this action. It reads.
 */
export async function prefillFromDeezerAction(
  companyId: string,
  track: {
    id: number;
    title: string;
    artistName: string;
    albumId: number;
    albumTitle: string;
    coverMd5: string | null;
    durationSeconds: number;
    isrc: string | null;
  },
): Promise<DeezerPrefillState> {
  const t = await getTranslations('music');
  const supabase = await createUserClient();

  const { data: allowed } = await supabase.rpc('has_permission', {
    p_permission: 'music.manage',
    p_company_id: companyId,
  });
  if (allowed !== true) {
    return { status: 'error', message: t('youDoNotHoldMusicManage2') };
  }

  const album = track.albumId > 0 ? await client.album(track.albumId) : null;

  // A failed album lookup does NOT stop the registration. Everything it would
  // have added -- label, genre, UPC, release date -- is optional on both the
  // song and the album, and refusing to fill the form because a second,
  // enriching call failed would trade the operator's whole action for three
  // fields nobody asked for. The form opens with those fields blank and the
  // operator may type them.
  if (album && !album.ok) {
    logger.warn(
      { reason: album.reason, albumId: track.albumId },
      'deezer album lookup failed; prefilling without it',
    );
  }

  const detail = album?.ok ? album.value : null;

  return {
    status: 'ok',
    prefill: {
      title: track.title,
      artistName: track.artistName,
      labelName: detail?.label ?? null,
      genreName: detail?.genreName ?? null,
      albumTitle: track.albumTitle || null,
      durationSeconds: track.durationSeconds,
      isrc: track.isrc,
      deezerTrackId: track.id,
      deezerAlbumId: track.albumId > 0 ? track.albumId : null,
      coverMd5: track.coverMd5,
      upc: detail?.upc ?? null,
      releaseDate: detail?.releaseDate ?? null,
    },
  };
}

/**
 * The submit. EVERY reference comes out of the FORM, by name -- not out of the
 * Deezer payload this dialog was opened with.
 *
 * That is the whole point of resolving the album in prefillFromDeezerAction
 * above: an operator who corrects "Universal Music Mexico" to "Universal"
 * before saving gets "Universal", because create_song_from_deezer (0139)
 * resolves whatever name arrives. Reading these from the track instead would
 * have made four fields on screen that quietly did not matter.
 */
export async function registerFromDeezerAction(
  _prev: SongFormState,
  formData: FormData,
): Promise<SongFormState> {
  const t = await getTranslations('music');
  const companyId = String(formData.get('companyId') ?? '');
  const trackId = Number(formData.get('deezerTrackId'));
  const albumId = Number(formData.get('deezerAlbumId'));

  if (!companyId || !Number.isFinite(trackId) || trackId <= 0) {
    return { status: 'error', message: t('checkTheForm') };
  }

  const parsed = deezerRegistrationSchema.safeParse({
    title: formData.get('title'),
    artistName: formData.get('artistName'),
    labelName: formData.get('labelName') || null,
    genreName: formData.get('genreName') || null,
    albumTitle: formData.get('albumTitle') || null,
    isrc: formData.get('isrc') || null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? t('checkTheForm') };
  }

  const { token } = await requireSession();

  try {
    const songId = await createSongFromDeezer(
      {
        companyId,
        ...parsed.data,
        deezerTrackId: trackId,
        deezerAlbumId: Number.isFinite(albumId) && albumId > 0 ? albumId : null,
        upc: String(formData.get('upc') ?? '') || null,
        coverMd5: String(formData.get('coverMd5') ?? '') || null,
        releaseDate: String(formData.get('releaseDate') ?? '') || null,
        durationSeconds: Number(formData.get('durationSeconds')) || null,
      },
      token,
    );
    return { status: 'saved', songId };
  } catch (cause) {
    logger.error({ err: cause, companyId, trackId }, 'register from deezer failed');
    return { status: 'error', message: describeDeezerWriteError(cause, t, 'actionRegisterSongs') };
  }
}

export interface DeezerLinkState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** What the database actually stored, for the grid to patch its row with. */
  song?: SongSummary;
}

/** Links a song that already exists (design D10). Touches nothing the operator typed. */
export async function linkToDeezerAction(
  _prev: DeezerLinkState,
  formData: FormData,
): Promise<DeezerLinkState> {
  const t = await getTranslations('music');
  const songId = String(formData.get('songId') ?? '');
  const trackId = Number(formData.get('deezerTrackId'));
  const albumId = Number(formData.get('deezerAlbumId'));

  if (!songId || !Number.isFinite(trackId) || trackId <= 0) {
    return { status: 'error', message: t('checkTheForm') };
  }

  const { token } = await requireSession();
  const album = Number.isFinite(albumId) && albumId > 0 ? await client.album(albumId) : null;
  const detail = album?.ok ? album.value : null;

  try {
    await linkSongToDeezer(
      {
        songId,
        deezerTrackId: trackId,
        albumTitle: String(formData.get('albumTitle') ?? '') || null,
        deezerAlbumId: Number.isFinite(albumId) && albumId > 0 ? albumId : null,
        upc: detail?.upc ?? null,
        coverMd5: String(formData.get('coverMd5') ?? '') || null,
        releaseDate: detail?.releaseDate ?? null,
        isrc: String(formData.get('isrc') ?? '') || null,
      },
      token,
    );

    // Re-read rather than echo: the album title and cover on SongSummary come
    // from an embed, not from anything this write's arguments carried by name
    // -- the same reason updateSongAction re-reads.
    const found = await getSongById(songId);
    return found ? { status: 'saved', song: found.song } : { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, songId, trackId }, 'link to deezer failed');
    return { status: 'error', message: describeDeezerWriteError(cause, t, 'actionSaveThisSong') };
  }
}

export async function unlinkFromDeezerAction(
  _prev: DeezerLinkState,
  formData: FormData,
): Promise<DeezerLinkState> {
  const t = await getTranslations('music');
  const songId = String(formData.get('songId') ?? '');
  if (!songId) return { status: 'error', message: t('checkTheForm') };

  const { token } = await requireSession();

  try {
    await unlinkSongFromDeezer(songId, token);
    const found = await getSongById(songId);
    return found ? { status: 'saved', song: found.song } : { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, songId }, 'unlink from deezer failed');
    return { status: 'error', message: describeMusicWriteError(cause, t, 'actionSaveThisSong') };
  }
}
