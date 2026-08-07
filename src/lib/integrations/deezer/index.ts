import 'server-only';
import { createDeezerClient } from './client';
import { FakeDeezerTransport } from './fake';
import type { DeezerTransport } from './transport';

/**
 * Which transport the application uses, decided once.
 *
 * `DEEZER_FAKE=1` selects the fixture transport. It exists for the end-to-end
 * suite and for nothing else: a Playwright journey that reached the real
 * api.deezer.com would spend the platform's shared per-IP rate limit on every
 * CI run, depend on a third party being up to go green, and assert against a
 * catalogue that can change under it — three ways for a test to fail while the
 * code is correct.
 *
 * This is the same shape api/worker/tick/route.ts already uses to pick between
 * GraphTransport and WhatsApp's FakeTransport, with one difference worth
 * naming: WhatsApp falls back to its fake when the ACCESS TOKEN is missing,
 * because a missing token means "not configured". Deezer needs no credential
 * at all, so absence cannot mean anything here and the switch has to be
 * explicit. It is therefore opt-IN: an unset variable is the real client, and
 * no deployment can silently end up serving fixtures.
 */
export function deezerTransport(): DeezerTransport {
  if (process.env.DEEZER_FAKE === '1') return new FakeDeezerTransport(FIXTURES, ALBUMS);
  return createDeezerClient();
}

/**
 * What the fake answers. Two tracks off one album, which is enough for the
 * journey the e2e suite walks: register one, and see the second marked as
 * already registered once the first is saved.
 *
 * The cover hash is a real one from Deezer, because 0136's check constraint
 * accepts only 32 lower-case hex characters and a made-up value would fail the
 * insert for a reason that has nothing to do with what the journey tests.
 *
 * The preview URL is deliberately a plain, unsigned one: nothing plays it in a
 * headless run, and a fixture carrying a fake `hdnea=exp=…` would read as if
 * storing one were fine.
 */
const ALBUM_ID = 103763;
const COVER = '2a0f6ac6bc05458fb072275653f01dd2';

const FIXTURES = [
  {
    id: 921568,
    title: 'Sozinho (Ao Vivo)',
    artistName: 'Caetano Veloso',
    albumId: ALBUM_ID,
    albumTitle: 'Prenda Minha',
    coverMd5: COVER,
    durationSeconds: 191,
    isrc: 'BRPGD9800678',
    previewUrl: 'https://cdnt-preview.dzcdn.net/api/1/1/fixture-one.mp3',
  },
  {
    id: 921569,
    title: 'Prenda Minha (Ao Vivo)',
    artistName: 'Caetano Veloso',
    albumId: ALBUM_ID,
    albumTitle: 'Prenda Minha',
    coverMd5: COVER,
    durationSeconds: 205,
    isrc: 'BRPGD9800679',
    previewUrl: 'https://cdnt-preview.dzcdn.net/api/1/1/fixture-two.mp3',
  },
];

const ALBUMS = {
  [ALBUM_ID]: {
    id: ALBUM_ID,
    title: 'Prenda Minha',
    upc: '731453833227',
    label: 'Universal Music',
    genreName: 'Pop',
    releaseDate: '2014-06-17',
    coverMd5: COVER,
  },
};
