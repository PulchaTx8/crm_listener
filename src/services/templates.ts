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
import { SYSTEM_MESSAGE_KEYS } from '@/schemas/templates';
import type {
  ArchiveTemplateInput,
  ClearSystemMessageInput,
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
 * All thirteen, whether overridden or not.
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
  purpose: string;
  name: string;
  language: string;
  body: string;
  /** What each position means, in order. Empty for an approved fixed-text template. */
  variables: string[];
  /**
   * Whether the approval carries an OTP button — Meta's Authentication
   * category (0165). The send must name that button or the Cloud API refuses
   * the whole message with (#131008).
   */
  otpButton: boolean;
  updatedAt: string;
}

export async function listRegisteredTemplates(companyId: string): Promise<RegisteredTemplate[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('message_templates')
    .select('id, purpose, name, language, body, variables, otp_button, updated_at')
    .eq('company_id', companyId)
    .order('purpose', { ascending: true });
  if (error) throw mapTemplateError(error.code, error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    purpose: row.purpose,
    name: row.name,
    language: row.language,
    body: row.body,
    // `variables` is jsonb and arrives as Json, which says nothing about its
    // shape. 0110's check constraint holds it to an array and 0113's door to
    // an array of non-blank strings; this is what stops a row written before
    // either from rendering as `[object Object]` on the screen.
    variables: Array.isArray(row.variables)
      ? row.variables.filter((value): value is string => typeof value === 'string')
      : [],
    otpButton: row.otp_button,
    updatedAt: row.updated_at,
  }));
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
