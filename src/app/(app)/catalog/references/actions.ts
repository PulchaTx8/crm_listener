'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { referenceFormSchema, referenceUpdateSchema } from '@/schemas/music';
import { archiveMusicReference, createMusicReference, updateMusicReference } from '@/services/music';
import { logger } from '@/lib/logger';
import { describeMusicWriteError } from '../../music/errors';
import { referenceScreenPath } from './list-params';
import type { ReferenceScreenKind } from './list-params';

// ---------------------------------------------------------------------------
// revalidatePath, not the row-patch pattern music/songs/actions.ts and
// music/artists/actions.ts both carry. Those two screens hold state a fresh
// render would throw away: a keyset position AND a record dialog addressed
// through the URL by useRecordDialog's raw history.pushState — a write Next's
// own router never learns about, so revalidating there re-renders against the
// router's STALE idea of the current search params (page one), not the one
// the address bar actually shows.
//
// ReferenceRecordDialog (reference-record-dialog.tsx) holds neither. The
// record it edits is a plain useState set from a row already in hand
// (references-grid.tsx) — never a second server read keyed by an id living in
// the URL — so there is no dialog address for Next's router to be stale
// about. The cursor itself DOES live in the URL, but nothing on this screen
// ever rewrites the address through the raw history API the way
// useRecordDialog does, so a fresh render of the SAME address lands on the
// SAME cursor. That is the exact reasoning music/catalog/actions.ts records
// for its own screen (deleted in Task 5), carried across because it still
// holds here: these screens hold no keyset position the operator would lose.
//
// THE ONE CASE THIS ARGUMENT DOES NOT COVER: which ROW, not which PAGE. The
// cursor surviving a fresh render says nothing about whether the record being
// edited is still IN that page's rows. A rename that moves a row's
// alphabetical position off the current page is exactly that: revalidatePath
// re-runs the same keyset query at the same cursor, the row lands on a
// different page, and references-grid.tsx's `rows.find(...)` (the record
// dialog derives its open record from the live `rows` prop, by id) comes back
// empty. The dialog closes itself, silently, immediately after "Saved."
// appears — reachable only past a full page of rows, and not a reason to
// abandon revalidatePath here, but not nothing either.
// ---------------------------------------------------------------------------

/**
 * The three kinds this screen's forms ever submit. A crafted POST naming ARTIST
 * or SHOW is refused here before it reaches create_music_reference/
 * update_music_reference/archive_music_reference — which would refuse it too,
 * on its own re-checked permission, but a kind this screen's UI has no way to
 * produce should not resolve a path or an ACTION_KEYS entry either.
 */
const REFERENCE_SCREEN_KINDS = ['LABEL', 'GENRE', 'SONGWRITER'] as const;

function isReferenceScreenKind(value: string): value is ReferenceScreenKind {
  return (REFERENCE_SCREEN_KINDS as readonly string[]).includes(value);
}

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * One whole action phrase per kind and per verb, as a catalogue key — the
 * same shape music/catalog/actions.ts's own ACTION_KEYS used (deleted in
 * Task 5) and for the same reason: "save this label" is *salvar esta
 * gravadora* and "save this genre" is *salvar este gênero* — the article
 * agrees with the noun's gender, so no stem plus noun can assemble both.
 */
const ACTION_KEYS: Record<ReferenceScreenKind, { register: string; save: string; archive: string }> = {
  LABEL: {
    register: 'actionRegisterLabels',
    save: 'actionSaveThisLabel',
    archive: 'actionArchiveThisLabel',
  },
  GENRE: {
    register: 'actionRegisterGenres',
    save: 'actionSaveThisGenre',
    archive: 'actionArchiveThisGenre',
  },
  // Block 27, renamed in Block 28. This entry was *salvar esta categoria*
  // and is now *salvar este compositor* — the gender flipped with the noun,
  // which is the map's own argument made twice over: neither a stem plus a
  // noun nor a translated stem could have followed that.
  SONGWRITER: {
    register: 'actionRegisterSongwriters',
    save: 'actionSaveThisSongwriter',
    archive: 'actionArchiveThisSongwriter',
  },
};

export interface ReferenceFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

export async function createReferenceAction(
  _prev: ReferenceFormState,
  formData: FormData,
): Promise<ReferenceFormState> {
  const kindRaw = formData.get('kind');
  const kind = typeof kindRaw === 'string' && isReferenceScreenKind(kindRaw) ? kindRaw : null;
  if (!kind) return { status: 'error', message: 'Missing kind.' };

  const parsed = referenceFormSchema.safeParse({
    companyId: formData.get('companyId'),
    kind,
    name: formData.get('name'),
    legacyId: formData.get('legacyId') || null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await createMusicReference(parsed.data, token);
    revalidatePath(referenceScreenPath(kind));
    return { status: 'saved' };
  } catch (cause) {
    logger.error(
      { err: cause, companyId: parsed.data.companyId, kind },
      'create music reference failed',
    );
    return {
      status: 'error',
      message: describeMusicWriteError(cause, await getTranslations('music'), ACTION_KEYS[kind].register),
    };
  }
}

export interface ReferenceSaveState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

/**
 * `legacyId` is deliberately not read from `formData` here — the edit form's
 * legacy-id field renders read-only with no `name` attribute (same shape as
 * artists/actions.ts's updateArtistAction), so it never reaches this FormData
 * either way — and referenceUpdateSchema (schemas/music.ts) has no `legacyId`
 * field to parse one into: update_music_reference (0102) no longer takes a
 * matching RPC parameter.
 *
 * No re-read after the write, unlike updateArtistAction: this screen has no
 * `getReferenceById` and needs none. revalidatePath refreshes the Server
 * Component above with the row as the database now has it, and
 * ReferenceRecordDialog reads its `record` prop from THAT live list by id
 * (references-grid.tsx) rather than from a value this action would otherwise
 * have to hand back.
 */
export async function updateReferenceAction(
  _prev: ReferenceSaveState,
  formData: FormData,
): Promise<ReferenceSaveState> {
  const kindRaw = formData.get('kind');
  const kind = typeof kindRaw === 'string' && isReferenceScreenKind(kindRaw) ? kindRaw : null;
  if (!kind) return { status: 'error', message: 'Missing kind.' };

  const parsed = referenceUpdateSchema.safeParse({
    kind,
    id: formData.get('id'),
    name: formData.get('name'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await updateMusicReference(parsed.data, token);
    revalidatePath(referenceScreenPath(kind));
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, id: parsed.data.id, kind }, 'update music reference failed');
    return {
      status: 'error',
      message: describeMusicWriteError(cause, await getTranslations('music'), ACTION_KEYS[kind].save),
    };
  }
}

export interface ArchiveReferenceState {
  status: 'idle' | 'archived' | 'error';
  message?: string;
}

/**
 * Can be refused: archive_music_reference answers 23503 while a live song
 * still names a genre or label, which services/music.ts's mapMusicError turns
 * into a BusinessRuleError and describeMusicWriteError (music/errors.ts) turns
 * into an instruction the operator can act on rather than the RPC's own
 * row-count sentence.
 */
export async function archiveReferenceAction(
  _prev: ArchiveReferenceState,
  formData: FormData,
): Promise<ArchiveReferenceState> {
  const kindRaw = formData.get('kind');
  const kind = typeof kindRaw === 'string' && isReferenceScreenKind(kindRaw) ? kindRaw : null;
  const id = String(formData.get('id') ?? '');
  if (!kind || !id) return { status: 'error', message: 'Missing record.' };

  const token = await requireAccessToken();

  try {
    await archiveMusicReference(kind, id, token);
    revalidatePath(referenceScreenPath(kind));
    return { status: 'archived' };
  } catch (cause) {
    logger.error({ err: cause, id, kind }, 'archive music reference failed');
    return {
      status: 'error',
      message: describeMusicWriteError(cause, await getTranslations('music'), ACTION_KEYS[kind].archive),
    };
  }
}
