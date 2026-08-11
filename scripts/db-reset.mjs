import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/**
 * `npm run db:reset`, with the hosted project taken off the table.
 *
 * WHAT THIS IS GUARDING AGAINST, precisely: `supabase db reset` is local and
 * harmless, and `supabase db reset --linked` destroys the hosted project --
 * every customer row, the demonstration Organization, every sign-in. They are
 * one word apart, and the second one is spelled the same way as the flag on
 * `supabase migration list --linked`, which is a routine and correct thing to
 * run in this repository. That is the whole trap: the muscle memory that types
 * the safe command is the muscle memory that types the destructive one.
 *
 * So the script this repository tells people to run cannot express the
 * destructive form at all. `--local` is passed explicitly rather than left to
 * the default, because a default is a thing that can change under you.
 *
 * WHAT IT DOES NOT GUARD. Typing `npx supabase db reset --linked` in a terminal
 * bypasses this entirely -- no file in a repository can stop that. Two other
 * layers cover the paths that can be covered: `.claude/settings.json` denies
 * the raw command to Claude Code sessions, and `supabase/.temp/project-ref` is
 * what `--linked` resolves through, so removing the link makes the flag fail
 * until somebody re-links on purpose.
 */
const BLOCKED = ['--linked', '--db-url'];

const args = process.argv.slice(2);

// The FLAG is named back, never the argument. `--db-url=postgresql://user:pass@…`
// carries a password, and a refusal that helpfully quotes what you typed puts it
// in the terminal scrollback and in whatever collects it.
const offending = BLOCKED.filter((flag) =>
  args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)),
);

if (offending.length > 0) {
  console.error(
    `\ndb:reset refused to run - ${offending.join(' ')} points this at a database that is not local.\n` +
      'This script only ever resets the local stack. If you genuinely mean to reset a hosted\n' +
      'project, you have to say so somewhere other than here.',
  );
  process.exit(1);
}

// The CLI's own entry point, run by this Node -- not `npx`, and not the shim in
// node_modules/.bin. On Windows those are .cmd files, and since the fix for
// CVE-2024-27980 Node refuses to spawn a .cmd without `shell: true`; the
// symptom is EINVAL. Turning the shell on to get around that would put every
// argument back through a quoting layer, which is a strange price to pay for
// starting a program. `bin` in the package manifest points at plain JavaScript.
const require = createRequire(import.meta.url);

let cli;
try {
  const manifest = require('supabase/package.json');
  cli = resolve(dirname(require.resolve('supabase/package.json')), manifest.bin.supabase);
} catch (cause) {
  console.error(
    `\ndb:reset could not find the Supabase CLI - ${cause.message}\n` +
      'Is `npm install` finished?',
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [cli, 'db', 'reset', '--local', ...args], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(`\ndb:reset could not start the Supabase CLI - ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
