'use client';

import { useTranslations } from 'next-intl';
import type { MusicRequestPlayStatus, MusicRequestReadStatus } from '@/services/music';

/**
 * The two badges, in one file because they are one idea seen twice and both the
 * grid and the attend window render them. Exhaustive Records rather than a
 * lookup with a fallback: the type checker is what caught two enum values
 * arriving without a label on this very screen (requests-grid.tsx's own note on
 * CHANNEL_LABEL_KEYS), and a fallback would have hidden both.
 */
const READ_LABEL_KEYS: Record<MusicRequestReadStatus, string> = {
  UNREAD: 'readUnread',
  READ: 'readRead',
  CANCELLED: 'readCancelled',
};

const PLAY_LABEL_KEYS: Record<MusicRequestPlayStatus, string> = {
  NOT_PLAYED: 'playNotPlayed',
  PLAYED: 'playPlayed',
  CANCELLED: 'playCancelled',
};

/** Muted for "nothing has happened yet", solid for the fact, struck through for called off. */
const TONE = {
  pending: 'bg-muted text-muted-foreground',
  done: 'bg-primary/10 text-primary',
  cancelled: 'bg-muted text-muted-foreground line-through',
} as const;

function Badge({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export function ReadStatusBadge({ status }: { status: MusicRequestReadStatus }) {
  const tv = useTranslations('vocab');
  const tone = status === 'CANCELLED' ? 'cancelled' : status === 'READ' ? 'done' : 'pending';
  return (
    <span data-testid="request-read-status" data-status={status}>
      <Badge tone={tone}>{tv(READ_LABEL_KEYS[status])}</Badge>
    </span>
  );
}

export function PlayStatusBadge({ status }: { status: MusicRequestPlayStatus }) {
  const tv = useTranslations('vocab');
  const tone = status === 'CANCELLED' ? 'cancelled' : status === 'PLAYED' ? 'done' : 'pending';
  return (
    <span data-testid="request-play-status" data-status={status}>
      <Badge tone={tone}>{tv(PLAY_LABEL_KEYS[status])}</Badge>
    </span>
  );
}
