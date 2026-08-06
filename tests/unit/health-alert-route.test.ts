import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Block 11b, D6. The alert path: one e-mail per incident, to a fixed address,
 * sent by the application because the database cannot speak SMTP.
 *
 * The service is mocked rather than driven -- what this file is about is the
 * gate in front of it and the decision of whether to send, not the two queries.
 */
const { findUnhealthyJobs, markJobAlerted } = vi.hoisted(() => ({
  findUnhealthyJobs: vi.fn(),
  markJobAlerted: vi.fn(),
}));
vi.mock('@/services/job-health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/job-health')>()),
  findUnhealthyJobs,
  markJobAlerted,
}));

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/mailer', () => ({
  DevMailer: class {
    send = send;
  },
  SmtpMailer: class {
    send = send;
  },
}));

// The real client would need a service-role key and a URL. Neither is what is
// under test here.
vi.mock('@/lib/supabase/service-client', () => ({ createServiceClient: () => ({}) }));

const SECRET = 'a-shared-secret-for-pg-cron';
process.env.WORKER_TICK_SECRET = SECRET;
process.env.ALERT_EMAIL = 'ops@example.test';

const { POST } = await import('@/app/api/worker/health-alert/route');

const post = (headers: Record<string, string>) =>
  POST(new Request('http://localhost/api/worker/health-alert', { method: 'POST', headers }));

const QUIET_SWEEP = {
  job_name: 'retention-sweep',
  last_success_at: '2026-07-01T04:11:00.000Z',
  last_started_at: '2026-07-01T04:11:00.000Z',
  last_counters: { total: 412 },
  alerted_at: null as string | null,
};

beforeEach(() => {
  findUnhealthyJobs.mockReset();
  findUnhealthyJobs.mockResolvedValue([QUIET_SWEEP]);
  markJobAlerted.mockReset();
  markJobAlerted.mockResolvedValue(undefined);
  send.mockReset();
  send.mockResolvedValue({ id: 'dev-1' });
});

describe('POST /api/worker/health-alert', () => {
  it('refuses without the shared secret, before reading anything', async () => {
    const response = await post({ 'x-worker-secret': 'wrong' });

    expect(response.status).toBe(401);
    // The check has to run BEFORE the work, and a handler that reads the
    // database and then returns 401 passes a status assertion while failing
    // this one.
    expect(findUnhealthyJobs).not.toHaveBeenCalled();
  });

  it('sends one message per unhealthy routine and stamps it', async () => {
    const response = await post({ 'x-worker-secret': SECRET });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]?.[0] as { to: string; subject: string; text: string };
    expect(message.to).toBe('ops@example.test');
    expect(message.subject).toContain('retention-sweep');
    // The last success and what it counted: "it is broken" without "and here is
    // what working looked like" starts every investigation from zero.
    expect(message.text).toContain('412');
    expect(markJobAlerted).toHaveBeenCalledWith(expect.anything(), 'retention-sweep');
  });

  it('says nothing twice about the same incident', async () => {
    // One e-mail per incident, not one per hour. The stamp is cleared by the
    // next success, which is what re-arms it.
    findUnhealthyJobs.mockResolvedValue([
      { ...QUIET_SWEEP, alerted_at: new Date().toISOString() },
    ]);

    await post({ 'x-worker-secret': SECRET });

    expect(send).not.toHaveBeenCalled();
    expect(markJobAlerted).not.toHaveBeenCalled();
  });

  it('reminds once a day while it stays broken', async () => {
    findUnhealthyJobs.mockResolvedValue([
      { ...QUIET_SWEEP, alerted_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() },
    ]);

    await post({ 'x-worker-secret': SECRET });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports that it is not configured rather than pretending to alert', async () => {
    delete process.env.ALERT_EMAIL;
    vi.resetModules();
    const { POST: unconfigured } = await import('@/app/api/worker/health-alert/route');

    const response = await unconfigured(
      new Request('http://localhost/api/worker/health-alert', {
        method: 'POST',
        headers: { 'x-worker-secret': SECRET },
      }),
    );

    // Not a 503: the caller did nothing wrong and there is nothing to retry.
    // Answered honestly so pg_net's stored response says why nothing happened.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false });
    expect(send).not.toHaveBeenCalled();

    process.env.ALERT_EMAIL = 'ops@example.test';
  });
});
