import 'server-only';
import { createUserClient } from '@/lib/supabase/user-client';
import { InternalError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { auditRowSchema, type AuditFilters, type AuditRow } from '@/schemas/audit';

/**
 * Block 10a. Reading the trail.
 *
 * There is NO permission check here and none in `list_audit_logs` either. The
 * function is `SECURITY INVOKER` and `audit_logs` carries the rule in its own
 * two policies (0011/0014) — a caller holding `audit.view` nowhere gets an empty
 * page, which is the correct answer and not an error.
 *
 * That is the one place this service departs from every other in this codebase,
 * and it departs deliberately: adding a gate here would be a second
 * implementation of a rule that already has a home, and the home is the one the
 * database enforces.
 */
export interface AuditPage {
  rows: AuditRow[];
  totalCount: number;
  nextCursor: { at: string; id: number } | null;
}

const PAGE_SIZE = 50;

function mapAuditError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === '22023') return new ValidationError(message);
  return new InternalError(message);
}

export async function listAuditLogs(
  filters: AuditFilters,
  cursor: { at: string; id: number } | null = null,
): Promise<AuditPage> {
  const supabase = await createUserClient();

  const { data, error } = await supabase.rpc('list_audit_logs', {
    p_actor_id: filters.actorId,
    p_action: filters.action,
    p_target_table: filters.targetTable,
    p_company_id: filters.companyId,
    // The half-open window every date bound in this codebase uses since 0117:
    // `to` is the day AFTER the last day the operator meant, so a row written at
    // 23:59 on the closing day is inside rather than a minute outside it.
    p_from: filters.from ? `${filters.from}T00:00:00Z` : undefined,
    p_to: filters.to ? `${filters.to}T00:00:00Z` : undefined,
    p_succeeded: filters.succeeded,
    p_cursor_at: cursor?.at,
    p_cursor_id: cursor?.id,
    // One more than the page, so "is there another page" is answered by the
    // query rather than by a second round trip.
    p_limit: PAGE_SIZE + 1,
  });

  if (error) throw mapAuditError(error.code, error.message);

  const parsed = (data ?? []).map((row) => auditRowSchema.parse(row));
  const rows = parsed.slice(0, PAGE_SIZE);
  const last = rows[rows.length - 1];

  return {
    rows,
    // Zero rows means zero total, which the RPC cannot tell us because it
    // returns the count ON a row.
    totalCount: parsed[0]?.total_count ?? 0,
    nextCursor: parsed.length > PAGE_SIZE && last ? { at: last.created_at, id: last.id } : null,
  };
}
