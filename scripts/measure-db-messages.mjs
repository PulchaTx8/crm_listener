import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Block 12a, D7. How much of what a user reads is NOT in the catalogue.
 *
 * The error mappers pass `cause.message` straight through for ConflictError,
 * BusinessRuleError and ValidationError -- and that message is whatever a
 * `raise exception` in SQL wrote. The SQLSTATE codes the services map say what
 * KIND of failure it is, never which rule broke, so the English sentence is the
 * only thing that tells one from another.
 *
 * This counts them and prints them. It decides nothing: Block 12b does, with
 * the list in hand.
 */
const DIRECTORY = join(process.cwd(), 'supabase', 'migrations');

// The codes the services map to error classes whose message reaches a screen.
// 42501 and P0002 are excluded deliberately: every mapper replaces those with a
// sentence of its own ("You do not have permission to…", "That could not be
// found."), so their SQL text never leaves the server.
const USER_FACING = new Set(['22023', '23514', '23505']);

const sentences = new Map();
let total = 0;

for (const file of readdirSync(DIRECTORY).filter((name) => name.endsWith('.sql'))) {
  const sql = readFileSync(join(DIRECTORY, file), 'utf8');

  // `raise exception 'text' using errcode = '22023';` and the variant that puts
  // the format arguments between the two. Non-greedy up to the statement end.
  const pattern = /raise\s+exception\s+'([^']+)'([\s\S]*?);/gi;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    total += 1;
    const [, message, tail] = match;
    const code = /errcode\s*=\s*'([0-9A-Za-z]+)'/.exec(tail ?? '')?.[1];
    if (!code || !USER_FACING.has(code)) continue;
    if (!sentences.has(message)) sentences.set(message, { code, files: new Set() });
    sentences.get(message).files.add(file);
  }
}

const rows = [...sentences.entries()].sort(([a], [b]) => a.localeCompare(b));

console.log(`${total} raise exception site(s) in the schema.`);
console.log(`${rows.length} distinct sentence(s) can reach a user.\n`);
for (const [message, { code, files }] of rows) {
  console.log(`  [${code}] ${message}`);
  console.log(`         ${[...files].sort().join(', ')}`);
}
