import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/service-client', () => ({ createServiceClient: () => ({ rpc }) }));

const album = vi.fn();
vi.mock('@/lib/integrations/deezer', () => ({
  deezerTransport: () => ({ album, search: vi.fn() }),
}));

const { POST } = await import('@/app/api/v1/music-requests/route');

const AUTHED = {
  data: [{ credential_id: 'c', company_id: 'co', organization_id: 'o', scope_ok: true }],
  error: null,
};
const ALLOWED = {
  data: [{ allowed: true, remaining: 9, reset_at: new Date(Date.now() + 60_000).toISOString() }],
  error: null,
};
const RECORDED = {
  data: {
    request_id: 'r1',
    created: true,
    song: { id: 's1', created: true, filled: [] },
    listener: { id: 'm1', created: true, linked: true },
  },
  error: null,
};

function post(body: unknown) {
  return new Request('https://example.test/api/v1/music-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ptx_x' },
    body: JSON.stringify(body),
  });
}

const BODY = {
  listener: { phone: '+5511999990001', name: 'Maria Silva' },
  song: {
    deezer: {
      id: 3135556,
      title: 'Harder, Better, Faster, Stronger',
      duration: 224,
      artist: { name: 'Daft Punk' },
      album: { id: 302127, title: 'Discovery', md5_image: 'a'.repeat(32) },
    },
  },
};

beforeEach(() => {
  rpc.mockReset();
  album.mockReset();
});

describe('POST /api/v1/music-requests', () => {
  it('enriches from /album/{id} and passes the label and genre to the door', async () => {
    // Design D7: /search carries no label, genre, UPC or release date. Without
    // this call the record enters missing all four.
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce(ALLOWED);
    album.mockResolvedValueOnce({
      ok: true,
      value: {
        id: 302127,
        title: 'Discovery',
        upc: '724384960650',
        label: 'Virgin',
        genreName: 'Electronic',
        releaseDate: '2001-03-07',
        coverMd5: 'a'.repeat(32),
      },
    });
    rpc.mockResolvedValueOnce(RECORDED);

    const response = await POST(post(BODY));
    expect(response.status).toBe(201);
    expect(album).toHaveBeenCalledWith(302127);
    const args = rpc.mock.calls.at(-1)![1];
    expect(args.p_label_name).toBe('Virgin');
    expect(args.p_genre_name).toBe('Electronic');
    expect(args.p_release_date).toBe('2001-03-07');
  });

  it('records the request anyway when Deezer refuses the album lookup', async () => {
    // Best effort, never fatal: a listener waiting on WhatsApp must not lose
    // their request because a second, enriching call hit a quota.
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce(ALLOWED);
    album.mockResolvedValueOnce({ ok: false, reason: 'quota', message: 'slow down' });
    rpc.mockResolvedValueOnce(RECORDED);

    const response = await POST(post(BODY));
    expect(response.status).toBe(201);
    expect(rpc.mock.calls.at(-1)![1].p_label_name).toBeUndefined();
  });

  it('does not call Deezer at all when the caller already sent a label and a genre', async () => {
    // The integrator did the work; Deezer's quota is per IP and shared by every
    // Station this server serves.
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce(RECORDED);

    await POST(post({ ...BODY, song: { ...BODY.song, label: 'Virgin', genre: 'Electronic' } }));
    expect(album).not.toHaveBeenCalled();
  });

  it('turns the door refusal for a nameless listener into 422', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce(ALLOWED);
    album.mockResolvedValueOnce({ ok: false, reason: 'network', message: 'nope' });
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'a new listener must arrive with a name' },
    });

    const response = await POST(post({ ...BODY, listener: { phone: '+5511999990001' } }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('listener_name_required');
  });

  it('turns the door refusal for an anonymised listener into 409', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce(ALLOWED);
    album.mockResolvedValueOnce({ ok: false, reason: 'network', message: 'nope' });
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23514', message: 'that listener has been anonymised' },
    });

    const response = await POST(post(BODY));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('listener_anonymized');
  });

  it('refuses a body with no listener phone', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED);
    const response = await POST(post({ ...BODY, listener: { name: 'Maria' } }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('invalid_payload');
  });
});
