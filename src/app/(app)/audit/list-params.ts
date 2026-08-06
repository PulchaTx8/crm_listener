/**
 * Block 10a. The audit viewer's URL contract.
 *
 * Pure, like `dashboards/period.ts` and for the same reason: no import beyond
 * types, so a Server Component, a client control and a unit test can all call
 * it without a stub.
 *
 * THE CURSOR IS A PAIR, AND ITS SECOND HALF IS A BIGINT. Every other keyset in
 * this codebase carries a uuid; `audit_logs.id` is a `bigint`, so the cursor is
 * encoded as `<iso>|<number>` and a malformed one is dropped rather than
 * erroring — `decodeCursor`'s standing contract in `lib/keyset.ts`: an
 * unreadable cursor means "start from the beginning", never an error page.
 */

export interface AuditSearchParams {
  actor?: string;
  action?: string;
  target?: string;
  companyId?: string;
  from?: string;
  to?: string;
  ok?: string;
  after?: string;
}

export interface AuditListState {
  actorId?: string;
  action?: string;
  targetTable?: string;
  companyId?: string;
  from?: string;
  to?: string;
  succeeded?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function uuidOrUndefined(value: string | undefined): string | undefined {
  return value && UUID.test(value) ? value : undefined;
}

function dateOrUndefined(value: string | undefined): string | undefined {
  return value && DATE.test(value) ? value : undefined;
}

export function parseAuditListState(params: AuditSearchParams): AuditListState {
  return {
    actorId: uuidOrUndefined(params.actor),
    // Bounded rather than validated against the known codes: the whole point of
    // the raw-code fallback in labels.ts is that codes this build does not know
    // still exist, and a filter that refused them would make the newest events
    // the least searchable.
    action: params.action?.trim().slice(0, 60) || undefined,
    targetTable: params.target?.trim().slice(0, 60) || undefined,
    companyId: uuidOrUndefined(params.companyId),
    from: dateOrUndefined(params.from),
    to: dateOrUndefined(params.to),
    succeeded: params.ok === 'yes' ? true : params.ok === 'no' ? false : undefined,
  };
}

export function parseAuditCursor(
  params: AuditSearchParams,
): { at: string; id: number } | null {
  const raw = params.after;
  if (!raw) return null;
  const separator = raw.lastIndexOf('|');
  if (separator <= 0) return null;
  const at = raw.slice(0, separator);
  const id = Number(raw.slice(separator + 1));
  // A hand-edited cursor starts the list over rather than erroring.
  if (!Number.isSafeInteger(id) || Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}

export function encodeAuditCursor(cursor: { at: string; id: number }): string {
  return `${cursor.at}|${cursor.id}`;
}

export function auditHref(state: AuditListState, cursor?: { at: string; id: number } | null): string {
  const query = new URLSearchParams();
  if (state.actorId) query.set('actor', state.actorId);
  if (state.action) query.set('action', state.action);
  if (state.targetTable) query.set('target', state.targetTable);
  if (state.companyId) query.set('companyId', state.companyId);
  if (state.from) query.set('from', state.from);
  if (state.to) query.set('to', state.to);
  if (state.succeeded !== undefined) query.set('ok', state.succeeded ? 'yes' : 'no');
  if (cursor) query.set('after', encodeAuditCursor(cursor));
  const search = query.toString();
  return search ? `/audit?${search}` : '/audit';
}
