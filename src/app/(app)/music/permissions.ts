import 'server-only';
import { InternalError } from '@/lib/errors';
import type { UserClient } from '@/lib/supabase/user-client';

export interface MusicPermissions {
  /** Register and edit the catalogue — songs, artists, labels, genres, shows (0098's D8). */
  manage: boolean;
  /** Record a music request by hand. */
  request: boolean;
  /** Merge duplicated songs, artists, labels and genres — the one destructive code, kept separate on purpose. */
  merge: boolean;
}

const MUSIC_PERMISSION_CODES = ['music.manage', 'music.request', 'music.merge'] as const;

/**
 * Which of the three write permissions the caller holds in this one Station —
 * a courtesy gate for which forms the three music screens render at all, in
 * the shape getInventoryPermissions (inventory/station-access.ts) uses:
 * has_permission asked once per code, never the boundary itself. Every RPC
 * these forms call (create_song, update_song, archive_song, and the
 * reference/merge RPCs Tasks 9–10 add) re-checks its own permission with the
 * same function before writing anything (0100/0101), so a stale render — a
 * permission revoked after this page loaded but before a form still sitting
 * in an open tab is submitted — is still refused where it actually matters,
 * not merely hidden here.
 *
 * Shared by all three music screens, which is why it sits at `music/` rather
 * than `music/songs/` — one Promise.all shape for the whole block instead of
 * three copies that could silently disagree the next time either one is
 * fixed.
 *
 * A failed has_permission call throws rather than being folded into "not
 * granted": collapsing a transient RPC failure into "no access" would
 * silently hide every form from someone who does hold the permission.
 */
export async function getMusicPermissions(
  supabase: UserClient,
  companyId: string,
): Promise<MusicPermissions> {
  const results = await Promise.all(
    MUSIC_PERMISSION_CODES.map((code) =>
      supabase.rpc('has_permission', { p_permission: code, p_company_id: companyId }),
    ),
  );

  results.forEach((result, i) => {
    if (result.error) {
      throw new InternalError(
        `Could not check ${MUSIC_PERMISSION_CODES[i]} access for this station: ${result.error.message}`,
      );
    }
  });

  // Index access under noUncheckedIndexedAccess types each element as
  // `boolean | undefined` even though results.length is always exactly 3
  // (one per MUSIC_PERMISSION_CODES entry, mapped 1:1 above) — the `?? false`
  // is satisfying the compiler about a case that cannot actually occur, not a
  // real fallback.
  const flags = results.map((r) => r.data === true);
  return {
    manage: flags[0] ?? false,
    request: flags[1] ?? false,
    merge: flags[2] ?? false,
  };
}
