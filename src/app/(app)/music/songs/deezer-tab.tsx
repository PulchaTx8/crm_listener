'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';
import { Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SongThumb } from '@/components/music/song-thumb';
import { formatDuration } from '../format';
import { prefillFromDeezerAction, searchDeezerAction } from './deezer-actions';
import type { DeezerSearchRow } from './deezer-marking';
import type { DeezerPrefill } from './song-fields';

/**
 * The Deezer tab, in both song dialogs (design D10).
 *
 * `mode` is the only difference between them, and it is one button label and
 * one callback: registering starts a new song from a recording, linking
 * attaches a recording to a song that already exists. The filters, the
 * results, the preview and the duplicate marking are identical, so they are
 * written once.
 */
export function DeezerTab({
  companyId,
  mode,
  onPrefill,
  onLink,
  onOpenExisting,
  linking,
}: {
  companyId: string;
  mode: 'register' | 'link';
  /** Register: hand the resolved prefill up so the dialog can switch to its data tab with the form filled. */
  onPrefill?: (prefill: DeezerPrefill) => void;
  /** Link: attach this recording to the song already open. */
  onLink?: (track: DeezerSearchRow) => void;
  /** A recording this Station already has: open its record rather than offering to register it again. */
  onOpenExisting: (songId: string) => void;
  linking?: boolean;
}) {
  const t = useTranslations('music');

  const [track, setTrack] = useState('');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');

  const [rows, setRows] = useState<DeezerSearchRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [preparing, startPrepare] = useTransition();

  /**
   * ONE <audio> for the whole list, not one per row. Two of them playing at
   * once is what a list of independent preview buttons produces by default,
   * and the fix is structural rather than a pile of pause() calls that have to
   * find each other.
   */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);

  function search() {
    setFailure(null);
    if (!track.trim() && !artist.trim() && !album.trim()) {
      setFailure(t('giveAtLeastOneFilter'));
      return;
    }
    startSearch(async () => {
      const result = await searchDeezerAction(companyId, { track, artist, album });
      if (result.status === 'error') {
        setFailure(result.message);
        setRows(null);
        return;
      }
      setRows(result.tracks);
    });
  }

  function togglePreview(row: DeezerSearchRow) {
    const el = audioRef.current;
    if (!el || !row.previewUrl) return;

    if (playing === row.id) {
      el.pause();
      setPlaying(null);
      return;
    }

    // The URL is signed and expires in hours, so it is used HERE, live, and
    // never stored or carried into the form. See DeezerTrack.previewUrl.
    el.src = row.previewUrl;
    void el.play();
    setPlaying(row.id);
  }

  function register(row: DeezerSearchRow) {
    setFailure(null);
    startPrepare(async () => {
      const result = await prefillFromDeezerAction(companyId, {
        id: row.id,
        title: row.title,
        artistName: row.artistName,
        albumId: row.albumId,
        albumTitle: row.albumTitle,
        coverMd5: row.coverMd5,
        durationSeconds: row.durationSeconds,
        isrc: row.isrc,
      });
      if (result.status === 'error') {
        setFailure(result.message);
        return;
      }
      onPrefill?.(result.prefill);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('songTitleFilter')}</span>
          <Input value={track} onChange={(e) => setTrack(e.target.value)} maxLength={100} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('artistFilter')}</span>
          <Input value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={100} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('albumFilter')}</span>
          <Input value={album} onChange={(e) => setAlbum(e.target.value)} maxLength={100} />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={search} disabled={searching} data-testid="deezer-search">
          {searching ? t('searching') : t('searchOnDeezer')}
        </Button>
        {failure && <span className="text-sm text-destructive">{failure}</span>}
      </div>

      {/* The one element every row shares. `onEnded` is what clears the button
          back to Play when a 30-second preview simply runs out. */}
      <audio ref={audioRef} onEnded={() => setPlaying(null)} className="hidden" />

      {rows !== null && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('noDeezerResults')}</p>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border" data-testid="deezer-results">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 p-3" data-testid="deezer-row">
              <SongThumb coverMd5={row.coverMd5} size="md" />

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{row.title}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {row.artistName}
                  {row.albumTitle ? ` — ${row.albumTitle}` : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDuration(row.durationSeconds)}
                  {row.isrc ? ` · ${row.isrc}` : ''}
                </p>
              </div>

              <button
                type="button"
                onClick={() => togglePreview(row)}
                disabled={!row.previewUrl}
                title={row.previewUrl ? undefined : t('noPreviewAvailable')}
                aria-label={playing === row.id ? t('stopPreview') : t('playPreview')}
                className="rounded-md p-2 ring-offset-background hover:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {playing === row.id ? (
                  <Pause className="size-4" aria-hidden="true" />
                ) : (
                  <Play className="size-4" aria-hidden="true" />
                )}
              </button>

              {row.registeredSongId ? (
                <button
                  type="button"
                  onClick={() => onOpenExisting(row.registeredSongId as string)}
                  className="whitespace-nowrap text-sm underline underline-offset-2"
                  title={t('openTheExistingSong')}
                  data-testid="deezer-already-registered"
                >
                  {t('alreadyRegistered')}
                </button>
              ) : mode === 'link' ? (
                <Button
                  type="button"
                  onClick={() => onLink?.(row)}
                  disabled={linking}
                  data-testid="deezer-link"
                >
                  {linking ? t('linking') : t('linkToThisSong')}
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => register(row)}
                  disabled={preparing}
                  data-testid="deezer-register"
                >
                  {t('registerFromDeezer')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Deezer's developer terms ask for attribution wherever their content is
          shown. The covers are served from their CDN unmodified, which is the
          other half of what they ask. */}
      <p className="text-xs text-muted-foreground">{t('poweredByDeezer')}</p>
    </div>
  );
}
