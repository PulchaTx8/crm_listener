'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { importRowSchema, participationFormSchema } from '@/schemas/participations';
import type { ImportRowInput } from '@/schemas/participations';
import {
  importParticipations,
  recordParticipation,
  resolveOrCreateMember,
  searchStationListeners,
} from '@/services/participations';
import type {
  ImportParticipationsResult,
  ParticipationStatus,
  StationListenerPage,
} from '@/services/participations';
import { describeParticipationsReadError, describeParticipationsWriteError } from './errors';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately — the same rule
// promotions/actions.ts, members/actions.ts and inventory/actions.ts all carry,
// and here it binds twice over.
//
// Both writes below are invoked from the promotion record's fifth tab, which
// sits over the promotions list. revalidatePath returns a fresh render of the
// current route alongside the action's result, which would re-run that list's
// keyset query and throw away the operator's place in it — silently, because
// the screen would still look right. Each write calls the dialog's own
// `refresh` instead, which re-reads one promotion, counts included; the
// prohibition is on re-running the LIST, and that is left alone.
//
// It binds a second time because these two actions are reachable from
// /participations itself, where a revalidate would re-run that screen's keyset
// query for exactly the same nothing.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export type StationListenerSearchResult =
  | { status: 'ok'; page: StationListenerPage }
  | { status: 'error'; message: string };

/**
 * The manual form's picker, called per keystroke from the browser and debounced
 * there. Not a form action — it takes its arguments directly, because there is
 * no form, which is the shape searchLinkablePrizesAction has for the same
 * reason.
 */
export async function searchStationListenersAction(
  companyId: string,
  search: string,
): Promise<StationListenerSearchResult> {
  const token = await requireAccessToken();
  try {
    return { status: 'ok', page: await searchStationListeners(companyId, search, token) };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not search the listeners of this station');
    // Named narrowly rather than left to the default "the entries in this
    // Station": what a caller lacks when this fails is members.view, and
    // telling them they cannot view entries — on a tab they reached by viewing
    // entries — sends them to ask for the wrong permission.
    return {
      status: 'error',
      message: describeParticipationsReadError(cause, 'the listeners of this Station'),
    };
  }
}

/**
 * What happened to one hand-typed attempt.
 *
 * `recorded` carries a status and is NOT an error state, which is the whole of
 * design spec D5 expressed in a type: three of the four statuses mean the entry
 * was written down and will not be drawn, and a state machine with a single
 * `error` branch for "anything that is not VALID" is precisely how a screen
 * comes to tell an operator that nothing was saved when a row exists.
 *
 * `out-of-reach` is its own branch for the same reason in the other direction:
 * resolve_or_create_member's `elsewhere` is neither a write nor a failure — an
 * identifier matches a listener this caller may not see, no id comes back on
 * purpose, and registering a second listener with that identifier is impossible
 * because 0031's per-Organization unique indexes would refuse it. Folding it
 * into `error` would make the form report our fault for a situation with a
 * specific, actionable cause.
 */
export type RecordParticipationState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'out-of-reach' }
  | {
      status: 'recorded';
      outcome: ParticipationStatus;
      /** How the listener was reached, so the form can say a person was just registered. */
      listener: 'picked' | 'resolved' | 'created';
    };

/**
 * Answers arrive as three parallel lists, one entry per question, aligned by
 * position.
 *
 * Every question posts all three fields whatever its kind — the form renders a
 * hidden empty one for whichever of option/text does not apply — because that
 * alignment is the contract. quiz-tab.tsx posts the INDEX of its ticked radio
 * for the mirror-image reason: an unticked checkbox posts nothing at all, and
 * two lists of different lengths silently pair the wrong answer with the wrong
 * question.
 *
 * A question with neither an option nor text is dropped rather than sent.
 * participationAnswer refuses that shape, and it is not an operator error: it
 * is a question they chose not to answer, which is allowed — apply_participation
 * stores whatever arrives and never requires a full quiz.
 */
function readAnswers(formData: FormData) {
  const questionIds = formData.getAll('answerQuestionId').map(String);
  const optionIds = formData.getAll('answerOptionId').map(String);
  const texts = formData.getAll('answerText').map(String);

  return questionIds
    .map((questionId, index) => ({
      questionId,
      optionId: optionIds[index]?.trim() || undefined,
      answerText: texts[index]?.trim() || undefined,
    }))
    .filter((answer) => answer.optionId !== undefined || answer.answerText !== undefined);
}

export async function recordParticipationAction(
  _prev: RecordParticipationState,
  formData: FormData,
): Promise<RecordParticipationState> {
  // Guarded before the schema for the reason readPrizeLinkForm gives: an absent
  // field arrives as null, fails z.string()'s base type check first, and the
  // operator sees "Expected string, received null" instead of a sentence.
  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId) return { status: 'error', message: 'Which Station? Reopen the record.' };

  const parsed = participationFormSchema.safeParse({
    promotionId: formData.get('promotionId'),
    memberId: formData.get('memberId'),
    fullName: formData.get('fullName'),
    phone: formData.get('phone'),
    cpf: formData.get('cpf'),
    participatedAt: formData.get('participatedAt'),
    answers: readAnswers(formData),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();
  const input = parsed.data;

  try {
    let memberId = input.memberId;
    let listener: 'picked' | 'resolved' | 'created' = 'picked';

    if (!memberId) {
      // The schema has already refused a form with no memberId and no
      // identifier, so `fullName` is present on this branch by construction —
      // asserted with `??` rather than `!` so a future change to that refinement
      // fails loudly at the RPC instead of sending "undefined" as a name.
      const resolved = await resolveOrCreateMember(
        {
          companyId,
          fullName: input.fullName ?? '',
          phone: input.phone,
          cpf: input.cpf,
        },
        token,
      );
      // Not an error, not a write, and deliberately not retried: see
      // RecordParticipationState's own comment.
      if (resolved.outcome === 'elsewhere') return { status: 'out-of-reach' };
      memberId = resolved.memberId;
      listener = resolved.outcome;
    }

    const result = await recordParticipation(
      {
        promotionId: input.promotionId,
        memberId,
        participatedAt: input.participatedAt,
        // Fixed here rather than read off the form. The source is recorded and
        // never consulted (0054), so a client-supplied value could not change
        // which permission is checked — but it could put a lie in the column
        // the list filters on, for nothing.
        source: 'MANUAL',
        answers: input.answers,
      },
      token,
    );

    return { status: 'recorded', outcome: result.status, listener };
  } catch (cause) {
    logger.error(
      { err: cause, promotionId: input.promotionId, companyId },
      'record participation failed',
    );
    return {
      status: 'error',
      message: describeParticipationsWriteError(cause, 'record an entry in this promotion'),
    };
  }
}

export interface UnreadableImportRow {
  line: number;
  reason: string;
}

/**
 * The result of one file.
 *
 * `unreadable` is this layer's own list and is NOT what the RPC calls skipped.
 * Two different things happen to a bad line and the operator has to be able to
 * tell them apart: a line the schema refuses here never reaches the database at
 * all (no name, an unreadable date, a CPF that is not eleven digits), while a
 * line the RPC skips was sent and declined for a reason only the database knows
 * — no identifier at all, or a listener out of reach. Both are reported with
 * their line number, and both are counted separately, because "fix your
 * spreadsheet" and "ask for access to that listener" are different instructions.
 */
export type ImportParticipationsState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | {
      status: 'done';
      result: ImportParticipationsResult;
      unreadable: UnreadableImportRow[];
    };

/**
 * One call for the whole file (design spec D6). The rows arrive as JSON on the
 * form, parsed out of the CSV in the browser: the file's own date format is read
 * against the STATION's timezone, and only the browser knows which Station was
 * on screen — parsing "01/08/2026 14:30" here would read it in whatever zone
 * this server process runs in and be silently wrong by hours.
 *
 * Rows the schema refuses are set aside rather than failing the file. The
 * alternative — refuse everything if any line is bad — turns one mistyped date
 * in a six-hundred-row spreadsheet into six hundred rows nobody can import, and
 * throws away D6's whole shape, which is to write what it can and report the
 * rest by line number.
 *
 * The CPF is not hashed here and must not be: importParticipations hashes it in
 * Node immediately before the RPC call (0031 — an argument passed to an RPC
 * lands in query logs and in backups), using services/members.ts's own hashCpf
 * so the digits this import deduplicates on are the digits the audience screen
 * registered. What this action passes on is the raw value the schema
 * normalised, and the one thing it must never do is call the RPC itself.
 */
export async function importParticipationsAction(
  _prev: ImportParticipationsState,
  formData: FormData,
): Promise<ImportParticipationsState> {
  const promotionId = String(formData.get('promotionId') ?? '');
  if (!promotionId) return { status: 'error', message: 'Which promotion? Reopen the record.' };

  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get('rows') ?? ''));
  } catch {
    return { status: 'error', message: 'The file could not be read. Choose it again.' };
  }
  if (!Array.isArray(raw)) {
    return { status: 'error', message: 'The file could not be read. Choose it again.' };
  }
  if (raw.length === 0) {
    return { status: 'error', message: 'That file has a header row and nothing under it.' };
  }

  const rows: ImportRowInput[] = [];
  const unreadable: UnreadableImportRow[] = [];

  raw.forEach((entry, index) => {
    const parsed = importRowSchema.safeParse(entry);
    if (parsed.success) {
      rows.push(parsed.data);
      return;
    }
    // The line comes off the raw entry, not off the parse: the parse failed, and
    // it may well have failed ON the line number. Falling back to the position
    // in the file keeps the report pointing somewhere real rather than at line
    // 0, which is a line no operator can find.
    const line = typeof (entry as { line?: unknown } | null)?.line === 'number'
      ? (entry as { line: number }).line
      : index + 2;
    unreadable.push({
      line,
      reason: parsed.error.issues[0]?.message ?? 'This line could not be read.',
    });
  });

  if (rows.length === 0) {
    return {
      status: 'error',
      message:
        'Not one line of that file could be read. Check the columns and the date format, then try again.',
    };
  }

  const token = await requireAccessToken();
  try {
    const result = await importParticipations(promotionId, rows, token);
    return { status: 'done', result, unreadable };
  } catch (cause) {
    logger.error({ err: cause, promotionId, rows: rows.length }, 'import participations failed');
    return {
      status: 'error',
      message: describeParticipationsWriteError(cause, 'import entries into this promotion'),
    };
  }
}
