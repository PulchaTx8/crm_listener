#!/usr/bin/env node
/**
 * Runs the isolation suite and REFUSES TO EXIT 0 IF A TEST FILE DID NOT REPORT.
 *
 * Why this exists. The isolation suite carries the only proof this project has
 * of several of its security boundaries — the read policy on
 * promotion_prize_balances has exactly one live denial case in the repository,
 * and it is in this suite; so does the archived-promotion restatement inside
 * list_promotion_prizes; so does every 42501 refusal on the promotion write
 * RPCs. pgTAP cannot stand in for any of them: it checks that a grant and a
 * policy exist, which a policy written `using (true)` would satisfy.
 *
 * And this suite has been observed reporting success while a whole file did not
 * run. A `Worker exited unexpectedly` crash mid-file printed
 *
 *     Test Files  12 passed (13)
 *          Tests  144 passed (151)
 *
 * and EXITED 0. It has since been seen dropping three DIFFERENT files across ten
 * runs, at roughly one run in five, with no cause yet found. A gate whose only
 * signal is an exit code cannot see any of that, and a gate whose other signal is
 * a human remembering to read a summary line is not a gate.
 *
 * So the exit code is not trusted here, and it is not the only thing read. TWO
 * independent questions are asked of every full run, because neither can see what
 * the other sees:
 *
 *   1. the JSON reporter's file list, against the files on disk that the config's
 *      `include` would collect — the only thing that knows what SHOULD have run;
 *   2. vitest's own summary line — the only thing that saw a worker die after its
 *      file's tests had all passed, a state in which the JSON report is entirely
 *      clean. An `Errors N error` line fails the run on its own.
 *
 * A shortfall on either fails the build, loudly, naming what is missing.
 *
 * THIS IS NOT A FIX FOR THE CRASH, and nothing here should be read as one. The
 * crash's suspected trigger — two harness helpers spawning the Supabase CLI from
 * inside a vitest worker — was removed, and the crash carried on, once on a file
 * that had never called either helper. What this script does is make the next
 * one, from whatever cause, impossible to mistake for a green run.
 *
 * Usage:
 *   node scripts/verify-isolation-suite.mjs              # full suite, guarded
 *   node scripts/verify-isolation-suite.mjs <file…>      # scoped, guard skipped
 *   node scripts/verify-isolation-suite.mjs --verify-report <path.json>
 *                                                       # validate a report only
 *   node scripts/verify-isolation-suite.mjs --verify-summary <run.log>
 *                                                       # validate a saved log only
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_DIR = path.join(REPO_ROOT, 'tests', 'isolation');

/** Every file the config's include glob (`tests/isolation/ ** /*.test.ts`) would collect. */
function expectedTestFiles(dir = SUITE_DIR) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...expectedTestFiles(full));
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found.sort();
}

/**
 * Returns the list of complaints about a run. Empty means the run accounted for
 * every file it was supposed to.
 *
 * Kept separate from the spawning above so it can be pointed at a report from a
 * previous run — which is how this guard was proved to fail rather than merely
 * asserted to.
 */
function complaintsAbout(report, expected) {
  const complaints = [];
  const reported = new Set(
    (report.testResults ?? []).map((result) => path.resolve(REPO_ROOT, result.name)),
  );

  const missing = expected.filter((file) => !reported.has(file));
  if (missing.length > 0) {
    complaints.push(
      `${missing.length} test file(s) exist on disk but reported NO result — the run did not ` +
        'cover them, whatever its exit code said:\n' +
        missing.map((file) => `      - ${path.relative(REPO_ROOT, file)}`).join('\n'),
    );
  }

  // A file can also report a result that is not `passed` — a collection error,
  // for instance, which the summary line counts as a file but not as tests.
  const notPassed = (report.testResults ?? []).filter((result) => result.status !== 'passed');
  if (notPassed.length > 0) {
    complaints.push(
      `${notPassed.length} test file(s) did not pass:\n` +
        notPassed
          .map((r) => `      - ${path.relative(REPO_ROOT, path.resolve(REPO_ROOT, r.name))} (${r.status})`)
          .join('\n'),
    );
  }

  if ((report.numFailedTests ?? 0) > 0) {
    complaints.push(`${report.numFailedTests} test(s) failed.`);
  }

  // The summary's own two halves disagreeing is the exact shape of the crash
  // this guard exists for, and it is worth naming separately from the file list.
  const counted = report.numTotalTests ?? 0;
  const accounted =
    (report.numPassedTests ?? 0) + (report.numFailedTests ?? 0) + (report.numPendingTests ?? 0) +
    (report.numTodoTests ?? 0);
  if (counted !== accounted) {
    complaints.push(
      `the run collected ${counted} test(s) but accounted for only ${accounted} — ` +
        'a file was dropped part-way through.',
    );
  }

  return complaints;
}

/** ESC [ … m — vitest colours its summary, and the counts have to be read out of it. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * The same question asked of vitest's own summary, and it is NOT redundant with
 * the JSON report above. Measured, on a real crash:
 *
 *     Test Files  12 passed (13)
 *          Tests  152 passed (152)
 *         Errors  1 error
 *
 * Every test in all thirteen files ran and passed; the thirteenth file's worker
 * then died before the file itself was reported. The JSON reporter had nothing
 * to complain about — every assertion it knew of had passed — so
 * complaintsAbout() returned nothing at all, and the only thing that failed that
 * run was the exit code. Which the crash this whole script exists for has been
 * observed setting to 0.
 *
 * So the summary line is read too. It is the one place the shortfall shows, and
 * reading it is what the block report had been asking a human to remember to do.
 */
function complaintsAboutSummary(output) {
  const complaints = [];
  // The escape CHARACTER and the whole sequence, not just the bracket: leaving a
  // stray \x1b in the line breaks the end-of-line anchor on the file total
  // below, and the guard would then say it could not read a total that is
  // right there.
  const plain = output.replace(ANSI, '').replace(/\r/g, '');

  const files = plain.match(/Test Files\s+(.+)/);
  if (!files) {
    complaints.push('vitest printed no "Test Files" summary line at all.');
  } else {
    // "12 passed (13)", "1 failed | 12 passed (13)", "13 passed (13)".
    const line = files[1].trim();
    const total = line.match(/\((\d+)\)\s*$/);
    const reported = [...line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)].reduce(
      (sum, m) => sum + Number(m[1]),
      0,
    );
    if (!total) {
      complaints.push(`could not read the file total out of "Test Files ${line}".`);
    } else if (reported !== Number(total[1])) {
      complaints.push(
        `vitest collected ${total[1]} test file(s) and reported on only ${reported}: ` +
          `"Test Files ${line}". A file's worker died without the file being reported.`,
      );
    }
  }

  // An unhandled error is never acceptable here, whatever the counts say: it is
  // how this crash announces itself, and vitest's own message for it is "This
  // might cause false positive tests."
  const errors = plain.match(/^\s*Errors\s+(\d+) error/m);
  if (errors) complaints.push(`vitest reported ${errors[1]} unhandled error(s) during the run.`);

  return complaints;
}

function fail(complaints) {
  console.error('\n' + '='.repeat(78));
  console.error('ISOLATION SUITE INCOMPLETE — this run proves nothing.');
  console.error('='.repeat(78));
  for (const complaint of complaints) console.error(`  * ${complaint}`);
  console.error(
    '\n  Do not re-run past this. The isolation suite holds the only live proof of\n' +
      '  several RLS policies and permission gates in this schema; a file that did\n' +
      '  not run is a boundary that was not checked.\n',
  );
  process.exit(1);
}

const argv = process.argv.slice(2);

// --verify-summary: check a saved run log, and run nothing. This is how the
// summary check was proved against the real crash rather than against a
// hand-written line.
const summaryOnlyAt = argv.indexOf('--verify-summary');
if (summaryOnlyAt !== -1) {
  const logPath = argv[summaryOnlyAt + 1];
  if (!logPath || !existsSync(logPath)) {
    console.error('--verify-summary needs the path of an existing run log.');
    process.exit(2);
  }
  const complaints = complaintsAboutSummary(readFileSync(logPath, 'utf8'));
  if (complaints.length > 0) fail(complaints);
  console.log('Run summary accounts for every test file, with no unhandled errors.');
  process.exit(0);
}

// --verify-report: validate a report produced elsewhere, and run nothing.
const reportOnlyAt = argv.indexOf('--verify-report');
if (reportOnlyAt !== -1) {
  const reportPath = argv[reportOnlyAt + 1];
  if (!reportPath || !existsSync(reportPath)) {
    console.error('--verify-report needs the path of an existing JSON report.');
    process.exit(2);
  }
  const complaints = complaintsAbout(
    JSON.parse(readFileSync(reportPath, 'utf8')),
    expectedTestFiles(),
  );
  if (complaints.length > 0) fail(complaints);
  console.log('Isolation report accounts for every test file.');
  process.exit(0);
}

// Anything that is not a flag narrows the run to particular files, and then the
// set on disk is no longer what should have reported. Say so out loud rather
// than silently checking nothing.
const scoped = argv.some((arg) => !arg.startsWith('-'));

const outputDir = mkdtempSync(path.join(tmpdir(), 'isolation-report-'));
const outputFile = path.join(outputDir, 'isolation.json');

// Piped rather than inherited, and echoed through as it arrives: the summary
// line is one of the two things checked below, and it cannot be read off a
// stream that went straight to the terminal. The echo is what keeps the run
// looking exactly as it did before this script existed.
const captured = [];
const run = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config',
      'vitest.isolation.config.ts',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${outputFile}`,
      ...argv,
    ],
    { cwd: REPO_ROOT, stdio: ['inherit', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    captured.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    captured.push(chunk);
  });
  child.on('close', (status) => resolve({ status }));
});
const output = Buffer.concat(captured).toString('utf8');

// Everything below reads the report and then deletes it, before anything can
// exit: process.exit does not run a `finally`, so the cleanup has to happen
// while the process is still deciding rather than on its way out.
let complaints = [];

if (scoped) {
  console.log(
    '\nNOTE: this run was narrowed to particular files, so the file-count guard is\n' +
      '      skipped. A full `npm run test:isolation` is what proves the suite ran.',
  );
  complaints = complaintsAboutSummary(output).filter((c) => !c.startsWith('vitest collected'));
} else if (!existsSync(outputFile)) {
  complaints.push(
    'the JSON reporter wrote no report at all, so nothing can be said about which ' +
      'files ran. Treat this as a failed run.',
  );
} else {
  // Both, because neither sees everything: the JSON report is the only thing
  // that knows which FILES exist on disk, and the summary is the only thing that
  // saw a worker die after its file's tests had all passed.
  complaints = [
    ...complaintsAbout(JSON.parse(readFileSync(outputFile, 'utf8')), expectedTestFiles()),
    ...complaintsAboutSummary(output),
  ];
}

// The exit code is checked LAST and never on its own: the crash this guard
// exists for exited 0 once and 1 once, from the same broken state.
if (run.status !== 0) complaints.push(`vitest exited ${run.status}.`);

rmSync(outputDir, { recursive: true, force: true });

if (complaints.length > 0) fail(complaints);

if (!scoped) {
  console.log(
    `\nIsolation suite complete: ${expectedTestFiles().length} file(s), ` +
      'every one accounted for.',
  );
}
