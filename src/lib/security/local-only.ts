/**
 * Block 11c, D2. Refuses to let a script touch anything but a local stack.
 *
 * `scripts/seed-demo.mjs` is the only thing in this repository that writes
 * invented data, and `.env` on the maintainer's machine names the HOSTED
 * project. One exported variable is the difference between a demo Station and a
 * demo Station inside a customer's database — which is not a mistake anybody
 * undoes, because the rows look exactly like the real ones.
 *
 * Matching is on the parsed HOSTNAME and never on a substring:
 * `localhost.evil.example` contains "localhost" and is somebody else's server.
 */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertLocalSupabase(url: string | undefined): void {
  if (!url) {
    throw new Error(
      'No Supabase URL. This script only ever runs against a local Supabase stack — start one with `npx supabase start`.',
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`The Supabase URL is not a URL: ${url}`);
  }

  if (!LOCAL_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Refusing to run against ${hostname}. This script writes demo data and only ever runs against a local Supabase stack.`,
    );
  }
}
