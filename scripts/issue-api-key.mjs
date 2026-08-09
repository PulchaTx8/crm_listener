import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from '../src/lib/security/local-only.ts';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
} from '../tests/local-supabase.ts';

/**
 * Issues a Block 15 API key against the LOCAL stack, so a developer can exercise
 * /api/v1/songs and /api/v1/music-requests without opening a browser.
 *
 * LOCAL ONLY, following seed-branding.mjs's guard and for a sharper reason than
 * that script has: this mints a bearer credential that writes into a Station.
 * Production keys are issued from the console -- /admin/stations, the API keys
 * tab -- by a signed-in platform admin, which is a place with an audit trail and
 * a person attached. A script that could reach the hosted project would be the
 * one path in this codebase that mints a production credential from a shell.
 *
 * IT SIGNS IN RATHER THAN USING THE SERVICE KEY, and that is not a convenience:
 * api_credentials has RLS on and NO POLICY (0148), and this schema revokes the
 * default ACL, so `service_role` reaches the table through nothing at all --
 * `createClient(serviceKey).from('api_credentials')` fails with 42501 by design.
 * The only door is issue_api_credential, and it is gated on is_platform_admin(),
 * which reads auth.uid(). So the script does exactly what a person does.
 *
 * Usage:
 *   node scripts/issue-api-key.mjs --company <uuid> --name "Deezer automation" \
 *     --scopes music.manage,music.request,members.create [--expires 2027-01-01]
 */

const SUPABASE_URL = process.env.SEED_SUPABASE_URL ?? LOCAL_SUPABASE_URL;
const ANON_KEY = process.env.SEED_ANON_KEY ?? LOCAL_SUPABASE_ANON_KEY;

assertLocalSupabase(SUPABASE_URL);

// The pair seed-demo.mjs creates. Overridable, because a developer who has
// bootstrapped their own admin should not have to edit this file.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@demo.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Demo-password-1';

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

const companyId = arg('company');
const name = arg('name');
const scopes = (arg('scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const expiresAt = arg('expires');

if (!companyId || !name || scopes.length === 0) {
  console.error(
    'usage: node scripts/issue-api-key.mjs --company <uuid> --name "<label>" ' +
      '--scopes music.manage,music.request [--expires YYYY-MM-DD]',
  );
  process.exit(1);
}

// Generated HERE, exactly as src/services/api-credentials.ts does it, and only
// the prefix and the hash travel to the RPC: an argument passed to an RPC lands
// in query logs and in backups, which is the rule the WhatsApp webhook already
// follows for the wamid.
const secret = `ptx_${randomBytes(32).toString('base64url')}`;
const prefix = secret.slice(0, 12);
const hash = createHash('sha256').update(secret).digest('hex');

const supabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const signedIn = await supabase.auth.signInWithPassword({
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
});

if (signedIn.error) {
  console.error(
    `could not sign in as ${ADMIN_EMAIL}: ${signedIn.error.message}\n` +
      'run `npm run seed:demo` first, or set ADMIN_EMAIL and ADMIN_PASSWORD.',
  );
  process.exit(1);
}

const { data, error } = await supabase.rpc('issue_api_credential', {
  p_company_id: companyId,
  p_name: name,
  p_token_prefix: prefix,
  p_token_hash: hash,
  p_scopes: scopes,
  p_expires_at: expiresAt ?? undefined,
});

if (error) {
  console.error(`could not issue the key: ${error.message}`);
  process.exit(1);
}

console.log(`\nkey ${data} issued for station ${companyId}`);
console.log(`scopes: ${scopes.join(', ')}`);
console.log(`\n  ${secret}\n`);
// Said plainly, because it is true rather than a formality: the database holds
// only the SHA-256, so nothing anywhere can print this again.
console.log('That secret is shown once. It is not stored and cannot be shown again.\n');
console.log('Try it:');
console.log(`  curl -X POST http://localhost:3000/api/v1/songs \\`);
console.log(`    -H "Authorization: Bearer ${secret}" \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(`    -d '{"title":"Discovery","artist":"Daft Punk"}'\n`);
