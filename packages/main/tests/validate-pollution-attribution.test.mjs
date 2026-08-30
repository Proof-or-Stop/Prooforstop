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
 *   8. HANDLER WIRING (B-7dff F-006) — the same scenario driven through the REAL
 *      `proof-or-stop validate --story=... --json` CLI, asserted on the PERSISTED
 *      test-evidence.json. Section 6 proves the summariser honours the flag when
 *      it is handed one; it cannot prove anybody hands it one. It did not:
 *      `externalResult()` in handlers/verifier.ts is a field whitelist and
 *      dropped `concurrentWorktreePollution` on the way to the evidence writer,
 *      so a detected-and-failed run persisted `commandExecution: {status: PASS,
 *      requiredFailureCount: 0}` — the exact shape `isReusableCommandPass`
 *      inspects. Section 8 fails if that whitelist ever drops the field again,
 *      and its clean control proves the assertion is carried by the pollution
 *      wiring rather than by a fixture that fails for any reason.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const distDir = resolve(repoRoot, 'packages/main/dist');

for (const required of ['core/validation-executor.js', 'core/validation-evidence-reuse.js', 'core/store.js', 'cli.js']) {
  if (!existsSync(join(distDir, required))) {
    console.error(`validate-pollution-attribution: missing build artifact ${join(distDir, required)}; run npm --prefix packages/main run build first`);
    process.exit(1);
  }
}

const load = (rel) => import(pathToFileURL(join(distDir, rel)).href);
const { attributeWorktreePollution, executeValidationPlan } = await load('core/validation-executor.js');
const { isReusableCommandPass, summarizeRoutineCommandExecution } = await load('core/validation-evidence-reuse.js');
const { StoryStore } = await load('core/store.js');
const cliPath = join(distDir, 'cli.js');

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

/**
 * A scratch directory for handshake markers, deliberately OUTSIDE any git
 * fixture so the synchronisation never registers as pollution itself.
 */
function syncDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `b7dff-sync-${name}-`));
  roots.push(dir);
  return dir;
}

/**
 * Per-command ceiling for every handshake probe. The in-script give-up budget
 * below is deliberately LARGER than this: see {@link handshakeCommand}.
 */
const HANDSHAKE_COMMAND_TIMEOUT_MS = 60_000;
/**
 * The in-script give-up budget. Strictly greater than the per-command ceiling
 * the framework itself enforces, so on a host that cannot schedule the two
 * probes together the FRAMEWORK's kill (exit 124, `timedOut: true`) always
 * fires first. That matters: an in-script budget that expires FIRST ends one
 * probe early, which silently turns the ambiguous-attribution shape this file
 * exists to prove into an exclusive one — a false negative dressed up as a
 * regression. This budget therefore only guards against a script that somehow
 * outlives its parent, and can never decide the attribution shape.
 */
const HANDSHAKE_BUDGET_MS = 90_000;

/**
 * A command whose overlap with its peers is established by a HANDSHAKE, not by
 * sleeping. What has to be ordered is not the two child processes but the FOUR
 * git-status samples the parent takes around them (`readGitStatus` before the
 * spawn, and again on 'close', in core/validation-executor.ts). The handshake
 * pins all four to observed facts rather than to timing:
 *
 *   before-samples < the write — each probe's before-sample is taken by the
 *     parent BEFORE that probe is spawned, and the writer does not write until
 *     every peer has announced its start, which only a spawned peer can do. So
 *     no before-sample can contain the row.
 *   the write < both after-samples — the bystander does not exit until it has
 *     stat'd the writer's REAL file (not a proxy marker) in the very directory
 *     git scans, and then publishes a `<self>.observed` receipt; the writer does
 *     not exit until it sees that receipt. Both 'close' events, and therefore
 *     both after-samples, are gated on one confirmed on-disk observation.
 *
 * Nothing here is timing-based, and no branch of it can end a probe early
 * enough to shrink a window: the only way out of a wait is the awaited fact or
 * a loud non-zero exit.
 *
 * `writes` makes this the writer; `observes` (an absolute path) makes it the
 * bystander that must witness that file; `awaitObservedBy` is the peer whose
 * `.observed` receipt the writer waits for before exiting.
 */
function handshakeCommand({ syncDir: dir, self, peers, writes = null, observes = null, awaitObservedBy = null }) {
  const script = [
    "const fs=require('fs');const path=require('path');",
    `const sync=${JSON.stringify(dir)};`,
    // Monotonic, so a wall-clock jump (NTP step, suspend/resume) cannot expire
    // the budget out from under a probe that is waiting correctly.
    'const startNs=process.hrtime.bigint();',
    'const elapsedMs=()=>Number((process.hrtime.bigint()-startNs)/1000000n);',
    'const idle=(ms)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);',
    `const budgetMs=${HANDSHAKE_BUDGET_MS};`,
    'const awaitFact=(label,holds)=>{while(!holds()){if(elapsedMs()>budgetMs){console.error("handshake timeout waiting for "+label);process.exit(3);}idle(5);}};',
    'const marker=(name)=>path.join(sync,name);',
    `fs.writeFileSync(marker(${JSON.stringify(`${self}.start`)}),'1');`,
    `for (const peer of ${JSON.stringify(peers)}) awaitFact(peer+'.start',()=>fs.existsSync(marker(peer+'.start')));`,
    writes ? `fs.writeFileSync(${JSON.stringify(writes)},'oops\\n');` : '',
    observes
      ? `awaitFact(${JSON.stringify(`${observes} on disk`)},()=>fs.existsSync(${JSON.stringify(observes)}));fs.writeFileSync(marker(${JSON.stringify(`${self}.observed`)}),'1');`
      : '',
    awaitObservedBy
      ? `awaitFact(${JSON.stringify(`${awaitObservedBy}.observed`)},()=>fs.existsSync(marker(${JSON.stringify(`${awaitObservedBy}.observed`)})));`
      : '',
    'process.exit(0);',
  ].join('');
  return {
    label: self,
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: HANDSHAKE_COMMAND_TIMEOUT_MS,
    resources: [REPO_SHARED],
  };
}

/**
 * A complete Proofbound project fixture (git repo + config + REVIEW-phase story)
 * whose configured `validate.commands` are the two handshake probes above, then
 * ONE real `proof-or-stop validate --story=... --json` run against it. Returns the
 * handler's own JSON result and the test-evidence.json the handler persisted.
 */
function runStoryValidateFixture(name, { dirty }) {
  const root = gitFixture(name);
  const sync = syncDir(name);
  const storyId = 'B-f006';
  const accidental = join(root, 'accidental.txt');
  const commands = [
    handshakeCommand({
      syncDir: sync,
      self: 'writer',
      peers: ['bystander'],
      ...(dirty ? { writes: accidental, awaitObservedBy: 'bystander' } : {}),
    }),
    handshakeCommand({
      syncDir: sync,
      self: 'bystander',
      peers: ['writer'],
      ...(dirty ? { observes: accidental } : {}),
    }),
  ];
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.',
    rootDir: '.',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
    validate: { commands },
  }, null, 2));
  git('checkout', '-B', 'main');
  git('add', '.');
  git('commit', '-m', 'configure validate commands');
  git('checkout', '-b', `story/${storyId}`);

  const now = '2026-08-17T00:00:00.000Z';
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId,
    name: 'f006-handler-wiring',
    title: 'concurrent pollution evidence wiring',
    description: 'Proves the validate handler carries the plan-level dirty verdict into persisted evidence.',
    type: 'bug',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    riskSignals: [],
    currentReviewRound: now,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  });
  store.writeChecklist(storyId, { items: [{
    id: 'CHK-001',
    title: 'handler wiring probe',
    context: 'No required intents keeps current coverage complete.',
    status: 'done',
    startTime: now,
    endTime: now,
  }] });
  git('add', '.proof-or-stop');
  git('commit', '-m', 'seed story metadata');

  const run = spawnSync(process.execPath, [cliPath, 'validate', `--story=${storyId}`, '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROOF_OR_STOP_PROJECT_ROOT: root,
      PROOF_OR_STOP_SESSION_ID: `b7dff-${name}`,
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
      PROOF_OR_STOP_VALIDATE_JOBS: '2',
    },
  });
  const transcript = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const jsonLine = (run.stdout ?? '').split('\n').filter((line) => line.trimStart().startsWith('{')).at(-1);
  assert.ok(jsonLine, `validate --json printed no JSON result:\n${transcript}`);
  const handler = JSON.parse(jsonLine);
  assert.notEqual(handler.provider, 'proof-or-stop-verifier-executed-persistence',
    `evidence persistence failed, so this fixture proves nothing about the wrap:\n${transcript}`);
  const evidencePath = join(root, `.proof-or-stop/story/actives/${storyId}/test-evidence.json`);
  assert.ok(existsSync(evidencePath), `handler persisted no test-evidence.json:\n${transcript}`);
  return { root, sync, handler, evidence: JSON.parse(readFileSync(evidencePath, 'utf8')), transcript };
}

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

  // ── 8. B-7dff F-006: the REAL handler must carry the record into evidence ──
  //
  // Driven through `node dist/cli.js validate --story=... --json`, the actual
  // configured-commands production path, and asserted on the file that path
  // persists. Nothing here reimplements verifier.ts's wrapping or evidence
  // logic: that is precisely the mistake section 6 could not catch.
  {
    const dirty = runStoryValidateFixture('f006-dirty', { dirty: true });
    const evidence = dirty.evidence;

    // FIXTURE PRECONDITION, checked BEFORE the attribution shape. The assertion
    // below only means "the handler dropped the field" if the two observation
    // windows really did both contain the row; a fixture whose overlap silently
    // failed to happen would otherwise report a false regression against
    // verifier.ts. The bystander publishes `bystander.observed` only after it
    // has stat'd the writer's file itself, and the writer does not exit until it
    // sees that receipt, so this pair of checks IS the overlap.
    ok('the bystander witnessed the writer\'s file on disk before either command exited',
      existsSync(join(dirty.sync, 'bystander.observed')));
    ok('and both handshake commands completed on their own terms, so neither window was cut short',
      Array.isArray(dirty.handler?.commands)
      && dirty.handler.commands.length === 2
      && dirty.handler.commands.every((command) => command.code === 0 && !command.timedOut));

    ok('the plan-level record survives the handler wrap and reaches the caller',
      Boolean(dirty.handler?.concurrentWorktreePollution));
    assert.deepEqual(dirty.handler.concurrentWorktreePollution.paths, ['accidental.txt']);
    assert.equal(dirty.handler.concurrentWorktreePollution.blocking, true);
    assert.equal(dirty.handler.status, 'fail');
    assert.equal(dirty.handler.allPass, false);
    assertions += 4;

    assert.equal(evidence.result, 'FAIL');
    assertions++;
    ok('and the persisted command-execution receipt states FAIL, not a PASS on a failed run',
      evidence.commandExecution.status === 'FAIL'
      && evidence.commandExecution.requiredFailureCount === 1
      && evidence.commandExecution.failureKind === 'validation_failure'
      && evidence.commandExecution.commandCount === 2);
    // The predicate the reuse gate itself calls, not a restatement of it.
    ok('so the reuse gate cannot read that receipt as a reusable PASS',
      isReusableCommandPass(evidence.commandExecution, 2) === false);
    ok('and the persisted output blob still explains WHY the run failed',
      Boolean(JSON.parse(evidence.output).concurrentWorktreePollution));

    // NEGATIVE CONTROL. Same fixture, same two concurrent commands, nobody
    // writes. If this also came back FAIL the assertions above would prove
    // nothing about pollution wiring — only that this fixture always fails.
    const clean = runStoryValidateFixture('f006-clean', { dirty: false });
    ok('the identical clean plan reports no plan-level record',
      clean.handler.concurrentWorktreePollution === undefined && clean.handler.status === 'pass');
    ok('and persists a genuine PASS receipt the reuse gate accepts',
      clean.evidence.result === 'PASS'
      && clean.evidence.commandExecution.status === 'PASS'
      && clean.evidence.commandExecution.requiredFailureCount === 0
      && isReusableCommandPass(clean.evidence.commandExecution, 2) === true);
    console.log('VI-OK B7DFF-F006-EVIDENCE-CARRIES-CONCURRENT-POLLUTION the real validate --story handler persists FAIL command-execution evidence for unattributable pollution, and a clean run still persists a reusable PASS');

    // STRUCTURAL GUARD. `externalResult()` is an enumerating whitelist; the F-006
    // defect was one unlisted field, and the next one would look identical. Run
    // the executor directly on an equivalent plan and require the handler's own
    // result to carry EVERY key the plan produced. This bites for any future
    // ValidationResult field, not just `concurrentWorktreePollution`.
    const probeRoot = gitFixture('f006-plan-keys');
    const sync = syncDir('f006-plan-keys');
    const probeAccidental = join(probeRoot, 'accidental.txt');
    const planResult = await executeValidationPlan({
      provider: 'b7dff-f006-plan-keys',
      commands: [
        handshakeCommand({ syncDir: sync, self: 'writer', peers: ['bystander'], writes: probeAccidental, awaitObservedBy: 'bystander' }),
        handshakeCommand({ syncDir: sync, self: 'bystander', peers: ['writer'], observes: probeAccidental }),
      ],
      // A headSha is supplied so the OPTIONAL keys of ValidationResult are in the
      // compared set too; a key the plan never emits cannot be proven carried.
    }, probeRoot, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: probeRoot, encoding: 'utf8' }).trim(), undefined, { jobs: 2 });
    ok('the direct plan reproduces the same unattributable row, so the key set below is the interesting one',
      Boolean(planResult.concurrentWorktreePollution));
    const dropped = Object.keys(planResult).filter((key) => !(key in dirty.handler));
    assert.deepEqual(dropped, [],
      `handlers/verifier.ts dropped plan result field(s) [${dropped.join(', ')}] on the way to persisted evidence; wrap the executor result additively instead of enumerating keys`);
    assertions++;
    console.log('VI-OK B7DFF-F006-NO-PLAN-FIELD-DROPPED every field executeValidationPlan produces survives the validate handler wrap');
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(`validate-pollution-attribution: PASS (${assertions} assertions)`);
