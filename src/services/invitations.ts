import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { DevMailer, SmtpMailer, type Mailer } from '@/lib/mailer';
import { env } from '@/lib/env';
import { InternalError, RateLimitError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { Database } from '@/lib/supabase/database.types';
import type { AcceptInvitationInput, CreateInvitationInput } from '@/schemas/invitations';

const ACCEPT_WINDOW_SECONDS = 3600;
const ACCEPT_MAX_PER_WINDOW = 10;

/** 32 bytes of CSPRNG, base64url so it survives a URL untouched. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this value reaches the database. A dump yields no working link. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function resolveMailer(): Mailer {
  if (env.SMTP_URL && env.MAIL_FROM) return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  return new DevMailer();
}

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
}

/**
 * A client bound to the caller's JWT. create_invitation re-checks
 * has_org_permission against auth.uid(), so calling it with the service key
 * would defeat the check it exists to make.
 */
function createUserScopedClient(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface InvitationPreview {
  invitationId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: 'owner' | 'operator' | 'viewer';
}

export async function createInvitation(
  input: CreateInvitationInput,
  accessToken: string,
): Promise<{ invitationId: string; acceptUrl: string }> {
  const token = generateInvitationToken();

  const asOwner = createUserScopedClient(accessToken);
  const { data, error } = await asOwner.rpc('create_invitation', {
    p_organization_id: input.organizationId,
    p_email: input.email,
    p_role: input.role,
    p_token_hash: hashInvitationToken(token),
    p_ttl_days: 7,
  });

  if (error) {
    // 23505 is the "already has an account" and "already invited" case; both are
    // the inviter's mistake, not a server fault.
    if (error.code === '23505') throw new ValidationError(error.message);
    throw new UnauthorizedError(`Could not create the invitation: ${error.message}`);
  }
  if (typeof data !== 'string') {
    throw new InternalError('create_invitation returned no id');
  }

  const acceptUrl = `${siteUrl()}/invite/${token}`;

  // Storage is the source of truth; delivery is best effort. A failed e-mail
  // must not lose the invitation — the caller shows the link for manual relay.
  try {
    await resolveMailer().send({
      to: input.email,
      subject: 'You have been invited to PulchatX',
      text: [
        'You have been invited to join a PulchatX account.',
        '',
        `Open this link to choose your password: ${acceptUrl}`,
        '',
        'The link expires in 7 days.',
      ].join('\n'),
    });
  } catch (cause) {
    // The token is deliberately absent from this log line.
    logger.error({ err: cause, invitationId: data }, 'invitation stored but e-mail failed');
  }

  return { invitationId: data, acceptUrl };
}

export async function revokeInvitation(invitationId: string, accessToken: string): Promise<void> {
  const asOwner = createUserScopedClient(accessToken);
  const { error } = await asOwner.rpc('revoke_invitation', { p_invitation_id: invitationId });
  if (error) throw new UnauthorizedError(`Could not revoke the invitation: ${error.message}`);
}

/**
 * Returns null for every failure — unknown, revoked, accepted, expired — so the
 * page renders one message for all of them. Distinct messages would tell an
 * attacker which guess landed close.
 */
export async function validateInvitation(token: string): Promise<InvitationPreview | null> {
  const admin = createServiceClient();
  const { data, error } = await admin.rpc('validate_invitation', {
    p_token_hash: hashInvitationToken(token),
  });
  if (error || !data) return null;

  const row = data as {
    invitation_id: string;
    organization_id: string;
    organization_name: string;
    email: string;
    role: 'owner' | 'operator' | 'viewer';
  };
  return {
    invitationId: row.invitation_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    email: row.email,
    role: row.role,
  };
}

/**
 * Creating the auth user is the Admin API; creating the memberships is SQL, with
 * no transaction spanning the two. If the RPC fails after the user exists we
 * would leave someone who can authenticate and belongs to no tenant — hence the
 * compensating delete, as in provisioning.
 *
 * The account is created with the invitation's e-mail, never one the visitor
 * typed: otherwise a valid token would mint an account for any address.
 */
export async function acceptInvitation(
  input: AcceptInvitationInput,
  ipAddress: string,
): Promise<{ organizationId: string }> {
  const admin = createServiceClient();

  const limiter = new PostgresRateLimiter(admin);
  const verdict = await limiter.check(
    `invite-accept:${createHash('sha256').update(ipAddress).digest('hex').slice(0, 32)}`,
    ACCEPT_MAX_PER_WINDOW,
    ACCEPT_WINDOW_SECONDS,
  );
  if (!verdict.allowed) {
    throw new RateLimitError('Too many attempts. Please try again later.');
  }

  const preview = await validateInvitation(input.token);
  if (!preview) throw new ValidationError('This invitation is no longer valid.');

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: preview.email,
    password: input.password,
    email_confirm: true,
    user_metadata: input.fullName ? { full_name: input.fullName } : undefined,
  });
  if (createError || !created.user) {
    throw new ValidationError(`Could not create the account: ${createError?.message ?? 'unknown'}`);
  }

  const userId = created.user.id;

  try {
    const { data, error } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(input.token),
      p_user_id: userId,
      p_full_name: input.fullName,
    });
    if (error) throw new Error(error.message);

    const result = data as { organization_id: string };
    return { organizationId: result.organization_id };
  } catch (cause) {
    await admin.auth.admin.deleteUser(userId).catch(() => {
      logger.error({ userId }, 'orphaned auth user could not be deleted after failed acceptance');
    });
    throw new InternalError('Could not accept the invitation', { cause });
  }
}
