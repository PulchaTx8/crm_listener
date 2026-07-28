import type { MemberBlockKind, MemberConsentType } from '@/services/members';

/** The three consents decision 2 fixed (0032_member_lifecycle_tables.sql) — no fourth value. */
export const CONSENT_TYPE_LABELS: Record<MemberConsentType, string> = {
  rules: 'Promotion rules',
  image_use: 'Use of image and name',
  sponsor_communication: 'Sponsor communication',
};

/** The two things a block covers (0032) — matches the members.block permission label. */
export const BLOCK_KIND_LABELS: Record<MemberBlockKind, string> = {
  draw_ban: 'Barred from draws',
  suspension: 'Suspended',
};

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
