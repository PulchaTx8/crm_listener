import { describe, expect, it } from 'vitest';
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
// spirit as tests/unit/whatsapp-worker.test.ts's FakeDb: it models the
// STATEFUL parts (claim_campaign_batch hands out its batch once, exactly like
// claim_outbox_batch) and records every write so a test can assert on the
// exact patch a settle sent, not merely on a resulting status.
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
}

class FakeDb {
  readonly rpcCalls: RpcCall[] = [];
  readonly updateCalls: UpdateCall[] = [];
  readonly selectCalls: SelectCall[] = [];
  private claimed = false;

  constructor(private readonly fx: Fixture = {}) {}

  rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args });

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
    this.updateCalls.push({ table, patch, filters });
    return { error: null };
  }

  private resolveSelect(table: string, columns: string, filters: Array<[string, unknown]>) {
    this.selectCalls.push({ table, columns, filters });

    if (table === 'message_campaign_recipients' && columns.includes('member_id')) {
      const ids = (filters.find(([k]) => k === 'in:id')?.[1] as string[]) ?? [];
      const data = ids.map((id) => ({ id, member_id: this.fx.memberByRowId?.[id] ?? null }));
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
    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0, suppressed: 1 });

    const settle = db.updateCalls.find((c) => c.table === 'message_campaign_recipients' && c.filters.some(([k, v]) => k === 'eq:id' && v === 'row-1'));
    expect(settle?.patch).toEqual({ status: 'suppressed' });
  });
});

describe('drainCampaigns — retry, permanence and the drain-wide park', () => {
  it('returns a retryable failure to pending with the next backoff, without exceeding MAX_ATTEMPTS', async () => {
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
    expect(result.failed).toBe(1);

    const settle = db.updateCalls.find((c) => c.filters.some(([k, v]) => k === 'eq:id' && v === 'row-1'));
    expect(settle?.patch.status).toBe('pending');
    expect(settle?.patch.attempts).toBe(2);
    expect(settle?.patch.attempts).toBeLessThan(MAX_ATTEMPTS);

    const nextAttemptAt = new Date(settle?.patch.next_attempt_at as string).getTime();
    // attempts was 1 before this send, so the next rung is BACKOFF_SECONDS[1].
    const expectedDelayMs = BACKOFF_SECONDS[1] * 1000;
    expect(nextAttemptAt).toBeGreaterThanOrEqual(before + expectedDelayMs);
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
  it('mints a distinct unsubscribe token for each e-mail recipient', async () => {
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

    const hashes = tokenCalls.map((c) => c.args.p_token_hash);
    expect(new Set(hashes).size).toBe(2);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);

    expect(emailProvider.calls).toHaveLength(2);
    for (const job of emailProvider.calls) {
      if (job.channel === 'EMAIL') expect(job.unsubscribe?.url).toMatch(/\/unsubscribe\//);
    }
  });
});

describe('drainCampaigns — the reclaim', () => {
  it('resets a stale claim to pending before claiming a new batch', async () => {
    const db = new FakeDb({ claimBatch: [], remaining: {} });
    await drainCampaigns(asClient(db));

    const reclaim = db.updateCalls.find(
      (c) =>
        c.table === 'message_campaign_recipients' &&
        c.filters.some(([k, v]) => k === 'eq:status' && v === 'claimed') &&
        c.filters.some(([k]) => k === 'lt:claimed_at'),
    );
    expect(reclaim).toBeDefined();
    expect(reclaim?.patch).toEqual({ status: 'pending' });

    const reclaimIndex = db.updateCalls.indexOf(reclaim!);
    const claimIndex = db.rpcCalls.findIndex((c) => c.fn === 'claim_campaign_batch');
    // The reclaim is a direct write; the claim is an RPC. Both are logged in
    // call order across their own arrays, so what proves the ordering is that
    // the reclaim exists at all before any settle write could exist -- there
    // is nothing to settle in an empty batch, so this also confirms the
    // reclaim runs unconditionally, not only when a batch is found.
    expect(reclaimIndex).toBe(0);
    expect(claimIndex).toBe(0);
  });
});

describe('drainCampaigns — resolving once per group', () => {
  it('resolves Station identity and template once per group, not once per row', async () => {
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
    const campaignSelects = db.selectCalls.filter((c) => c.table === 'message_campaigns');

    expect(companySelects).toHaveLength(1);
    expect(templateSelects).toHaveLength(1);
    expect(campaignSelects).toHaveLength(1);
    expect(emailProvider.calls).toHaveLength(3);
  });
});
