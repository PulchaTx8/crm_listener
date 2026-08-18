import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/supabase/user-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import {
  ConflictError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import type { Database } from '@/lib/supabase/database.types';
import { SYSTEM_MESSAGE_DEFAULTS } from '@/lib/conversation/engine';
import type { SystemMessageKey } from '@/lib/conversation/engine';
import type { TemplateVariable } from '@/lib/templates/variables';
import { SYSTEM_MESSAGE_KEYS } from '@/schemas/templates';
import type {
  ArchiveTemplateInput,
  ClearSystemMessageInput,
  MarketingTemplateInput,
  ServiceHashtagsFormInput,
  SystemMessageFormInput,
  TemplateRegistrationInput,
} from '@/schemas/templates';

/** A client bound to the caller's JWT — see services/inventory.ts's asCaller for why every write uses one. */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// The ten system texts
// ---------------------------------------------------------------------------

/** One of the ten, as the Messages screen renders it. */
export interface SystemMessageRow {
  key: SystemMessageKey;
  /** What this Station actually sends: its own wording, or the code's default. */
  body: string;
  /** The constant in engine.ts, shown BESIDE the override while editing (spec §5). */
  defaultBody: string;
  /** True when the Station has given this text its own wording. */
  overridden: boolean;
  /** When that wording was last changed. Null for a text that is still the default. */
  updatedAt: string | null;
}

/**
 * All fourteen, whether overridden or not.
 *
 * EVERY ROW ALWAYS, built from `SYSTEM_MESSAGE_DEFAULTS` and filled in from
 * whatever the Station has overridden — never the query's rows alone. A screen
 * rendering only what came back would show a brand-new Station an empty page,
 * and would be the same all-or-nothing misreading of D2 that the resolver's
 * own test exists to catch: an absent row is a text at its default, not a text
 * that is missing.
 */
export async function listSystemMessages(companyId: string): Promise<SystemMessageRow[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('station_message_templates')
    .select('key, body, updated_at')
    .eq('company_id', companyId);

  // A caller without templates.view reads zero rows rather than an error
  // (0109's policy filters; the grant lets the statement run), so an empty
  // result is indistinguishable here from a Station that has overridden
  // nothing. That is correct for this screen: both render the ten defaults,
  // and the page itself is what refuses a caller who may not be here.
  if (error) throw mapTemplateError(error.code, error.message);

  const overrides = new Map(
    (data ?? []).map((row) => [row.key as SystemMessageKey, row]),
  );

  return SYSTEM_MESSAGE_KEYS.map((key) => {
    const override = overrides.get(key);
    const defaultBody = SYSTEM_MESSAGE_DEFAULTS[key];
    return {
      key,
      body: override?.body ?? defaultBody,
      defaultBody,
      overridden: override !== undefined,
      updatedAt: override?.updated_at ?? null,
    };
  });
}

export async function setSystemMessage(
  input: SystemMessageFormInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('set_station_message_template', {
    p_company_id: input.companyId,
    p_key: input.key,
    p_body: input.body,
  });
  if (error) throw mapTemplateError(error.code, error.message);
}

/**
 * Removes a Station's own wording, returning that text to the default.
 *
 * Its own function and its own action, never an empty save (spec §5): a blank
 * body is refused by 0109's check constraint, by 0113's door and by the schema,
 * so "clear" cannot be expressed as "set to nothing" anywhere in this stack.
 */
export async function clearSystemMessage(
  input: ClearSystemMessageInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('clear_station_message_template', {
    p_company_id: input.companyId,
    p_key: input.key,
  });
  if (error) throw mapTemplateError(error.code, error.message);
}

// ---------------------------------------------------------------------------
// Block 19a, Task 8. The two service hashtags.
// ---------------------------------------------------------------------------

/** One Station's two service hashtags, as Task 8's screen renders them. */
export interface ServiceHashtags {
  /**
   * False when this Station has no `widget_installations` row at all —
   * creating one is a console act (0159) this screen cannot perform. Both
   * hashtags are null either way, which is why the screen needs this flag
   * rather than inferring "no widget" from null fields: a Station that HAS a
   * widget and simply has not typed a hashtag yet carries the same nulls.
   */
  installed: boolean;
  music: string | null;
  service: string | null;
}

/**
 * `service_hashtags_for` returns jsonb, which arrives here as `unknown`
 * (`Json` in the generated types) — checked at the boundary rather than cast,
 * the same defence-in-depth `parseWidgetInstallation` (services/widget-installations.ts)
 * gives its own jsonb-returning door: a shape that drifted under this file
 * would otherwise surface as `undefined` fields quietly reaching the screen
 * rather than a loud failure naming the actual cause.
 */
function parseServiceHashtags(data: unknown): ServiceHashtags {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new InternalError('service_hashtags_for returned an unexpected shape');
  }

  const row = data as Record<string, unknown>;
  if (
    typeof row.installed !== 'boolean' ||
    (row.music !== null && typeof row.music !== 'string') ||
    (row.service !== null && typeof row.service !== 'string')
  ) {
    throw new InternalError('service_hashtags_for returned an unexpected shape');
  }

  return {
    installed: row.installed,
    music: row.music as string | null,
    service: row.service as string | null,
  };
}

/**
 * Reads `service_hashtags_for` (0182). `widget_installations` carries RLS
 * with no policy and its ACL revoked (0159's own comment): every reader is
 * inside a SECURITY DEFINER body and even the service client is refused with
 * 42501, so this door is the only way this screen can see these two columns.
 */
export async function getServiceHashtags(companyId: string): Promise<ServiceHashtags> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc('service_hashtags_for', {
    p_company_id: companyId,
  });
  if (error) throw mapTemplateError(error.code, error.message);
  return parseServiceHashtags(data);
}

/**
 * Writes both hashtags in one call, through `set_service_hashtags` (0177).
 * An empty string clears a field to NULL — the door's own rule, not repeated
 * here. Refuses with `42501` (no `templates.manage`), `22023` (a bad shape,
 * the two hashtags equal ignoring case, or a clash with a live or future
 * promotion of this Station — the door's own sentence, which names the
 * clashing hashtag) or `P0002` (this Station has no widget installation).
 */
export async function setServiceHashtags(
  input: ServiceHashtagsFormInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('set_service_hashtags', {
    p_company_id: input.companyId,
    p_music: input.music,
    p_service: input.service,
  });
  if (error) throw mapTemplateError(error.code, error.message);
}

// ---------------------------------------------------------------------------
// The approved-template registry
// ---------------------------------------------------------------------------

export interface RegisteredTemplate {
  id: string;
  // Null for a MARKETING template (0225), which carries no purpose of its
  // own; non-null is one of TEMPLATE_PURPOSES. listTemplates below partitions
  // on exactly this field.
  purpose: string | null;
  channel: 'WHATSAPP' | 'EMAIL';
  internalName: string;
  description: string | null;
  name: string | null;
  language: string | null;
  body: string;
  subject: string | null;
  /**
   * Block 29b-1, Task 9. The per-template override of this Station's own
   * sender identity (0223, 0226) — null on every row that sends as the
   * Station's default, and on every WhatsApp row, which has no sender to
   * name. Read back here (never only accepted on the way in) for the same
   * reason `RegisteredTemplate` reads everything else it does: TemplateDialog
   * prefills an edit from this row, and a save that always submits three
   * blank fields because the screen never told it what was already there
   * would clear an override on every edit that did not happen to retype it.
   */
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  /** What each position means, in order. Empty for an approved fixed-text template. */
  variables: TemplateVariable[];
  /**
   * Whether the approval carries an OTP button — Meta's Authentication
   * category (0165). The send must name that button or the Cloud API refuses
   * the whole message with (#131008).
   */
  otpButton: boolean;
  updatedAt: string;
  /**
   * Block 29b-1, Task 9. Who last saved this row, and its display name —
   * `message_templates.updated_by` (0223) references `auth.users`, which is
   * not the table the Marketing grid can put a name to, so `listTemplates`
   * below resolves it through `profiles` itself rather than a second RPC. Both
   * null for a row nothing has ever named an actor for (there is none today —
   * every insert and every update stamps `updated_by` — but the column carries
   * no NOT NULL, so this stays honest about what it actually is: nullable).
   */
  updatedById: string | null;
  updatedByName: string | null;
}

/**
 * Both families `message_templates` holds since 0225, in one query and split
 * on the field that tells them apart: `purpose is null` is a marketing
 * template, non-null is a SYSTEM registration. Partitioned here rather than
 * with two queries because the caller (the Templates screen) renders both
 * groups from the same read of the same Station.
 */
export async function listTemplates(
  companyId: string,
): Promise<{ system: RegisteredTemplate[]; marketing: RegisteredTemplate[] }> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('message_templates')
    .select(
      'id, purpose, channel, internal_name, description, name, language, body, subject, from_name, from_email, reply_to, variables, otp_button, updated_by, updated_at',
    )
    .eq('company_id', companyId)
    .order('purpose', { ascending: true });
  if (error) throw mapTemplateError(error.code, error.message);

  // A second, batched read for the name behind `updated_by` — never a join in
  // the query above, because the column references `auth.users` (0223) and
  // PostgREST cannot embed across a foreign key that names a schema it does
  // not expose. Same shape `listMemberStations` (services/members.ts) uses for
  // its own batch of names: the ids this Station's rows actually carry, read
  // once, mapped back onto every row that carries one. `profiles_select_org_member`
  // (0020) is what makes the read itself legal — every actor on a template this
  // caller can see shares an Organization with them by construction.
  const actorIds = [...new Set((data ?? []).map((row) => row.updated_by).filter((id): id is string => id !== null))];
  const { data: profiles, error: profilesError } = actorIds.length
    ? await supabase.from('profiles').select('id, full_name').in('id', actorIds)
    : { data: [], error: null };
  if (profilesError) {
    throw new InternalError(`Could not read who last updated these templates: ${profilesError.message}`);
  }
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  const rows: RegisteredTemplate[] = (data ?? []).map((row) => ({
    id: row.id,
    purpose: row.purpose,
    channel: row.channel,
    internalName: row.internal_name,
    description: row.description,
    name: row.name,
    language: row.language,
    body: row.body,
    subject: row.subject,
    fromName: row.from_name,
    fromEmail: row.from_email,
    replyTo: row.reply_to,
    // `variables` is `template_variable[]` (0222) since 0225's regeneration,
    // not the jsonb this comment used to distrust -- the column's own type is
    // now the shape guarantee, so there is nothing left here to narrow.
    variables: row.variables,
    otpButton: row.otp_button,
    updatedAt: row.updated_at,
    updatedById: row.updated_by,
    updatedByName: row.updated_by ? (nameById.get(row.updated_by) ?? null) : null,
  }));

  return {
    system: rows.filter((row) => row.purpose !== null),
    marketing: rows.filter((row) => row.purpose === null),
  };
}

/**
 * Creates or updates a marketing template through `save_marketing_template`
 * (0225) — the door `register_message_template` cannot serve, because that
 * one upserts on `(company_id, purpose)` and a marketing template has no
 * purpose to give that ON CONFLICT clause as a target (0225's own comment).
 */
export async function saveMarketingTemplate(
  input: MarketingTemplateInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('save_marketing_template', {
    p_id: input.templateId,
    p_company_id: input.companyId,
    p_channel: input.channel,
    p_internal_name: input.internalName,
    p_description: input.description,
    p_body: input.body,
    p_subject: input.subject,
    p_name: input.name,
    p_language: input.language,
    p_variables: input.variables,
    p_from_name: input.fromName,
    p_from_email: input.fromEmail,
    p_reply_to: input.replyTo,
  });
  if (error) throw mapTemplateError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('save_marketing_template returned no id');
  return data;
}

export async function registerTemplate(
  input: TemplateRegistrationInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('register_message_template', {
    p_company_id: input.companyId,
    p_purpose: input.purpose,
    p_name: input.name,
    p_language: input.language,
    p_body: input.body,
    p_variables: input.variables,
    p_otp_button: input.otpButton,
  });
  if (error) throw mapTemplateError(error.code, error.message);
}

export async function archiveTemplate(
  input: ArchiveTemplateInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_message_template', {
    p_id: input.templateId,
  });
  if (error) throw mapTemplateError(error.code, error.message);
}

/**
 * The code taxonomy the six doors raise (the original four, plus Block 19a's
 * `set_service_hashtags` and `service_hashtags_for`), in the shape
 * services/music.ts documents its own.
 *
 * - `42501` is every permission refusal, and — by 0093's rule, which all six
 *   doors follow — ALSO an id that names nothing and a Station the caller
 *   cannot reach. There is deliberately no way to tell the three apart from
 *   outside, so this must not be softened into a "not found" anywhere.
 * - `P0002` is the honest absences a caller who DOES hold the permission can
 *   be told about: clearing a text that has no override, a Station id that
 *   stopped being live between the permission check and the read, and (Block
 *   19a) a Station with no widget installation at all — creating one is a
 *   console act (0159) `set_service_hashtags` cannot perform on its own.
 * - `22023` is every validation raise: a blank body, a blank template name or
 *   language, a variable description that is not a non-empty string, the one
 *   that matters — a body whose `{{n}}` count disagrees with the descriptions
 *   given — and (Block 19a) a service hashtag with a bad shape, the two equal
 *   ignoring case, or a clash with a live or future promotion of that Station.
 *   schemas/templates.ts catches all of these before a request is sent; this
 *   mapping is what still applies if a caller bypasses the form.
 * - `23514` is the same class arriving from a check constraint rather than a
 *   raise, and is mapped alongside it for that reason.
 * - `23505` should be unreachable: both doors upsert against the partial
 *   unique index rather than inserting blindly. Mapped anyway, because an
 *   unreachable branch that surfaces as InternalError tells an operator
 *   nothing, and a conflict here has an obvious cause — two operators saving
 *   the same text at once.
 * - Anything else is ours, not the caller's. Labelling an unexpected database
 *   fault a refusal hides a real fault behind a plausible-looking message.
 */
function mapTemplateError(code: string | undefined, message: string): Error {
  if (code === '23505') return new ConflictError(message);
  if (code === '22023' || code === '23514') return new ValidationError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}
