#!/usr/bin/env node
/**
 * RED artifact (W2d / B-9ff1, CHK-012 + CHK-013 + CHK-014) — the read-only
 * `red_evidence_envelope_check` command: its SUCCESS OUTPUT CONTRACT, its
 * registration, and its read-only-ness.
 *
 * Repro-first RED: written and committed BEFORE the command is implemented and
 * wired. At that point `registry.get('red_evidence_envelope_check')` is
 * undefined (and the envelope module import fails), so this file exits non-zero
 * — that IS the RED evidence.
 *
 * CHK-014 success output contract: on an ADMISSIBLE envelope the command reports
 *   - the computed `assertionDigest`
 *   - the matched binding reference (acceptanceTargetRef, adapterId, testCaseRef)
 *   - the resolved `policyDigest`
 * so the operator can proceed to spend a run. On an INADMISSIBLE envelope that
 * success output is ABSENT and the tagged §1.6 rejection is reported instead.
 *
 * CHK-012 read-only, stated as exactly what each mechanism can show (review
 * B-9ff1 F-002/F-012/F-013 — three reviewers independently observed that the
 * directory snapshot was being credited with more than it proves):
 *
 *   1. A per-file SHA-256 snapshot of the whole `.lattice/` tree, compared
 *      before and after every invocation. WHAT IT PROVES: across the DIRECT
 *      handler invocations this file makes, no file under `.lattice/` was
 *      created, modified or removed — which covers the story record, the chain,
 *      evidence artifacts and process-event logs, because those all live there.
 *      WHAT IT CANNOT PROVE: anything about writes OUTSIDE `.lattice/`;
 *      anything about CHILD PROCESSES (a directory hash cannot see a spawn);
 *      and anything the CLI WRAPPER does, because these are direct
 *      `registry.get(COMMAND)` calls that never enter `runCli` in
 *      `cli-engine.ts`. Section 6a states both reasons the CLI's own
 *      `activity.jsonl` session row is structurally invisible here.
 *   2. A CHILD-PROCESS RECORDER installed before the dist graph is imported, so
 *      the handler's `child_process` calls are observed rather than assumed.
 *      WHAT IT PROVES: the exact spawn set of the call, positively. The command
 *      is EXPECTED to spawn: reading the target binding from the COMMITTED tree
 *      (`git rev-parse` + `git show`) instead of the live story directory is
 *      §1.1.3's anti-swap property, so the assertion is that the spawn set is
 *      exactly those read-only git reads — never a RED run, a package manager,
 *      or a test harness. "Spawns nothing" would be the wrong claim and would
 *      make this test demand the removal of a deliberate safety property.
 *   3. Static registration facts (`ownershipClass: readOnly`,
 *      `READ_ONLY_COMMANDS` membership, process-fact level L0, no
 *      `gateEvidence`). WHAT THEY PROVE: the command is CLASSIFIED read-only, so
 *      the CLI's hook and process-event write surfaces are suppressed for it —
 *      both are gated on `isReadOnlyCommand` alone, with no second term. WHAT
 *      THEY DO NOT PROVE: that the CLI writes no activity row. Classification is
 *      necessary but not sufficient there, and two independent paths break it:
 *      `shouldWriteActivityLog` returns true for a read-only command when
 *      `LATTICE_ACTIVITY_RECORD_READONLY=1` (a real operating mode — it is baked
 *      into the global Codex fallback command and the generated Codex wrapper),
 *      and both `writeLog` call sites in `cli-engine.ts` read
 *      `shouldWriteActivityLog(...) || staleWarnings.length > 0`, so an uncooled
 *      stale warning appends one generic session row for ANY command, read-only
 *      included. That row is CLI session telemetry, not a write by this command,
 *      which is why the contract asserted here is the four-category one (no
 *      artifact, no process event, no chain record, no gate verdict change).
 *      These are declarations about wiring, NOT behavioural evidence, and are
 *      labelled as such below.
 *
 * CHK-013 validate-pipeline invocation: the smoke's `validate.commands` entry is
 * resolved with the SAME `configuredValidationCommands` the validate pipeline
 * uses and executed with the SAME `runValidationCommand` executor, so the entry
 * is proven to actually run green through that path — not merely to appear in a
 * config array.
 *
 * Assurance scope (§0.6 practical tier): registered-surface drift detection, not
 * a defence against a hostile local agent (Tier-C).
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

// ── THE CHILD-PROCESS RECORDER (must be installed BEFORE any dist import) ────
// Node snapshots a builtin's named exports into the ESM namespace the FIRST time
// any ES module imports it, so a patch applied after that snapshot is invisible
// to later importers. This file therefore does NOT statically import
// `node:child_process`: it reaches the CJS exports object through `createRequire`
// and wraps the spawn family here, before the `await import(DIST/...)` calls
// below link the module graph. (Verified by the negative control at the bottom:
// the recorder must have observed the git reads; a recorder that silently failed
// to install would record nothing and could then "prove" anything.)
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
/** Every child process created after this point, in order. */
const spawnLog = [];
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = childProcess[fn];
  if (typeof real !== 'function') continue;
  childProcess[fn] = function recorded(...args) {
    spawnLog.push({ api: fn, file: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [] });
    return real.apply(this, args);
  };
}
/** The test's own fixture commands go through the recorder too; windows exclude them. */
const spawnSync = (...args) => childProcess.spawnSync(...args);
const spawnWindow = () => {
  const from = spawnLog.length;
  return () => spawnLog.slice(from);
};

const DIST = new URL('../../dist', import.meta.url).pathname;
/** The repository root, so the validate-pipeline section reads the REAL config. */
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { createMainRegistry } = await import(`${DIST}/registry.js`);
const { targetBindingDigest, emptyRedTargetBindingsFile, appendTargetBinding } =
  await import(`${DIST}/core/red-evidence/target-bindings.js`);
const { computeAssertionDigest } = await import(`${DIST}/core/red-evidence/envelope.js`);
const { MAIN_TOOLS, resolveEffectiveOwnershipClass, enforceStoryOwnerLeaseGate } =
  await import(`${DIST}/cli-engine.js`);
const { getCommandPolicy } = await import(`${DIST}/core/command-policy.js`);
const { PROCESS_FACT_LEVELS } = await import(`${DIST}/core/process-fact-levels.js`);
const { isReadOnlyCommand, READ_ONLY_COMMANDS } = await import(`${DIST}/cli/activity-policy.js`);
const { configuredValidationCommands } = await import(`${DIST}/handlers/verifier.js`);
const { runValidationCommand } = await import(`${DIST}/core/validation-executor.js`);

const COMMAND = 'red_evidence_envelope_check';
const FROZEN_POLICY_DIGEST = 'sha256:470db38278a59387f2105c8bcdcca59ee52c8706cb3c69f7e150d3cd1154d767';

// ── 1. Registration (CHK-013) ────────────────────────────────────────────────
// These are DECLARATIONS about wiring, not behavioural evidence: they prove the
// command is CLASSIFIED read-only — which is what suppresses the CLI's hook and
// process-event writes, and which is NOT sufficient to suppress the activity row
// (see §3 of the header) — not that any particular call wrote nothing. The
// behavioural evidence is sections 2 and 6 below, and it is evidence about the
// HANDLER: every invocation there is a direct `registry.get(COMMAND)` call, so it
// establishes what the handler does, never what the CLI wrapper around it does.
assert.ok(MAIN_TOOLS.some((tool) => tool.name === COMMAND), `${COMMAND} must be in MAIN_TOOLS (CLI dispatchable)`);
const policyEntry = getCommandPolicy(COMMAND);
assert.ok(policyEntry, `${COMMAND} must have a CommandPolicy entry`);
assert.equal(policyEntry.ownershipClass, 'readOnly',
  `${COMMAND} is classified readOnly — it writes no artifact, process event or chain record`);
assert.equal(policyEntry.destructiveRisk, 'none', `${COMMAND} carries no destructive risk`);
assert.notEqual(policyEntry.status, 'gateEvidence', `${COMMAND} is NOT gate evidence — it changes no gate verdict`);
assert.notEqual(policyEntry.gateEvidence, true, `${COMMAND} must not declare gateEvidence`);
const levelEntry = PROCESS_FACT_LEVELS.find((entry) => entry.name === COMMAND);
assert.ok(levelEntry, `${COMMAND} must have a process-fact level entry`);
assert.equal(levelEntry.level, 'L0', `${COMMAND} is an L0 read-only/reporting fact`);
assert.equal(levelEntry.gateConsumer, undefined, 'an L0 read-only checker declares no gateConsumer');
assert.ok(READ_ONLY_COMMANDS.has(COMMAND), `${COMMAND} must be in the CLI READ_ONLY_COMMANDS class`);
assert.equal(isReadOnlyCommand(COMMAND, {}), true,
  'the CLI read-only predicate recognises the command, so its hook and process-event writes are suppressed; '
  + 'the activity row is NOT settled by this predicate alone (LATTICE_ACTIVITY_RECORD_READONLY=1 and the '
  + 'stale-warning OR in cli-engine.ts each still append one generic session row)');

// ── Fixture repo ─────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'red-w2d-cmd-'));
try {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'red@w2d.local']);
  git(['config', 'user.name', 'red-w2d']);

  // A config carrying the MINIMAL red-evidence policy block: pinnedPath only,
  // so the resolved snapshot is the frozen default and its digest is the W2a
  // pinned literal.
  writeFileSync(join(root, 'lattice.config.json'), `${JSON.stringify({ redEvidence: { pinnedPath: ['/usr/bin'] } }, null, 2)}\n`);

  const storyId = 'B-w2d1';
  const store = new StoryStore(root);
  const now = '2026-08-01T00:00:00.000Z';
  store.writeStory(storyId, {
    storyId, name: 'w2d', title: 'W2d envelope check fixture',
    description: 'Envelope admissibility pre-flight fixture.',
    type: 'feature', phase: 'DEV', priority: 'high', createdAt: now, startedAt: now, endedAt: null,
  });

  const BINDING = { acceptanceTargetRef: 'M1', adapterId: 'npm-script@1', testCaseRef: 'npm-script:test:x' };
  store.writeRedTargetBindings(storyId, appendTargetBinding(emptyRedTargetBindingsFile(storyId, now), BINDING, now));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture: committed target binding']);

  const storyRel = relative(realpathSync(root), realpathSync(store.storyDirPath(storyId)));
  assert.ok(!storyRel.startsWith('..'), 'the story dir resolves inside the fixture repo');

  const ADMISSIBLE_VALUE = "Error: Cannot find module '/repo/dist/x.js'";
  const admissible = {
    acceptanceTargetRef: 'M1',
    matchers: [{ id: 'L1', kind: 'literal-line', value: ADMISSIBLE_VALUE, stream: 'combined', polarity: 'present-in-red' }],
    expectedExitClass: 'nonzero',
    targetExercisedProof: {
      method: 'harness-token',
      testCaseRef: BINDING.testCaseRef,
      adapterId: BINDING.adapterId,
      targetBindingDigest: targetBindingDigest(BINDING),
    },
  };
  const admissibleFile = join(root, 'envelope-ok.json');
  writeFileSync(admissibleFile, `${JSON.stringify(admissible, null, 2)}\n`);

  const inadmissible = JSON.parse(JSON.stringify(admissible));
  inadmissible.matchers[0].value = 'failed'; // below the §1.3 rule-2 floors -> R1-2
  const inadmissibleFile = join(root, 'envelope-bad.json');
  writeFileSync(inadmissibleFile, `${JSON.stringify(inadmissible, null, 2)}\n`);

  writeFileSync(join(root, 'envelope-broken.json'), '{ this is not json\n');

  const registry = createMainRegistry({ store, root, scanRoot: join(root, 'packages', 'main') });
  const registeredCheck = registry.get(COMMAND);
  assert.ok(registeredCheck, `${COMMAND} must have a registered handler (dispatchability)`);
  // Count invocations so the summary line reports the number actually made
  // rather than a literal that can drift away from the body.
  let invocations = 0;
  const check = (args) => {
    invocations += 1;
    return registeredCheck(args);
  };

  // ── 2. Read-only snapshot of the whole .lattice tree (CHK-012) ─────────────
  function snapshotLattice() {
    const base = join(root, '.lattice');
    const entries = [];
    const walk = (dir, rel) => {
      for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = join(dir, item.name);
        const next = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory()) walk(abs, next);
        else entries.push(`${next}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
      }
    };
    walk(base, '');
    return entries.join('\n');
  }
  const before = snapshotLattice();
  assert.ok(before.length > 0, 'the fixture .lattice tree is non-empty, so the comparison is meaningful');
  // Open the child-process window: everything spawned from here until section 6
  // is attributable to the command under test, not to this file's git fixture.
  const spawnsDuringCheck = spawnWindow();

  // ── 3. SUCCESS OUTPUT CONTRACT (CHK-014) ──────────────────────────────────
  const expectedDigest = computeAssertionDigest({ ...admissible, policyDigest: FROZEN_POLICY_DIGEST });
  const out = check({ storyId, assertionFile: admissibleFile });
  assert.equal(typeof out, 'string', 'the command returns a report string');
  assert.ok(out.includes(expectedDigest), `success output must carry the COMPUTED assertionDigest ${expectedDigest}; got:\n${out}`);
  assert.ok(out.includes(FROZEN_POLICY_DIGEST), `success output must carry the resolved policyDigest; got:\n${out}`);
  for (const field of [BINDING.acceptanceTargetRef, BINDING.adapterId, BINDING.testCaseRef]) {
    assert.ok(out.includes(field), `success output must carry the matched binding field ${field}; got:\n${out}`);
  }
  assert.match(out, /ADMISSIBLE/, 'success output states the verdict in words');

  // JSON projection carries the same three facts structurally.
  const json = JSON.parse(check({ storyId, assertionFile: admissibleFile, json: true }));
  assert.equal(json.ok, true);
  assert.equal(json.assertionDigest, expectedDigest);
  assert.equal(json.policyDigest, FROZEN_POLICY_DIGEST);
  assert.deepEqual(json.binding, BINDING, 'the JSON binding reference carries all THREE fields, not just the target ref');
  assert.deepEqual(json.rejections, []);

  // The digest is recomputed per envelope, never cached or echoed: a one-value
  // change moves it.
  const variant = JSON.parse(JSON.stringify(admissible));
  variant.matchers[0].value = "Error: Cannot find module '/repo/dist/y.js'";
  const variantFile = join(root, 'envelope-variant.json');
  writeFileSync(variantFile, `${JSON.stringify(variant, null, 2)}\n`);
  const variantJson = JSON.parse(check({ storyId, assertionFile: variantFile, json: true }));
  assert.equal(variantJson.ok, true);
  assert.notEqual(variantJson.assertionDigest, expectedDigest,
    'two envelopes differing by one matcher value produce DIFFERENT assertionDigests');

  // ── 4. Inadmissible: tagged rejection, NO success output (CHK-014) ─────────
  let rejectionMessage = '';
  assert.throws(
    () => check({ storyId, assertionFile: inadmissibleFile }),
    (error) => {
      rejectionMessage = error.message;
      return /R1-2/.test(error.message);
    },
    'an inadmissible envelope reports its EXACT §1.6 tag and exits non-zero',
  );
  assert.equal(rejectionMessage.split('\n')[0], 'Red-evidence envelope: NOT ADMISSIBLE',
    `the verdict line must state NOT ADMISSIBLE; got:\n${rejectionMessage}`);
  assert.ok(!rejectionMessage.includes('Red-evidence envelope: ADMISSIBLE'),
    `the success verdict line must be ABSENT for an inadmissible envelope; got:\n${rejectionMessage}`);
  assert.ok(!rejectionMessage.includes(expectedDigest),
    'no computed assertionDigest is advertised for an inadmissible envelope');

  // ── 5. Fail-closed inputs (CHK-012) ───────────────────────────────────────
  assert.throws(() => check({ storyId: 'B-nope', assertionFile: admissibleFile }), /B-nope/,
    'a nonexistent storyId fails with a diagnostic naming the story');
  assert.throws(() => check({ storyId, assertionFile: join(root, 'envelope-broken.json') }), /JSON|parse/i,
    'a syntactically invalid envelope file fails with a parse diagnostic');
  assert.throws(() => check({ storyId, assertionFile: join(root, 'no-such-file.json') }), /no-such-file\.json/,
    'a missing envelope file fails with a diagnostic naming the path');
  assert.throws(() => check({ storyId }), /assertionFile/,
    'a missing assertionFile argument fails closed');

  // ── 6a. WHAT THE DIRECTORY SNAPSHOT PROVES ────────────────────────────────
  // Exactly this: no file under `.lattice/` was created, modified or removed by
  // any of the invocations above. The story record, the red-evidence chain,
  // evidence artifacts and process-event logs all live under `.lattice/`, so
  // this covers those writes — and nothing else. It says NOTHING about child
  // processes; section 6b is what carries that claim.
  //
  // AND IT CANNOT SEE THE CLI WRAPPER. Every invocation above is
  // `registeredCheck(args)` — the handler, called directly. Two independent
  // reasons the CLI's own `activity.jsonl` session row can never show up in this
  // comparison, so an unchanged snapshot must not be read as "the CLI writes
  // nothing when this command runs":
  //   1. PRIMARY and controlling: `writeLog` is a function local to `runCli` in
  //      `cli-engine.ts`, called only from that function's inner `run()` wrapper.
  //      A direct handler call never enters `runCli`, so neither the
  //      `shouldWriteActivityLog(...) || staleWarnings.length > 0` decision nor
  //      the append it guards is reached at all. This holds no matter how the
  //      fixture or the environment is configured.
  //   2. SECONDARY, and it would still hold even through the CLI: the
  //      stale-warning path starts at `detectActiveStoryId` in
  //      `core/stale-detector.ts`, which requires the git branch to start with
  //      `story/`. This fixture repo is a bare `git init` in a tmpdir, so
  //      `detectStaleState` short-circuits to `[]` and that OR term is always
  //      false here regardless.
  // Observing the row would take a CLI-level test running on a `story/` branch
  // with an uncooled warning, or with LATTICE_ACTIVITY_RECORD_READONLY=1; that
  // belongs to the follow-up work on the shared entrypoint, not here.
  assert.equal(snapshotLattice(), before,
    'red_evidence_envelope_check, invoked directly as a handler, created, modified or removed NO file under .lattice/ — so it wrote no story record, chain record, evidence artifact or process event, and moved no stored gate verdict');

  // ── 6b. THE SPAWN SET, ASSERTED POSITIVELY ────────────────────────────────
  // The command IS expected to spawn: §1.1.3 requires the target binding to be
  // read from the COMMITTED tree (`git show <ref>:<path>`, guarded by a
  // `git rev-parse` ref check) rather than the live story directory, which is
  // what makes a post-review edit invisible. So the claim under test is not
  // "spawns nothing" — it is "spawns EXACTLY those read-only git reads", i.e.
  // never a RED run, a test harness, or a package manager.
  const spawns = spawnsDuringCheck();
  assert.ok(spawns.length > 0,
    'NEGATIVE CONTROL: the recorder observed no child process at all across every invocation. Either the '
    + 'committed-tree binding read is gone (a §1.1.3 anti-swap regression) or the recorder failed to install '
    + 'before the dist graph linked — in which case every assertion below would pass vacuously');
  // `exec`/`execSync` take a command STRING while `spawn*`/`execFile*` take an
  // argv array; normalize both to argv so one allowlist governs all of them.
  const argvOf = (call) => (call.args.length > 0 ? [call.file, ...call.args] : call.file.trim().split(/\s+/));
  const shapes = [...new Set(spawns.map((call) => {
    const argv = argvOf(call);
    return `${call.api} ${argv[0]} ${argv[1] ?? ''}`.trim();
  }))].sort();
  // THE EXACT OBSERVED SPAWN SET. Two families, both read-only:
  //   - repository/worktree RESOLUTION (which git dir and toplevel this story's
  //     root maps to), which the handler needs before it can name a committed
  //     path at all; and
  //   - the W2b committed-tree READ itself (ref verify + blob read).
  // Anything else — a runner, a harness, a package manager, a git command that
  // MUTATES — is a regression, and this list is what makes it one.
  assert.deepEqual(
    shapes,
    [
      'execFileSync git rev-parse',
      'execFileSync git worktree',
      'execSync git rev-parse',
      'spawnSync git rev-parse',
      'spawnSync git show',
    ],
    `unexpected child-process shape; observed: ${JSON.stringify(spawns.map(argvOf))}`,
  );
  /** Read-only git subcommands, with the exact read-only sub-form required. */
  const READ_ONLY_GIT = {
    'rev-parse': (argv) => argv.slice(2).every((a) => /^(?:--verify|--quiet|--show-toplevel|--git-common-dir)$/.test(a) || /\^\{commit\}$/.test(a)),
    show: (argv) => argv.length === 3 && argv[2].includes(':'),
    worktree: (argv) => argv[2] === 'list',
  };
  for (const call of spawns) {
    const argv = argvOf(call);
    assert.equal(argv[0], 'git', `every child process must be git; observed ${argv.join(' ')}`);
    const allowed = READ_ONLY_GIT[argv[1]];
    assert.ok(allowed, `git subcommand ${JSON.stringify(argv[1])} is outside the read-only allowlist: ${argv.join(' ')}`);
    assert.ok(allowed(argv), `git ${argv[1]} is not in its read-only form: ${argv.join(' ')}`);
    // The fabrication surface this pre-flight exists to keep closed until a run
    // is deliberately spent.
    assert.ok(!/^(?:npm|npx|yarn|pnpm|node|sh|bash|zsh|env|make|python3?)$/.test(argv[0]),
      `the pre-flight must never spawn a runner/harness/shell; observed ${argv.join(' ')}`);
  }
  // The W2b pair specifically: a ref VERIFY and a blob read of the COMMITTED
  // bindings file, pairing up one-for-one. This is the anti-swap property, so it
  // is asserted to be PRESENT, not merely permitted.
  const refVerify = spawns.map(argvOf).filter((argv) => argv[1] === 'rev-parse' && argv.includes('--verify'));
  const blobRead = spawns.map(argvOf).filter((argv) => argv[1] === 'show');
  assert.ok(blobRead.length > 0, 'the committed-tree blob read must actually happen');
  assert.equal(refVerify.length, blobRead.length,
    'each committed-tree read is a ref VERIFY followed by a blob read; the two must pair up');
  for (const argv of refVerify) {
    assert.deepEqual(argv.slice(1, 4), ['rev-parse', '--verify', '--quiet'], 'the ref check is the read-only verify form');
    assert.match(argv[4] ?? '', /\^\{commit\}$/, 'the ref check resolves a commit');
  }
  for (const argv of blobRead) {
    assert.match(argv[2], /^[^:]+:\.lattice\/story\/actives\/.+\/red-target-bindings\.json$/,
      'the blob read targets the committed target-bindings file at a ref, and nothing else');
  }

  // ── 7. The owner lease never gates it (readOnly) ──────────────────────────
  assert.equal(resolveEffectiveOwnershipClass(COMMAND, { storyId }, storyId), 'readOnly');
  assert.doesNotThrow(
    () => enforceStoryOwnerLeaseGate(COMMAND, { storyId }, store, null, root),
    'a read-only pre-flight is never owner-lease gated, even on a foreign-owned story',
  );

  // ── 8. THE VALIDATE-PIPELINE INVOCATION PATH (CHK-013) ────────────────────
  // Registration-in-config plus a hand-rolled `node <path>` run only APPROXIMATE
  // "lattice validate runs it": neither exercises the pipeline's own resolution
  // of the entry (argv, cwd, timeout) nor its executor. Both are exercised here,
  // through the exact functions `lattice validate` calls, so a registration that
  // is present but unrunnable — a typo'd arg, a bad cwd, a nonsense timeout —
  // fails this committed test instead of surfacing on somebody's next validate.
  const SMOKE_ENTRY = 'packages/main/dist/tasks/red-evidence-envelope-smoke.js';
  const resolved = configuredValidationCommands(REPO_ROOT)
    .filter((entry) => [entry.command, ...(entry.args ?? [])].includes(SMOKE_ENTRY));
  assert.equal(resolved.length, 1,
    `exactly one lattice.config.json validate.commands entry must resolve to ${SMOKE_ENTRY}; got ${resolved.length}`);
  const [smokeCommand] = resolved;
  assert.equal(smokeCommand.command, 'node', 'the pipeline resolves the entry to a direct node invocation');
  assert.notEqual(smokeCommand.shell, true, 'the entry is argv-shaped, never shell-interpreted');
  assert.ok(typeof smokeCommand.timeoutMs === 'number' && smokeCommand.timeoutMs > 0,
    'the entry declares a positive per-command timeout the pipeline can enforce');
  const pipelineResult = await runValidationCommand(smokeCommand, REPO_ROOT);
  assert.equal(pipelineResult.code, 0,
    `${SMOKE_ENTRY} must exit 0 when run through the validate pipeline's own executor; got code=${pipelineResult.code}\n${pipelineResult.output}`);
  assert.notEqual(pipelineResult.timedOut, true, 'the entry completes inside its configured timeout');
  assert.match(pipelineResult.output, /red-evidence-envelope-smoke: OK/,
    'the pipeline captured the smoke\'s own success transcript, so the entry really ran');

  console.log('red-w2d-command-readonly: PASS');
  console.log(`  registration: MAIN_TOOLS + command-policy(readOnly/none) + process-fact L0 + READ_ONLY_COMMANDS + registered handler`);
  console.log(`  success output: assertionDigest ${expectedDigest} / binding ${BINDING.acceptanceTargetRef} ${BINDING.adapterId} ${BINDING.testCaseRef} / policyDigest ${FROZEN_POLICY_DIGEST}`);
  console.log(`  inadmissible: tagged R1-2 rejection, success output absent; no .lattice file created/modified/removed across ${invocations} DIRECT handler invocations (the CLI wrapper is not exercised here)`);
  console.log(`  spawn set observed across those invocations: ${shapes.join(' + ')} (${spawns.length} calls) — read-only git, no runner/harness/shell`);
  console.log(`  validate pipeline: ${SMOKE_ENTRY} resolved via configuredValidationCommands and run via runValidationCommand -> exit 0 in ${pipelineResult.durationMs}ms`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
