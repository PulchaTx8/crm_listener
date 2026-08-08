import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from '../src/lib/security/local-only.ts';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../tests/local-supabase.ts';

/**
 * Puts a picture in the `branding` bucket so the sign-in screen has something to
 * show on a freshly reset database.
 *
 * NOT `supabase/seed.sql`, for seed-demo.mjs's reason -- that file runs on every
 * `db reset` and everything else starts from it -- and, more simply, because
 * SQL cannot put bytes in a bucket. Storage objects are written over HTTP.
 *
 * SERVICE ROLE, and there is no alternative: 0146 gives this bucket no write
 * policy at all, on purpose. Nothing subject to RLS writes here. That is the
 * same door the operator uses in production, where the Supabase dashboard acts
 * as service_role -- this script is that dashboard upload, scripted, for a
 * machine that has no operator sitting at it.
 *
 * Idempotent: `upsert` replaces whatever is there, so running it twice leaves
 * one object.
 */
// NOT named `URL` like seed-demo.mjs's equivalent: this file calls `new URL()`
// below to resolve the asset path, and a const of that name would shadow the
// global and take the script down before it reached the guard.
const SUPABASE_URL = process.env.SEED_SUPABASE_URL ?? LOCAL_SUPABASE_URL;
const SERVICE_KEY = process.env.SEED_SERVICE_ROLE_KEY ?? LOCAL_SUPABASE_SERVICE_ROLE_KEY;

// LOCAL ONLY, applied to the override as well as the default, exactly as
// seed-demo.mjs does. Production's picture is chosen by the operator and
// replaced through the dashboard; a script that could reach the hosted project
// is a script that can overwrite the front door of the product from a shell
// that happened to have the wrong variables exported.
//
// Caught rather than left to throw: this runs at module scope, and an uncaught
// throw prints a stack trace over the one sentence that says what happened.
try {
  assertLocalSupabase(SUPABASE_URL);
} catch (cause) {
  console.error(`\nseed:branding refused to run - ${cause.message}`);
  process.exit(1);
}

// Kept in step with src/lib/branding/login-hero.ts by hand -- this file is
// plain Node run outside the bundler and cannot import from '@/'. The unit test
// tests/unit/login-hero.test.ts asserts both constants, so a change there that
// is not made here fails a test rather than silently seeding the wrong key.
const BUCKET = 'branding';
const KEY = 'login-hero.png';
const SOURCE = fileURLToPath(new URL('../supabase/seed-assets/login-hero.png', import.meta.url));

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function main() {
  const bytes = await readFile(SOURCE);

  const { error } = await admin.storage.from(BUCKET).upload(KEY, bytes, {
    // EXPLICIT, and load-bearing. Storage serves an object as whatever it was
    // told, and an upload with no contentType is served as
    // application/octet-stream -- which a browser will not render in an <img>.
    // artwork-keys.ts carries the same warning for the same reason.
    contentType: 'image/png',
    upsert: true,
    // Seconds, as a string, which is what storage-api expects. Sixty rather
    // than the default hour: this is the developer's own machine, where the
    // whole point of re-running the script is to see a different picture.
    // Production's object is uploaded by the dashboard at its own default, and
    // the ?v= stamp from login-hero.ts is what makes that harmless.
    cacheControl: '60',
  });

  if (error) {
    console.error(`\nseed:branding could not upload - ${error.message}`);
    process.exit(1);
  }

  console.log(`seed:branding uploaded ${bytes.length} bytes to ${BUCKET}/${KEY}`);
}

await main();
