'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { referenceFormSchema, referenceUpdateSchema } from '@/schemas/music';
import type { MusicReferenceKind } from '@/schemas/music';
import { archiveMusicReference, createMusicReference, updateMusicReference } from '@/services/music';
import { logger } from '@/lib/logger';
import { describeMusicWriteError } from '../errors';

// ---------------------------------------------------------------------------
// Every write below calls revalidatePath('/music/catalog') — the exact
// opposite of the rule songs/actions.ts and artists/actions.ts both carry,
// and deliberately so, not an oversight of it.
//
// Those two screens hold state a fresh render would throw away: a keyset
// position (a page of up to 50 rows reached by an opaque cursor) and, on
// Songs and Artists, a record dialog that may be open over it. That is why
// their own actions never call revalidatePath and instead patch one row in
// place (src/lib/row-patch.ts) — a fresh render would re-run the list's
// keyset query, rebuild the grid from page one and close whatever the
// operator had open.
//
// This screen has neither. Labels, genres and shows are each read WHOLE by
// listMusicReferences — no cursor, no page — and there is no record dialog to
// preserve: the whole record is one field, edited in the row itself
// (reference-panel.tsx). A fresh render of /music/catalog costs exactly what
// re-reading three short lists costs, which is what page.tsx already does on
// every ordinary visit, and it is simpler and more complete than a hand-built
// patch: an edit on the Labels tab that also changes what the Genres tab
// would show (it never does today, but the next kind added here might) needs
// no separate wiring to be reflected, because everything on the page is
// re-read from the same source of truth rather than assembled from whichever
// patches happened to be applied on the client.
// ---------------------------------------------------------------------------

/** Singular, lower case, for the `action` phrase describeMusicWriteError expects — "register labels", "save this genre", "archive this show". */
const NOUN: Record<MusicReferenceKind, string> = {
  LABEL: 'label',
  GENRE: 'genre',
  ARTIST: 'artist',
  SHOW: 'show',
};

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export interface ReferenceFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

export async function createReferenceAction(
  _prev: ReferenceFormState,
  formData: FormData,
): Promise<ReferenceFormState> {
  const parsed = referenceFormSchema.safeParse({
    companyId: formData.get('companyId'),
    kind: formData.get('kind'),
    name: formData.get('name'),
    legacyId: formData.get('legacyId') || null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await createMusicReference(parsed.data, token);
    revalidatePath('/music/catalog');
    return { status: 'saved' };
  } catch (cause) {
    logger.error(
      { err: cause, companyId: parsed.data.companyId, kind: parsed.data.kind },
      'create music reference failed',
    );
    return {
      status: 'error',
      message: describeMusicWriteError(cause, `register ${NOUN[parsed.data.kind]}s`),
    };
  }
}

/**
 * `legacyId` is deliberately not read from `formData` here — the edit row
 * shows it read-only, with no `name` attribute, so it never reaches this
 * FormData either way — and referenceUpdateSchema (schemas/music.ts) has no
 * `legacyId` field to parse one into: update_music_reference (0102) no
 * longer takes a matching RPC parameter, after exactly this omission used to
 * be read as "clear it" (services/music.ts's own comment on
 * updateMusicReference). Renaming never touches the handle Block 9's ETL
 * relies on; only createReferenceAction, the create path, sets it.
 */
export async function updateReferenceAction(
  _prev: ReferenceFormState,
  formData: FormData,
): Promise<ReferenceFormState> {
  const parsed = referenceUpdateSchema.safeParse({
    kind: formData.get('kind'),
    id: formData.get('id'),
    name: formData.get('name'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await updateMusicReference(parsed.data, token);
    revalidatePath('/music/catalog');
    return { status: 'saved' };
  } catch (cause) {
    logger.error(
      { err: cause, id: parsed.data.id, kind: parsed.data.kind },
      'update music reference failed',
    );
    return {
      status: 'error',
      message: describeMusicWriteError(cause, `save this ${NOUN[parsed.data.kind]}`),
    };
  }
}

export interface ArchiveReferenceState {
  status: 'idle' | 'archived' | 'error';
  message?: string;
}

/**
 * Can be refused: archive_music_reference answers 23503 while a live song
 * still names a genre or label (or a live request still names a show), which
 * services/music.ts's mapMusicError turns into a BusinessRuleError and
 * describeMusicWriteError (music/errors.ts) turns into an instruction the
 * operator can act on rather than the RPC's own row-count sentence.
 */
export async function archiveReferenceAction(
  _prev: ArchiveReferenceState,
  formData: FormData,
): Promise<ArchiveReferenceState> {
  const kindRaw = formData.get('kind');
  const kind =
    typeof kindRaw === 'string' && Object.prototype.hasOwnProperty.call(NOUN, kindRaw)
      ? (kindRaw as MusicReferenceKind)
      : null;
  const id = String(formData.get('id') ?? '');
  if (!kind || !id) return { status: 'error', message: 'Missing record.' };

  const token = await requireAccessToken();

  try {
    await archiveMusicReference(kind, id, token);
    revalidatePath('/music/catalog');
    return { status: 'archived' };
  } catch (cause) {
    logger.error({ err: cause, id, kind }, 'archive music reference failed');
    return { status: 'error', message: describeMusicWriteError(cause, `archive this ${NOUN[kind]}`) };
  }
}
