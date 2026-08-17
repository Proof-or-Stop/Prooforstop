#!/usr/bin/env node
/**
 * B-7dff F-003 — worktree-pollution attribution under the concurrent scheduler.
 *
 * THE DEFECT. `runValidationCommand` guards against validation side effects by
 * taking a REPO-WIDE `git status` snapshot before and after each command and
 * diffing the two. That was sound while the plan ran sequentially. Once CHK-003
 * put the plan on the keyed scheduler and CHK-005 declared `git-common-dir:shared`
 * on ~90 of 104 commands, a command's window routinely straddles another
 * command's write — and every straddling command's own before/after diff shows
 * that write, so each of them got a `worktreePollution` record naming a path it
 * never touched. Reproduced deterministically: a pure-sleep command reported
 * `paths=["accidental-a.txt"] blocking=true` at jobs=2 while touching nothing.
 * `commands[i].worktreePollution` is gate-consumed (it feeds `allPass`, the
 * dirty-gate audit trail, and `summarizeRoutineCommandExecution`), so that
 * false record can fail a legitimate story.
 *
 * WHY NO EXISTING TEST CAUGHT IT. The CHK-004 fixture smoke builds its
 * projectRoot with `mkdtempSync` and never runs `git init`, so `readGitStatus`
 * returns null there and the entire pollution path is a no-op. EVERY plan in
 * this file therefore runs inside a REAL git repository fixture, and section 2
 * exists specifically to prove detection is live rather than silently disabled
 * by the environment.
 *
 * WHAT IS ASSERTED:
 *   1. AMBIGUOUS  — concurrent commands: no innocent command is blamed, the row
 *      is reported against the SET of commands whose windows contained it, and
 *      the run still FAILS. Detection is not traded away for correctness.
 *   2. NEGATIVE CONTROL (serial) — the same plan at jobs=1 still catches the
 *      genuine pollution and pins it on the one command that caused it. Without
 *      this, section 1 could equally mean "the probe stopped working".
 *   3. NEGATIVE CONTROL (barrier) — an undeclared command is solo-scheduled by
 *      construction, so exact attribution survives even at jobs=4.
 *   4. VACUITY GUARD — a clean plan in the same live git repo reports nothing,
 *      so sections 1-3 are not just an always-on reporter.
 *   5. NOTHING LOST — two commands dirtying concurrently: BOTH paths surface.
 *   6. GATE WIRING — the set-attributed record is a required failure for
 *      `summarizeRoutineCommandExecution`, the other gate that reads pollution.
 *   7. The pure attributor itself, including a control proving it does not
 *      report ambiguity when there is none.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const distDir = resolve(repoRoot, 'packages/main/dist');

for (const required of ['core/validation-executor.js', 'core/validation-evidence-reuse.js']) {
  if (!existsSync(join(distDir, required))) {
    console.error(`validate-pollution-attribution: missing build artifact ${join(distDir, required)}; run npm --prefix packages/main run build first`);
    process.exit(1);
  }
}

const load = (rel) => import(pathToFileURL(join(distDir, rel)).href);
const { attributeWorktreePollution, executeValidationPlan } = await load('core/validation-executor.js');
const { summarizeRoutineCommandExecution } = await load('core/validation-evidence-reuse.js');

let assertions = 0;
const ok = (message, condition = true) => {
  assert.ok(condition, message);
  assertions++;
};

const REPO_SHARED = { class: 'git-common-dir', key: '.', access: 'shared' };
const roots = [];

/** A real git repository with one committed file, so `git status` has a clean baseline. */
function gitFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `b7dff-pollution-${name}-`));
  roots.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
  git('init');
  git('config', 'user.name', 'Proofbound Test');
  git('config', 'user.email', 'test@example.test');
  writeFileSync(join(root, 'README.md'), 'seed\n');
  git('add', '.');
  git('commit', '-m', 'seed pollution attribution fixture');
  return root;
}

/**
 * One probe. `writes` is written `writeAtMs` into the run; the process then stays
 * alive until `exitAtMs`, which is how a command's observation window is made to
 * straddle (or not straddle) another command's write. `declared: false` leaves
 * `resources` off entirely, which is the fail-closed exclusive barrier.
 */
function probe(label, { writes = null, writeAtMs = 250, exitAtMs = 250, declared = true } = {}) {
  const script = [
    writes
      ? `setTimeout(()=>{require("fs").writeFileSync(${JSON.stringify(writes)},"oops\\n");},${writeAtMs});`
      : '',
    `setTimeout(()=>process.exit(0),${exitAtMs});`,
  ].join('');
  return {
    label,
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: 60_000,
    ...(declared ? { resources: [REPO_SHARED] } : {}),
  };
}

const pollutionOf = (result, index) => result.commands[index].worktreePollution ?? null;
const detailsOf = (result) => result.details.join('\n');

try {
  // ── 1. AMBIGUOUS: concurrent windows, no innocent command blamed ───────────
  //
  // dirtying-A writes at 300ms and exits. clean-B writes NOTHING and stays alive
  // until 1200ms, so its window strictly contains A's write. Pre-fix this is the
  // exact shape that put `paths=["accidental-a.txt"] blocking=true` on clean-B.
  {
    const root = gitFixture('concurrent');
    const result = await executeValidationPlan({
      provider: 'b7dff-f003-concurrent',
      commands: [
        probe('dirtying-A', { writes: 'accidental-a.txt', writeAtMs: 300, exitAtMs: 320 }),
        probe('clean-B', { exitAtMs: 1200 }),
      ],
    }, root, undefined, undefined, { jobs: 2 });

    ok('both commands exited 0, so the plan failed on pollution and nothing else',
      result.commands.every((command) => command.code === 0 && !command.timedOut));
    ok('the command that wrote nothing carries NO pollution record',
      pollutionOf(result, 1) === null);
    ok('neither does the other candidate: with overlapping windows the probe cannot prove which one wrote it',
      pollutionOf(result, 0) === null);

    const concurrent = result.concurrentWorktreePollution;
    ok('the plan reports the row it could not attribute', Boolean(concurrent));
    assert.deepEqual(concurrent.paths, ['accidental-a.txt']);
    assert.deepEqual(concurrent.candidates, ['1:dirtying-A', '2:clean-B']);
    assert.deepEqual(concurrent.attributions.map((a) => a.path), ['accidental-a.txt']);
    assert.deepEqual(concurrent.attributions[0].candidates, ['1:dirtying-A', '2:clean-B']);
    assertions += 4;
    ok('the unattributable row still BLOCKS: detection is not traded away for correct attribution',
      concurrent.blocking === true && result.allPass === false && result.status === 'fail');
    assert.match(result.summary, /dirtied the worktree/);
    assertions++;

    const details = detailsOf(result);
    assert.doesNotMatch(details, /validation command dirtied worktree: clean-B/,
      'the innocent command must never appear in a "this command dirtied worktree" line');
    assert.doesNotMatch(details, /validation command dirtied worktree: dirtying-A/,
      'nor may one candidate be silently picked out of the set');
    assert.match(details, /validation commands dirtied worktree during overlapping windows \(not attributable to one command\): 1:dirtying-A, 2:clean-B/);
    assert.match(details, /accidental-a\.txt: appeared during the windows of 1:dirtying-A, 2:clean-B/);
    assert.match(details, /unexpected_dirty_files=1/);
    assertions += 5;
    console.log('VI-OK B7DFF-F003-CONCURRENT-NOT-MISATTRIBUTED concurrent pollution is reported against the candidate set, blames nobody individually, and still fails the run');
  }

  // ── 2. NEGATIVE CONTROL: the same plan serially still catches and pins it ──
  //
  // If this section came back clean, section 1's "nobody was blamed" would be
  // indistinguishable from "the probe is dead in this fixture".
  {
    const root = gitFixture('serial');
    const result = await executeValidationPlan({
      provider: 'b7dff-f003-serial',
      commands: [
        probe('dirtying-A', { writes: 'accidental-a.txt', writeAtMs: 300, exitAtMs: 320 }),
        probe('clean-B', { exitAtMs: 1200 }),
      ],
    }, root, undefined, undefined, { jobs: 1 });

    const blamed = pollutionOf(result, 0);
    ok('the command that really wrote the file IS caught', Boolean(blamed));
    assert.deepEqual(blamed.paths, ['accidental-a.txt']);
    assert.equal(blamed.attribution, 'exclusive');
    assert.equal(blamed.blocking, true);
    assertions += 3;
    ok('the clean command that ran AFTER it is not blamed (the file is already in its before-snapshot)',
      pollutionOf(result, 1) === null);
    ok('serial execution needs no set-attributed record at all',
      result.concurrentWorktreePollution === undefined);
    ok('and the run fails', result.allPass === false && result.status === 'fail');
    assert.match(detailsOf(result), /✗ validation command dirtied worktree: dirtying-A/);
    assertions++;
    console.log('VI-OK B7DFF-F003-SERIAL-STILL-ATTRIBUTES-EXACTLY genuine pollution is still detected and pinned on the exact command when no window overlaps');
  }

  // ── 3. NEGATIVE CONTROL: a fail-closed barrier keeps exact attribution ─────
  //
  // An undeclared command conflicts with every other entry, so it is solo even
  // at jobs=4 — the case F-003 required to keep precise blame.
  {
    const root = gitFixture('barrier');
    const result = await executeValidationPlan({
      provider: 'b7dff-f003-barrier',
      commands: [
        probe('declared-noise-1', { exitAtMs: 400 }),
        probe('undeclared-dirty', { writes: 'barrier-wrote.txt', writeAtMs: 50, exitAtMs: 120, declared: false }),
        probe('declared-noise-2', { exitAtMs: 400 }),
      ],
    }, root, undefined, undefined, { jobs: 4 });

    const blamed = pollutionOf(result, 1);
    ok('the solo-scheduled barrier is still blamed precisely', Boolean(blamed));
    assert.deepEqual(blamed.paths, ['barrier-wrote.txt']);
    assert.equal(blamed.attribution, 'exclusive');
    assertions += 2;
    ok('no concurrently declared command is dragged in',
      pollutionOf(result, 0) === null && pollutionOf(result, 2) === null);
    ok('nothing needed the set-attributed record', result.concurrentWorktreePollution === undefined);
    ok('and it blocks', result.allPass === false);
    assert.match(detailsOf(result), /✗ validation command dirtied worktree: undeclared-dirty/);
    assertions++;
    console.log('VI-OK B7DFF-F003-BARRIER-EXACT-UNDER-JOBS-4 a command scheduled alone keeps exact per-command attribution even with 4 workers');
  }

  // ── 4. VACUITY GUARD: a clean plan reports nothing ────────────────────────
  {
    const root = gitFixture('clean');
    const result = await executeValidationPlan({
      provider: 'b7dff-f003-clean',
      commands: [probe('clean-1', { exitAtMs: 400 }), probe('clean-2', { exitAtMs: 400 })],
    }, root, undefined, undefined, { jobs: 2 });

    ok('a clean concurrent plan produces no per-command pollution',
      result.commands.every((command) => command.worktreePollution === undefined));
    ok('and no set-attributed record', result.concurrentWorktreePollution === undefined);
    ok('and passes', result.allPass === true && result.status === 'pass');
    assert.doesNotMatch(detailsOf(result), /dirtied worktree/);
    assertions++;
    console.log('VI-OK B7DFF-F003-CLEAN-PLAN-SILENT a clean plan in the same live git repo reports no pollution, so the sections above are not an always-on reporter');
  }

  // ── 5. NOTHING LOST: two concurrent writers, both paths still surface ──────
  {
    const root = gitFixture('both-dirty');
    const result = await executeValidationPlan({
      provider: 'b7dff-f003-both-dirty',
      commands: [
        probe('writer-A', { writes: 'from-a.txt', writeAtMs: 300, exitAtMs: 1200 }),
        probe('writer-B', { writes: 'from-b.txt', writeAtMs: 300, exitAtMs: 1200 }),
      ],
    }, root, undefined, undefined, { jobs: 2 });

    const concurrent = result.concurrentWorktreePollution;
    ok('both writes are reported, neither is dropped',
      Boolean(concurrent) && [...concurrent.paths].sort().join(',') === 'from-a.txt,from-b.txt');
    ok('each row names both candidates',
      concurrent.attributions.every((a) => a.candidates.length === 2));
    ok('and the run fails', concurrent.blocking === true && result.allPass === false);
    console.log('VI-OK B7DFF-F003-NO-DETECTION-LOST every path dirtied during overlapping windows is still reported and still blocks');

    // ── 6. GATE WIRING: the other pollution-reading gate must fail too ───────
    const blockingConcurrent = concurrent.blocking !== false;
    const summary = summarizeRoutineCommandExecution(result.commands, result.commands.length, {
      ...(blockingConcurrent ? { concurrentPollutionBlocking: true } : {}),
    });
    ok('summarizeRoutineCommandExecution reports FAIL for the set-attributed pollution',
      summary.status === 'FAIL' && summary.requiredFailureCount === 1 && summary.failureKind === 'validation_failure');
    // Control: the very same passing command results, without the flag, are a PASS —
    // so the assertion above is carried by the plan-level record and not by the
    // commands happening to fail on their own.
    const withoutFlag = summarizeRoutineCommandExecution(result.commands, result.commands.length, {});
    ok('the same command results without the plan-level record summarize as PASS',
      withoutFlag.status === 'PASS' && withoutFlag.requiredFailureCount === 0);
    console.log('VI-OK B7DFF-F003-GATE-CONSUMES-SET-RECORD the routine-validation command-execution receipt counts unattributable pollution as a required failure');
  }

  // ── 7. The pure attributor, with a control against phantom ambiguity ───────
  {
    assert.deepEqual(attributeWorktreePollution([]), { exclusive: [], concurrent: null });
    assertions++;

    const noPollution = attributeWorktreePollution([
      { candidate: '1:a', statusLines: [] },
      { candidate: '2:b', statusLines: [] },
    ]);
    ok('no observations means no attribution work',
      noPollution.concurrent === null && noPollution.exclusive.every((lines) => lines.length === 0));

    // A saw x and y; B saw only y; C saw nothing. x is A's alone; y belongs to
    // {A,B} and C must not be named.
    const mixed = attributeWorktreePollution([
      { candidate: '1:a', statusLines: ['?? x.txt', '?? y.txt'] },
      { candidate: '2:b', statusLines: ['?? y.txt'] },
      { candidate: '3:c', statusLines: [] },
    ]);
    assert.deepEqual(mixed.exclusive, [['?? x.txt'], [], []]);
    assert.deepEqual(mixed.concurrent.paths, ['y.txt']);
    assert.deepEqual(mixed.concurrent.candidates, ['1:a', '2:b']);
    assert.deepEqual(mixed.concurrent.attributions[0].candidates, ['1:a', '2:b']);
    assertions += 4;

    // CONTROL: the same shape with y observed only once must NOT report ambiguity.
    const disjoint = attributeWorktreePollution([
      { candidate: '1:a', statusLines: ['?? x.txt'] },
      { candidate: '2:b', statusLines: ['?? y.txt'] },
    ]);
    ok('disjoint observations stay exclusive and produce no ambiguity record',
      disjoint.concurrent === null
      && disjoint.exclusive[0][0] === '?? x.txt'
      && disjoint.exclusive[1][0] === '?? y.txt');
    console.log('VI-OK B7DFF-F003-ATTRIBUTOR-PURE the attributor keeps single-observer rows exclusive, groups multi-observer rows in plan order, and reports ambiguity only when it exists');
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(`validate-pollution-attribution: PASS (${assertions} assertions)`);
