import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TickResult } from '@/services/whatsapp';

// runTick is mocked rather than driven, because what this file is about is the
// gate in front of it. Mocking it is also what makes "did the check run BEFORE
// the work?" answerable at all: a handler that drains both queues and then
// returns 401 passes a status-code assertion and fails the call-count one.
const { runTick } = vi.hoisted(() => ({ runTick: vi.fn() }));
vi.mock('@/services/whatsapp', () => ({ runTick }));

// Block 6b's erasure drain rides the same tick. Mocked for the same reason
// runTick is: this file is about the gate in front of both, not about either.
const { drainStorageErasures } = vi.hoisted(() => ({ drainStorageErasures: vi.fn() }));
vi.mock('@/lib/storage/erasure', () => ({ drainStorageErasures }));

// The real client would need a service-role key and a URL. Neither is what is
// under test here.
vi.mock('@/lib/supabase/service-client', () => ({ createServiceClient: () => ({}) }));

const SECRET = 'a-shared-secret-for-pg-cron';
process.env.WORKER_TICK_SECRET = SECRET;

const { POST } = await import('@/app/api/worker/tick/route');

const EMPTY_TICK: TickResult = {
  reclaimedEvents: 0,
  reclaimedMessages: 0,
  ingested: 3,
  skipped: 0,
  turns: 0,
  turnsBusy: 0,
  swept: 0,
  eventsFailed: 0,
  sent: 2,
  sendFailed: 0,
  sendAborted: false,
  dbErrors: 0,
};

const post = (headers: Record<string, string>) =>
  POST(new Request('http://localhost/api/worker/tick', { method: 'POST', headers }));

const NO_ERASURES = { deleted: 0, failed: 0 };

beforeEach(() => {
  runTick.mockReset();
  runTick.mockResolvedValue(EMPTY_TICK);
  drainStorageErasures.mockReset();
  drainStorageErasures.mockResolvedValue(NO_ERASURES);
});

describe('POST /api/worker/tick', () => {
  it('runs a tick and reports its counters when the secret matches', async () => {
    const response = await post({ 'x-worker-secret': SECRET });

    expect(response.status).toBe(200);
    // pg_net stores the response in net._http_response, and these numbers are
    // the only account of a tick anybody can read afterwards.
    expect(await response.json()).toEqual({ ...EMPTY_TICK, erasures: NO_ERASURES });
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it('reports a failing erasure drain instead of losing the tick with it', async () => {
    // The drain is an LGPD obligation riding a WhatsApp tick. If it throws, the
    // conversation counters are already computed and must still be reported --
    // a 500 here would hide a working tick behind a broken queue, and pg_net's
    // stored response is the only account anybody reads afterwards.
    drainStorageErasures.mockRejectedValue(new Error('storage is unreachable'));

    const response = await post({ 'x-worker-secret': SECRET });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...EMPTY_TICK,
      erasures: { error: 'storage is unreachable' },
    });
  });

  // M1. This endpoint drains both queues and its authentication is one header.
  // Without the check, anyone who finds the URL can run the worker — and,
  // because a tick is idempotent and quiet, can do it repeatedly without
  // leaving anything that looks like an attack.
  it('refuses a request with no secret at all, and does no work', async () => {
    const response = await post({});

    expect(response.status).toBe(401);
    expect(runTick).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret of the same length, and does no work', async () => {
    const wrong = 'X'.repeat(SECRET.length);
    expect(wrong).toHaveLength(SECRET.length);

    const response = await post({ 'x-worker-secret': wrong });

    expect(response.status).toBe(401);
    expect(runTick).not.toHaveBeenCalled();
  });

  // The length guard in front of timingSafeEqual, which throws on a mismatch
  // rather than returning false. Without it this is a 500 and a stack trace on
  // an endpoint anyone can reach.
  it('refuses a secret of the wrong length without throwing', async () => {
    const response = await post({ 'x-worker-secret': 'short' });

    expect(response.status).toBe(401);
    expect(runTick).not.toHaveBeenCalled();
  });

  // A deployment fault, not a caller fault. Draining queues for whoever asks
  // would be the alternative, so it refuses to serve and says which it is.
  it('refuses to serve at all when no secret is configured', async () => {
    vi.resetModules();
    delete process.env.WORKER_TICK_SECRET;
    const unconfigured = await import('@/app/api/worker/tick/route');

    const response = await unconfigured.POST(
      new Request('http://localhost/api/worker/tick', { method: 'POST' }),
    );

    expect(response.status).toBe(503);
    expect(runTick).not.toHaveBeenCalled();

    process.env.WORKER_TICK_SECRET = SECRET;
  });
});
