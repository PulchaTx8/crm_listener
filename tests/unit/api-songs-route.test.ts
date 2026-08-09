import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceClient: () => ({ rpc }),
}));

const { POST } = await import('@/app/api/v1/songs/route');

const AUTHED = {
  data: [{ credential_id: 'c', company_id: 'co', organization_id: 'o', scope_ok: true }],
  error: null,
};
const ALLOWED = {
  data: [{ allowed: true, remaining: 9, reset_at: new Date(Date.now() + 60_000).toISOString() }],
  error: null,
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://example.test/api/v1/songs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => rpc.mockReset());

describe('POST /api/v1/songs', () => {
  it('refuses a request with no Authorization header', async () => {
    const response = await POST(post({ title: 'A', artist: 'B' }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('unauthorized');
  });

  it('refuses a body that is not declared as JSON, before reading it', async () => {
    const response = await POST(
      new Request('https://example.test/api/v1/songs', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', authorization: 'Bearer ptx_x' },
        body: 'hello',
      }),
    );
    expect(response.status).toBe(415);
  });

  it('answers 403 when the key is valid but lacks the scope', async () => {
    rpc.mockResolvedValueOnce({
      data: [{ credential_id: 'c', company_id: 'co', organization_id: 'o', scope_ok: false }],
      error: null,
    });
    const response = await POST(
      post({ title: 'A', artist: 'B' }, { authorization: 'Bearer ptx_x' }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden_scope');
  });

  it('answers 201 with the new song, and echoes the request id', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce({
      data: { song_id: 's1', created: true, filled: [], references: {} },
      error: null,
    });

    const response = await POST(
      post({ title: 'A', artist: 'B' }, {
        authorization: 'Bearer ptx_x',
        'x-request-id': 'trace-1',
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('trace-1');
    expect((await response.json()).song_id).toBe('s1');
  });

  it('answers 200 rather than 201 when the song was already there', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce({
      data: { song_id: 's1', created: false, filled: ['isrc'], references: {} },
      error: null,
    });

    const response = await POST(
      post({ title: 'A', artist: 'B' }, { authorization: 'Bearer ptx_x' }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).filled).toEqual(['isrc']);
  });

  it('answers 422 naming the offending path when the body is wrong', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED);

    const response = await POST(post({ title: 'A' }, { authorization: 'Bearer ptx_x' }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe('invalid_payload');
    expect(body.error.details.some((d: { path: string }) => d.path === 'artist')).toBe(true);
  });

  it('answers 429 with Retry-After when the credential is over its limit', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce({
      data: [{ allowed: false, remaining: 0, reset_at: new Date(Date.now() + 30_000).toISOString() }],
      error: null,
    });

    const response = await POST(
      post({ title: 'A', artist: 'B' }, { authorization: 'Bearer ptx_x' }),
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('never leaks raw database text on an unexpected failure', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce({
      data: null,
      error: { code: 'XX000', message: 'relation "public.secret_table" does not exist' },
    });

    const response = await POST(
      post({ title: 'A', artist: 'B' }, { authorization: 'Bearer ptx_x' }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain('secret_table');
  });
});
