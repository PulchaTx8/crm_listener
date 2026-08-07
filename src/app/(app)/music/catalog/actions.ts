'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { referenceFormSchema, referenceUpdateSchema } from '@/schemas/music';
import type { MusicReferenceKind } from '@/schemas/music';
import { z } from 'zod';
import {
  archiveAlbum,
  archiveMusicReference,
  createAlbum,
  createMusicReference,
  updateAlbum,
  updateMusicReference,
} from '@/services/music';
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

/**
 * One WHOLE action phrase per kind and per verb, as a catalogue key —
 * deliberately not a noun this file splices into `register ${noun}s`.
 *
 * That splice was English grammar written into the code, the same defect §4 of
 * the Block 12b report names: English pluralises by adding a letter and puts
 * one demonstrative in front of every noun, and neither is true elsewhere.
 * "save this label" is *salvar esta gravadora* and "save this genre" is
 * *salvar este gênero* — the article agrees with the noun's gender, so no stem
 * plus noun can assemble both.
 */
const ACTION_KEYS: Record<MusicReferenceKind, { register: string; save: string; archive: string }> =
  {
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
    ARTIST: {
      register: 'actionRegisterArtists',
      save: 'actionSaveThisArtist',
      archive: 'actionArchiveThisArtist',
    },
    SHOW: {
      register: 'actionRegisterShows',
      save: 'actionSaveThisShow',
      archive: 'actionArchiveThisShow',
    },
  };

/**
 * The three kinds this screen's own forms ever submit — narrower than
 * MusicReferenceKind, whose fourth member, ARTIST, is the Artists screen's
 * own kind and never appears in a hidden `kind` input anywhere under
 * catalog/ (reference-tabs.tsx's KIND_FOR_TAB only maps to these three).
 * archiveReferenceAction validates against this tuple rather than against
 * ACTION_KEYS's keys (a superset), so its own validator cannot admit a case this
 * screen's UI has no way to produce — even though create_music_reference and
 * update_music_reference's re-checked permission would still refuse an
 * ARTIST request from a caller who has no business making one either way.
 */
const CATALOG_REFERENCE_KINDS = ['LABEL', 'GENRE', 'SHOW'] as const;

function isCatalogReferenceKind(value: string): value is (typeof CATALOG_REFERENCE_KINDS)[number] {
  return (CATALOG_REFERENCE_KINDS as readonly string[]).includes(value);
}

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

// ---------------------------------------------------------------------------
// ALBUM is a fourth TAB on this screen and NOT a fourth music_reference_kind.
//
// 0137's own header argues that widening the enum would be wrong: the 0100
// trio exists because four tables have identical columns — a name and a legacy
// handle — and albums do not. They carry a UPC, a Deezer id, a cover hash and
// a release date, so folding them in would push four album-only parameters
// into every genre and label call.
//
// What the three actions below share with albums is the SCREEN, not the RPC:
// a list of names, renamed and archived in place. So the routing happens here,
// at the one place both paths already pass through, and the database keeps the
// separate doors 0137 gave it.
// ---------------------------------------------------------------------------

/** A one-field name, bounded as the reference tables' own column is. */
const albumNameSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().trim().min(1, 'Give the album a title.').max(160),
});

function isAlbum(formData: FormData): boolean {
  return formData.get('kind') === 'ALBUM';
}

export async function createReferenceAction(
  _prev: ReferenceFormState,
  formData: FormData,
): Promise<ReferenceFormState> {
  if (isAlbum(formData)) {
    const parsed = albumNameSchema.safeParse({
      companyId: formData.get('companyId'),
      title: formData.get('name'),
    });
    if (!parsed.success) {
      return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
    }
    const token = await requireAccessToken();
    try {
      await createAlbum(parsed.data, token);
      revalidatePath('/music/catalog');
      return { status: 'saved' };
    } catch (cause) {
      logger.error({ err: cause, companyId: parsed.data.companyId }, 'create album failed');
      return {
        status: 'error',
        message: describeMusicWriteError(
          cause,
          await getTranslations('music'),
          'actionRegisterAlbums',
        ),
      };
    }
  }

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
      message: describeMusicWriteError(cause, await getTranslations('music'), ACTION_KEYS[parsed.data.kind].register),
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
  if (isAlbum(formData)) {
    const albumId = String(formData.get('id') ?? '');
    const title = String(formData.get('name') ?? '').trim();
    if (!albumId || !title) return { status: 'error', message: 'Check the form.' };

    const token = await requireAccessToken();
    try {
      // Renames and nothing else — 0141 removed update_album's UPC parameter
      // precisely because this form has no field for it, and an omitted
      // parameter is indistinguishable to the RPC from a cleared one.
      await updateAlbum({ albumId, title }, token);
      revalidatePath('/music/catalog');
      return { status: 'saved' };
    } catch (cause) {
      logger.error({ err: cause, albumId }, 'update album failed');
      return {
        status: 'error',
        message: describeMusicWriteError(
          cause,
          await getTranslations('music'),
          'actionSaveThisAlbum',
        ),
      };
    }
  }

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
      message: describeMusicWriteError(cause, await getTranslations('music'), ACTION_KEYS[parsed.data.kind].save),
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
  const id = String(formData.get('id') ?? '');

  if (isAlbum(formData)) {
    if (!id) return { status: 'error', message: 'Missing record.' };
    const token = await requireAccessToken();
    try {
      await archiveAlbum(id, token);
      revalidatePath('/music/catalog');
      return { status: 'archived' };
    } catch (cause) {
      logger.error({ err: cause, id }, 'archive album failed');
      return {
        status: 'error',
        message: describeMusicWriteError(
          cause,
          await getTranslations('music'),
          'actionArchiveThisAlbum',
        ),
      };
    }
  }

  const kindRaw = formData.get('kind');
  const kind = typeof kindRaw === 'string' && isCatalogReferenceKind(kindRaw) ? kindRaw : null;
  if (!kind || !id) return { status: 'error', message: 'Missing record.' };

  const token = await requireAccessToken();

  try {
    await archiveMusicReference(kind, id, token);
    revalidatePath('/music/catalog');
    return { status: 'archived' };
  } catch (cause) {
    logger.error({ err: cause, id, kind }, 'archive music reference failed');
    return { status: 'error', message: describeMusicWriteError(cause, await getTranslations('music'), ACTION_KEYS[kind].archive) };
  }
}
