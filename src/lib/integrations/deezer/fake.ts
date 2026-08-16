import { isExcludedTitle } from './transport';
import type {
  DeezerAlbumDetail,
  DeezerFailureReason,
  DeezerResult,
  DeezerSearchFilters,
  DeezerTrack,
  DeezerTransport,
} from './transport';

/**
 * Answers from a fixture instead of the network. The transport CI uses — the
 * same role whatsapp/fake.ts plays, and the reason the end-to-end suite can
 * prove the Deezer tab with no outside service reachable and no rate limit to
 * respect.
 *
 * It records what it was asked, because "the album call happens once, on the
 * register click, and never per search result" is a claim about call counts
 * that only a recording transport can check.
 */
export class FakeDeezerTransport implements DeezerTransport {
  readonly searches: DeezerSearchFilters[] = [];
  readonly albumLookups: number[] = [];
  /** Block 17b's equivalent claim: the widget resolves the chosen track once, on submit. */
  readonly trackLookups: number[] = [];

  private failure: { reason: DeezerFailureReason } | null = null;

  constructor(
    private readonly tracks: DeezerTrack[] = [],
    private readonly albums: Record<number, DeezerAlbumDetail> = {},
  ) {}

  /** The next call fails once, then normal service resumes — whatsapp/fake.ts's failNext, for the same reason: a retry path is untestable without it. */
  failNext(reason: DeezerFailureReason): void {
    this.failure = { reason };
  }

  private takeFailure(): { ok: false; reason: DeezerFailureReason; message: string } | null {
    if (!this.failure) return null;
    const { reason } = this.failure;
    this.failure = null;
    return { ok: false, reason, message: `fake ${reason}` };
  }

  async search(filters: DeezerSearchFilters): Promise<DeezerResult<DeezerTrack[]>> {
    this.searches.push(filters);
    return (
      this.takeFailure() ?? {
        ok: true,
        // Block 24, D1: filtered exactly as the real client filters, so the
        // end-to-end suite proves the rule and not a screen with no rule behind
        // it. `track` below is deliberately NOT filtered, for the same reason
        // the real client does not filter it.
        value: this.tracks.filter((track) => !isExcludedTitle(track.title)),
      }
    );
  }

  async album(albumId: number): Promise<DeezerResult<DeezerAlbumDetail>> {
    this.albumLookups.push(albumId);

    const failure = this.takeFailure();
    if (failure) return failure;

    const found = this.albums[albumId];
    // The same refusal the real client produces for an unknown id: Deezer's
    // HTTP 200 with code 800, mapped to `not-found`. A fake that answered
    // something else would let a test pass over a path production fails on.
    return found
      ? { ok: true, value: found }
      : { ok: false, reason: 'not-found', message: 'no data' };
  }

  async track(trackId: number): Promise<DeezerResult<DeezerTrack>> {
    this.trackLookups.push(trackId);

    const failure = this.takeFailure();
    if (failure) return failure;

    // Resolved out of the same fixture the search answers from, so a widget
    // test cannot pick a recording the search never offered — which is exactly
    // the pairing Block 17b's D4 relies on.
    const found = this.tracks.find((track) => track.id === trackId);

    return found
      ? { ok: true, value: found }
      : { ok: false, reason: 'not-found', message: 'no data' };
  }
}
