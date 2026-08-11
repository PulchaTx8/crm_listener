/**
 * The shape every widget door answers with, and the one reader for it.
 *
 * MOVED HERE BY BLOCK 17b, out of `(widget)/w/[publicKey]/actions.ts`, and the
 * reason is a Next constraint rather than tidiness: that file carries
 * `'use server'`, and a module with that directive may export nothing but async
 * functions. A second set of actions needed this reader, and a `'use server'`
 * file cannot lend it — so the choice was to move it or to write it twice, and
 * two readers for one database contract is how the two come to disagree about
 * what a refusal looks like.
 */
export type DoorAnswer = {
  ok: boolean;
  reason: string | null;
  memberId: string | null;
  companyId: string | null;
  organizationId: string | null;
  /** Block 17b: how many seconds of a Station's cooldown are left. */
  waitSeconds: number | null;
};

/**
 * 0161's and 0167's doors answer a `jsonb` object, which reaches supabase-js as
 * `Json` — so the shape is checked rather than asserted. `null` means "not an
 * answer this code understands", which every caller turns into `failed`: a
 * PostgREST error envelope, or a future migration that changes the shape, must
 * not be read as a success with missing fields.
 */
export function readAnswer(data: unknown): DoorAnswer | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.ok !== 'boolean') return null;
  return {
    ok: row.ok,
    reason: typeof row.reason === 'string' ? row.reason : null,
    memberId: typeof row.member_id === 'string' ? row.member_id : null,
    companyId: typeof row.company_id === 'string' ? row.company_id : null,
    organizationId: typeof row.organization_id === 'string' ? row.organization_id : null,
    waitSeconds: typeof row.wait_seconds === 'number' ? row.wait_seconds : null,
  };
}
