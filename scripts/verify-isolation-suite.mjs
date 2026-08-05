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
 * and EXITED 0. It has since been measured at **six crashes in fifteen full
 * runs — about two runs in five — on SIX DIFFERENT FILES with no repeats**
 * (`inventory`, `invitations`, `roles`, `tenant`, `listing`, `promotion-prizes`),
 * with no cause yet found. Four of those six call none of the machinery anybody
 * suspected. A gate whose only signal is an exit code cannot see any of that, and
 * a gate whose other signal is a human remembering to read a summary line is not
 * a gate.
 *
 * So the exit code is not trusted here, and it is not the only thing read. THREE
 * independent questions are asked of every full run, because none of them can see
 * what the others do:
 *
 *   1. the manifest below, against disk AND against each file's own case floor —
 *      the only thing that knows a required file has been DELETED rather than
 *      merely not run, and the only check whose expectation neither a deletion
 *      nor an ordinary code edit can quietly lower. The floor on CASES is the
 *      newer half: without it, deleting eight `it()` blocks left every total
 *      below balancing perfectly, because the run really had accounted for
 *      everything it collected — it had simply collected less;
 *   2. the JSON reporter's file list and counts, against the files on disk that
 *      the config's `include` would collect — including that nothing was pending
 *      or todo, because a skipped test balances every total while checking
 *      nothing;
 *   3. vitest's own summary line — the only thing that saw a worker die after its
 *      file's tests had all passed, a state in which the JSON report is entirely
 *      clean. Its `Errors N error` line fails the run on its own, on a full run
 *      and a narrowed one alike.
 *
 * A shortfall on any of them fails the build, loudly, NAMING what is missing —
 * never only that a number was short.
 *
 * Every gap listed above was once open here, and each is now held by a fixture in
 * FIXTURES that `--self-test` re-runs. Two of them were found by a reviewer
 * exercising this script adversarially after a previous version of it had been
 * called finished; the fixtures exist so the next such gap has to be found the
 * same expensive way only once.
 *
 * THIS IS NOT A FIX FOR THE CRASH, and nothing here should be read as one. The
 * crash's suspected trigger — two harness helpers spawning the Supabase CLI from
 * inside a vitest worker — was removed, and the crash carried on unchanged, four
 * of its six occurrences on files that had never called either helper. What this
 * script does is make the next one, from whatever cause, impossible to mistake
 * for a green run.
 *
 * Usage:
 *   node scripts/verify-isolation-suite.mjs              # full suite, guarded
 *   node scripts/verify-isolation-suite.mjs <file…>      # scoped, counts unchecked
 *   node scripts/verify-isolation-suite.mjs --self-test  # prove the guard still bites
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

/**
 * THE FLOOR. Every check below this line derives its expectation from what is on
 * disk, and that is one edit away from expecting nothing: delete
 * promotion-prizes.test.ts, or rename it past the `*.test.ts` glob, or move it
 * out of tests/isolation, and a run of the remaining twelve is "complete". The
 * file it would be easiest to lose that way is the one carrying this block's only
 * live proof of the promotion_prize_balances denial, of the archived-promotion
 * rule inside a SECURITY DEFINER read, and of every 42501 on the promotion write
 * RPCs.
 *
 * So the expectation has a floor that a deletion cannot move. A file listed here
 * must exist AND must report; the guard names it by path when it does neither,
 * because "12 is fewer than 13" tells whoever reads the build nothing about what
 * they have lost.
 *
 * A manifest rather than a bare count, deliberately: a count says a number was
 * short, a manifest says which boundary went unchecked. Adding a test file means
 * adding a line here — that friction is the point, and the disk walk below still
 * catches a NEW file that failed to report even before anybody remembers to.
 *
 * `minTests` IS THE SECOND HALF OF THE FLOOR, and without it the first half was
 * a floor on FILES and nothing else. Every count below derived its expectation
 * from the run itself: delete eight `it()` blocks from members.test.ts, or wrap
 * them in a condition that has quietly become false, and the collected total IS
 * the reduced number — every arithmetic check balances, no file is missing, and
 * this script prints "every one accounted for, nothing skipped". An ordinary
 * code edit walked straight through the guard whose whole purpose is that a
 * boundary cannot go unchecked silently.
 *
 * A FLOOR and not an equality, on purpose. Adding a case must not break the
 * build for everybody until somebody remembers to bump a number — that is the
 * friction that gets guards deleted. The cost, stated: after cases are added,
 * the number here is lower than the truth until it is next refreshed, so the
 * floor protects the cases that existed when it was last written rather than all
 * of them. Refresh it when a file grows meaningfully; it is one number and it is
 * printed by every full run.
 *
 * Counted as "cases that actually ran": a pending or todo case does not count
 * towards a file's floor, so the two ways of hiding a case — deleting it and
 * skipping it — are both caught here as well as by the scan further down.
 */
const REQUIRED_TEST_FILES = [
  { path: 'tests/isolation/contact-requests.test.ts', minTests: 3 },
  { path: 'tests/isolation/conversation.test.ts', minTests: 7 },
  // Block 8a, Task 6: the three dashboard aggregates are all SECURITY
  // INVOKER (D4) precisely so RLS applies inside them -- pgTAP's own suite
  // (supabase/tests/20_dashboards.test.sql) runs under `set local role
  // authenticated` with hand-written JWT claims, never a real session or a
  // real second identity of different ownership, so it cannot show RLS
  // actually engaging, only that the arithmetic is right once it does. Six
  // cases: a cross-Station call raises rather than narrows (D3); a
  // consolidated call needs reports.consolidated in EVERY Station named, not
  // one; the three panels gate independently; the withheld contract (D13),
  // both halves, on the audience panel; the same shape on the promotions
  // panel, where the prize cycle survives while the entry side is withheld;
  // and an archived promotion's participations dropping out of a non-owner's
  // totals while holding for the Organization's owner -- the one case
  // deliberately deferred from Task 5's pgTAP suite, which has no second
  // identity to prove ownership with.
  { path: 'tests/isolation/dashboards.test.ts', minTests: 6 },
  { path: 'tests/isolation/conversation-store.test.ts', minTests: 5 },
  // One when REDIS_URL is unset -- the case that REPORTS the skip -- and the
  // whole contract when it is set. The floor is the honest one: a file that
  // collected nothing would look identical to one that failed to load.
  { path: 'tests/isolation/conversation-store-redis.test.ts', minTests: 1 },
  // Three reproduction rounds, the boundary case and the concurrency case. The
  // three is the point: one round could agree by luck on one seed, and a file
  // that quietly dropped to one would still report a pass. Block 6c adds three:
  // the filtered round drawn twice, and the wrong-answer permission from both
  // sides of the grant.
  { path: 'tests/isolation/draw.test.ts', minTests: 11 },
  { path: 'tests/isolation/inventory.test.ts', minTests: 19 },
  { path: 'tests/isolation/invitations.test.ts', minTests: 7 },
  { path: 'tests/isolation/listing.test.ts', minTests: 5 },
  { path: 'tests/isolation/members.test.ts', minTests: 21 },
  // Block 7a, Task 5: the music catalogue's tenant boundary -- a cross-
  // Station song refused by assert_song_references_live with P0002 (not a
  // permission code, even for the owner, who passes every gate), the
  // 42501-not-P0002 rule for an id a narrower caller cannot see, and the
  // write refusal on a table with no INSERT grant to any role. pgTAP runs
  // as superuser and answers true from has_permission unconditionally, so
  // none of this is visible to it.
  { path: 'tests/isolation/music.test.ts', minTests: 8 },
  // Block 7b, Task 5: the merge's boundary and D6's identity rules. The three
  // that only a second identity can prove: music.manage does NOT confer
  // music.merge; a loser in another Station answers the SAME P0002 as a uuid
  // naming nothing (the core scopes its lock, so "elsewhere" is
  // indistinguishable from "absent"); and list_music_requests still LISTS
  // without members.view, with the listener columns null, while a search
  // returns nothing at all. Task 9's fix round 2 adds the pair that proves
  // list_merge_candidates' corrected gate (0108, moved from music.merge to
  // music.view in fix round 1): music.manage alone still cannot read the
  // Maintenance screen's list, and music.view alone now can — the property
  // the whole read-only-screen ruling rests on, and pgTAP cannot show it
  // either, for the identical reason as everything else in this file: it
  // runs as superuser with a null auth.uid().
  { path: 'tests/isolation/music-merge.test.ts', minTests: 11 },
  { path: 'tests/isolation/participations.test.ts', minTests: 29 },
  { path: 'tests/isolation/permissions.test.ts', minTests: 11 },
  // Block 6d, Task 5: the four rules SECURITY DEFINER stopped enforcing for
  // free on list_pickups -- another Station refused, an archived promotion's
  // winners hidden, names withheld without members.view, and the search
  // oracle shut off with them. Same reasoning as list_participations' own
  // entry below: pgTAP cannot see any of the four, only a real second user
  // under a real, narrower grant can. Task 6 adds three more for
  // list_movements in the same file: another Station refused, the promotion
  // name returned to an inventory-only caller (the whole reason that function
  // exists), and an archived promotion's name withheld from a delegate but
  // not from the owner.
  { path: 'tests/isolation/pickups.test.ts', minTests: 7 },
  { path: 'tests/isolation/promotion-prizes.test.ts', minTests: 29 },
  { path: 'tests/isolation/promotions.test.ts', minTests: 21 },
  { path: 'tests/isolation/provisional-password.test.ts', minTests: 4 },
  { path: 'tests/isolation/record.test.ts', minTests: 6 },
  { path: 'tests/isolation/roles.test.ts', minTests: 17 },
  { path: 'tests/isolation/signup-disabled.test.ts', minTests: 1 },
  { path: 'tests/isolation/tenant.test.ts', minTests: 9 },
  // Block Templates, Task 5: the two codes, both tables, four doors. What only
  // this file can show, for the reason every other entry here gives -- pgTAP
  // runs as superuser with a null auth.uid() and gets `true` from
  // has_permission unconditionally -- is the GATE: templates.view does not
  // confer templates.manage on any of the four doors, one case each, because a
  // gate restored on three of four would satisfy a bundled assertion; and the
  // read policy filters per row's company_id, so a delegate in one Station
  // cannot see the group's other registrations.
  //
  // The positive branch (templates.view ALONE genuinely reading BOTH tables)
  // is here for a different reason: it is the whole reachability of the two
  // screens, and it is what a caller EXPERIENCES rather than what a catalogue
  // says. Revoking `grant select on message_templates from authenticated` was
  // run as a real mutation against the local stack and fails exactly this file
  // with 42501; 18_templates.test.sql now asserts that grant directly as well,
  // after the same mutation showed it was only being caught there
  // incidentally, inside another test's fixture read.
  { path: 'tests/isolation/templates.test.ts', minTests: 13 },
  { path: 'tests/isolation/whatsapp.test.ts', minTests: 10 },
];

/** Every file the config's include glob (`tests/isolation/ ** /*.test.ts`) would collect. */
function filesOnDisk(dir = SUITE_DIR) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesOnDisk(full));
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

/**
 * What must have reported: everything on disk, UNION the manifest. The union is
 * what makes a deleted required file still count as missing from the run rather
 * than quietly stop being expected.
 */
function expectedTestFiles(required = REQUIRED_TEST_FILES) {
  const union = new Set([
    ...filesOnDisk(),
    ...required.map((entry) => path.resolve(REPO_ROOT, entry.path)),
  ]);
  return [...union].sort();
}

/**
 * The disk half of the floor, asked separately from the report half so that a
 * file which has been deleted is named as deleted rather than as "did not
 * report" — two different mistakes with two different fixes.
 */
function complaintsAboutManifest(required = REQUIRED_TEST_FILES) {
  const gone = required.filter((entry) => !existsSync(path.resolve(REPO_ROOT, entry.path)));
  if (gone.length === 0) return [];
  return [
    `${gone.length} test file(s) this suite is REQUIRED to run are not on disk at all — ` +
      'deleted, renamed past the *.test.ts glob, or moved out of tests/isolation. If that ' +
      'was deliberate, the deletion belongs in the same commit as an edit to ' +
      'REQUIRED_TEST_FILES in this script, so somebody has to say so out loud:\n' +
      gone.map((entry) => `      - ${entry.path}`).join('\n'),
  ];
}

/**
 * Returns the list of complaints about a run. Empty means the run accounted for
 * every file it was supposed to.
 *
 * Kept separate from the spawning above so it can be pointed at a report from a
 * previous run — which is how this guard was proved to fail rather than merely
 * asserted to.
 */
function complaintsAbout(report, expected, required = REQUIRED_TEST_FILES) {
  const complaints = [];
  const reported = new Set(
    (report.testResults ?? []).map((result) => path.resolve(REPO_ROOT, result.name)),
  );

  // The case-level floor. Everything else in this function asks whether the run
  // accounted for what the run collected, which a run that collected fewer
  // cases answers perfectly. See REQUIRED_TEST_FILES' own comment: eight
  // deleted `it()` blocks balanced every total here and printed a clean line.
  const byFile = new Map(
    (report.testResults ?? []).map((result) => [
      path.resolve(REPO_ROOT, result.name),
      (result.assertionResults ?? []).filter(
        (assertion) => assertion.status !== 'pending' && assertion.status !== 'todo',
      ).length,
    ]),
  );
  const thin = required
    .map((entry) => ({ entry, ran: byFile.get(path.resolve(REPO_ROOT, entry.path)) }))
    // A file that reported nothing at all is already named by the check below;
    // saying it twice would bury the more specific message.
    .filter(({ entry, ran }) => ran !== undefined && ran < entry.minTests);
  if (thin.length > 0) {
    complaints.push(
      `${thin.length} test file(s) ran FEWER cases than this suite requires of them. Every ` +
        'case in this suite is a boundary somebody decided had to be checked on every run, ' +
        'and a file that quietly lost some of them balances every other count here:\n' +
        thin
          .map(({ entry, ran }) => `      - ${entry.path}: ran ${ran}, floor is ${entry.minTests}`)
          .join('\n') +
        '\n      If cases were deliberately removed, the removal belongs in the same commit ' +
        'as the new floor in REQUIRED_TEST_FILES.',
    );
  }

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

  // A skipped test is not a run test, and the arithmetic below cannot tell the
  // difference: 152 collected against 145 passed + 7 pending balances exactly,
  // and every other check here is satisfied by it. This suite has no .skip and
  // no .todo, so nothing is hidden today — which is precisely why an edit that
  // introduced one, or a crash that ended with vitest marking a dead worker's
  // tests skipped, would slide through the one direction left open. Named
  // separately from "failed" because the fix is different: a skipped security
  // case is not a broken one, it is an unasked one.
  const pending = report.numPendingTests ?? 0;
  const todo = report.numTodoTests ?? 0;
  if (pending > 0 || todo > 0) {
    complaints.push(
      `${pending + todo} test(s) did not run — ${pending} skipped, ${todo} todo. Every case in ` +
        'this suite is a boundary somebody decided had to be checked on every run; a skipped ' +
        'one is a boundary nobody checked, and it counts toward the total either way.',
    );
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
function complaintsAboutSummary(output, { countsMatter = true } = {}) {
  const complaints = [];
  // The escape CHARACTER and the whole sequence, not just the bracket: leaving a
  // stray \x1b in the line breaks the end-of-line anchor on the file total
  // below, and the guard would then say it could not read a total that is
  // right there.
  const plain = output.replace(ANSI, '').replace(/\r/g, '');

  // "13 passed (13)", "12 passed (13)", "1 failed | 12 passed (13)",
  // "12 passed | 1 skipped (13)". The last of those balances to 13 and used to
  // pass every check here, which is the gap the `skipped` scan below closes.
  const readCounts = (line) => ({
    total: line.match(/\((\d+)\)\s*$/),
    reported: [...line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)].reduce(
      (sum, m) => sum + Number(m[1]),
      0,
    ),
    idle: [...line.matchAll(/(\d+)\s+(skipped|todo)/g)].reduce((sum, m) => sum + Number(m[1]), 0),
  });

  if (countsMatter) {
    const files = plain.match(/Test Files\s+(.+)/);
    if (!files) {
      complaints.push('vitest printed no "Test Files" summary line at all.');
    } else {
      const line = files[1].trim();
      const { total, reported, idle } = readCounts(line);
      if (!total) {
        complaints.push(`could not read the file total out of "Test Files ${line}".`);
      } else if (reported !== Number(total[1])) {
        complaints.push(
          `vitest collected ${total[1]} test file(s) and reported on only ${reported}: ` +
            `"Test Files ${line}". A file's worker died without the file being reported.`,
        );
      }
      if (idle > 0) {
        complaints.push(
          `${idle} test file(s) were skipped rather than run: "Test Files ${line}". A file that ` +
            'balances the total by being skipped is a file that did not run.',
        );
      }
    }

    // The Tests line, for the same reason and the same blind spot:
    // "145 passed | 7 skipped (152)" balances, and until this scan existed it
    // satisfied every count in this script.
    const tests = plain.match(/^\s*Tests\s+(.+)/m);
    if (!tests) {
      complaints.push('vitest printed no "Tests" summary line at all.');
    } else {
      const line = tests[1].trim();
      const { total, reported, idle } = readCounts(line);
      if (!total) {
        complaints.push(`could not read the test total out of "Tests ${line}".`);
      } else if (reported !== Number(total[1])) {
        complaints.push(
          `vitest collected ${total[1]} test(s) and reported on only ${reported}: ` +
            `"Tests ${line}".`,
        );
      }
      if (idle > 0) {
        complaints.push(
          `${idle} test(s) were skipped rather than run: "Tests ${line}". Every case in this ` +
            'suite is a boundary somebody decided had to be checked on every run.',
        );
      }
    }
  }

  // An unhandled error is never acceptable here, whatever the counts say — not
  // even on a narrowed run. It is how this crash announces itself, and vitest's
  // own message for it is "This might cause false positive tests."
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

/**
 * The fixtures. Each one is a state this guard was ONCE BLIND TO, kept here so
 * that closing the gap is a thing that can be re-run rather than a thing that was
 * claimed. `--self-test` asserts every one of them still produces a complaint;
 * it fails loudly if any stops doing so, which is what a silently loosened check
 * would look like.
 *
 * Two of the three were found by a reviewer exercising this script adversarially
 * rather than reading it, after the version above had already been called
 * finished. That is the argument for having them here.
 */
/** The floor's own sum: what a healthy run collects, at minimum. */
const FLOOR_TOTAL = REQUIRED_TEST_FILES.reduce((sum, entry) => sum + entry.minTests, 0);

/**
 * A report as vitest writes one, from a description of what went wrong.
 *
 * Built from REQUIRED_TEST_FILES rather than hand-listed, so the fixtures below
 * cannot drift out of agreement with the manifest they are checking — and so
 * that each one differs from a healthy run in exactly the ONE way it is named
 * for. `assertionResults` is populated because the case floor reads it; before
 * that floor existed every fixture here carried `{ name, status }` alone.
 */
function reportLike({ omit = null, ranPerFile = null, totals = null } = {}) {
  const testResults = REQUIRED_TEST_FILES.filter(
    (entry) => omit === null || !entry.path.endsWith(omit),
  ).map((entry) => {
    const ran = ranPerFile?.[entry.path] ?? entry.minTests;
    return {
      name: entry.path,
      status: 'passed',
      assertionResults: Array.from({ length: ran }, () => ({ status: 'passed' })),
    };
  });
  const collected = testResults.reduce((sum, r) => sum + r.assertionResults.length, 0);
  return {
    numTotalTests: collected,
    numPassedTests: collected,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    ...(totals ?? {}),
    testResults,
  };
}

const FIXTURES = [
  {
    name: 'report: a crash that ended with the dead worker\'s tests marked skipped',
    // The totals balance — passed + pending equals collected — every file
    // reports `passed`, and nothing failed. Before the skipped scan this
    // satisfied every check in complaintsAbout().
    run: () =>
      complaintsAbout(
        reportLike({
          totals: {
            numTotalTests: FLOOR_TOTAL,
            numPassedTests: FLOOR_TOTAL - 7,
            numPendingTests: 7,
          },
        }),
        expectedTestFiles(),
      ),
    expect: /did not run — 7 skipped/,
  },
  {
    name: 'summary: "12 passed | 1 skipped (13)" and "145 passed | 7 skipped (152)"',
    // Balances on both lines. Before the skipped scan this was a clean summary.
    run: () =>
      complaintsAboutSummary(
        ' Test Files  12 passed | 1 skipped (13)\n      Tests  145 passed | 7 skipped (152)\n',
      ),
    expect: /test file\(s\) were skipped rather than run/,
  },
  {
    name: 'manifest: a required file deleted, renamed, or moved out of the glob',
    run: () =>
      complaintsAboutManifest([
        { path: 'tests/isolation/deleted-by-somebody.test.ts', minTests: 1 },
      ]),
    expect: /are not on disk at all/,
  },
  {
    name: 'report: a short file list — promotion-prizes never reported',
    run: () => complaintsAbout(reportLike({ omit: 'promotion-prizes.test.ts' }), expectedTestFiles()),
    expect: /promotion-prizes\.test\.ts/,
  },
  {
    // THE GAP THE CASE FLOOR EXISTS FOR, and the one this script was blind to
    // for its whole life: not a file that vanished, but a file that reported
    // and ran fewer cases than it holds. Every other check in complaintsAbout
    // is satisfied by this report, because the run really did account for
    // everything it collected — it simply collected less.
    name: 'report: a file that ran but lost eight of its cases',
    run: () =>
      complaintsAbout(
        reportLike({ ranPerFile: { 'tests/isolation/members.test.ts': 13 } }),
        expectedTestFiles(),
      ),
    expect: /members\.test\.ts: ran 13, floor is 21/,
  },
  {
    // complaintsAbout's `counted !== accounted` branch, which had no fixture at
    // all. This is the JSON shape of a file dropped part-way through: the
    // reporter knows 182 were collected and can account for only 174, and no
    // other check here sees it — every file reported, nothing failed, nothing
    // was skipped.
    name: 'report: collected more than it accounted for — a file dropped mid-flight',
    run: () =>
      complaintsAbout(
        reportLike({ totals: { numTotalTests: FLOOR_TOTAL, numPassedTests: FLOOR_TOTAL - 8 } }),
        expectedTestFiles(),
      ),
    expect: /but accounted for only/,
  },
  {
    // The summary's Tests line failing to balance, which also had no fixture:
    // fixture 2 above feeds a line that BALANCES and so trips the `idle > 0`
    // branch instead, leaving this one — a different check, on a different
    // line, with a different message — unexercised.
    name: 'summary: "174 passed (182)" — the Tests line does not balance',
    run: () =>
      complaintsAboutSummary(' Test Files  14 passed (14)\n      Tests  174 passed (182)\n'),
    expect: /collected 182 test\(s\) and reported on only 174/,
  },
  {
    // The exact shape this whole script was written for, quoted at the top of
    // this file and never once exercised: a worker that died AFTER its file's
    // tests had all passed. The Tests line is perfect, the JSON report is
    // perfect, and the only thing anywhere that can see it is the file total.
    name: 'summary: "Test Files 12 passed (13)" with a clean Tests line — the original crash',
    run: () =>
      complaintsAboutSummary(' Test Files  12 passed (13)\n      Tests  152 passed (152)\n'),
    expect: /collected 13 test file\(s\) and reported on only 12/,
  },
  {
    name: 'sanity: a genuinely clean report and summary produce NO complaint',
    // The other half of every fixture above, and the more important half: a
    // guard that fails closed on a healthy run is worse than the gap it closes.
    // The file totals here are the manifest's own length, so this stays true as
    // the suite grows.
    run: () => [
      ...complaintsAbout(reportLike(), expectedTestFiles()),
      ...complaintsAboutSummary(
        ` Test Files  ${REQUIRED_TEST_FILES.length} passed (${REQUIRED_TEST_FILES.length})\n` +
          `      Tests  ${FLOOR_TOTAL} passed (${FLOOR_TOTAL})\n`,
      ),
      ...complaintsAboutManifest(),
    ],
    expect: null,
  },
];

const argv = process.argv.slice(2);

// --self-test: run every fixture and check it still catches what it was written
// for. Runs nothing against the database and needs no stack.
if (argv.includes('--self-test')) {
  let bad = 0;
  for (const fixture of FIXTURES) {
    const complaints = fixture.run();
    const caught = fixture.expect
      ? complaints.some((c) => fixture.expect.test(c))
      : complaints.length === 0;
    console.log(`${caught ? 'ok  ' : 'FAIL'}  ${fixture.name}`);
    if (!caught) {
      bad += 1;
      console.log(
        fixture.expect
          ? `        expected a complaint matching ${fixture.expect}, got: ` +
              (complaints.length ? JSON.stringify(complaints, null, 2) : '(none)')
          : `        expected no complaint, got: ${JSON.stringify(complaints, null, 2)}`,
      );
    }
  }
  if (bad > 0) {
    console.error(
      `\n${bad} of ${FIXTURES.length} guard fixtures did not behave as written. A check that ` +
        'stopped catching what it was added for is a check that is no longer there.',
    );
    process.exit(1);
  }
  console.log(`\nAll ${FIXTURES.length} guard fixtures behave as written.`);
  process.exit(0);
}

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
  console.log('Run summary accounts for every test file, with nothing skipped and no errors.');
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
  const complaints = [
    ...complaintsAboutManifest(),
    ...complaintsAbout(JSON.parse(readFileSync(reportPath, 'utf8')), expectedTestFiles()),
  ];
  if (complaints.length > 0) fail(complaints);
  console.log('Isolation report accounts for every required test file, with nothing skipped.');
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
    '\nNOTE: this run was narrowed to particular files, so no count here means anything\n' +
      '      and none is checked — a `-t` filter legitimately skips, and a file list\n' +
      '      legitimately leaves files out. An unhandled error still fails. A full\n' +
      '      `npm run test:isolation` is what proves the suite ran.',
  );
  complaints = complaintsAboutSummary(output, { countsMatter: false });
} else if (!existsSync(outputFile)) {
  complaints = [
    ...complaintsAboutManifest(),
    'the JSON reporter wrote no report at all, so nothing can be said about which ' +
      'files ran. Treat this as a failed run.',
  ];
} else {
  // All three, because none of them sees what the others do: the manifest is the
  // only thing that knows a required file has been deleted rather than merely not
  // run; the JSON report is the only thing that knows which files exist on disk;
  // and the summary is the only thing that saw a worker die after its file's
  // tests had all passed.
  complaints = [
    ...complaintsAboutManifest(),
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
    `\nIsolation suite complete: ${expectedTestFiles().length} file(s), every one accounted ` +
      `for, ${REQUIRED_TEST_FILES.length} of them required by name and each above its own ` +
      `case floor (${FLOOR_TOTAL} cases in total), nothing skipped.`,
  );
}
