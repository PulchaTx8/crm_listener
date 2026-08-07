import type { Database } from '@/lib/supabase/database.types';

/**
 * One module for the whole catalogue, because the Songs grid, the song
 * record and the Artists screen's song tab all render a duration and a
 * nationality/vocal pair — three call sites that would otherwise each round
 * or label them their own way (the same reasoning inventory/format.ts gives
 * for physicalTotal).
 */

/**
 * `songs.duration_seconds` (0098) as `m:ss`. Null renders as an em dash: a
 * song with no duration recorded is not zero seconds long, and treating it as
 * "0:00" would say something the catalogue does not know.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

/** Every value music_nationality (0098) carries. */
export const NATIONALITY_LABEL_KEYS: Record<
  Database['public']['Enums']['music_nationality'],
  string
> = {
  DOMESTIC: 'nationalityDomestic',
  INTERNATIONAL: 'nationalityInternational',
};

/** Every value music_vocal (0098) carries. */
export const VOCAL_LABEL_KEYS: Record<Database['public']['Enums']['music_vocal'], string> = {
  MALE: 'vocalMale',
  FEMALE: 'vocalFemale',
  DUO: 'vocalDuo',
  GROUP: 'vocalGroup',
  INSTRUMENTAL: 'vocalInstrumental',
};
