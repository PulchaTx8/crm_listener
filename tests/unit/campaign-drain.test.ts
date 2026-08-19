import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import type { MessagingProvider, SendJob, SendOutcome } from '@/lib/messaging/provider';

/**
 * `env` (src/lib/env.ts) is computed once, at module import, from
 * `process.env` -- the same reason tests/unit/whatsapp-link.test.ts imports
 * its module under test dynamically, after this line, rather than with a
 * static `import`. `@/services/whatsapp` is a VALUE import too (not `import
 * type`), and it reaches `@/lib/env` transitively through
 * `@/services/conversation` -> `@/services/whatsapp-link` -- a static import
 * of it above this line would evaluate `env` before this assignment ever
 * runs, since static imports are hoisted above every other statement in the
 * module regardless of source order.
 */
process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.test';

const { BACKOFF_SECONDS, MAX_ATTEMPTS, MAX_CONSECUTIVE_SEND_FAILURES } = await import('@/services/whatsapp');
const { drainCampaigns } = await import('@/services/campaigns');

// ---------------------------------------------------------------------------
// A Supabase client that records instead of talking to one, in the same
// spirit as tests/unit/whatsapp-worker.test.ts's own FakeDb, generalized to
// the several distinct tables/RPCs this drain touches.
//
// `callLog` is ONE shared, ordered log every RPC and every write/read
// resolution pushes into (at the same point the operation would actually run
// in production -- an RPC call, or a `.then()` on a chain), so ordering
// between DIFFERENT kinds of call (an RPC and a table update) can be proven
// from a single array rather than compared across two separate ones that
// happen to both be zero.
//
// `bump_campaign_counters` is modeled STATEFULLY, seeded from each fixture
// campaign's own counts and accumulated across calls -- the one behaviour
// (Fix round 1, Item 2) this drain now depends on for correctness, so a fake
// that could not fail to accumulate would let a regression back to a plain
// overwrite pass silently.
// ---------------------------------------------------------------------------

interface ClaimedRow {
  id: string;
  campaign_id: string;
  channel: 'WHATSAPP' | 'EMAIL';
  address: string | null;
  variables: unknown;
  attempts: number;
  company_id: string | null;
  template_name: string | null;
  template_language: string | null;
  body: string | null;
  subject: string | null;
}

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

interface SelectCall {
  table: string;
  columns: string;
  filters: Array<[string, unknown]>;
}

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface CompanyRow {
  id: string;
  name: string;
  thumb_url: string | null;
  email_from_name: string | null;
  email_from_address: string | null;
  email_reply_to: string | null;
}

interface IntegrationRow {
  company_id: string;
  phone_number_id: string;
}

interface CampaignRow {
  id: string;
  status: string;
  sent_count: number;
  failed_count: number;
  suppressed_count: number;
  template_id: string;
}

interface TemplateRow {
  id: string;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  otp_button: boolean;
}

interface Fixture {
  claimBatch?: ClaimedRow[];
  memberByRowId?: Record<string, string>;
  companies?: CompanyRow[];
  integrations?: IntegrationRow[];
  campaigns?: CampaignRow[];
  templates?: TemplateRow[];
  /** member_id -> eligible. Absent members default to eligible. */
  eligible?: Record<string, boolean>;
  /** campaign_id -> rows still pending/claimed, for the finish check. */
  remaining?: Record<string, unknown[]>;
  issueTokenError?: string;
  /** rowId -> error message, to make that row's own settle write fail. */
  settleErrors?: Record<string, string>;
}

class FakeDb {
  readonly rpcCalls: RpcCall[] = [];
  readonly updateCalls: UpdateCall[] = [];
  readonly selectCalls: SelectCall[] = [];
  readonly callLog: string[] = [];
  private claimed = false;
  private readonly campaignCounters = new Map<
    string,
    { sent_count: number; failed_count: number; suppressed_count: number }
  >();
  /**
   * Seeded from each fixture campaign's own `status` and kept live as writes
   * land, so a `message_campaigns` update carrying an `eq:status`/`in:status`
   * guard can be resolved the way a real WHERE clause would: a guard that
   * does not match the row's CURRENT status matches zero rows, and a real
   * PostgREST caller sees `{error: null}` regardless -- indistinguishable
   * from an ordinary success. Simulating that (rather than recording every
   * attempted update unconditionally) is what lets a test assert on what
   * actually reached the database, not on what the drain merely tried.
   */
  private readonly campaignStatus = new Map<string, string>();

  constructor(private readonly fx: Fixture = {}) {
    for (const c of fx.campaigns ?? []) {
      this.campaignCounters.set(c.id, {
        sent_count: c.sent_count,
        failed_count: c.failed_count,
        suppressed_count: c.suppressed_count,
      });
      this.campaignStatus.set(c.id, c.status);
    }
  }

  rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args });
    this.callLog.push(`rpc:${fn}`);

    if (fn === 'claim_campaign_batch') {
      if (this.claimed) return Promise.resolve({ data: [], error: null });
      this.claimed = true;
      return Promise.resolve({ data: this.fx.claimBatch ?? [], error: null });
    }
    if (fn === 'members_marketing_eligible_bulk_for_worker') {
      const memberIds = (args.p_member_ids as string[]) ?? [];
      const data = memberIds.map((id) => ({ member_id: id, eligible: this.fx.eligible?.[id] ?? true }));
      return Promise.resolve({ data, error: null });
    }
    if (fn === 'issue_unsubscribe_token') {
      if (this.fx.issueTokenError) {
        return Promise.resolve({ data: null, error: { message: this.fx.issueTokenError } });
      }
      return Promise.resolve({ data: 'unsubscribe-token-id', error: null });
    }
    if (fn === 'bump_campaign_counters') {
      // Mirrors 0247's own SQL exactly: read the row's current counters,
      // add this call's deltas, write the sum back, return the new totals --
      // stateful across calls within one FakeDb, so two calls against the
      // SAME campaign accumulate rather than each starting from the
      // fixture's original numbers.
      const campaignId = args.p_campaign_id as string;
      const current = this.campaignCounters.get(campaignId) ?? {
        sent_count: 0,
        failed_count: 0,
        suppressed_count: 0,
      };
      const next = {
        sent_count: current.sent_count + (args.p_sent as number),
        failed_count: current.failed_count + (args.p_failed as number),
        suppressed_count: current.suppressed_count + (args.p_suppressed as number),
      };
      this.campaignCounters.set(campaignId, next);
      return Promise.resolve({ data: [next], error: null });
    }
    throw new Error(`unexpected rpc: ${fn}`);
  }

  from(table: string) {
    const db = this;
    return {
      select: (columns: string) => db.chain(table, 'select', columns),
      update: (patch: Record<string, unknown>) => db.chain(table, 'update', undefined, patch),
    };
  }

  private chain(
    table: string,
    mode: 'select' | 'update',
    columns?: string,
    patch?: Record<string, unknown>,
  ) {
    const filters: Array<[string, unknown]> = [];
    const db = this;
    const builder = {
      eq: (col: string, val: unknown) => {
        filters.push([`eq:${col}`, val]);
        return builder;
      },
      in: (col: string, vals: unknown) => {
        filters.push([`in:${col}`, vals]);
        return builder;
      },
      is: (col: string, val: unknown) => {
        filters.push([`is:${col}`, val]);
        return builder;
      },
      lt: (col: string, val: unknown) => {
        filters.push([`lt:${col}`, val]);
        return builder;
      },
      limit: (n: number) => {
        filters.push(['limit', n]);
        return builder;
      },
      then: (onfulfilled: (v: unknown) => unknown, onrejected?: (r: unknown) => unknown) => {
        const result =
          mode === 'update'
            ? db.resolveUpdate(table, patch ?? {}, filters)
            : db.resolveSelect(table, columns ?? '', filters);
        return Promise.resolve(result).then(onfulfilled, onrejected);
      },
    };
    return builder;
  }

  private resolveUpdate(table: string, patch: Record<string, unknown>, filters: Array<[string, unknown]>) {
    if (table === 'message_campaigns') {
      const campaignId = filters.find(([k]) => k === 'eq:id')?.[1] as string | undefined;
      const allowedStatuses = filters.find(([k]) => k === 'in:status')?.[1] as string[] | undefined;
      const requiredStatus = filters.find(([k]) => k === 'eq:status')?.[1] as string | undefined;
      const currentStatus = campaignId ? this.campaignStatus.get(campaignId) : undefined;

      const guardPasses =
        (!allowedStatuses || (currentStatus !== undefined && allowedStatuses.includes(currentStatus))) &&
        (!requiredStatus || currentStatus === requiredStatus);

      if (!guardPasses) {
        // Zero rows matched -- nothing recorded, the same as it would leave
        // no trace in a real database. NOT an error: PostgREST answers a
        // guard that matched nothing exactly the way it answers success.
        return { error: null };
      }
      if (campaignId && typeof patch.status === 'string') {
        this.campaignStatus.set(campaignId, patch.status as string);
      }
    }

    this.updateCalls.push({ table, patch, filters });

    const rowId = filters.find(([k]) => k === 'eq:id')?.[1] as string | undefined;
    this.callLog.push(rowId ? `update:${table}:${rowId}` : `update:${table}`);

    if (table === 'message_campaign_recipients' && rowId) {
      const failure = this.fx.settleErrors?.[rowId];
      if (failure) return { error: { message: failure } };
    }
    return { error: null };
  }

  private resolveSelect(table: string, columns: string, filters: Array<[string, unknown]>) {
    this.selectCalls.push({ table, columns, filters });
    this.callLog.push(`select:${table}`);

    if (table === 'message_campaign_recipients' && columns.includes('member_id')) {
      const ids = (filters.find(([k]) => k === 'in:id')?.[1] as string[]) ?? [];
      const data = ids.map((id) => ({ id, member_id: this.fx.memberByRowId?.[id] ?? null }));
      return { data, error: null };
    }
    if (table === 'message_campaign_recipients' && columns === 'campaign_id') {
      // Item 1(b), fix round 1. finalizeEmptyRunningCampaigns' own bulk
      // "is this campaign still active" check: `select('campaign_id')
      // .in('campaign_id', runningIds).in('status', ['pending', 'claimed'])`.
      // Reuses `fx.remaining` -- the SAME fixture the per-campaign finish
      // check below already reads -- rather than a second fixture field
      // meaning the identical thing under a different name.
      const campaignIds = (filters.find(([k]) => k === 'in:campaign_id')?.[1] as string[]) ?? [];
      const data = campaignIds
        .filter((id) => (this.fx.remaining?.[id] ?? []).length > 0)
        .map((id) => ({ campaign_id: id }));
      return { data, error: null };
    }
    if (table === 'message_campaign_recipients') {
      // The finish check: `select('id').eq('campaign_id', x).in('status', [...])`.
      const campaignId = filters.find(([k]) => k === 'eq:campaign_id')?.[1] as string;
      const data = this.fx.remaining?.[campaignId] ?? [];
      return { data, error: null };
    }
    if (table === 'companies') return { data: this.fx.companies ?? [], error: null };
    if (table === 'integrations') return { data: this.fx.integrations ?? [], error: null };
    if (table === 'message_campaigns' && columns === 'id') {
      // Item 1(b), fix round 1. finalizeEmptyRunningCampaigns' own
      // `select('id').eq('status', 'running')`. Reads `this.campaignStatus`
      // -- the LIVE map, kept current by every status-changing update this
      // FakeDb has resolved so far -- rather than the static `fx.campaigns`
      // seed: this query runs AFTER this tick's own batch loop (drainCampaigns'
      // own ordering), so a campaign the batch loop already finished this
      // same tick must already read back as no-longer-running here, the same
      // as it would against a real database.
      const status = filters.find(([k]) => k === 'eq:status')?.[1] as string | undefined;
      const data = [...this.campaignStatus.entries()]
        .filter(([, s]) => !status || s === status)
        .map(([id]) => ({ id }));
      return { data, error: null };
    }
    if (table === 'message_campaigns') return { data: this.fx.campaigns ?? [], error: null };
    if (table === 'message_templates') return { data: this.fx.templates ?? [], error: null };
    throw new Error(`unexpected select on ${table}`);
  }
}

function asClient(db: FakeDb): SupabaseClient<Database> {
  return db as unknown as SupabaseClient<Database>;
}

/** Returns each scripted outcome in turn, then repeats the last one. */
function scriptedProvider(...outcomes: SendOutcome[]): MessagingProvider & { calls: SendJob[] } {
  const calls: SendJob[] = [];
  let index = 0;
  return {
    calls,
    async send(job: SendJob): Promise<SendOutcome> {
      calls.push(job);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return outcome ?? { ok: true, providerMessageId: 'fallback' };
    },
  };
}

const BASE_CAMPAIGN: CampaignRow = {
  id: 'campaign-1',
  status: 'running',
  sent_count: 0,
  failed_count: 0,
  suppressed_count: 0,
  template_id: 'template-1',
};

const BASE_TEMPLATE: TemplateRow = {
  id: 'template-1',
  from_name: null,
  from_email: null,
  reply_to: null,
  otp_button: false,
};

const BASE_COMPANY: CompanyRow = {
  id: 'company-1',
  name: 'Rádio Alvorada',
  thumb_url: null,
  email_from_name: null,
  email_from_address: null,
  email_reply_to: null,
};

function emailRow(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    id: 'row-1',
    campaign_id: 'campaign-1',
    channel: 'EMAIL',
    address: 'listener@example.com',
    variables: [],
    attempts: 0,
    company_id: 'company-1',
    template_name: null,
    template_language: null,
    body: 'Ola!',
    subject: 'Promo',
    ...overrides,
  };
}

function whatsappRow(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    id: 'row-1',
    campaign_id: 'campaign-1',
    channel: 'WHATSAPP',
    address: '+5511999999999',
    variables: ['Maria'],
    attempts: 0,
    company_id: 'company-1',
    template_name: 'promo_template',
    template_language: 'pt_BR',
    body: null,
    subject: null,
    ...overrides,
  };
}

describe('drainCampaigns — the consent re-check', () => {
  it('suppresses a recipient whose consent was withdrawn since the snapshot, and never calls the provider', async () => {
    const db = new FakeDb({
      claimBatch: [emailRow({ id: 'row-1' })],
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      eligible: { 'member-1': false },
      remaining: { 'campaign-1': [] },
    });

    const emailProvider = scriptedProvider();
    const result = await drainCampaigns(asClient(db), { emailProvider });

    expect(emailProvider.calls).toEqual([]);
    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0, suppressed: 1, dbErrors: 0 });

    const settle = db.updateCalls.find((c) => c.table === 'message_campaign_recipients' && c.filters.some(([k, v]) => k === 'eq:id' && v === 'row-1'));
    expect(settle?.patch).toEqual({ status: 'suppressed' });
  });
});

describe('drainCampaigns — retry, permanence and the drain-wide park', () => {
  it('returns a retryable failure to pending with the next backoff', async () => {
    const db = new FakeDb({
      claimBatch: [whatsappRow({ id: 'row-1', attempts: 1 })],
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      integrations: [{ company_id: 'company-1', phone_number_id: 'phone-1' }],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const whatsappProvider = scriptedProvider({
      ok: false,
      retryable: true,
      code: 'whatsapp_retryable_error',
      description: 'temporary',
    });

    const before = Date.now();
    const result = await drainCampaigns(asClient(db), { whatsappProvider });
    // Fix round 1, ITEM 1. A row still `pending` -- still working -- must
    // never count against the campaign's own `failed` outcome.
    expect(result.failed).toBe(0);

    const settle = db.updateCalls.find((c) => c.filters.some(([k, v]) => k === 'eq:id' && v === 'row-1'));
    expect(settle?.patch.status).toBe('pending');
    expect(settle?.patch.attempts).toBe(2);

    const nextAttemptAt = new Date(settle?.patch.next_attempt_at as string).getTime();
    // attempts was 1 before this send, so the next rung is BACKOFF_SECONDS[1].
    const expectedDelayMs = BACKOFF_SECONDS[1] * 1000;
    expect(nextAttemptAt).toBeGreaterThanOrEqual(before + expectedDelayMs);

    // Fix round 1, ITEM 2. A row still retrying must not have moved the
    // campaign's own failed_count at all -- bump_campaign_counters was never
    // called with a non-zero p_failed for it.
    const bump = db.rpcCalls.find((c) => c.fn === 'bump_campaign_counters');
    expect(bump?.args).toMatchObject({ p_sent: 0, p_failed: 0, p_suppressed: 0 });
  });

  it('marks a retryable failure as failed once the ladder is exhausted, rather than retrying forever', async () => {
    // Fix round 1, Minor. The one settle path the old assertion
    // (`toBeLessThan(MAX_ATTEMPTS)`, true of any implementation) proved
    // nothing about: a row at the LAST rung -- nextAttemptDelay(attempts)
    // returns undefined once attempts reaches BACKOFF_SECONDS.length, and
    // MAX_ATTEMPTS is defined as exactly that length plus one -- must come
    // out `failed`, not `pending` forever.
    expect(MAX_ATTEMPTS).toBe(BACKOFF_SECONDS.length + 1);

    const db = new FakeDb({
      claimBatch: [whatsappRow({ id: 'row-1', attempts: BACKOFF_SECONDS.length })],
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      integrations: [{ company_id: 'company-1', phone_number_id: 'phone-1' }],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const whatsappProvider = scriptedProvider({
      ok: false,
      retryable: true,
      code: 'whatsapp_retryable_error',
      description: 'temporary',
    });

    const result = await drainCampaigns(asClient(db), { whatsappProvider });
    expect(result.failed).toBe(1);

    const settle = db.updateCalls.find((c) => c.filters.some(([k, v]) => k === 'eq:id' && v === 'row-1'));
    expect(settle?.patch).toMatchObject({ status: 'failed', attempts: BACKOFF_SECONDS.length + 1 });
    expect(settle?.patch.next_attempt_at).toBeUndefined();
  });

  it('marks a permanent failure as failed and never retries it', async () => {
    const db = new FakeDb({
      claimBatch: [whatsappRow({ id: 'row-1', attempts: 0 })],
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      integrations: [{ company_id: 'company-1', phone_number_id: 'phone-1' }],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const whatsappProvider = scriptedProvider({
      ok: false,
      retryable: false,
      code: 'whatsapp_permanent_error',
      description: 'bad number',
    });

    const result = await drainCampaigns(asClient(db), { whatsappProvider });
    expect(result.failed).toBe(1);

    const settle = db.updateCalls.find((c) => c.filters.some(([k, v]) => k === 'eq:id' && v === 'row-1'));
    expect(settle?.patch).toMatchObject({
      status: 'failed',
      attempts: 1,
      error_code: 'whatsapp_permanent_error',
    });
    expect(settle?.patch.next_attempt_at).toBeUndefined();
  });

  it('parks the whole drain after MAX_CONSECUTIVE_SEND_FAILURES retryable failures in a row', async () => {
    const rows = Array.from({ length: MAX_CONSECUTIVE_SEND_FAILURES + 2 }, (_, i) =>
      whatsappRow({ id: `row-${i}`, address: `+551199900000${i}` }),
    );
    const db = new FakeDb({
      claimBatch: rows,
      memberByRowId: Object.fromEntries(rows.map((r) => [r.id, `member-${r.id}`])),
      companies: [BASE_COMPANY],
      integrations: [{ company_id: 'company-1', phone_number_id: 'phone-1' }],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const whatsappProvider = scriptedProvider({
      ok: false,
      retryable: true,
      code: 'whatsapp_retryable_error',
      description: 'temporary',
    });

    await drainCampaigns(asClient(db), { whatsappProvider });

    // The batch held more rows than the failure threshold; the drain must have
    // stopped calling the provider once the threshold was reached rather than
    // burning every row's ladder on the same outage.
    expect(whatsappProvider.calls.length).toBe(MAX_CONSECUTIVE_SEND_FAILURES);
  });
});

describe('drainCampaigns — the unsubscribe link', () => {
  it('mints a distinct unsubscribe token for each e-mail recipient, labelled with the campaign', async () => {
    const rows = [
      emailRow({ id: 'row-1', address: 'a@example.com' }),
      emailRow({ id: 'row-2', address: 'b@example.com' }),
    ];
    const db = new FakeDb({
      claimBatch: rows,
      memberByRowId: { 'row-1': 'member-1', 'row-2': 'member-2' },
      companies: [BASE_COMPANY],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const emailProvider = scriptedProvider({ ok: true, providerMessageId: 'm-1' }, { ok: true, providerMessageId: 'm-2' });
    await drainCampaigns(asClient(db), { emailProvider });

    const tokenCalls = db.rpcCalls.filter((c) => c.fn === 'issue_unsubscribe_token');
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls.map((c) => c.args.p_member_id).sort()).toEqual(['member-1', 'member-2']);

    // Fix round 1, ITEM 4. Without a campaign label, member_consents.origin
    // (0232) records the bare string "unsubscribe:" with nothing naming which
    // campaign. Every mint must carry one identifying this campaign.
    for (const call of tokenCalls) {
      expect(call.args.p_campaign_label).toBe('campaign-1');
    }

    const hashes = tokenCalls.map((c) => c.args.p_token_hash);
    expect(new Set(hashes).size).toBe(2);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);

    expect(emailProvider.calls).toHaveLength(2);
    for (const job of emailProvider.calls) {
      if (job.channel === 'EMAIL') expect(job.unsubscribe?.url).toMatch(/\/unsubscribe\//);
    }
  });

  it('fails the row rather than sending with no unsubscribe link when NEXT_PUBLIC_SITE_URL is unset', async () => {
    // Fix round 1, ITEM 5. Isolated with its own dynamic import, exactly the
    // "no site URL" shape tests/unit/whatsapp-link.test.ts already uses: env
    // is a module singleton, so this has to run against a copy that never
    // saw the top-of-file assignment.
    const original = process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    vi.resetModules();
    const { drainCampaigns: drainWithNoSiteUrl } = await import('@/services/campaigns');

    try {
      const db = new FakeDb({
        claimBatch: [emailRow({ id: 'row-1' })],
        memberByRowId: { 'row-1': 'member-1' },
        companies: [BASE_COMPANY],
        campaigns: [BASE_CAMPAIGN],
        templates: [BASE_TEMPLATE],
        remaining: { 'campaign-1': [] },
      });
      const emailProvider = scriptedProvider();

      const result = await drainWithNoSiteUrl(asClient(db), { emailProvider });

      expect(emailProvider.calls).toEqual([]);
      expect(db.rpcCalls.some((c) => c.fn === 'issue_unsubscribe_token')).toBe(false);
      expect(result.failed).toBe(1);
      const settle = db.updateCalls.find((c) => c.filters.some(([k, v]) => k === 'eq:id' && v === 'row-1'));
      expect(settle?.patch).toMatchObject({ status: 'failed', error_code: 'no_unsubscribe_base_url' });
      // Not retryable: nothing about time passing fixes a missing env var.
      expect(settle?.patch.next_attempt_at).toBeUndefined();
    } finally {
      process.env.NEXT_PUBLIC_SITE_URL = original;
      vi.resetModules();
    }
  });
});

describe('drainCampaigns — the e-mail body and subject are substituted by name', () => {
  it('fills {{listener_first_name}}-style placeholders from the recipient’s own snapshot', async () => {
    const rows = [
      emailRow({
        id: 'row-1',
        body: 'Oi {{listener_first_name}}, tudo bem?',
        subject: 'Oferta para {{listener_first_name}}',
        variables: [{ name: 'LISTENER_FIRST_NAME', value: 'Maria' }],
      }),
    ];
    const db = new FakeDb({
      claimBatch: rows,
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const emailProvider = scriptedProvider({ ok: true, providerMessageId: 'm-1' });
    const result = await drainCampaigns(asClient(db), { emailProvider });

    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, suppressed: 0, dbErrors: 0 });
    expect(emailProvider.calls).toHaveLength(1);
    const job = emailProvider.calls[0]!;
    if (job.channel !== 'EMAIL') throw new Error('expected an EMAIL job');
    expect(job.body).toBe('Oi Maria, tudo bem?');
    expect(job.subject).toBe('Oferta para Maria');
  });

  it('fails the row, never blanking it, when the body names a placeholder the snapshot has no value for', async () => {
    const rows = [
      emailRow({
        id: 'row-1',
        body: 'Oi {{listener_first_name}}!',
        subject: 'Promo',
        variables: [],
      }),
    ];
    const db = new FakeDb({
      claimBatch: rows,
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const emailProvider = scriptedProvider();
    const result = await drainCampaigns(asClient(db), { emailProvider });

    expect(emailProvider.calls).toEqual([]);
    expect(result.failed).toBe(1);
    const settle = db.updateCalls.find((c) => c.filters.some(([k, v]) => k === 'eq:id' && v === 'row-1'));
    expect(settle?.patch).toMatchObject({ status: 'failed', error_code: 'unresolved_email_variable' });
    // Permanent: no value in the snapshot will appear by retrying.
    expect(settle?.patch.next_attempt_at).toBeUndefined();
  });
});

describe('drainCampaigns — the reclaim', () => {
  it('resets a stale claim to pending before claiming a new batch', async () => {
    const db = new FakeDb({ claimBatch: [], remaining: {} });
    await drainCampaigns(asClient(db));

    // Fix round 1, ITEM 7. ONE shared, ordered log -- not two separately
    // indexed arrays that are both simply `0` regardless of which ran
    // first. `findIndex` over this single array is the only way inverting
    // the two calls in production code can make this assertion fail.
    const reclaimIndex = db.callLog.findIndex((c) => c.startsWith('update:message_campaign_recipients'));
    const claimIndex = db.callLog.findIndex((c) => c === 'rpc:claim_campaign_batch');
    expect(reclaimIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(reclaimIndex).toBeLessThan(claimIndex);
  });
});

describe('drainCampaigns — resolving once per group', () => {
  it('resolves Station identity and template once per BATCH, not once per row within a group', async () => {
    const rows = [
      emailRow({ id: 'row-1', address: 'a@example.com' }),
      emailRow({ id: 'row-2', address: 'b@example.com' }),
      emailRow({ id: 'row-3', address: 'c@example.com' }),
    ];
    const db = new FakeDb({
      claimBatch: rows,
      memberByRowId: { 'row-1': 'member-1', 'row-2': 'member-2', 'row-3': 'member-3' },
      companies: [BASE_COMPANY],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const emailProvider = scriptedProvider({ ok: true, providerMessageId: 'm' });
    await drainCampaigns(asClient(db), { emailProvider });

    const companySelects = db.selectCalls.filter((c) => c.table === 'companies');
    const templateSelects = db.selectCalls.filter((c) => c.table === 'message_templates');
    // Filtered on loadCampaignInfo's own column list, deliberately, rather
    // than on the table alone: Item 1(b), fix round 1 added a SECOND,
    // unrelated `message_campaigns` select every tick
    // (finalizeEmptyRunningCampaigns' own `select('id').eq('status',
    // 'running')`, columns 'id' rather than 'id, status, template_id') that
    // this test is not about and would otherwise fail it by coincidence.
    const campaignSelects = db.selectCalls.filter(
      (c) => c.table === 'message_campaigns' && c.columns === 'id, status, template_id',
    );

    expect(companySelects).toHaveLength(1);
    expect(templateSelects).toHaveLength(1);
    expect(campaignSelects).toHaveLength(1);
    expect(emailProvider.calls).toHaveLength(3);
  });

  it('resolves once per DISTINCT group, proven with two campaigns at two Stations', async () => {
    // Fix round 1, Minor. One campaign at one company (the test above) cannot
    // tell "once per batch" apart from "once per campaign" -- both would
    // produce exactly one select either way. Two campaigns at two Stations
    // is the case that actually discriminates them: still exactly one
    // `companies` select and one `message_campaigns` select, covering BOTH
    // groups, because each is `.in(...)` over every distinct id in the whole
    // claimed batch rather than issued per group.
    const companyTwo: CompanyRow = { ...BASE_COMPANY, id: 'company-2', name: 'Rádio Horizonte' };
    const campaignTwo: CampaignRow = { ...BASE_CAMPAIGN, id: 'campaign-2', template_id: 'template-1' };

    const rows = [
      emailRow({ id: 'row-1', campaign_id: 'campaign-1', company_id: 'company-1', address: 'a@example.com' }),
      emailRow({ id: 'row-2', campaign_id: 'campaign-2', company_id: 'company-2', address: 'b@example.com' }),
    ];
    const db = new FakeDb({
      claimBatch: rows,
      memberByRowId: { 'row-1': 'member-1', 'row-2': 'member-2' },
      companies: [BASE_COMPANY, companyTwo],
      campaigns: [BASE_CAMPAIGN, campaignTwo],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [], 'campaign-2': [] },
    });

    const emailProvider = scriptedProvider({ ok: true, providerMessageId: 'm' });
    await drainCampaigns(asClient(db), { emailProvider });

    expect(db.selectCalls.filter((c) => c.table === 'companies')).toHaveLength(1);
    // Same exclusion as the test above: loadCampaignInfo's own select only.
    expect(
      db.selectCalls.filter((c) => c.table === 'message_campaigns' && c.columns === 'id, status, template_id'),
    ).toHaveLength(1);
    expect(emailProvider.calls).toHaveLength(2);
  });
});

describe('drainCampaigns — a settle write that fails at the database', () => {
  it('records a dbError and lets the OTHER rows in the same group still settle and finalize', async () => {
    // Fix round 1, ITEM 3. Before this fix, settleRow threw, which aborted
    // the per-row loop and skipped the finalizeCampaign call below it --
    // discarding every already-tallied delta for the whole group, not only
    // the one row whose write failed.
    const rows = [
      emailRow({ id: 'row-1', address: 'a@example.com' }),
      emailRow({ id: 'row-2', address: 'b@example.com' }),
    ];
    const db = new FakeDb({
      claimBatch: rows,
      memberByRowId: { 'row-1': 'member-1', 'row-2': 'member-2' },
      companies: [BASE_COMPANY],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
      settleErrors: { 'row-1': 'connection reset' },
    });

    const emailProvider = scriptedProvider({ ok: true, providerMessageId: 'm-1' }, { ok: true, providerMessageId: 'm-2' });
    const result = await drainCampaigns(asClient(db), { emailProvider });

    expect(result.dbErrors).toBe(1);
    // row-1's send outcome is real (the provider WAS called and it DID
    // succeed) but is not counted, because it was never durably recorded --
    // counting it here and again whenever the reclaim returns this still-
    // `claimed` row would double it in the campaign's own counters.
    expect(result.sent).toBe(1);

    const bump = db.rpcCalls.find((c) => c.fn === 'bump_campaign_counters');
    expect(bump?.args).toMatchObject({ p_sent: 1, p_failed: 0, p_suppressed: 0 });
  });
});

describe('drainCampaigns — finalizeCampaign', () => {
  it('moves a queued campaign to running with started_at on its first claimed row', async () => {
    const queuedCampaign: CampaignRow = { ...BASE_CAMPAIGN, status: 'queued' };
    const db = new FakeDb({
      claimBatch: [emailRow({ id: 'row-1' })],
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      campaigns: [queuedCampaign],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const emailProvider = scriptedProvider({ ok: true, providerMessageId: 'm' });
    await drainCampaigns(asClient(db), { emailProvider });

    const transition = db.updateCalls.find(
      (c) =>
        c.table === 'message_campaigns' &&
        c.filters.some(([k, v]) => k === 'eq:status' && v === 'queued') &&
        c.patch.status === 'running',
    );
    expect(transition).toBeDefined();
    expect(typeof transition?.patch.started_at).toBe('string');
  });

  it('bumps the counters and finishes the campaign `sent` once nothing pending or claimed remains', async () => {
    const seeded: CampaignRow = { ...BASE_CAMPAIGN, sent_count: 10, failed_count: 2, suppressed_count: 1 };
    const db = new FakeDb({
      claimBatch: [emailRow({ id: 'row-1' })],
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      campaigns: [seeded],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const emailProvider = scriptedProvider({ ok: true, providerMessageId: 'm' });
    await drainCampaigns(asClient(db), { emailProvider });

    const bump = db.rpcCalls.find((c) => c.fn === 'bump_campaign_counters');
    expect(bump?.args).toEqual({ p_campaign_id: 'campaign-1', p_sent: 1, p_failed: 0, p_suppressed: 0 });

    const finish = db.updateCalls.find(
      (c) => c.table === 'message_campaigns' && typeof c.patch.finished_at === 'string',
    );
    expect(finish?.patch.status).toBe('sent');
  });

  it('finishes `failed` when the empty queue leaves nothing sent and something failed', async () => {
    const db = new FakeDb({
      claimBatch: [whatsappRow({ id: 'row-1', attempts: 0 })],
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      integrations: [{ company_id: 'company-1', phone_number_id: 'phone-1' }],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const whatsappProvider = scriptedProvider({
      ok: false,
      retryable: false,
      code: 'whatsapp_permanent_error',
      description: 'bad number',
    });
    await drainCampaigns(asClient(db), { whatsappProvider });

    const finish = db.updateCalls.find(
      (c) => c.table === 'message_campaigns' && typeof c.patch.finished_at === 'string',
    );
    expect(finish?.patch.status).toBe('failed');
  });

  it('does not finish while pending or claimed rows remain for that campaign', async () => {
    const db = new FakeDb({
      claimBatch: [emailRow({ id: 'row-1' })],
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      // A second recipient of the same campaign is still `pending` --
      // untouched by this tick's batch, but still in the queue.
      remaining: { 'campaign-1': [{ id: 'row-2', status: 'pending' }] },
    });

    const emailProvider = scriptedProvider({ ok: true, providerMessageId: 'm' });
    await drainCampaigns(asClient(db), { emailProvider });

    const finish = db.updateCalls.find(
      (c) => c.table === 'message_campaigns' && typeof c.patch.finished_at === 'string',
    );
    expect(finish).toBeUndefined();
  });

  it('bumps the counters of a campaign cancelled mid-drain, but never overwrites its cancelled status', async () => {
    // The split (finalizeCampaign) exists exactly for this case: an
    // already-claimed row is "in flight, cannot be recalled" (cancel_campaign,
    // 0243) and this drain is what settles it -- its outcome must still
    // reach the campaign's own counters even though the campaign's status
    // must never be overwritten back to `sent`/`failed`.
    const cancelled: CampaignRow = { ...BASE_CAMPAIGN, status: 'cancelled' };
    const db = new FakeDb({
      claimBatch: [emailRow({ id: 'row-1' })],
      memberByRowId: { 'row-1': 'member-1' },
      companies: [BASE_COMPANY],
      campaigns: [cancelled],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const emailProvider = scriptedProvider({ ok: true, providerMessageId: 'm' });
    await drainCampaigns(asClient(db), { emailProvider });

    const bump = db.rpcCalls.find((c) => c.fn === 'bump_campaign_counters');
    expect(bump?.args).toMatchObject({ p_sent: 1, p_failed: 0, p_suppressed: 0 });

    const finish = db.updateCalls.find(
      (c) => c.table === 'message_campaigns' && typeof c.patch.finished_at === 'string',
    );
    expect(finish).toBeUndefined();
  });
});

describe('drainCampaigns — finalizeEmptyRunningCampaigns (Item 1(b), fix round 1)', () => {
  it('finalizes a `running` campaign with an empty queue even when this tick claims NOTHING at all', async () => {
    // THE WHOLE POINT of this fix: a campaign stranded `running` by
    // anonymize_member (Task 8) moving its last `pending` row straight to
    // `suppressed` never appears in any claimed batch again -- nothing is
    // left in it to claim. A test that claimed a row first would exercise
    // the ORDINARY path (finalizeCampaign, called from inside the batch
    // loop) and prove nothing about the case this item exists for.
    const db = new FakeDb({
      claimBatch: [],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    const result = await drainCampaigns(asClient(db));
    expect(result.claimed).toBe(0);

    const finish = db.updateCalls.find(
      (c) => c.table === 'message_campaigns' && typeof c.patch.finished_at === 'string',
    );
    expect(finish).toBeDefined();
    // sent_count and failed_count are both 0 (BASE_CAMPAIGN's own seed, and
    // this path bumps nothing): "ran to completion, nothing failed" is
    // `sent`, the same rule finalizeCampaign's own comment states.
    expect(finish?.patch.status).toBe('sent');
  });

  it('bumps the counters through the SAME bump_campaign_counters call, with an all-zero delta', async () => {
    // Reuse, not a second version: this path calls finalizeCampaign exactly
    // as the batch loop does, so the RPC log shows the identical call shape,
    // only with nothing to add.
    const db = new FakeDb({
      claimBatch: [],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    await drainCampaigns(asClient(db));

    const bump = db.rpcCalls.find((c) => c.fn === 'bump_campaign_counters');
    expect(bump?.args).toEqual({ p_campaign_id: 'campaign-1', p_sent: 0, p_failed: 0, p_suppressed: 0 });
  });

  it('leaves a `running` campaign alone while a row is still pending or claimed, even on a tick that claims nothing else', async () => {
    // The other half: a sweep that finalized every `running` campaign
    // regardless of its queue would pass the case above and be
    // catastrophic. A row belonging to SOME OTHER tick's claim (or simply
    // not yet due) must not be raced past.
    const db = new FakeDb({
      claimBatch: [],
      campaigns: [BASE_CAMPAIGN],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [{ id: 'row-x', status: 'pending' }] },
    });

    await drainCampaigns(asClient(db));

    const finish = db.updateCalls.find(
      (c) => c.table === 'message_campaigns' && typeof c.patch.finished_at === 'string',
    );
    expect(finish).toBeUndefined();
  });

  it('does not touch a campaign that is not `running` (queued, sent, failed or cancelled)', async () => {
    // finalizeEmptyRunningCampaigns' own first query is `eq('status',
    // 'running')` -- a campaign in any other status must never reach
    // finalizeCampaign through this path at all, queued included: a queued
    // campaign with nothing claimed yet is not "stranded", it has simply
    // not started.
    const queuedCampaign: CampaignRow = { ...BASE_CAMPAIGN, status: 'queued' };
    const db = new FakeDb({
      claimBatch: [],
      campaigns: [queuedCampaign],
      templates: [BASE_TEMPLATE],
      remaining: { 'campaign-1': [] },
    });

    await drainCampaigns(asClient(db));

    expect(db.rpcCalls.find((c) => c.fn === 'bump_campaign_counters')).toBeUndefined();
    const finish = db.updateCalls.find(
      (c) => c.table === 'message_campaigns' && typeof c.patch.finished_at === 'string',
    );
    expect(finish).toBeUndefined();
  });
});
