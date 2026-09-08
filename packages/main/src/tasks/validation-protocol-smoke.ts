#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { PROOF_OR_STOP_ADAPTER_DIR } from '../core/brand-paths.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeValidationPlan } from '../core/validation-executor.js';
import { resetConfigCache } from '../core/config.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import {
  configuredValidationCommands,
  createVerifierHandlers,
  discoverFallbackValidationCommands,
} from '../handlers/verifier.js';
import { createCheckHandlers } from '../handlers/check.js';
import { createDoctorHandlers } from '../handlers/doctor.js';
import { detectManagedAssetMode, managedAssetNextAction, renderManagedAssetCheck, runManagedAssetCheck } from '../core/managed-assets.js';
import { renderRuntimeFootprintSummary, runRuntimeEnvironmentChecks } from '../core/runtime-environment-checks.js';
import { StoryStore } from '../core/store.js';
import { acquireOwnerLease } from '../core/story-owner-lease.js';
import { getGuardFailureReason } from '../core/machine.js';
import { assertStoryTransitionReachedTarget, canSendStoryEvent } from '../handlers/transition-orchestrator.js';
import { renderProofOrStopBootstrapScript, renderProofOrStopCodexWrapperScript } from '../init-assets.js';
import { FULL_SUITE_ENTRIES, entriesFromSerialReference, parseSerialReference } from './full-suite-runner.js';

// B-623a: keep this smoke hermetic and fast — doctor now runs an advisory host
// burn scan over the real ~/.codex / ~/.claude stores by default; 0 disables it.
process.env.PROOF_OR_STOP_BURN_ALERT_RECENT_HOURS = '0';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = resolve(packageRoot, '../../..');
const cliPath = join(packageRoot, 'cli.js');

const tmp = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-protocol-'));

function gitQuiet(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
}

function initSmokeGitRepo(root: string): void {
  gitQuiet(root, ['init', '--initial-branch=main']);
  gitQuiet(root, ['config', 'user.name', 'ProofOrStop Smoke']);
  gitQuiet(root, ['config', 'user.email', 'smoke@example.test']);
}

function withFakeNpx<T>(root: string, scriptBody: string, fn: () => Promise<T>): Promise<T> {
  const binDir = join(root, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const npxPath = join(binDir, 'npx');
  writeFileSync(npxPath, `#!/usr/bin/env node\n${scriptBody}\n`, 'utf8');
  chmodSync(npxPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = oldPath ? `${binDir}${delimiter}${oldPath}` : binDir;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    });
}

function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env[key];
  process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
}

function assertRuntimeModeShape(value: any): void {
  assert.ok(value, 'runtimeMode should be present');
  assert.ok(['global-cli', 'project-local-package', 'packaged-runtime', 'compatibility-launcher', 'diagnostic-only'].includes(value.mode), `runtimeMode.mode enum: ${value.mode}`);
  assert.ok(['repo-local-dist', 'project-node-modules', 'packaged-runtime', 'external-development-engine', 'global-cli', 'unknown'].includes(value.source), `runtimeMode.source enum: ${value.source}`);
  assert.equal(typeof value.requiresProjectJavaScriptRuntime, 'boolean');
  assert.equal(value.authority, 'local-runtime-diagnostic-only');
  assert.equal(typeof value.message, 'string');
  assert.ok(value.message.length > 0);
  assert.deepEqual(Object.keys(value).sort(), ['authority', 'message', 'mode', 'requiresProjectJavaScriptRuntime', 'source'].sort());
}

// ---------------------------------------------------------------------------
// B-dc2e CHK-001: inventory registration and tasks/ orphan sweep.
//
// Until B-dc2e this smoke was an orphan: no npm script named it, the
// test:serial-reference chain never ran it, full-suite-runner RESOURCE_POLICY
// had no row for it and proof-or-stop.config.json validate.commands did not list
// it. Its CASE_MISMATCH assertion (further down) had been failing on every direct
// run and nobody could see it. The cases below turn orphaning itself into a
// failure, so the next silent drop-out of an inventory is visible here.
//
// Four inventories are consulted. The three canonical ones are the npm scripts
// (root and packages/main package.json, plus main package exports/bin), the
// full-suite-runner RESOURCE_POLICY (read through FULL_SUITE_ENTRIES, never
// copied) and validate.commands. The fourth is run-all-smokes discovery: every
// dist/tasks/*-smoke.js not marked skip in smoke-manifest.json is executed by
// `npm run test:all`, so a smoke reachable only that way is still executed and
// is reported as registered:test:all rather than listed as an orphan. Files
// referenced by no inventory are printed one per line and must be classified:
// reached by path from another source file, kept with an explicit reason, or
// recorded as deleted (the file must then be absent).
// ---------------------------------------------------------------------------
const repoRoot = resolve(packageRoot, '..', '..', '..'); // packageRoot is packages/main/dist
const SELF_SCRIPT = 'test:validation-protocol';
const SELF_DIST = 'tasks/validation-protocol-smoke.js';

/** Files with no inventory reference and no source-path reference, kept on purpose. Stale entries fail the sweep. */
const SWEEP_KEPT_UNREGISTERED: Readonly<Record<string, string>> = {
  'cli-executor': 'legacy @task-annotation real-machine CLI executor with no importer (superseded by verifier/cli-executor); scripts/audit-silent-catches-baseline.json still pins entries for it, so removal belongs to a dedicated dead-code story',
  'drift-check': 'legacy @task-annotation drift checker over extract.ts with no importer; pinned by scripts/audit-silent-catches-baseline.json and docs/metadata/task.json; removal deferred to a dedicated dead-code story',
  'test-runner': 'legacy @task-annotation flow test runner with no importer (handlers use test-runner-core.js); pinned by scripts/audit-silent-catches-baseline.json; removal deferred to a dedicated dead-code story',
  'test-fixture-gen': 'legacy @task-annotation fixture generator over extract.ts with no importer and no pins; deferred to the same dead-code story as its siblings so the pipeline is removed as one unit',
  'metadata-cross-check': 'loaded at runtime by the logic fixture packages/main/tests/fixtures/metadata-cross-check.json (dynamic import in its execute block) under the configured fixturesDir; not an inventory member by design',
  'story6-acceptance-transcript': 'one-off Story 6 acceptance transcript generator cited by docs/requirements/decisions/complex-role-modular-recall-recovery-execution-plan.md; run by hand, not a smoke',
  // origin/main merge: four of our task files are unknown to origin's sweep because they
  // exist only on this side. Classified with their real reasons rather than left
  // unclassified or force-registered into an inventory they do not belong in.
  'quorum-submit-shards': 'pure re-export shim: its whole body forwards VALIDATION_SHARD_RECEIPT_SCHEMA, aggregateShards, aggregateValidationShards, buildValidationShards, createValidationShardReceipt and verifyValidationShardReceipt from core/story-aware-validation.js. 14 lines, no test body, and grep finds no importer under packages/main/src, so registering it in an inventory would run nothing; removal belongs to a dedicated dead-code story alongside its sibling',
  'review-pass-shards': 'pure re-export shim identical in shape to quorum-submit-shards, forwarding the same six validation-shard symbols from core/story-aware-validation.js with no importer; same dead-code story',
  'story-aware-validation-historical-replay': 'Section 19.1 replay harness (890 lines, #!/usr/bin/env bun) that reconstructs real Story base/head pairs from the Story index and feeds their actual git diffs through the dynamic planner; --execute runs the paired complete/portable campaign that takes hours. Run by hand for a campaign, never as a smoke -- registering it would put a multi-hour bun script in the suite',
  'story-aware-validation-historical-replay-artifact-verify': 'the 12-line bun companion that verifies the artifact the replay harness above writes (verifyHistoricalReplayArtifact). It is already referenced by this very file as the harness pair, and it is meaningless without a campaign artifact to check, so it follows the harness rather than joining an inventory',
};
/** Files this story deleted on purpose; each must be absent. */
const SWEEP_RECORDED_DELETIONS: Readonly<Record<string, string>> = {};
/** The orphans that triggered this item and the classification they must now carry. */
const SWEEP_STORY_LEDGER: Readonly<Record<string, string>> = {
  'validation-protocol-smoke': 'registered:npm-script+serial-reference+RESOURCE_POLICY+validate.commands+test:all',
  'observability-snapshot-smoke': 'registered:npm-script+test:all',
};

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runInventoryAndSweep(): void {
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const mainPkg = JSON.parse(readFileSync(join(repoRoot, 'packages', 'main', 'package.json'), 'utf8'));
  const scripts: Record<string, string> = rootPkg.scripts ?? {};
  const scriptText = JSON.stringify({ root: rootPkg.scripts, main: mainPkg.scripts, exports: mainPkg.exports, bin: mainPkg.bin });
  const chainNames = [
    ...parseSerialReference(scripts['test:serial-reference'] ?? ''),
    ...parseSerialReference(scripts['test:serial-reference-prefix'] ?? ''),
  ];
  const chainText = chainNames.map((name) => scripts[name] ?? '').join('\n');
  const policyNames = FULL_SUITE_ENTRIES.map((entry) => entry.name);
  const policyText = policyNames.map((name) => scripts[name] ?? '').join('\n');
  const config = JSON.parse(readFileSync(join(repoRoot, 'proof-or-stop.config.json'), 'utf8'));
  const validateText = JSON.stringify(config.validate?.commands ?? []);
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', 'main', 'smoke-manifest.json'), 'utf8'));
  const skippedSmokes = new Set<string>((manifest.smokes ?? []).filter((m: any) => m?.skip).map((m: any) => `${m.name}-smoke`));

  // Case 1: this smoke is reachable from every canonical inventory, and the
  // chain resolves through the real policy without an unknown or stale row.
  assert.ok(typeof scripts[SELF_SCRIPT] === 'string' && scripts[SELF_SCRIPT].includes(SELF_DIST), `root package.json must define ${SELF_SCRIPT} -> ${SELF_DIST}`);
  assert.ok(chainNames.includes(SELF_SCRIPT), `${SELF_SCRIPT} must be a test:serial-reference member`);
  assert.ok(policyNames.includes(SELF_SCRIPT), `${SELF_SCRIPT} must have a full-suite-runner RESOURCE_POLICY row`);
  assert.ok(validateText.includes(SELF_DIST), `proof-or-stop.config.json validate.commands must list ${SELF_DIST}`);
  const unknownPolicy = chainNames.filter((name) => !policyNames.includes(name));
  const stalePolicy = policyNames.filter((name) => !chainNames.includes(name));
  assert.deepEqual(unknownPolicy, [], `chain members with no RESOURCE_POLICY row: ${unknownPolicy.join(', ')}`);
  assert.deepEqual(stalePolicy, [], `RESOURCE_POLICY rows absent from both chains: ${stalePolicy.join(', ')}`);
  console.log('[PASS] validation-protocol-smoke registered in npm scripts, test:serial-reference, RESOURCE_POLICY and validate.commands');

  // Case 2: the runner refuses a chain member that has no policy row, naming it.
  const policyWithoutSelf = Object.fromEntries(FULL_SUITE_ENTRIES.filter((entry) => entry.name !== SELF_SCRIPT).map((entry) => [entry.name, entry]));
  assert.throws(
    () => entriesFromSerialReference(scripts['test:serial-reference'] ?? '', scripts, policyWithoutSelf),
    (error: unknown) => error instanceof Error && /unknownPolicy=\[[^\]]*test:validation-protocol/.test(error.message),
    'entriesFromSerialReference must fail closed and name the member without a policy row',
  );
  console.log('[PASS] full-suite runner refuses a test:serial-reference member without a RESOURCE_POLICY row: test:validation-protocol');

  // Case 3: sweep every packages/main/src/tasks/*.ts file.
  const tasksDir = join(repoRoot, 'packages', 'main', 'src', 'tasks');
  const bases = readdirSync(tasksDir).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort();
  const sources = listSourceFiles(join(repoRoot, 'packages', 'main', 'src')).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  const counts: Record<string, number> = {};
  const lines: string[] = [];
  const classification = new Map<string, string>();
  const usedKept = new Set<string>();
  let unclassified = 0;
  for (const base of bases) {
    const dist = `tasks/${base}.js`;
    const tags: string[] = [];
    if (scriptText.includes(dist)) tags.push('npm-script');
    if (chainText.includes(dist)) tags.push('serial-reference');
    if (policyText.includes(dist)) tags.push('RESOURCE_POLICY');
    if (validateText.includes(dist)) tags.push('validate.commands');
    if (base.endsWith('-smoke') && !skippedSmokes.has(base)) tags.push('test:all');
    let label: string;
    if (tags.length) {
      label = `registered:${tags.join('+')}`;
      for (const tag of tags) counts[tag] = (counts[tag] ?? 0) + 1;
    } else {
      const self = join(tasksDir, `${base}.ts`);
      // A reference must resolve into tasks/: a sibling tasks/ file may name
      // it as ./<base>.js or as a quoted '<base>.js' path segment; any other
      // source file must spell tasks/<base>.js (or join(..., 'tasks', '<base>.js')).
      // A bare <base>.js elsewhere (for example core/types.js) does not count.
      const siblingPattern = new RegExp(`(^|['"\`]|\\./)${escapeRegExp(base)}\\.js\\b`, 'm');
      const outsidePattern = new RegExp(`tasks(?:/|['"]\\s*,\\s*['"])${escapeRegExp(base)}\\.js\\b`);
      const referrers = sources
        .filter((s) => s.file !== self && (dirname(s.file) === tasksDir ? siblingPattern : outsidePattern).test(s.text))
        .map((s) => s.file.slice(repoRoot.length + 1));
      if (referrers.length) {
        label = `kept-unregistered: reached by path from ${referrers[0]}${referrers.length > 1 ? ` (+${referrers.length - 1} more)` : ''}`;
      } else if (base in SWEEP_KEPT_UNREGISTERED) {
        usedKept.add(base);
        label = `kept-unregistered: ${SWEEP_KEPT_UNREGISTERED[base]}`;
      } else {
        unclassified += 1;
        label = 'UNCLASSIFIED: no inventory reference, no source-path reference, no SWEEP_KEPT_UNREGISTERED reason';
      }
      lines.push(`  ${base}  ${label}`);
    }
    classification.set(base, label);
  }
  for (const [base, reason] of Object.entries(SWEEP_RECORDED_DELETIONS)) {
    assert.ok(!existsSync(join(tasksDir, `${base}.ts`)), `recorded deletion still present: ${base}.ts`);
    lines.push(`  ${base}  deleted: ${reason}`);
  }
  const staleKept = Object.keys(SWEEP_KEPT_UNREGISTERED).filter((base) => !usedKept.has(base));
  console.log(`tasks sweep: ${bases.length} files under packages/main/src/tasks; registered by inventory: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log('tasks sweep: files referenced by no inventory (npm scripts, serial-reference, RESOURCE_POLICY, validate.commands, test:all discovery):');
  for (const line of lines) console.log(line);
  for (const [base, expected] of Object.entries(SWEEP_STORY_LEDGER)) {
    const actual = classification.get(base);
    console.log(`  ledger ${base}  ${actual ?? 'MISSING'}`);
    assert.equal(actual, expected, `story ledger classification for ${base}`);
  }
  assert.deepEqual(staleKept, [], `stale SWEEP_KEPT_UNREGISTERED entries (now referenced elsewhere or absent): ${staleKept.join(', ')}`);
  assert.equal(unclassified, 0, `${unclassified} packages/main/src/tasks file(s) are unclassified; see the sweep lines above`);
  console.log(`[PASS] tasks sweep: ${bases.length} packages/main/src/tasks files classified, 0 unclassified`);
}

runInventoryAndSweep();

try {
  const subdir = join(tmp, 'sub');
  mkdirSync(subdir);

  const serial = await executeValidationPlan({
    provider: 'smoke-serial',
    commands: [
      {
        label: 'write marker',
        command: 'node',
        args: ['-e', "require('fs').writeFileSync('marker.txt', 'ok')"],
      },
      {
        label: 'read marker',
        command: 'node',
        args: ['-e', "process.stdout.write(require('fs').readFileSync('marker.txt', 'utf8'))"],
      },
    ],
  }, tmp, 'HEAD-A');
  assert.equal(serial.status, 'pass');
  assert.equal(serial.allPass, true);
  assert.equal(serial.headSha, 'HEAD-A');
  assert.equal(serial.commands.length, 2);
  assert.match(serial.commands[1].output, /ok/);

  const requiredFailure = await executeValidationPlan({
    provider: 'smoke-required-fail',
    commands: [
      { label: 'required failure', command: 'node', args: ['-e', 'process.exit(7)'] },
    ],
  }, tmp);
  assert.equal(requiredFailure.status, 'fail');
  assert.equal(requiredFailure.allPass, false);
  assert.equal(requiredFailure.failureKind, 'validation_failure');
  assert.equal(requiredFailure.commands[0].code, 7);
  assert.equal(requiredFailure.commands[0].failureKind, 'validation_failure');
  const requiredFailureDetails = requiredFailure.details.join('\n');
  assert.doesNotMatch(requiredFailureDetails, /timeout diagnostic/i);
  assert.doesNotMatch(requiredFailureDetails, /timeoutMs|raise proof-or-stop\.config\.json validate\.commands\[\]\.timeoutMs/i);

  const optionalFailure = await executeValidationPlan({
    provider: 'smoke-optional-fail',
    commands: [
      { label: 'optional failure', command: 'node', args: ['-e', 'process.exit(3)'], optional: true },
    ],
  }, tmp);
  assert.equal(optionalFailure.status, 'warn');
  assert.equal(optionalFailure.allPass, true);
  assert.match(optionalFailure.warnings.join('\n'), /optional validation failed/);

  const shellCommand = await executeValidationPlan({
    provider: 'smoke-shell',
    commands: [
      { label: 'shell command', command: 'cd sub && node -e "process.stdout.write(process.cwd())"', args: [], shell: true },
    ],
  }, tmp);
  assert.equal(shellCommand.status, 'pass');
  assert.match(shellCommand.details[0], /cd sub && node -e/);
  assert.equal(shellCommand.commands[0].shell, true);
  assert.equal(shellCommand.commands[0].command, 'cd sub && node -e "process.stdout.write(process.cwd())"');
  assert.equal(shellCommand.commands[0].code, 0);
  assert.equal(typeof shellCommand.commands[0].durationMs, 'number');
  assert.ok(shellCommand.commands[0].durationMs >= 0);
  assert.match(shellCommand.commands[0].output, /sub$/);

  const timeout = await executeValidationPlan({
    provider: 'smoke-timeout',
    commands: [
      { label: 'timeout', command: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 100 },
    ],
  }, tmp);
  assert.equal(timeout.status, 'fail');
  assert.equal(timeout.failureKind, 'infra_failure');
  assert.equal(timeout.commands[0].timedOut, true);
  assert.equal(timeout.commands[0].failureKind, 'infra_failure');
  assert.match(timeout.details.join('\n'), /configured timeoutMs=100ms/);
  assert.match(timeout.details.join('\n'), /proof-or-stop\.config\.json validate\.commands\[\]\.timeoutMs/);

  writeFileSync(join(tmp, 'proof-or-stop.config.json'), JSON.stringify({
    validate: {
      commands: [
        {
          label: 'configured command',
          command: 'node',
          args: ['-e', 'process.stdout.write(process.env.PROOF_OR_STOP_SMOKE || "")'],
          cwd: 'sub',
          env: { PROOF_OR_STOP_SMOKE: 'yes' },
          timeoutMs: 1234,
          optional: true,
        },
      ],
    },
  }));
  resetConfigCache();
  const discovered = configuredValidationCommands(tmp);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].label, 'configured command');
  assert.equal(discovered[0].cwd, 'sub');
  assert.equal(discovered[0].env?.PROOF_OR_STOP_SMOKE, 'yes');
  assert.equal(discovered[0].timeoutMs, 1234);
  assert.equal(discovered[0].optional, true);

  writeFileSync(join(tmp, 'proof-or-stop.config.json'), JSON.stringify({
    validate: {
      command: 'cd sub && node -e "process.stdout.write(process.cwd())"',
    },
  }));
  resetConfigCache();
  const shellDiscovered = configuredValidationCommands(tmp);
  assert.equal(shellDiscovered.length, 1);
  assert.equal(shellDiscovered[0].shell, true);
  assert.equal(shellDiscovered[0].command, 'cd sub && node -e "process.stdout.write(process.cwd())"');
  assert.deepEqual(shellDiscovered[0].args, []);

  const noEntryRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-no-entry-'));
  try {
    resetConfigCache();
    const logs: string[] = [];
    const noEntryJson = await createVerifierHandlers({
      root: noEntryRoot,
      scanRoot: noEntryRoot,
      store: new StoryStore(noEntryRoot),
      log: (line) => logs.push(line),
    }).validate({ json: true });
    const noEntryResult = JSON.parse(noEntryJson);
    assert.equal(noEntryResult.provider, 'proof-or-stop-verifier-no-validation-entry');
    assert.equal(noEntryResult.status, 'warn');
    assert.equal(noEntryResult.allPass, true);
    assert.equal(noEntryResult.commands.length, 0);
    const noEntryRendered = `${noEntryResult.summary}\n${noEntryResult.details.join('\n')}\n${noEntryResult.warnings.join('\n')}\n${logs.join('\n')}`;
    assert.match(noEntryRendered, /No project validator configured|skipped project-specific validation/);
    assert.match(noEntryRendered, /validate\.ts\/js\/mts/);
    assert.match(noEntryRendered, /fallback/);
    assert.match(noEntryRendered, /skip\/warn/);
    assert.match(noEntryRendered, /validate\.command/);
  } finally {
    rmSync(noEntryRoot, { recursive: true, force: true });
  }

  const configuredOnlyRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-configured-'));
  try {
    writeFileSync(join(configuredOnlyRoot, 'proof-or-stop.config.json'), JSON.stringify({
      validate: {
        commands: [
          {
            label: 'configured validate smoke',
            command: 'node',
            args: ['-e', 'process.stdout.write("configured-ok")'],
          },
        ],
      },
    }));
    resetConfigCache();
    const logs: string[] = [];
    const validateJson = await createVerifierHandlers({
      root: configuredOnlyRoot,
      scanRoot: configuredOnlyRoot,
      store: new StoryStore(configuredOnlyRoot),
      log: (line) => logs.push(line),
    }).validate({ json: true });
    const configuredResult = JSON.parse(validateJson);
    assert.equal(configuredResult.provider, 'proof-or-stop-verifier-configured-commands');
    assert.equal(configuredResult.status, 'pass');
    assert.equal(configuredResult.allPass, true);
    assert.deepEqual(configuredResult.warnings, []);
    assert.match(configuredResult.commands[0].output, /configured-ok/);
    assert.equal(configuredResult.commands[0].command, 'node');
    assert.equal(configuredResult.commands[0].code, 0);
    assert.equal(typeof configuredResult.commands[0].durationMs, 'number');
    assert.ok(configuredResult.commands[0].durationMs >= 0);
    assert.doesNotMatch(`${configuredResult.summary}\n${configuredResult.details.join('\n')}\n${configuredResult.warnings.join('\n')}\n${logs.join('\n')}`, /discover|fallback|advisory|validate\.ts not found/i);
  } finally {
    rmSync(configuredOnlyRoot, { recursive: true, force: true });
  }

  const configuredFailRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-configured-fail-'));
  try {
    writeFileSync(join(configuredFailRoot, 'proof-or-stop.config.json'), JSON.stringify({
      validate: {
        commands: [
          {
            label: 'configured failing gate',
            command: 'node',
            args: ['-e', 'process.exit(9)'],
          },
        ],
      },
    }));
    writeFileSync(join(configuredFailRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "process.stdout.write(\\"fallback-should-not-run\\")"' },
    }));
    resetConfigCache();
    const logs: string[] = [];
    const configuredFailJson = await createVerifierHandlers({
      root: configuredFailRoot,
      scanRoot: configuredFailRoot,
      store: new StoryStore(configuredFailRoot),
      log: (line) => logs.push(line),
    }).validate({ json: true });
    const configuredFailResult = JSON.parse(configuredFailJson);
    assert.equal(configuredFailResult.provider, 'proof-or-stop-verifier-configured-commands');
    assert.equal(configuredFailResult.status, 'fail');
    assert.equal(configuredFailResult.allPass, false);
    assert.equal(configuredFailResult.commands.length, 1);
    assert.equal(configuredFailResult.commands[0].label, 'configured failing gate');
    assert.equal(configuredFailResult.commands[0].command, 'node');
    assert.equal(configuredFailResult.commands[0].code, 9);
    const configuredFailRendered = `${configuredFailResult.summary}\n${configuredFailResult.details.join('\n')}\n${configuredFailResult.warnings.join('\n')}\n${logs.join('\n')}\n${configuredFailResult.commands[0].output || ''}`;
    assert.doesNotMatch(configuredFailRendered, /fallback-should-not-run/);
    assert.doesNotMatch(configuredFailRendered, /advisory fallback command discovery|running .* advisory fallback/i);
    assert.match(configuredFailRendered, /configured validate\.command/);
  } finally {
    rmSync(configuredFailRoot, { recursive: true, force: true });
  }

  const fallbackRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-fallback-'));
  try {
    writeFileSync(join(fallbackRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "process.stdout.write(\\"fallback-ok\\")"' },
    }));
    resetConfigCache();
    const fallbackCommands = discoverFallbackValidationCommands(fallbackRoot);
    assert.equal(fallbackCommands.length, 1);
    assert.equal(fallbackCommands[0].label, 'package.json test script');
    const fallbackJson = await createVerifierHandlers({
      root: fallbackRoot,
      scanRoot: fallbackRoot,
      store: new StoryStore(fallbackRoot),
      log: () => {},
    }).validate({ json: true });
    const fallbackResult = JSON.parse(fallbackJson);
    assert.equal(fallbackResult.provider, 'proof-or-stop-verifier-fallback-commands');
    assert.equal(fallbackResult.status, 'pass');
    assert.equal(fallbackResult.allPass, true);
    assert.deepEqual(fallbackResult.warnings, []);
    assert.match(`${fallbackResult.summary}\n${fallbackResult.details.join('\n')}`, /advisory fallback command discovery/);
    assert.match(`${fallbackResult.summary}\n${fallbackResult.details.join('\n')}`, /no configured validate\.command/);
    assert.match(fallbackResult.commands[0].output, /fallback-ok/);
  } finally {
    rmSync(fallbackRoot, { recursive: true, force: true });
  }

  // B-38d6 CHK-001: Package.swift alone must NOT auto-fall back to swift test.
  // The Mac Native App / Swift product runtime has been demoted; explicit
  // validate.commands is the only opt-in path.
  const swiftOnlyRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-swift-only-'));
  try {
    writeFileSync(join(swiftOnlyRoot, 'Package.swift'), '// swift-tools-version:5.9\nimport PackageDescription\n');
    resetConfigCache();
    const swiftFallback = discoverFallbackValidationCommands(swiftOnlyRoot);
    assert.equal(swiftFallback.length, 0, 'Package.swift alone must NOT produce automatic swift test fallback');
    const logs: string[] = [];
    const swiftJson = await createVerifierHandlers({
      root: swiftOnlyRoot,
      scanRoot: swiftOnlyRoot,
      store: new StoryStore(swiftOnlyRoot),
      log: (line) => logs.push(line),
    }).validate({ json: true });
    const swiftResult = JSON.parse(swiftJson);
    assert.equal(swiftResult.provider, 'proof-or-stop-verifier-no-validation-entry', 'Package.swift alone must surface no-validation-entry warn/skip');
    assert.equal(swiftResult.status, 'warn');
    assert.equal(swiftResult.allPass, true, 'no-validation-entry skip is advisory, not a hard fail');
    assert.equal(swiftResult.commands.length, 0);
    const swiftRendered = `${swiftResult.summary}\n${swiftResult.details.join('\n')}\n${swiftResult.warnings.join('\n')}\n${logs.join('\n')}`;
    assert.doesNotMatch(swiftRendered, /swift test as a standard automatic fallback/i);
    // Swift may be mentioned ONLY in the negative form (demoted notice). It
    // must not advertise swift test as a fallback that is being executed.
    assert.match(swiftRendered, /Mac Native App|不在自动 fallback|demoted/i);
  } finally {
    rmSync(swiftOnlyRoot, { recursive: true, force: true });
  }

  // B-38d6 CHK-001: explicit validate.commands for swift test must STILL run.
  const swiftExplicitRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-swift-explicit-'));
  try {
    writeFileSync(join(swiftExplicitRoot, 'Package.swift'), '// swift-tools-version:5.9\nimport PackageDescription\n');
    writeFileSync(join(swiftExplicitRoot, 'proof-or-stop.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'explicit swift test', command: 'node', args: ['-e', 'process.stdout.write("swift-opt-in-ok")'] },
        ],
      },
    }));
    resetConfigCache();
    const swiftExplicit = configuredValidationCommands(swiftExplicitRoot);
    assert.equal(swiftExplicit.length, 1, 'explicit validate.commands entry should be honoured');
    assert.equal(swiftExplicit[0].label, 'explicit swift test');
    const swiftExplicitJson = await createVerifierHandlers({
      root: swiftExplicitRoot,
      scanRoot: swiftExplicitRoot,
      store: new StoryStore(swiftExplicitRoot),
      log: () => {},
    }).validate({ json: true });
    const swiftExplicitResult = JSON.parse(swiftExplicitJson);
    assert.equal(swiftExplicitResult.provider, 'proof-or-stop-verifier-configured-commands');
    assert.equal(swiftExplicitResult.status, 'pass');
    assert.match(swiftExplicitResult.commands[0].output, /swift-opt-in-ok/);
  } finally {
    rmSync(swiftExplicitRoot, { recursive: true, force: true });
  }

  // B-38d6 CHK-002: proof-or-stop.config.json is canonical; validate.commands there
  // must be loaded and used by proof-or-stop validate.
  const proofOrStopCanonicalRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-canonical-'));
  try {
    writeFileSync(join(proofOrStopCanonicalRoot, 'proof-or-stop.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'canonical proof-or-stop gate', command: 'node', args: ['-e', 'process.stdout.write("proof-or-stop-canonical-ok")'] },
        ],
      },
    }));
    resetConfigCache();
    const canonicalDiscovered = configuredValidationCommands(proofOrStopCanonicalRoot);
    assert.equal(canonicalDiscovered.length, 1, 'proof-or-stop.config.json validate.commands must load');
    assert.equal(canonicalDiscovered[0].label, 'canonical proof-or-stop gate');
    const canonicalJson = await createVerifierHandlers({
      root: proofOrStopCanonicalRoot,
      scanRoot: proofOrStopCanonicalRoot,
      store: new StoryStore(proofOrStopCanonicalRoot),
      log: () => {},
    }).validate({ json: true });
    const canonicalResult = JSON.parse(canonicalJson);
    assert.equal(canonicalResult.provider, 'proof-or-stop-verifier-configured-commands');
    assert.equal(canonicalResult.status, 'pass');
    assert.match(canonicalResult.commands[0].output, /proof-or-stop-canonical-ok/);
  } finally {
    rmSync(proofOrStopCanonicalRoot, { recursive: true, force: true });
  }

  // ProofOrStop-only config: a non-canonical config file is not an active fallback
  // when proof-or-stop.config.json is absent.
  const legacyOnlyRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-legacy-only-'));
  try {
    writeFileSync(join(legacyOnlyRoot, 'other.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'legacy gate', command: 'node', args: ['-e', 'process.stdout.write("legacy-ok")'] },
        ],
      },
    }));
    resetConfigCache();
    const legacyDiscovered = configuredValidationCommands(legacyOnlyRoot);
    assert.equal(legacyDiscovered.length, 0, 'a non-canonical config file validate.commands must not load as an active config fallback');
  } finally {
    rmSync(legacyOnlyRoot, { recursive: true, force: true });
  }

  // B-38d6 CHK-002: proof-or-stop.config.json and a non-canonical config both present →
  // proof-or-stop.config.json wins (canonical) and diagnostic identifies the winner.
  const conflictConfigRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-config-conflict-'));
  try {
    writeFileSync(join(conflictConfigRoot, 'proof-or-stop.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'proof-or-stop wins gate', command: 'node', args: ['-e', 'process.stdout.write("proof-or-stop-wins")'] },
        ],
      },
    }));
    writeFileSync(join(conflictConfigRoot, 'other.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'other loses gate', command: 'node', args: ['-e', 'process.stdout.write("other-loses")'] },
        ],
      },
    }));
    resetConfigCache();
    const conflictDiscovered = configuredValidationCommands(conflictConfigRoot);
    assert.equal(conflictDiscovered.length, 1, 'only the canonical proof-or-stop.config.json entry must be loaded');
    assert.equal(conflictDiscovered[0].label, 'proof-or-stop wins gate', 'proof-or-stop.config.json must win over a non-canonical config');
    const conflictJson = await createVerifierHandlers({
      root: conflictConfigRoot,
      scanRoot: conflictConfigRoot,
      store: new StoryStore(conflictConfigRoot),
      log: () => {},
    }).validate({ json: true });
    const conflictResult = JSON.parse(conflictJson);
    assert.match(conflictResult.commands[0].output, /proof-or-stop-wins/);
    assert.doesNotMatch(conflictResult.commands[0].output, /other-loses/, 'a non-canonical config gate must NOT be executed when proof-or-stop.config.json is present');
  } finally {
    rmSync(conflictConfigRoot, { recursive: true, force: true });
  }

  const dirtyFallbackRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-dirty-fallback-'));
  try {
    writeFileSync(join(dirtyFallbackRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "require(\\"fs\\").writeFileSync(\\"report.md\\", \\"changed\\\\n\\")"' },
    }));
    writeFileSync(join(dirtyFallbackRoot, 'report.md'), 'baseline\n');
    execFileSync('git', ['init'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Proof-or-Stop Smoke'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['add', '.'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '-m', 'seed dirty fallback smoke'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    resetConfigCache();
    const dirtyJson = await createVerifierHandlers({
      root: dirtyFallbackRoot,
      scanRoot: dirtyFallbackRoot,
      store: new StoryStore(dirtyFallbackRoot),
      log: () => {},
    }).validate({ json: true });
    const dirtyResult = JSON.parse(String(dirtyJson));
    assert.equal(dirtyResult.status, 'fail');
    assert.equal(dirtyResult.allPass, false);
    assert.match(dirtyResult.summary, /dirtied the worktree/);
    assert.match(dirtyResult.details.join('\n'), /validation command dirtied worktree/);
    assert.match(dirtyResult.details.join('\n'), /package\.json test script/);
    assert.match(dirtyResult.details.join('\n'), /unexpected_dirty_files=1/);
    assert.match(dirtyResult.details.join('\n'), /unexpected_dirty_files \(1\):/);
    assert.match(dirtyResult.details.join('\n'), /report\.md/);
    assert.match(dirtyResult.details.join('\n'), /side-effect-free/);
    assert.equal(dirtyResult.commands[0].worktreePollution.paths[0], 'report.md');
  } finally {
    rmSync(dirtyFallbackRoot, { recursive: true, force: true });
  }

  const dirtyValidateFileRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-dirty-validate-file-'));
  try {
    writeFileSync(join(dirtyValidateFileRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: '.',
      rootDir: '.',
    }));
    writeFileSync(join(dirtyValidateFileRoot, 'validate.ts'), '// fake npx smoke target\n');
    writeFileSync(join(dirtyValidateFileRoot, 'report.md'), 'baseline\n');
    initSmokeGitRepo(dirtyValidateFileRoot);
    gitQuiet(dirtyValidateFileRoot, ['add', '.']);
    gitQuiet(dirtyValidateFileRoot, ['commit', '-m', 'seed dirty validate-file smoke']);
    resetConfigCache();
    const dirtyJson = await withFakeNpx(
      dirtyValidateFileRoot,
      "require('node:fs').writeFileSync('report.md', 'polluted\\n');",
      () => createVerifierHandlers({
        root: dirtyValidateFileRoot,
        scanRoot: dirtyValidateFileRoot,
        store: new StoryStore(dirtyValidateFileRoot),
        log: () => {},
      }).validate({ json: true }),
    );
    const dirtyResult = JSON.parse(String(dirtyJson));
    assert.equal(dirtyResult.status, 'fail');
    assert.equal(dirtyResult.allPass, false);
    assert.equal(dirtyResult.failureKind, 'validation_failure', 'validate.ts blocking pollution without infra failure remains validation_failure');
    assert.match(dirtyResult.summary, /dirtied the worktree/);
    assert.match(dirtyResult.details.join('\n'), /validation command dirtied worktree/);
    assert.equal(dirtyResult.commands[0].worktreePollution.paths[0], 'report.md');
    assert.equal(dirtyResult.commands[0].failureKind, undefined, 'successful validate.ts command with pollution has no command failureKind');
  } finally {
    rmSync(dirtyValidateFileRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  const dirtyValidateFileInfraRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-dirty-validate-file-infra-'));
  try {
    writeFileSync(join(dirtyValidateFileInfraRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: '.',
      rootDir: '.',
    }));
    writeFileSync(join(dirtyValidateFileInfraRoot, 'validate.ts'), '// fake npx timeout smoke target\n');
    writeFileSync(join(dirtyValidateFileInfraRoot, 'report.md'), 'baseline\n');
    initSmokeGitRepo(dirtyValidateFileInfraRoot);
    gitQuiet(dirtyValidateFileInfraRoot, ['add', '.']);
    gitQuiet(dirtyValidateFileInfraRoot, ['commit', '-m', 'seed dirty validate-file infra smoke']);
    resetConfigCache();
    const dirtyInfraJson = await withEnv(
      'PROOF_OR_STOP_VALIDATE_FILE_TIMEOUT_MS',
      '1000',
      () => withFakeNpx(
        dirtyValidateFileInfraRoot,
        "require('node:fs').writeFileSync('report.md', 'polluted\\n'); setInterval(() => {}, 1000);",
        () => createVerifierHandlers({
          root: dirtyValidateFileInfraRoot,
          scanRoot: dirtyValidateFileInfraRoot,
          store: new StoryStore(dirtyValidateFileInfraRoot),
          log: () => {},
        }).validate({ json: true }),
      ),
    );
    const dirtyInfraResult = JSON.parse(String(dirtyInfraJson));
    assert.equal(dirtyInfraResult.status, 'fail');
    assert.equal(dirtyInfraResult.allPass, false);
    assert.equal(dirtyInfraResult.failureKind, 'infra_failure', 'validate.ts timedOut + blocking pollution must preserve infra_failure');
    assert.match(dirtyInfraResult.summary, /dirtied the worktree/);
    assert.match(dirtyInfraResult.details.join('\n'), /validation command dirtied worktree/);
    assert.equal(dirtyInfraResult.commands[0].timedOut, true);
    assert.equal(dirtyInfraResult.commands[0].failureKind, 'infra_failure');
    assert.equal(dirtyInfraResult.commands[0].worktreePollution.paths[0], 'report.md');
  } finally {
    rmSync(dirtyValidateFileInfraRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  const categorizedPollutionRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-dirty-classified-'));
  try {
    writeFileSync(join(categorizedPollutionRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    execFileSync('git', ['init'], { cwd: categorizedPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Proof-or-Stop Smoke'], { cwd: categorizedPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: categorizedPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['add', '.'], { cwd: categorizedPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '-m', 'seed classified pollution smoke'], { cwd: categorizedPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    resetConfigCache();

    const categorizedPollution = await executeValidationPlan({
      provider: 'smoke-dirty-classified',
      commands: [{
        label: 'classified pollution writer',
        command: 'node',
        args: ['-e', [
          "const fs = require('fs');",
          "for (const dir of ['.proof-or-stop/story/actives/B-smoke', '.proof-or-stop', 'packages/main/src/core', 'packages/main/tests/fixtures', 'packages/main/tests/output/bl21_lacz_ecoli_minicell']) fs.mkdirSync(dir, { recursive: true });",
          "fs.writeFileSync('.proof-or-stop/story/actives/B-smoke/checklist.json', '{}\\n');",
          "fs.writeFileSync('.proof-or-stop/activity.jsonl', '{}\\n');",
          "fs.writeFileSync('packages/main/src/core/dirty-product.ts', 'export const dirty = true;\\n');",
          "fs.writeFileSync('packages/main/tests/fixtures/dirty-owner.json', '{}\\n');",
          "fs.writeFileSync('packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json', '{}\\n');",
        ].join(' ')],
      }],
    }, categorizedPollutionRoot);

    const details = categorizedPollution.details.join('\n');
    assert.equal(categorizedPollution.status, 'fail');
    assert.equal(categorizedPollution.allPass, false);
    assert.match(details, /proof_or_stop_metadata_changes=1/);
    assert.match(details, /runtime_artifact_changes=1/);
    assert.match(details, /material_source_changes=1/);
    assert.match(details, /fixture_changes=1/);
    assert.match(details, /unexpected_dirty_files=1/);
    assert.match(details, /packages\/main\/tests\/output\/bl21_lacz_ecoli_minicell\/prodenovo_viewer\.json/);
    // B-4b22: blocking pollution still surfaces "validation command dirtied
    // worktree" header; passing-only pollution (next block) gets the "policy-
    // allowed dirty paths" wording instead.
    assert.match(details, /validation command dirtied worktree/);
    assert.match(details, /fail: blocking=/);
  } finally {
    rmSync(categorizedPollutionRoot, { recursive: true, force: true });
  }

  // B-4b22: pollution that classifies entirely as passing categories
  // (proof_or_stop_metadata_changes + runtime_artifact_changes) must NOT trip
  // executeValidationPlan; status stays 'pass', allPass=true, details swap
  // to the policy-allowed wording and audit info appears.
  const passingPollutionRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-passing-pollution-'));
  try {
    writeFileSync(join(passingPollutionRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    execFileSync('git', ['init'], { cwd: passingPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Proof-or-Stop Smoke'], { cwd: passingPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: passingPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    mkdirSync(join(passingPollutionRoot, '.proof-or-stop', 'story', 'actives', 'B-pass'), { recursive: true });
    writeFileSync(join(passingPollutionRoot, '.proof-or-stop', 'story', 'actives', 'B-pass', 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: passingPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '-m', 'seed passing pollution smoke'], { cwd: passingPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    resetConfigCache();

    const passingPollution = await executeValidationPlan({
      provider: 'smoke-passing-pollution',
      commands: [{
        label: 'passing pollution writer',
        command: 'node',
        args: ['-e', [
          "const fs = require('fs');",
          "fs.mkdirSync('.proof-or-stop/story/actives/B-pass', { recursive: true });",
          "fs.mkdirSync('.proof-or-stop', { recursive: true });",
          "fs.writeFileSync('.proof-or-stop/story/actives/B-pass/checklist.json', '{}\\n');",
          "fs.writeFileSync('.proof-or-stop/activity.jsonl', '{}\\n');",
        ].join(' ')],
      }],
    }, passingPollutionRoot, undefined, 'B-pass');

    const details = passingPollution.details.join('\n');
    assert.equal(passingPollution.status, 'pass', 'passing-only pollution must NOT trip allPass=false');
    assert.equal(passingPollution.allPass, true);
    assert.doesNotMatch(details, /✗ validation command dirtied worktree/, 'passing-only pollution must NOT emit the blocking failure header');
    assert.match(details, /policy-allowed dirty paths/);
    assert.match(details, /pass: blocking=0/);
    assert.match(details, /proof_or_stop_metadata_changes=1/);
    assert.match(details, /runtime_artifact_changes=1/);
    // Audit JSONL must be persisted in the per-story process-events file.
    const auditPath = join(passingPollutionRoot, '.proof-or-stop', 'story', 'actives', 'B-pass', 'process-events.jsonl');
    assert.ok(existsSync(auditPath), 'audit log must be appended to per-story process-events.jsonl');
    const auditLines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(auditLines.length, 2, 'one audit line per passing category (proof_or_stop_metadata + runtime_artifact)');
    for (const line of auditLines) {
      const ev = JSON.parse(line);
      assert.equal(ev.type, 'dirty_gate_audit');
      assert.equal(ev.gate, 'validate-side-effect');
      assert.equal(ev.storyId, 'B-pass');
    }
  } finally {
    rmSync(passingPollutionRoot, { recursive: true, force: true });
  }

  // B-cf60: when the BL21 lacZ viewer path is declared for the active story,
  // dirtyWorktreeClassifierOptionsForStory must group it under
  // declared_artifact_changes — the field-derived regression target stays
  // mechanically pinned even though validation-protocol-smoke is end-to-end.
  const declaredPathRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-declared-bl21-'));
  try {
    const BL21 = 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json';
    writeFileSync(join(declaredPathRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();

    const declaredStore = new StoryStore(declaredPathRoot);
    const storyId = 'B-cftest';
    const now = '2026-05-15T18:30:00.000Z';
    declaredStore.writeStory(storyId, {
      storyId,
      name: 'declared-bl21-smoke',
      title: 'Declared BL21 smoke',
      description: 'Verify per-story declared artifact reclassification of BL21 viewer path.',
      type: 'chore',
      phase: 'DEV',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      currentReviewRound: now,
      events: [],
    });
    declaredStore.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Item with verificationIntent slot',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationIntent: {
          happy: [{ desc: 'cli regenerates viewer', type: 'cli', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });

    const { classifyGitStatusRows: classifyRows } = await import('../core/dirty-worktree.js');
    const { dirtyWorktreeClassifierOptionsForStory: optsForStory } = await import('../core/dirty-worktree.js');
    const { loadConfig: loadCfg } = await import('../core/config.js');
    const { createArtifactDeclareHandlers: makeHandlers } = await import('../handlers/artifact-declare.js');
    const { evaluateDeclaredArtifactReferences: refEval } = await import('../core/declared-artifact-gate.js');

    const handlers = makeHandlers({
      store: declaredStore,
      root: declaredPathRoot,
      scanRoot: join(declaredPathRoot, 'packages/main'),
    });
    handlers.artifact_declare({
      storyId,
      path: BL21,
      reason: 'BL21 lacZ minicell viewer regenerated for verification (validation-protocol smoke)',
      relatedIntent: 'CHK-001:happy:0',
    });

    const dirtyRows = [`?? ${BL21}`];
    const cfg = loadCfg(declaredPathRoot);
    const declared = classifyRows(dirtyRows, optsForStory(cfg, storyId, declaredStore));
    assert.equal(
      declared.groups.declared_artifact_changes.length,
      1,
      'BL21 lacZ viewer path must reclassify as declared_artifact_changes after artifact_declare',
    );
    assert.equal(declared.groups.declared_artifact_changes[0].path, BL21);
    assert.equal(
      declared.groups.unexpected_dirty_files.length,
      0,
      'declared BL21 path must NOT remain in unexpected_dirty_files',
    );

    // DONE gate reference check: matching intentRef → no unreferenced
    const checklistData = declaredStore.readChecklist(storyId);
    const declaredEntries = declaredStore.readDeclaredArtifacts(storyId);
    const passing = refEval(declaredEntries, checklistData, null);
    assert.equal(passing.total, 1);
    assert.equal(passing.unreferenced.length, 0, 'BL21 viewer with CHK-001:happy:0 must satisfy DONE reference check');

    // Bogus intentRef → unreferenced surfaces (preMortem #2 anchor)
    handlers.artifact_declare({
      storyId,
      path: 'packages/main/tests/output/bl21_lacz_ecoli_minicell/other_viewer.json',
      reason: 'second viewer with bogus ref for adversarial smoke',
      relatedIntent: 'CHK-999:happy:0',
    });
    const failing = refEval(declaredStore.readDeclaredArtifacts(storyId), checklistData, null);
    assert.equal(failing.total, 2);
    assert.equal(failing.unreferenced.length, 1, 'bogus intentRef must NOT pass DONE reference check');
    assert.equal(failing.unreferenced[0].relatedIntent, 'CHK-999:happy:0');
  } finally {
    rmSync(declaredPathRoot, { recursive: true, force: true });
  }

  // B-4b22 F-004 regression: executeValidationPlan with storyId must route
  // through dirtyWorktreeClassifierOptionsForStory so declared artifacts are
  // classified as declared_artifact_changes (not unexpected_dirty_files).
  const declaredE2eRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-declared-e2e-'));
  try {
    const BL21_E2E = 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json';
    writeFileSync(join(declaredE2eRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    execFileSync('git', ['init'], { cwd: declaredE2eRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Proof-or-Stop Smoke'], { cwd: declaredE2eRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: declaredE2eRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['add', '.'], { cwd: declaredE2eRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '-m', 'seed declared e2e smoke'], { cwd: declaredE2eRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    resetConfigCache();

    const e2eStore = new StoryStore(declaredE2eRoot);
    const e2eStoryId = 'B-e2etest';
    const e2eNow = '2026-05-15T19:00:00.000Z';
    e2eStore.writeStory(e2eStoryId, {
      storyId: e2eStoryId,
      name: 'declared-e2e-smoke',
      title: 'Declared E2E smoke',
      description: 'F-004 regression: executeValidationPlan must use story-aware classifier.',
      type: 'chore',
      phase: 'DEV',
      priority: 'medium',
      createdAt: e2eNow,
      startedAt: e2eNow,
      endedAt: null,
      currentReviewRound: e2eNow,
      events: [],
    });
    e2eStore.writeChecklist(e2eStoryId, {
      items: [{
        id: 'CHK-001',
        title: 'Regenerate BL21 viewer',
        status: 'done',
        startTime: e2eNow,
        endTime: e2eNow,
        verificationIntent: {
          happy: [{ desc: 'viewer regenerated', type: 'cli', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });

    const { createArtifactDeclareHandlers: makeE2eHandlers } = await import('../handlers/artifact-declare.js');
    makeE2eHandlers({
      store: e2eStore,
      root: declaredE2eRoot,
      scanRoot: join(declaredE2eRoot, 'packages/main'),
    }).artifact_declare({
      storyId: e2eStoryId,
      path: BL21_E2E,
      reason: 'BL21 lacZ minicell viewer regenerated (F-004 regression)',
      relatedIntent: 'CHK-001:happy:0',
    });

    const declaredE2eResult = await executeValidationPlan({
      provider: 'smoke-declared-e2e',
      commands: [{
        label: 'write declared BL21 artifact',
        command: 'node',
        args: ['-e', [
          "const fs = require('fs');",
          `const dir = '${dirname(BL21_E2E).replace(/'/g, "\\'")}';`,
          "fs.mkdirSync(dir, { recursive: true });",
          `fs.writeFileSync('${BL21_E2E.replace(/'/g, "\\'")}', '{}\\n');`,
        ].join(' ')],
      }],
    }, declaredE2eRoot, undefined, e2eStoryId);

    const e2eDetails = declaredE2eResult.details.join('\n');
    assert.equal(declaredE2eResult.status, 'pass', 'F-004: declared artifact pollution must NOT fail executeValidationPlan when storyId is supplied');
    assert.equal(declaredE2eResult.allPass, true, 'F-004: allPass must be true for declared artifact pollution');
    assert.match(e2eDetails, /policy-allowed dirty paths/, 'F-004: details must show policy-allowed wording');
    assert.match(e2eDetails, /declared_artifact_changes/, 'F-004: details must mention declared_artifact_changes');
    assert.doesNotMatch(e2eDetails, /unexpected_dirty_files/, 'F-004: declared BL21 must NOT appear as unexpected_dirty_files');
    // Audit trail must exist for the declared artifact pass.
    const e2eAuditPath = join(declaredE2eRoot, '.proof-or-stop', 'story', 'actives', e2eStoryId, 'process-events.jsonl');
    assert.ok(existsSync(e2eAuditPath), 'F-004: audit log must be written for declared artifact pass');
    const e2eAuditLines = readFileSync(e2eAuditPath, 'utf-8').trim().split('\n').filter(Boolean);
    const declaredAudit = e2eAuditLines.find(l => JSON.parse(l).category === 'declared_artifact_changes');
    assert.ok(declaredAudit, 'F-004: audit must include declared_artifact_changes entry');
  } finally {
    rmSync(declaredE2eRoot, { recursive: true, force: true });
  }

  // B-8db9 CHK-004: declared-artifact gate-bypass attack chain in the
  // side-effect-guard context. A hand-injected declared-artifacts.json entry
  // pointing at a material source path must NOT let executeValidationPlan
  // pass — the classifier reorder keeps a dirty source file as
  // material_source_changes (blocking) even when it is declared.
  const attackChainRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-attack-chain-'));
  try {
    const ATTACK_SOURCE = 'packages/main/src/core/store.ts';
    writeFileSync(join(attackChainRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    mkdirSync(join(attackChainRoot, 'packages/main/src/core'), { recursive: true });
    writeFileSync(join(attackChainRoot, ATTACK_SOURCE), 'export const seed = 1;\n');
    execFileSync('git', ['init'], { cwd: attackChainRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Proof-or-Stop Smoke'], { cwd: attackChainRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: attackChainRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['add', '.'], { cwd: attackChainRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '-m', 'seed attack-chain smoke'], { cwd: attackChainRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    resetConfigCache();

    const attackStore = new StoryStore(attackChainRoot);
    const attackStoryId = 'B-attack';
    const attackNow = '2026-05-15T21:45:00.000Z';
    attackStore.writeStory(attackStoryId, {
      storyId: attackStoryId,
      name: 'declared-attack-chain-smoke',
      title: 'Declared attack chain smoke',
      description: 'Hand-injected source declaration must not bypass the dirty gate.',
      type: 'chore',
      phase: 'DEV',
      priority: 'high',
      createdAt: attackNow,
      startedAt: attackNow,
      endedAt: null,
      currentReviewRound: attackNow,
      events: [],
    });
    // Hand-inject the source path WITHOUT going through artifact_declare —
    // proving the classifier reorder is the hard gate independent of the
    // artifact_declare entry rejection.
    attackStore.writeDeclaredArtifacts(attackStoryId, {
      entries: [{
        path: ATTACK_SOURCE,
        reason: 'attacker hand-injects a source path to bypass the dirty gate',
        relatedIntent: 'CHK-001:happy:0',
        declaredAt: attackNow,
      }],
    });

    const attackResult = await executeValidationPlan({
      provider: 'smoke-attack-chain',
      commands: [{
        label: 'dirty the declared source file',
        command: 'node',
        args: ['-e', [
          "const fs = require('fs');",
          `fs.appendFileSync('${ATTACK_SOURCE.replace(/'/g, "\\'")}', '// polluted\\n');`,
        ].join(' ')],
      }],
    }, attackChainRoot, undefined, attackStoryId);

    const attackDetails = attackResult.details.join('\n');
    assert.notEqual(attackResult.status, 'pass', 'CHK-004: a declared dirty SOURCE file must NOT pass the side-effect guard');
    assert.equal(attackResult.allPass, false, 'CHK-004: declared source pollution must keep allPass false');
    assert.match(attackDetails, /material_source_changes/, 'CHK-004: dirty declared source must classify as material_source_changes');
    assert.doesNotMatch(attackDetails, /declared_artifact_changes=1/, 'CHK-004: the source path must NOT be downgraded to declared_artifact_changes');
  } finally {
    rmSync(attackChainRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  const invalidArgCwd = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-schema-'));
  const env = { ...process.env };
  delete env.PROOF_OR_STOP_PROJECT_ROOT;
  const invalidVerificationIntent = spawnSync(process.execPath, [
    cliPath,
    'checklist_update',
    JSON.stringify({
      storyId: 'B-smoke',
      itemId: 'CHK-001',
      verificationIntent: {
        happy: [{ desc: 'bad enum', type: 'integration_test', priority: 'must' }],
      },
    }),
  ], {
    cwd: invalidArgCwd,
    env,
    encoding: 'utf-8',
  });
  assert.notEqual(invalidVerificationIntent.status, 0, 'invalid nested verificationIntent enum should fail');
  assert.match(invalidVerificationIntent.stderr, /Argument validation failed/);
  assert.match(invalidVerificationIntent.stderr, /verificationIntent\.happy\.0\.type/);
  assert.match(invalidVerificationIntent.stderr, /integration_test/);
  assert.match(invalidVerificationIntent.stderr, /logic[\s\S]*cli[\s\S]*browser[\s\S]*manual[\s\S]*docs/);
  assert.equal(existsSync(join(invalidArgCwd, '.proof-or-stop')), false, 'schema failure should happen before metadata mutation');
  rmSync(invalidArgCwd, { recursive: true, force: true });

  const malformedJsonCwd = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-malformed-json-'));
  const malformedJson = spawnSync(process.execPath, [
    cliPath,
    'story_create',
    '{"name":"broken",',
  ], {
    cwd: malformedJsonCwd,
    env,
    encoding: 'utf-8',
  });
  assert.notEqual(malformedJson.status, 0, 'malformed JSON body should fail');
  assert.match(malformedJson.stderr, /JSON parse failed|JSON parse|Unexpected end of JSON input|JSON 解析失败/);
  assert.match(malformedJson.stderr.trim().split('\n')[0], /JSON parse failed|JSON parse|JSON 解析失败/);
  assert.equal(existsSync(join(malformedJsonCwd, '.proof-or-stop')), false, 'malformed JSON should not create project metadata');
  rmSync(malformedJsonCwd, { recursive: true, force: true });

  const projectLocalRuntimeRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-runtime-mode-local-'));
  try {
    mkdirSync(join(projectLocalRuntimeRoot, 'node_modules', '.bin'), { recursive: true });
    const localBin = join(projectLocalRuntimeRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'proof-or-stop.cmd' : 'proof-or-stop');
    writeFileSync(localBin, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(projectLocalRuntimeRoot, {
      commandResolver: () => localBin,
      globalNpmRootResolver: () => null,
      corePackageRoot: join(projectLocalRuntimeRoot, 'node_modules', '@proof-or-stop', 'core'),
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'project-local-package');
    assert.equal(report.runtimeMode.source, 'project-node-modules');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, true);
  } finally {
    rmSync(projectLocalRuntimeRoot, { recursive: true, force: true });
  }

  const externalRuntimeRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-runtime-mode-external-'));
  const externalEngineRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-runtime-mode-engine-'));
  try {
    mkdirSync(join(externalEngineRoot, 'dist'), { recursive: true });
    const engineCli = join(externalEngineRoot, 'dist', 'cli.js');
    writeFileSync(engineCli, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(externalRuntimeRoot, {
      commandResolver: () => engineCli,
      globalNpmRootResolver: () => null,
      corePackageRoot: externalEngineRoot,
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeEntrypointAuthority.id, 'entrypoint-authority');
    assert.equal(report.runtimeEntrypointAuthority.status, 'pass', 'external consumers keep advisory runtime authority');
    assert.equal((report.runtimeEntrypointAuthority.actual as any).selfHostWorktree, false);
    assert.equal(report.runtimeMode.mode, 'compatibility-launcher');
    assert.equal(report.runtimeMode.source, 'external-development-engine');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, false);
  } finally {
    rmSync(externalRuntimeRoot, { recursive: true, force: true });
    rmSync(externalEngineRoot, { recursive: true, force: true });
  }

  const proofOrStopConflictRuntimeRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-runtime-mode-proof-or-stop-conflict-'));
  try {
    mkdirSync(join(proofOrStopConflictRuntimeRoot, 'node_modules', '.bin'), { recursive: true });
    const localBin = join(proofOrStopConflictRuntimeRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'proof-or-stop.cmd' : 'proof-or-stop');
    const otherCli = join(proofOrStopConflictRuntimeRoot, 'other-proof-or-stop');
    writeFileSync(localBin, '#!/usr/bin/env node\n');
    writeFileSync(otherCli, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(proofOrStopConflictRuntimeRoot, {
      commandResolver: () => otherCli,
      globalNpmRootResolver: () => null,
      corePackageRoot: join(proofOrStopConflictRuntimeRoot, 'node_modules', '@proof-or-stop', 'core'),
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'diagnostic-only');
    assert.equal(report.runtimeMode.source, 'unknown');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, false);
    assert.equal((report.projectLocalBin.actual as any).path, localBin, 'project-local-bin must report the proof-or-stop bin that shadows the active CLI');
    assert.equal((report.projectLocalBin.actual as any).shadowsEntrypoint, true);
    assert.match(report.projectLocalBin.warnings?.join('\n') ?? '', /node_modules\/\.bin\/proof-or-stop/);
    const runtimeSummary = renderRuntimeFootprintSummary(report.runtimeMode);
    assert.match(
      runtimeSummary,
      /Next action: project-local CLI bin .*node_modules\/\.bin\/proof-or-stop resolves to .* but the active CLI resolves to .*/,
    );
  } finally {
    rmSync(proofOrStopConflictRuntimeRoot, { recursive: true, force: true });
  }

  const conflictRuntimeRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-runtime-mode-legacy-local-'));
  try {
    mkdirSync(join(conflictRuntimeRoot, 'node_modules', '.bin'), { recursive: true });
    const legacyLocalBin = join(conflictRuntimeRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'stale-legacy.cmd' : 'stale-legacy');
    const otherCli = join(conflictRuntimeRoot, 'other-cli');
    writeFileSync(legacyLocalBin, '#!/usr/bin/env node\n');
    writeFileSync(otherCli, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(conflictRuntimeRoot, {
      commandResolver: () => otherCli,
      globalNpmRootResolver: () => null,
      corePackageRoot: join(conflictRuntimeRoot, 'runtime-core'),
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'diagnostic-only');
    assert.equal(report.runtimeMode.source, 'unknown');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, false);
    assert.equal(
      (report.projectLocalBin.actual as any).path,
      join(conflictRuntimeRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'proof-or-stop.cmd' : 'proof-or-stop'),
      'project-local-bin must ignore stale legacy local bins',
    );
    assert.equal((report.projectLocalBin.actual as any).present, false);
    const runtimeSummary = renderRuntimeFootprintSummary(report.runtimeMode);
    assert.ok(runtimeSummary.startsWith('Runtime footprint:\nRuntime mode: diagnostic-only'));
    assert.match(runtimeSummary, /Runtime source: unknown/);
    assert.match(runtimeSummary, /Project-local JavaScript runtime required: no/);
    assert.match(runtimeSummary, /Authority: local-runtime-diagnostic-only/);
    assert.doesNotMatch(runtimeSummary, /node_modules\/\.bin\/stale-legacy/);
  } finally {
    rmSync(conflictRuntimeRoot, { recursive: true, force: true });
  }

  const previousPackagedRuntime = process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME;
  process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME = '1';
  const packagedConflictRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-runtime-mode-packaged-conflict-'));
  try {
    mkdirSync(join(packagedConflictRoot, 'node_modules', '.bin'), { recursive: true });
    const legacyLocalBin = join(packagedConflictRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'stale-legacy.cmd' : 'stale-legacy');
    const packagedCli = join(packagedConflictRoot, 'packaged-cli');
    writeFileSync(legacyLocalBin, '#!/usr/bin/env node\n');
    writeFileSync(packagedCli, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(packagedConflictRoot, {
      commandResolver: () => packagedCli,
      globalNpmRootResolver: () => null,
      corePackageRoot: join(packagedConflictRoot, 'packaged-runtime'),
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'packaged-runtime');
    assert.equal(report.runtimeMode.source, 'packaged-runtime');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, false);
    assert.equal((report.projectLocalBin.actual as any).present, false, 'packaged mode should ignore stale legacy local bins');
  } finally {
    rmSync(packagedConflictRoot, { recursive: true, force: true });
    if (previousPackagedRuntime === undefined) delete process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME;
    else process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME = previousPackagedRuntime;
  }

  const previousPackagedRuntimeClean = process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME;
  process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME = '1';
  const packagedCleanRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-runtime-mode-packaged-clean-'));
  try {
    const packagedCli = join(packagedCleanRoot, 'packaged-cli');
    writeFileSync(packagedCli, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(packagedCleanRoot, {
      commandResolver: () => packagedCli,
      globalNpmRootResolver: () => null,
      corePackageRoot: join(packagedCleanRoot, 'packaged-runtime'),
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'packaged-runtime');
    assert.equal(report.runtimeMode.source, 'packaged-runtime');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, false);
  } finally {
    rmSync(packagedCleanRoot, { recursive: true, force: true });
    if (previousPackagedRuntimeClean === undefined) delete process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME;
    else process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME = previousPackagedRuntimeClean;
  }

  const checkRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-check-runtime-surface-'));
  try {
    resetConfigCache();
    const check = createCheckHandlers({
      root: checkRoot,
      scanRoot: checkRoot,
      store: new StoryStore(checkRoot),
      log: () => {},
    }).check;
    const checkJson = check({ json: true, profile: 'core' }) as any;
    assertRuntimeModeShape(checkJson.runtimeMode);
    assert.ok(Array.isArray(checkJson.items), 'check --json should preserve managed asset fields');
    let driftText = '';
    try {
      check({ profile: 'core' });
      assert.fail('plain check should throw on managed asset drift');
    } catch (error: any) {
      driftText = String(error.message || error);
    }
    assert.ok(driftText.startsWith('Runtime footprint:\nRuntime mode:'), 'plain check drift should render runtime footprint before drift details');
    assert.match(driftText, /Project-local JavaScript runtime required: (yes|no)/);
    assert.match(driftText, /Next action: run proof-or-stop check --apply to sync MISSING\/STALE_SAFE assets/);
    assert.match(driftText, /Proof-or-Stop managed asset check: DRIFT/);

    runManagedAssetCheck(checkRoot, { apply: true, profile: 'core' });
    const cleanText = check({ profile: 'core' }) as string;
    assert.ok(cleanText.startsWith('Runtime footprint:\nRuntime mode:'), 'plain check OK should start with runtime footprint');
    assert.match(cleanText, /Next action: no managed asset drift/);
    assert.match(cleanText, /Proof-or-Stop managed asset check: OK/);
  } finally {
    rmSync(checkRoot, { recursive: true, force: true });
  }

  const staleLocalAssetRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-managed-stale-local-'));
  try {
    writeFileSync(join(staleLocalAssetRoot, 'PROOF_OR_STOP.md'), '<!-- proof-or-stop:start -->\n# Local Proof-or-Stop Notes\ncustom text\n<!-- proof-or-stop:end -->\n');
    assert.equal(detectManagedAssetMode(staleLocalAssetRoot), 'full', 'canonical PROOF_OR_STOP.md must select full managed-asset mode');
    const before = readFileSync(join(staleLocalAssetRoot, 'PROOF_OR_STOP.md'), 'utf-8');
    const plainCheck = createCheckHandlers({
      root: staleLocalAssetRoot,
      scanRoot: staleLocalAssetRoot,
      store: new StoryStore(staleLocalAssetRoot),
      log: () => {},
    }).check;
    let staleLocalCheckText = '';
    try {
      plainCheck({ profile: 'core', reviewLocalEdits: true });
      assert.fail('plain check should throw on stale local managed block edits');
    } catch (error: any) {
      staleLocalCheckText = String(error.message || error);
    }
    assert.ok(
      staleLocalCheckText.startsWith('Runtime footprint:\nRuntime mode:'),
      'plain check stale local edit should render runtime footprint before drift details',
    );
    assert.match(staleLocalCheckText, /Next action: review unsafe managed assets manually/);
    assert.match(staleLocalCheckText, /Proof-or-Stop managed asset check: DRIFT/);
    assert.match(staleLocalCheckText, /STALE_LOCAL_EDIT PROOF_OR_STOP\.md|STALE_LOCAL_EDIT[\s\S]*PROOF_OR_STOP\.md/);
    const result = runManagedAssetCheck(staleLocalAssetRoot, { apply: true, reviewLocalEdits: true, profile: 'core' });
    const item = result.items.find(entry => entry.relPath === 'PROOF_OR_STOP.md');
    assert.equal(item?.status, 'STALE_LOCAL_EDIT');
    assert.equal(item?.applied, undefined);
    assert.equal(readFileSync(join(staleLocalAssetRoot, 'PROOF_OR_STOP.md'), 'utf-8'), before, 'STALE_LOCAL_EDIT must not be overwritten by apply');
    assert.equal(result.applied.includes('PROOF_OR_STOP.md'), false, 'STALE_LOCAL_EDIT must not be counted as applied');
    assert.equal(managedAssetNextAction(result), 'review unsafe managed assets manually');
    const rendered = renderManagedAssetCheck(result);
    assert.match(rendered, /STALE_LOCAL_EDIT PROOF_OR_STOP\.md/);
    assert.match(rendered, /action: review local edits before overwriting|action: review local doc edits before replacing the section/);
  } finally {
    rmSync(staleLocalAssetRoot, { recursive: true, force: true });
  }

  const caseMismatchAssetRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-managed-case-mismatch-'));
  try {
    // B-dc2e CHK-001 root cause: the fixture used to write 'proofOrStop.md',
    // which is NOT a case-only variant of PROOF_OR_STOP.md (it lacks the
    // underscores; it is the mechanical rewrite of the pre-rename 'lattice.md'
    // by the B-022e identity migration). detectManagedAssetMode() only selects
    // 'full' mode when the lowercased directory listing contains
    // 'proof_or_stop.md', so the root was classified global-thin, no
    // PROOF_OR_STOP.md definition was listed at all, and `find` returned
    // undefined. The detector itself is filesystem-neutral: findCaseVariant()
    // compares lowercased readdir() names, so a genuine case-only variant is
    // reported as CASE_MISMATCH on both case-sensitive and case-insensitive
    // disks (probed below; on a case-insensitive disk existsSync() of the
    // canonical name is also true, which is exactly why the variant check
    // must run first). The assertion was right; the fixture name was wrong.
    writeFileSync(join(caseMismatchAssetRoot, 'proof_or_stop.md'), 'case mismatch\n');
    const canonicalExists = existsSync(join(caseMismatchAssetRoot, 'PROOF_OR_STOP.md'));
    assert.equal(detectManagedAssetMode(caseMismatchAssetRoot), 'full', 'a case-only variant of PROOF_OR_STOP.md must still select full managed-asset mode');
    const result = runManagedAssetCheck(caseMismatchAssetRoot, { apply: true, profile: 'core' });
    const item = result.items.find(entry => entry.relPath === 'PROOF_OR_STOP.md');
    assert.equal(item?.status, 'CASE_MISMATCH');
    assert.equal(item?.actualRelPath, 'proof_or_stop.md');
    console.log(`[PASS] managed asset CASE_MISMATCH detected for case-only variant proof_or_stop.md (filesystem: ${canonicalExists ? 'case-insensitive' : 'case-sensitive'})`);
    assert.equal(item?.applied, undefined);
    assert.equal(result.applied.includes('PROOF_OR_STOP.md'), false, 'CASE_MISMATCH must not be counted as applied');
    const rendered = renderManagedAssetCheck(result);
    assert.match(rendered, /CASE_MISMATCH PROOF_OR_STOP\.md/);
    assert.match(rendered, /action: rename the path with exact casing/);
  } finally {
    rmSync(caseMismatchAssetRoot, { recursive: true, force: true });
  }

  const incompatibleAssetRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-managed-incompatible-'));
  try {
    // An excluded-path runtime asset present as a directory must report INCOMPATIBLE.
    // B-cc10 F-071: CHK-007 moved this excluded-path definition's relPath in
    // managed-assets.ts from the hardcoded deprecated adapter dir to the resolver-derived
    // one. The fixture kept staging + probing the DEPRECATED path, so `find` returned
    // undefined and the assertion compared undefined to 'INCOMPATIBLE'. Derive the path
    // from the same resolver the production code uses, so the two cannot drift again.
    const settingsRel = `${PROOF_OR_STOP_ADAPTER_DIR}/settings.json`;
    mkdirSync(join(incompatibleAssetRoot, ...settingsRel.split('/')), { recursive: true });
    const result = runManagedAssetCheck(incompatibleAssetRoot, { apply: true, profile: 'codex', assetMode: 'full' });
    const item = result.items.find(entry => entry.relPath === settingsRel);
    assert.equal(item?.status, 'INCOMPATIBLE');
    assert.equal(item?.applied, undefined);
    assert.equal(result.applied.includes(settingsRel), false, 'INCOMPATIBLE must not be counted as applied');
    const rendered = renderManagedAssetCheck(result);
    assert.match(rendered, new RegExp(`INCOMPATIBLE ${settingsRel.replace(/[.\/]/g, (ch) => `\\${ch}`)}`));
    assert.match(rendered, /action: .*fix manually|action: .*manually/);
  } finally {
    rmSync(incompatibleAssetRoot, { recursive: true, force: true });
  }

  const wrapperRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-wrapper-cjs-'));
  try {
    mkdirSync(join(wrapperRoot, 'bin'), { recursive: true });
    const proofOrStopWrapperPath = join(wrapperRoot, 'bin', 'proof-or-stop.js');
    const codexWrapperPath = join(wrapperRoot, 'bin', 'proof-or-stop-codex.js');
    // renderProofOrStopBootstrapScript takes the PACKAGE root and appends
    // 'dist/cli-engine.js' itself. `packageRoot` here is already packages/main/dist (see
    // its definition above), so passing it produced a dead `dist/dist/cli-engine.js`
    // candidate -- harmless while the wrapper ran inside the repo, fatal in a temp
    // wrapper root where the other two candidates cannot resolve either.
    writeFileSync(proofOrStopWrapperPath, renderProofOrStopBootstrapScript(dirname(packageRoot)));
    writeFileSync(codexWrapperPath, renderProofOrStopCodexWrapperScript());
    const proofOrStopWrapper = readFileSync(proofOrStopWrapperPath, 'utf-8');
    const codexWrapper = readFileSync(codexWrapperPath, 'utf-8');
    assert.match(proofOrStopWrapper, /require\('node:fs'\)/, 'Proof-or-Stop wrapper should be CommonJS so non-JS repos do not need package.json type=module');
    assert.match(codexWrapper, /import\('node:fs'\)/, 'Codex wrapper should use dynamic import so it runs in both CommonJS and type=module projects');
    assert.doesNotMatch(codexWrapper, /require\(/, 'Codex wrapper must not use require because type=module projects execute .js files as ESM');
    assert.doesNotMatch(proofOrStopWrapper, /^import\s/m, 'Proof-or-Stop wrapper must not use static ESM import syntax');
    assert.doesNotMatch(codexWrapper, /^import\s/m, 'Codex wrapper must not use static ESM import syntax');

    const proofOrStopHelp = spawnSync(process.execPath, [proofOrStopWrapperPath, 'help'], { cwd: wrapperRoot, encoding: 'utf8' });
    assert.equal(proofOrStopHelp.status, 0, proofOrStopHelp.stderr || proofOrStopHelp.stdout);
    assert.doesNotMatch(proofOrStopHelp.stderr, /MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module/, 'Proof-or-Stop wrapper help must not emit Node module-type warnings');

    const codexHelp = spawnSync(process.execPath, [codexWrapperPath, 'help'], { cwd: wrapperRoot, encoding: 'utf8' });
    assert.equal(codexHelp.status, 0, codexHelp.stderr || codexHelp.stdout);
    assert.doesNotMatch(codexHelp.stderr, /MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module/, 'Codex wrapper help must not emit Node module-type warnings');
  } finally {
    rmSync(wrapperRoot, { recursive: true, force: true });
  }

  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.stdout.write(\\"fallback\\")"' },
  }));
  execFileSync('git', ['init'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('git', ['config', 'user.name', 'Proof-or-Stop Smoke'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  mkdirSync(join(tmp, '.proof-or-stop', 'story', 'actives', 'B-demo'), { recursive: true });
  mkdirSync(join(tmp, '.proof-or-stop', 'runtime'), { recursive: true });
  writeFileSync(join(tmp, '.proof-or-stop', 'activity.jsonl'), '{}\n');
  const shellMetaArtifactPath = ".proof-or-stop/runtime/$USER $(echo hi) `uname` 'artifact'.json";
  writeFileSync(join(tmp, shellMetaArtifactPath), '{}\n');
  writeFileSync(join(tmp, '.proof-or-stop', 'story', 'actives', 'B-demo', 'index.json'), '{}\n');
  execFileSync('git', ['add', '.'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('git', ['commit', '-m', 'seed doctor runtime artifact smoke'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  resetConfigCache();
  const doctor = createDoctorHandlers({
    root: tmp,
    scanRoot: tmp,
    store: new StoryStore(tmp),
    log: () => {},
    getAllToolNames: () => new Set<string>(),
  }).doctor;
  const doctorJson = (await doctor({ format: 'json' })) as any;
  assertRuntimeModeShape(doctorJson.runtimeMode);
  assert.ok(doctorJson.runtime, 'doctor JSON should expose runtime section');
  assert.deepEqual(doctorJson.runtime.runtimeMode, doctorJson.runtimeMode, 'doctor should expose runtimeMode top-level and inside runtime scan');
  assert.equal(doctorJson.runtime.cliEntrypoint.id, 'cli-entrypoint');
  assert.equal(doctorJson.runtime.globalCoreRealpath.id, 'global-core-realpath');
  assert.equal(doctorJson.runtime.projectLocalBin.id, 'project-local-bin');
  assert.equal(doctorJson.runtime.nodeVersion.id, 'node-version');
  assert.equal(doctorJson.runtime.packageVersion.id, 'package-version');
  assert.equal(doctorJson.runtime.validateSource.id, 'validate-source');
  assert.equal(doctorJson.runtime.externalReferencePolicy.id, 'external-reference-policy');
  assert.equal(doctorJson.runtime.externalReferencePolicy.connectivityChecked, false);
  assert.equal(doctorJson.runtime.externalReferencePolicy.actual.policy, 'reference-only');
  assert.equal(doctorJson.validation.validateFile, null);
  assert.equal(doctorJson.validation.configuredCommands.length, 1);
  assert.equal(doctorJson.validation.configuredCommands[0].shell, true);
  assert.equal(doctorJson.validation.configuredShellReceiptsIntentional, true);
  assert.deepEqual(doctorJson.validation.discoveredFallbackLabels, ['package.json test script']);
  assert.equal(doctorJson.validation.noValidatorWarning, false);
  assert.equal(doctorJson.runtimeArtifacts.tracked.length, 2, 'doctor should report tracked runtime artifacts');
  assert.ok(doctorJson.storyOwnerLeases, 'doctor JSON should expose story owner lease diagnostics');
  assert.ok(Array.isArray(doctorJson.storyOwnerLeases.leases), 'storyOwnerLeases.leases should be an array');
  assert.ok(Array.isArray(doctorJson.storyOwnerLeases.stale), 'storyOwnerLeases.stale should be an array');
  assert.ok(Array.isArray(doctorJson.storyOwnerLeases.terminalStale), 'storyOwnerLeases.terminalStale should be an array');
  assert.equal(doctorJson.storyOwnerLeases.hasTerminalStale, false, 'no terminal stale lease in the clean doctor fixture');
  const activityArtifact = doctorJson.runtimeArtifacts.tracked.find((artifact: any) => artifact.path === '.proof-or-stop/activity.jsonl');
  assert.ok(activityArtifact, 'doctor should include .proof-or-stop/activity.jsonl');
  assert.equal(activityArtifact.repairable, true);
  assert.equal(activityArtifact.repairCommand, "git rm --cached -- '.proof-or-stop/activity.jsonl'");
  const shellMetaArtifact = doctorJson.runtimeArtifacts.tracked.find((artifact: any) => artifact.path === shellMetaArtifactPath);
  assert.ok(shellMetaArtifact, 'doctor should include tracked runtime artifacts with shell metacharacters');
  assert.equal(shellMetaArtifact.repairable, true);
  assert.equal(
    shellMetaArtifact.repairCommand,
    "git rm --cached -- '.proof-or-stop/runtime/$USER $(echo hi) `uname` '\"'\"'artifact'\"'\"'.json'",
  );

  const doctorText = (await doctor()) as string;
  assert.ok(doctorText.startsWith('Runtime footprint:\nRuntime mode:'), 'plain doctor should start with runtime footprint');
  assert.match(doctorText, /Project-local JavaScript runtime required: (yes|no)/);
  assert.match(doctorText, /Next action: /);
  assert.match(doctorText, /Runtime artifacts:/);
  assert.match(doctorText, /\.proof-or-stop\/activity\.jsonl/);
  assert.match(doctorText, /git rm --cached -- '\.proof-or-stop\/activity\.jsonl'/);
  assert.match(doctorText, /git rm --cached -- '\.proof-or-stop\/runtime\/\$USER \$\(echo hi\) `uname` '"'"'artifact'"'"'\.json'/);
  assert.doesNotMatch(doctorText, /git rm --cached -- ".*activity\.jsonl"/);
  assert.match(doctorText, /Runtime scan:/);
  assert.match(doctorText, /cli-entrypoint/);
  assert.match(doctorText, /external-reference-policy/);
  assert.match(doctorText, /Validation scan:/);
  assert.match(doctorText, /configured validate\.command/);
  assert.match(doctorText, /shell=true/);
  assert.match(doctorText, /discovered fallback labels: package\.json test script/);
  assert.match(doctorText, /fallback command discovery is advisory/);
  assert.doesNotMatch(doctorText, /PVSC|B-2065|\b\d+\s+passed\b/);

  const repairedDoctorJson = (await doctor({ format: 'json', repair: true })) as any;
  assert.equal(repairedDoctorJson.runtimeArtifacts.tracked.length, 0, 'doctor --repair should untrack repairable runtime artifacts');
  assert.deepEqual(
    [...repairedDoctorJson.runtimeArtifacts.repaired].sort(),
    ['.proof-or-stop/activity.jsonl', shellMetaArtifactPath].sort(),
  );
  assert.notEqual(execFileSync('git', ['ls-files', '--', '.proof-or-stop/story/actives/B-demo/index.json'], { cwd: tmp, encoding: 'utf8' }).trim(), '', 'doctor --repair should not untrack story evidence');
  assert.equal(execFileSync('git', ['ls-files', '--', '.proof-or-stop/activity.jsonl'], { cwd: tmp, encoding: 'utf8' }).trim(), '', 'doctor --repair should untrack runtime artifacts');
  assert.equal(execFileSync('git', ['ls-files', '--', shellMetaArtifactPath], { cwd: tmp, encoding: 'utf8' }).trim(), '', 'doctor --repair should untrack metacharacter runtime artifacts');

  // B-50fb F-001: transition fallback must share the machine guard predicate,
  // not getGuardFailureReason's human-facing renderer. A PLAN→DEV story with no
  // review record is genuinely blocked, so the renderer returns a real reason
  // and runtimes without snapshot.can must still fail closed (return false) and
  // never advance past PLAN.
  const transitionFallbackRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-transition-fallback-'));
  try {
    resetConfigCache();
    const store = new StoryStore(transitionFallbackRoot);
    const storyId = 'B-transition-fallback';
    const now = '2026-06-12T22:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'transition-fallback',
      title: 'Transition fallback',
      description: 'Synthetic story for PLAN to DEV guard fallback.',
      type: 'chore',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
    });
    // B-dc2e CHK-001: while this smoke was orphaned, B-a7c5 CHK-001 added the
    // dev-memory preflight ack gate in front of every DEV door, so the
    // review-record reason below was pre-empted by
    // [missing_dev_memory_preflight_ack]. Acknowledge the preflight through the
    // store (the same artifact the ack handler writes) so the case keeps
    // exercising the review-record reason it was written for.
    store.writeDevMemoryPreflightAck(storyId, {
      schemaVersion: 'lattice.dev_memory_preflight_ack.v1',
      storyId,
      packDigest: null,
      topHitIds: [],
      acknowledgedAt: now,
      acknowledgedBy: 'validation-protocol-smoke',
      downgradeReason: 'synthetic PLAN story; the case under test is the review-record reason, not the preflight pack',
    });
    resetConfigCache();
    const actorWithoutSnapshotCan = {
      getSnapshot: () => ({ value: 'PLAN' }),
    } as any;
    assert.match(
      getGuardFailureReason(storyId, store, 'DEV', transitionFallbackRoot) ?? '',
      /story_review check not passed|missing_dev_memory_preflight_ack/,
      'PLAN→DEV with no review record must report a concrete preflight/review guard reason',
    );
    assert.equal(
      canSendStoryEvent(actorWithoutSnapshotCan, 'START', storyId, store, transitionFallbackRoot),
      false,
      'snapshot.can fallback must fail closed on a blocked PLAN→DEV transition',
    );
    assert.throws(
      () => assertStoryTransitionReachedTarget(storyId, 'START', 'DEV', 'PLAN'),
      /did not reach requested phase DEV/,
      'orchestrator must verify actor.send reached the requested target before writing DEV effects',
    );
    assert.equal(store.readStory(storyId).phase, 'PLAN');
  } finally {
    rmSync(transitionFallbackRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  // B-56d3 CHK-003: validate-gate fail-closed regression.
  // The DEV->TEST proof-or-stop validate gate was extracted into handlers/phase-gates.ts
  // (runValidateGate), and B-6974 moved actor lifecycle ownership up to
  // transition-orchestrator.ts. The gate must still fail-closed: a failing
  // validate run must throw "Cannot enter TEST" while preserving the verifier's
  // canonical FAIL test-evidence record — never silently advance or rewrite it.
  // Direct gate calls must not stop the actor themselves.
  const { runValidateGate } = await import('../handlers/phase-gates.js');

  function seedValidateGateSkipRoot(prefix: string, storyId: string): {
    root: string;
    store: StoryStore;
    storyId: string;
    evidence: any;
  } {
    const root = mkdtempSync(join(tmpdir(), prefix));
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      validate: {
        commands: [
          { label: 'failing skip guard rerun', command: 'node', args: ['-e', 'process.exit(5)'] },
        ],
      },
    }));
    mkdirSync(join(root, 'packages/main/src'), { recursive: true });
    writeFileSync(join(root, 'packages/main/src/app.ts'), 'export const base = 1;\n');
    initSmokeGitRepo(root);
    gitQuiet(root, ['add', 'proof-or-stop.config.json', 'packages/main/src/app.ts']);
    gitQuiet(root, ['commit', '-m', 'seed validate gate skip guard smoke']);
    gitQuiet(root, ['checkout', '-b', `story/${storyId}`]);
    writeFileSync(join(root, 'packages/main/src/app.ts'), 'export const base = 2;\n');
    gitQuiet(root, ['add', 'packages/main/src/app.ts']);
    gitQuiet(root, ['commit', '-m', 'story change']);
    resetConfigCache();
    const store = new StoryStore(root);
    const now = '2026-05-16T03:00:00.000Z';
    store.writeStory(storyId, {
      storyId, name: `${storyId}-skip-guard`, title: `${storyId} skip guard`,
      description: 'unsafe PASS evidence must rerun validate', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      currentReviewRound: now, events: [],
    });
    store.writeChecklist(storyId, { items: [] });
    // Direct handler test: seed the owner lease a real story-scoped validate would
    // acquire, so B-5a15's causal preflight probes an available writer instead of
    // refusing with writerLease:writer_unavailable before validate can run.
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: transitionFallbackRoot });
    const evidence: any = {
      command: `proof-or-stop validate --story=${storyId} --json`,
      output: '{"allPass":true,"summary":"already passed"}',
      result: 'PASS' as const,
      timestamp: '2026-05-16T03:01:00.000Z',
      headHash: currentGitHead(root)!,
      materialHash: currentMaterialHash(root, 'HEAD', root)!,
      storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)!,
      verificationCoverage: { total: 0, required: 0, covered: 0, missingRequired: 0, entries: [] },
    };
    // origin/main merge: this fixture drives runValidateGate directly, which bypasses the
    // CLI ownership gate that a real story-scoped validate goes through. B-5a15 added a
    // causal preflight that probes writer availability (causal-evidence.ts:911), and with
    // no owner lease on disk it refuses with writerLease:writer_unavailable BEFORE running
    // validate -- so the rerun never happens and the stored PASS survives, which is what
    // made 'whole-tree material drift must rerun rather than reuse PASS evidence' fail.
    // Seeding the same lease the real command would acquire SATISFIES that guard instead
    // of weakening it; exempting fixtures from the preflight would disable a fail-closed
    // check whose whole purpose is preventing false PASS evidence. Same precedent and
    // rationale as closeout-trust-smoke.ts.
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: root });
    return { root, store, storyId, evidence };
  }

  async function assertUnsafePassEvidenceReruns(args: {
    name: string;
    reason: string;
    prepareBeforeEvidenceCommit?: (fixture: { root: string; store: StoryStore; storyId: string; evidence: any }) => void;
    mutateEvidence?: (evidence: any) => void;
    mutateAfterCommit?: (fixture: { root: string; store: StoryStore; storyId: string; evidence: any }) => void;
  }): Promise<void> {
    const fixture = seedValidateGateSkipRoot(`proof-or-stop-validate-gate-${args.name}-`, `B-vgate-${args.name}`);
    try {
      args.prepareBeforeEvidenceCommit?.(fixture);
      args.mutateEvidence?.(fixture.evidence);
      fixture.store.writeTestEvidence(fixture.storyId, fixture.evidence);
      gitQuiet(fixture.root, ['add', `.proof-or-stop/story/actives/${fixture.storyId}`]);
      gitQuiet(fixture.root, ['commit', '-m', `record ${args.name} validation evidence`]);
      args.mutateAfterCommit?.(fixture);
      let stopped = false;
      const logs: string[] = [];
      const actor = { stop() { stopped = true; } };
      await assert.rejects(
        () => runValidateGate({ store: fixture.store, root: fixture.root, scanRoot: join(fixture.root, 'packages/main'), log: line => logs.push(line) }, fixture.storyId, actor),
        /Cannot enter TEST: proof-or-stop validate (did not pass|execution error)/,
        `${args.name}: unsafe PASS evidence must not skip a failing validate rerun`,
      );
      const after = fixture.store.readTestEvidence(fixture.storyId);
      assert.equal(stopped, false, `${args.name}: rerun path must leave actor stop to transition-orchestrator`);
      assert.equal(after?.result, 'FAIL', `${args.name}: failing validate rerun must persist FAIL evidence`);
      assert.equal(after?.disposition, 'executed', `${args.name}: gate must preserve verifier disposition`);
      assert.equal(after?.commandExecution?.status, 'FAIL', `${args.name}: gate must preserve verifier command execution summary`);
      assert.equal(after?.commandExecution?.commandCount, 1, `${args.name}: gate must preserve verifier command count`);
      assert.equal(typeof after?.routineValidationIdentity?.digest, 'string', `${args.name}: gate must preserve verifier validation identity`);
      assert.doesNotMatch(
        spawnSync('git', ['status', '--porcelain'], { cwd: fixture.root, encoding: 'utf8' }).stdout,
        /test-evidence\.json/,
        `${args.name}: gate must not dirty canonical test evidence after verifier auto-commit`,
      );
      assert.ok(
        logs.some(line => line.includes(args.reason)),
        `${args.name}: rerun log should include "${args.reason}"`,
      );
      assert.ok(
        !logs.some(line => line.includes('existing validation PASS is fresh; skipping proof-or-stop validate rerun')),
        `${args.name}: unsafe evidence must not log fresh skip`,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      resetConfigCache();
    }
  }

  const gateFreshRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-gate-fresh-skip-'));
  try {
    writeFileSync(join(gateFreshRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      validate: {
        commands: [
          { label: 'would fail if rerun', command: 'node', args: ['-e', 'process.exit(5)'] },
        ],
      },
    }));
    mkdirSync(join(gateFreshRoot, 'packages/main/src'), { recursive: true });
    writeFileSync(join(gateFreshRoot, 'packages/main/src/app.ts'), 'export const base = 1;\n');
    initSmokeGitRepo(gateFreshRoot);
    gitQuiet(gateFreshRoot, ['add', 'proof-or-stop.config.json', 'packages/main/src/app.ts']);
    gitQuiet(gateFreshRoot, ['commit', '-m', 'seed fresh validate gate smoke']);
    gitQuiet(gateFreshRoot, ['checkout', '-b', 'story/B-vgate-fresh']);
    writeFileSync(join(gateFreshRoot, 'packages/main/src/app.ts'), 'export const base = 2;\n');
    gitQuiet(gateFreshRoot, ['add', 'packages/main/src/app.ts']);
    gitQuiet(gateFreshRoot, ['commit', '-m', 'story change']);
    resetConfigCache();
    const store = new StoryStore(gateFreshRoot);
    const storyId = 'B-vgate-fresh';
    const now = '2026-05-16T03:00:00.000Z';
    store.writeStory(storyId, {
      storyId, name: 'validate-gate-fresh', title: 'Validate gate fresh skip',
      description: 'fresh PASS validation evidence skips rerun', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      currentReviewRound: now, events: [],
    });
    store.writeChecklist(storyId, { items: [] });
    // Direct handler test: seed the owner lease a real story-scoped validate would
    // acquire, so B-5a15's causal preflight probes an available writer instead of
    // refusing with writerLease:writer_unavailable before validate can run.
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: gateFreshRoot });
    const evidence = {
      command: `proof-or-stop validate --story=${storyId} --json`,
      output: '{"allPass":true,"summary":"already passed"}',
      result: 'PASS' as const,
      timestamp: '2026-05-16T03:01:00.000Z',
      headHash: currentGitHead(gateFreshRoot)!,
      materialHash: currentMaterialHash(gateFreshRoot, 'HEAD', gateFreshRoot)!,
      storyFilesHash: currentStoryFilesHash(gateFreshRoot, 'HEAD', gateFreshRoot)!,
      verificationCoverage: { total: 0, required: 0, covered: 0, missingRequired: 0, entries: [] },
    };
    assert.ok(evidence.headHash, 'fresh skip smoke must bind headHash');
    assert.ok(evidence.materialHash, 'fresh skip smoke must bind materialHash');
    assert.ok(evidence.storyFilesHash, 'fresh skip smoke must bind storyFilesHash');
    store.writeTestEvidence(storyId, evidence);
    gitQuiet(gateFreshRoot, ['add', `.proof-or-stop/story/actives/${storyId}`]);
    gitQuiet(gateFreshRoot, ['commit', '-m', 'record fresh validation evidence']);
    evidence.headHash = currentGitHead(gateFreshRoot)!;
    evidence.materialHash = currentMaterialHash(gateFreshRoot, 'HEAD', gateFreshRoot)!;
    evidence.storyFilesHash = currentStoryFilesHash(gateFreshRoot, 'HEAD', gateFreshRoot)!;
    store.writeTestEvidence(storyId, evidence);
    let stopped = false;
    const logs: string[] = [];
    const actor = { stop() { stopped = true; } };
    await runValidateGate({ store, root: gateFreshRoot, scanRoot: join(gateFreshRoot, 'packages/main'), log: line => logs.push(line) }, storyId, actor);
    const after = store.readTestEvidence(storyId);
    assert.equal(stopped, false, 'fresh skip path must leave actor stop to transition-orchestrator');
    assert.equal(after?.result, 'PASS', 'fresh skip path must preserve the existing PASS result');
    assert.equal(after?.timestamp, evidence.timestamp, 'fresh skip path must not rewrite test-evidence timestamp');
    assert.equal(after?.output, evidence.output, 'fresh skip path must not rewrite test-evidence output');
    assert.ok(
      logs.some(line => line.includes('existing validation PASS is fresh; skipping proof-or-stop validate rerun')),
      'fresh skip path must log that proof-or-stop validate was not rerun',
    );
  } finally {
    rmSync(gateFreshRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  const gateWarningRoot = seedValidateGateSkipRoot('proof-or-stop-validate-gate-warning-skip-', 'B-vgate-warning');
  try {
    gateWarningRoot.store.writeTestEvidence(gateWarningRoot.storyId, gateWarningRoot.evidence);
    gitQuiet(gateWarningRoot.root, ['add', `.proof-or-stop/story/actives/${gateWarningRoot.storyId}`]);
    gitQuiet(gateWarningRoot.root, ['commit', '-m', 'record warning validation evidence']);
    gitQuiet(gateWarningRoot.root, ['checkout', 'main']);
    writeFileSync(join(gateWarningRoot.root, 'packages/main/src/unrelated.ts'), 'export const unrelated = 1;\n');
    gitQuiet(gateWarningRoot.root, ['add', 'packages/main/src/unrelated.ts']);
    gitQuiet(gateWarningRoot.root, ['commit', '-m', 'unrelated main material change']);
    gitQuiet(gateWarningRoot.root, ['checkout', `story/${gateWarningRoot.storyId}`]);
    gitQuiet(gateWarningRoot.root, ['merge', 'main', '--no-edit']);
    let stopped = false;
    const logs: string[] = [];
    const actor = { stop() { stopped = true; } };
    await assert.rejects(
      () => runValidateGate({ store: gateWarningRoot.store, root: gateWarningRoot.root, scanRoot: join(gateWarningRoot.root, 'packages/main'), log: line => logs.push(line) }, gateWarningRoot.storyId, actor),
      /Cannot enter TEST: proof-or-stop validate (did not pass|execution error)/,
    );
    const after = gateWarningRoot.store.readTestEvidence(gateWarningRoot.storyId);
    assert.equal(stopped, false, 'fresh warning skip path must leave actor stop to transition-orchestrator');
    assert.equal(after?.result, 'FAIL', 'whole-tree material drift must rerun rather than reuse PASS evidence');
    assert.ok(
      logs.some(line => line.includes('materialHash does not match current materialHash')),
      'whole-tree material drift must fail the exact validation admissibility envelope',
    );
  } finally {
    rmSync(gateWarningRoot.root, { recursive: true, force: true });
    resetConfigCache();
  }

  await assertUnsafePassEvidenceReruns({
    name: 'wrong-command',
    reason: 'existing validation PASS command is not',
    mutateEvidence: evidence => { evidence.command = 'proof-or-stop validate --story=B-other --json'; },
  });

  await assertUnsafePassEvidenceReruns({
    name: 'coverage-malformed',
    reason: 'verificationCoverage is missing missingRequired',
    mutateEvidence: evidence => { evidence.verificationCoverage.missingRequired = '0'; },
  });

  await assertUnsafePassEvidenceReruns({
    name: 'coverage-gap',
    reason: 'required verification coverage gap',
    mutateEvidence: evidence => { evidence.verificationCoverage.missingRequired = 1; },
  });

  await assertUnsafePassEvidenceReruns({
    name: 'missing-hashes',
    reason: 'missing headHash/materialHash freshness bindings',
    mutateEvidence: evidence => {
      delete evidence.headHash;
      delete evidence.materialHash;
    },
  });

  await assertUnsafePassEvidenceReruns({
    name: 'output-false',
    reason: 'output is not allPass/allPassed=true',
    mutateEvidence: evidence => { evidence.output = '{"allPass":false,"summary":"contradiction"}'; },
  });

  await assertUnsafePassEvidenceReruns({
    name: 'output-malformed',
    reason: 'output is not valid JSON',
    mutateEvidence: evidence => { evidence.output = 'not json'; },
  });

  await assertUnsafePassEvidenceReruns({
    name: 'checklist-drift',
    reason: 'verificationCoverage does not match current checklist verificationIntent inputs',
    mutateAfterCommit: ({ store, storyId }) => {
      store.writeChecklist(storyId, {
        items: [{
          id: 'CHK-001',
          title: 'New required intent after validation',
          status: 'done',
          startTime: null,
          endTime: null,
          verificationIntent: {
            happy: [{ desc: 'New must intent requires recomputed coverage', type: 'logic', priority: 'must' }],
            edge: [],
            adversarial: [],
          },
        }],
      });
    },
  });

  await assertUnsafePassEvidenceReruns({
    name: 'coverage-evidence-removed',
    reason: 'current verificationEvidence records',
    prepareBeforeEvidenceCommit: ({ store, storyId, evidence }) => {
      const intentEvidence = {
        intentRef: 'CHK-001:happy:0',
        kind: 'logic_test',
        result: 'pass',
        command: 'node packages/main/dist/tasks/validation-protocol-smoke.js',
        note: 'Fresh PASS evidence for the required intent before metadata weakening.',
      };
      store.writeChecklist(storyId, {
        items: [{
          id: 'CHK-001',
          title: 'Required intent with real evidence',
          status: 'done',
          startTime: null,
          endTime: null,
          verificationIntent: {
            happy: [{ desc: 'Required intent keeps the same text after PASS', type: 'logic', priority: 'must' }],
            edge: [],
            adversarial: [],
          },
          verificationEvidence: [intentEvidence as any],
        }],
      });
      evidence.output = '{"allPass":true,"summary":"already passed with covered intent"}';
      evidence.verificationCoverage = {
        total: 1,
        required: 1,
        covered: 1,
        missingRequired: 0,
        entries: [{
          intentRef: 'CHK-001:happy:0',
          itemId: 'CHK-001',
          lane: 'happy',
          desc: 'Required intent keeps the same text after PASS',
          type: 'logic',
          priority: 'must',
          status: 'covered',
          evidence: intentEvidence,
        }],
      };
    },
    mutateAfterCommit: ({ store, storyId }) => {
      const checklist = store.readChecklist(storyId);
      const item = checklist.items[0];
      assert.ok(item, 'coverage evidence removal smoke must seed a checklist item');
      item.verificationEvidence = [];
      store.writeChecklist(storyId, checklist);
    },
  });

  await assertUnsafePassEvidenceReruns({
    name: 'dirty-material',
    reason: 'current worktree has blocking dirty path',
    mutateAfterCommit: ({ root }) => {
      writeFileSync(join(root, 'packages/main/src/app.ts'), 'export const base = 999;\n');
    },
  });

  const gateLegacyNoCoverageRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-gate-legacy-no-coverage-'));
  try {
    writeFileSync(join(gateLegacyNoCoverageRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      validate: {
        commands: [
          { label: 'failing legacy no coverage rerun', command: 'node', args: ['-e', 'process.exit(5)'] },
        ],
      },
    }));
    mkdirSync(join(gateLegacyNoCoverageRoot, 'packages/main/src'), { recursive: true });
    writeFileSync(join(gateLegacyNoCoverageRoot, 'packages/main/src/app.ts'), 'export const base = 1;\n');
    initSmokeGitRepo(gateLegacyNoCoverageRoot);
    gitQuiet(gateLegacyNoCoverageRoot, ['add', 'proof-or-stop.config.json', 'packages/main/src/app.ts']);
    gitQuiet(gateLegacyNoCoverageRoot, ['commit', '-m', 'seed legacy validation evidence smoke']);
    gitQuiet(gateLegacyNoCoverageRoot, ['checkout', '-b', 'story/B-vgate-legacy']);
    writeFileSync(join(gateLegacyNoCoverageRoot, 'packages/main/src/app.ts'), 'export const base = 2;\n');
    gitQuiet(gateLegacyNoCoverageRoot, ['add', 'packages/main/src/app.ts']);
    gitQuiet(gateLegacyNoCoverageRoot, ['commit', '-m', 'story change']);
    resetConfigCache();
    const store = new StoryStore(gateLegacyNoCoverageRoot);
    const storyId = 'B-vgate-legacy';
    const now = '2026-05-16T03:00:00.000Z';
    store.writeStory(storyId, {
      storyId, name: 'validate-gate-legacy', title: 'Validate gate legacy no coverage',
      description: 'strongly bound legacy PASS without verificationCoverage reruns validate', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      currentReviewRound: now, events: [],
    });
    store.writeChecklist(storyId, { items: [] });
    // Direct handler test: seed the owner lease a real story-scoped validate would
    // acquire, so B-5a15's causal preflight probes an available writer instead of
    // refusing with writerLease:writer_unavailable before validate can run.
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: gateLegacyNoCoverageRoot });
    const legacyEvidence = {
      command: `proof-or-stop validate --story=${storyId} --json`,
      output: '{"allPass":true,"summary":"legacy pass without coverage"}',
      result: 'PASS' as const,
      timestamp: '2026-05-16T03:01:00.000Z',
      headHash: currentGitHead(gateLegacyNoCoverageRoot)!,
      materialHash: currentMaterialHash(gateLegacyNoCoverageRoot, 'HEAD', gateLegacyNoCoverageRoot)!,
      storyFilesHash: currentStoryFilesHash(gateLegacyNoCoverageRoot, 'HEAD', gateLegacyNoCoverageRoot)!,
    };
    assert.ok(legacyEvidence.headHash, 'legacy no coverage smoke must bind headHash');
    assert.ok(legacyEvidence.materialHash, 'legacy no coverage smoke must bind materialHash');
    assert.ok(legacyEvidence.storyFilesHash, 'legacy no coverage smoke must bind storyFilesHash');
    store.writeTestEvidence(storyId, legacyEvidence);
    gitQuiet(gateLegacyNoCoverageRoot, ['add', `.proof-or-stop/story/actives/${storyId}`]);
    gitQuiet(gateLegacyNoCoverageRoot, ['commit', '-m', 'record legacy validation evidence']);
    let stopped = false;
    const logs: string[] = [];
    const actor = { stop() { stopped = true; } };
    await assert.rejects(
      () => runValidateGate({ store, root: gateLegacyNoCoverageRoot, scanRoot: join(gateLegacyNoCoverageRoot, 'packages/main'), log: line => logs.push(line) }, storyId, actor),
      /Cannot enter TEST: proof-or-stop validate (did not pass|execution error)/,
      'strongly bound legacy PASS without verificationCoverage must not skip a failing validate rerun',
    );
    const after = store.readTestEvidence(storyId);
    assert.equal(stopped, false, 'legacy no coverage path must leave actor stop to transition-orchestrator');
    assert.equal(after?.result, 'FAIL', 'legacy PASS without verificationCoverage followed by failing validate must persist FAIL evidence');
    assert.notEqual(after?.timestamp, legacyEvidence.timestamp, 'legacy no coverage path must rewrite stale-format PASS evidence');
    assert.ok(
      logs.some(line => line.includes('missing verificationCoverage from proof-or-stop validate')),
      'legacy no coverage path must log why the existing PASS was not consumed',
    );
    assert.ok(
      !logs.some(line => line.includes('existing validation PASS is fresh; skipping proof-or-stop validate rerun')),
      'legacy no coverage path must not log the fresh skip message',
    );
  } finally {
    rmSync(gateLegacyNoCoverageRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  const gateStaleRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-gate-stale-rerun-'));
  try {
    writeFileSync(join(gateStaleRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      validate: {
        commands: [
          { label: 'failing stale rerun', command: 'node', args: ['-e', 'process.exit(5)'] },
        ],
      },
    }));
    mkdirSync(join(gateStaleRoot, 'packages/main/src'), { recursive: true });
    writeFileSync(join(gateStaleRoot, 'packages/main/src/app.ts'), 'export const base = 1;\n');
    initSmokeGitRepo(gateStaleRoot);
    gitQuiet(gateStaleRoot, ['add', 'proof-or-stop.config.json', 'packages/main/src/app.ts']);
    gitQuiet(gateStaleRoot, ['commit', '-m', 'seed stale validate gate smoke']);
    gitQuiet(gateStaleRoot, ['checkout', '-b', 'story/B-vgate-stale']);
    writeFileSync(join(gateStaleRoot, 'packages/main/src/app.ts'), 'export const base = 2;\n');
    gitQuiet(gateStaleRoot, ['add', 'packages/main/src/app.ts']);
    gitQuiet(gateStaleRoot, ['commit', '-m', 'first story change']);
    resetConfigCache();
    const store = new StoryStore(gateStaleRoot);
    const storyId = 'B-vgate-stale';
    const now = '2026-05-16T03:00:00.000Z';
    store.writeStory(storyId, {
      storyId, name: 'validate-gate-stale', title: 'Validate gate stale rerun',
      description: 'stale PASS validation evidence reruns validate', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      currentReviewRound: now, events: [],
    });
    store.writeChecklist(storyId, { items: [] });
    // Direct handler test: seed the owner lease a real story-scoped validate would
    // acquire, so B-5a15's causal preflight probes an available writer instead of
    // refusing with writerLease:writer_unavailable before validate can run.
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: gateStaleRoot });
    const staleEvidence = {
      command: `proof-or-stop validate --story=${storyId} --json`,
      output: '{"allPass":true,"summary":"old pass"}',
      result: 'PASS' as const,
      timestamp: '2026-05-16T03:01:00.000Z',
      headHash: currentGitHead(gateStaleRoot)!,
      materialHash: currentMaterialHash(gateStaleRoot, 'HEAD', gateStaleRoot)!,
      storyFilesHash: currentStoryFilesHash(gateStaleRoot, 'HEAD', gateStaleRoot)!,
      verificationCoverage: { total: 0, required: 0, covered: 0, missingRequired: 0, entries: [] },
    };
    assert.ok(staleEvidence.headHash, 'stale rerun smoke must bind headHash');
    assert.ok(staleEvidence.materialHash, 'stale rerun smoke must bind materialHash');
    assert.ok(staleEvidence.storyFilesHash, 'stale rerun smoke must bind storyFilesHash');
    store.writeTestEvidence(storyId, staleEvidence);
    gitQuiet(gateStaleRoot, ['add', `.proof-or-stop/story/actives/${storyId}`]);
    gitQuiet(gateStaleRoot, ['commit', '-m', 'record stale validation evidence']);
    writeFileSync(join(gateStaleRoot, 'packages/main/src/app.ts'), 'export const base = 3;\n');
    gitQuiet(gateStaleRoot, ['add', 'packages/main/src/app.ts']);
    gitQuiet(gateStaleRoot, ['commit', '-m', 'second story change']);
    // The direct gate call bypasses the CLI ownership entry point. Reacquire
    // after its fixture commits so the official validation heartbeat observes
    // the lease generation it is expected to renew.
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: gateStaleRoot });
    let stopped = false;
    const logs: string[] = [];
    const actor = { stop() { stopped = true; } };
    await assert.rejects(
      () => runValidateGate({ store, root: gateStaleRoot, scanRoot: join(gateStaleRoot, 'packages/main'), log: line => logs.push(line) }, storyId, actor),
      /Cannot enter TEST: proof-or-stop validate (did not pass|execution error)/,
      'stale PASS evidence must not skip a failing validate rerun',
    );
    const after = store.readTestEvidence(storyId);
    assert.equal(stopped, false, 'stale rerun path must leave actor stop to transition-orchestrator');
    assert.equal(after?.result, 'FAIL', 'stale PASS evidence followed by failing validate must persist FAIL evidence');
    assert.notEqual(after?.timestamp, staleEvidence.timestamp, 'stale rerun path must rewrite stale PASS evidence');
    assert.ok(
      logs.some(line => line.includes('existing validation PASS is stale')),
      'stale rerun path must log why the existing PASS was not consumed',
    );
    assert.ok(
      !logs.some(line => line.includes('existing validation PASS is fresh; skipping proof-or-stop validate rerun')),
      'stale rerun path must not log the fresh skip message',
    );
  } finally {
    rmSync(gateStaleRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  const gateFailRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-gate-fail-'));
  try {
    writeFileSync(join(gateFailRoot, 'proof-or-stop.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'failing gate', command: 'node', args: ['-e', 'process.exit(5)'] },
        ],
      },
    }));
    // B-dc2e CHK-001: while this smoke was orphaned, workspace validation
    // capacity started resolving git-common-dir identity, so a bare temp dir
    // now fails as an execution error before the gate reaches the configured
    // command. Seed the same minimal repository the sibling gate fixtures use.
    initSmokeGitRepo(gateFailRoot);
    gitQuiet(gateFailRoot, ['add', 'proof-or-stop.config.json']);
    gitQuiet(gateFailRoot, ['commit', '-m', 'seed validate gate fail smoke']);
    resetConfigCache();
    const store = new StoryStore(gateFailRoot);
    const storyId = 'B-vgate-fail';
    const now = '2026-05-16T03:00:00.000Z';
    store.writeStory(storyId, {
      storyId, name: 'validate-gate-fail', title: 'Validate gate fail',
      description: 'validate FAIL must block TEST', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      currentReviewRound: now, events: [],
    });
    store.writeChecklist(storyId, { items: [] });
    // Direct handler test: seed the owner lease a real story-scoped validate would
    // acquire, so B-5a15's causal preflight probes an available writer instead of
    // refusing with writerLease:writer_unavailable before validate can run.
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: gateFailRoot });
    let stopped = false;
    const actor = { stop() { stopped = true; } };
    await assert.rejects(
      () => runValidateGate({ store, root: gateFailRoot, scanRoot: gateFailRoot }, storyId, actor),
      /Cannot enter TEST: proof-or-stop validate (did not pass|execution error)/,
      'runValidateGate must block TEST when proof-or-stop validate fails',
    );
    assert.equal(stopped, false, 'runValidateGate must leave actor stop to transition-orchestrator');
    assert.equal(store.readTestEvidence(storyId)?.result, 'FAIL', 'validate FAIL must persist a FAIL test-evidence record');
    assert.equal(store.readTestEvidence(storyId)?.failureKind, 'validation_failure', 'ordinary validate command failure must be classified as validation_failure');
  } finally {
    rmSync(gateFailRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  const gateInfraRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-gate-infra-'));
  try {
    writeFileSync(join(gateInfraRoot, 'proof-or-stop.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'timed out gate', command: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 100 },
        ],
      },
    }));
    // B-dc2e CHK-001: while this smoke was orphaned, workspace validation
    // capacity started resolving git-common-dir identity, so a bare temp dir
    // now fails as an execution error before the gate reaches the configured
    // command. Seed the same minimal repository the sibling gate fixtures use.
    initSmokeGitRepo(gateInfraRoot);
    gitQuiet(gateInfraRoot, ['add', 'proof-or-stop.config.json']);
    gitQuiet(gateInfraRoot, ['commit', '-m', 'seed validate gate infra smoke']);
    resetConfigCache();
    const store = new StoryStore(gateInfraRoot);
    const storyId = 'B-vgate-infra';
    const now = '2026-05-16T03:05:00.000Z';
    store.writeStory(storyId, {
      storyId, name: 'validate-gate-infra', title: 'Validate gate infra',
      description: 'validate infra failure must block TEST distinctly', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      currentReviewRound: now, events: [],
    });
    store.writeChecklist(storyId, { items: [] });
    // Direct handler test: seed the owner lease a real story-scoped validate would
    // acquire, so B-5a15's causal preflight probes an available writer instead of
    // refusing with writerLease:writer_unavailable before validate can run.
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: gateInfraRoot });
    const actor = { stop() { /* transition-orchestrator owns actor stop */ } };
    await assert.rejects(
      () => runValidateGate({ store, root: gateInfraRoot, scanRoot: gateInfraRoot }, storyId, actor),
      /Cannot enter TEST: proof-or-stop validate (did not pass|execution error)/,
      'runValidateGate must block TEST when the validation runner times out',
    );
    const evidence = store.readTestEvidence(storyId);
    assert.equal(evidence?.result, 'FAIL', 'timeout must still persist FAIL evidence');
    assert.equal(evidence?.failureKind, 'infra_failure', 'timeout must be classified as infra_failure');
    assert.match(evidence?.output ?? '', /"failureKind":"infra_failure"/, 'persisted validation JSON must expose infra_failure');
    const terminal = store.readProcessEvents(storyId).find((event) => event.type === 'validation_terminal');
    assert.ok(terminal, 'routine validation must emit a durable validation_terminal event');
    assert.equal(terminal?.storyId, storyId);
    assert.equal(terminal?.attemptId, now);
    assert.equal(terminal?.reviewRound, now);
    assert.equal(terminal?.disposition, 'executed');
    assert.equal(terminal?.commandExecutions, 1);
    assert.equal(terminal?.result, 'fail');
    assert.equal(typeof terminal?.commandSetHash, 'string');
    assert.ok(String(terminal?.commandSetHash).length > 0);
    assert.equal(typeof terminal?.materialHash, 'string');
    assert.equal(typeof terminal?.storyFilesHash, 'string');
  } finally {
    rmSync(gateInfraRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  // B-a30e CHK-001: validate storyId alias — conflict, evidence, read-only parity

  // 1. Conflicting story + storyId values must fail with an explicit error
  const conflictAliasRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-alias-conflict-'));
  try {
    resetConfigCache();
    await assert.rejects(
      () => createVerifierHandlers({
        root: conflictAliasRoot,
        scanRoot: conflictAliasRoot,
        store: new StoryStore(conflictAliasRoot),
        log: () => {},
      }).validate({ story: 'B-x1', storyId: 'B-x2', json: true }),
      /conflicting story identifiers.*--story.*storyId.*differ/i,
      'validate with story != storyId must fail with an explicit error',
    );
  } finally {
    rmSync(conflictAliasRoot, { recursive: true, force: true });
  }

  // 2. storyId alias writes test evidence (same as --story)
  const storyIdAliasRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-storyid-alias-'));
  try {
    writeFileSync(join(storyIdAliasRoot, 'proof-or-stop.config.json'), JSON.stringify({ validate: { commands: [] } }));
    resetConfigCache();
    // B-dc2e CHK-001: validate now resolves git-common-dir identity for its
    // workspace capacity lock, so these alias fixtures (bare temp dirs while
    // this smoke was orphaned) are seeded as minimal repositories; the
    // no-story case still proves nothing under .proof-or-stop/ is created.
    initSmokeGitRepo(storyIdAliasRoot);
    gitQuiet(storyIdAliasRoot, ['commit', '--allow-empty', '-m', 'seed storyIdAliasRoot']);
    const aliasStore = new StoryStore(storyIdAliasRoot);
    // B-dc2e CHK-001: the canonical evidence transaction resolves the story
    // directory (realpath) before persisting test evidence, so a story-scoped
    // validate against a story that was never written now fails as
    // canonical-validation-persistence-failed instead of writing evidence.
    // Seed the story the alias refers to, as every other evidence-writing
    // fixture in this smoke already does.
    aliasStore.writeStory('B-alias-smoke', {
      storyId: 'B-alias-smoke', name: 'alias-smoke', title: 'storyId alias smoke',
      description: 'seeded so the alias validate can persist evidence', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: '2026-05-16T04:00:00.000Z', startedAt: '2026-05-16T04:00:00.000Z', endedAt: null,
      currentReviewRound: '2026-05-16T04:00:00.000Z', events: [],
    });
    const aliasNow = new Date().toISOString();
    aliasStore.writeStory('B-alias-smoke', {
      storyId: 'B-alias-smoke', name: 'story-id-alias-smoke', title: 'Story id alias smoke',
      description: 'validate storyId alias persists evidence', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: aliasNow, startedAt: aliasNow, endedAt: null,
      currentReviewRound: aliasNow, events: [],
    });
    aliasStore.writeChecklist('B-alias-smoke', { items: [] });
    // This calls the verifier directly, bypassing the CLI path that acquires
    // the story owner lease before a story-scoped validation begins.
    acquireOwnerLease(aliasStore.storyDirPath('B-alias-smoke'), { command: 'validate', cwd: storyIdAliasRoot });
    const aliasJson = await createVerifierHandlers({
      root: storyIdAliasRoot,
      scanRoot: storyIdAliasRoot,
      store: aliasStore,
      log: () => {},
    }).validate({ storyId: 'B-alias-smoke', json: true, noSync: true });
    const aliasResult = JSON.parse(aliasJson);
    assert.equal(aliasResult.provider, 'proof-or-stop-verifier-no-validation-entry', 'storyId alias: expected no-validation-entry provider');
    assert.equal(aliasResult.status, 'warn', 'storyId alias: expected warn status for no-validator');
    const aliasEvidence = aliasStore.readTestEvidence('B-alias-smoke');
    assert.ok(aliasEvidence !== null, 'storyId alias: test evidence must be written when storyId is supplied');
    assert.equal(aliasEvidence!.result, 'PASS', 'storyId alias: warn/skip evidence persists as PASS');
  } finally {
    rmSync(storyIdAliasRoot, { recursive: true, force: true });
  }

  // 3. --story still writes test evidence (unchanged behavior)
  const storyFlagRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-story-flag-'));
  try {
    writeFileSync(join(storyFlagRoot, 'proof-or-stop.config.json'), JSON.stringify({ validate: { commands: [] } }));
    resetConfigCache();
    initSmokeGitRepo(storyFlagRoot);
    gitQuiet(storyFlagRoot, ['commit', '--allow-empty', '-m', 'seed storyFlagRoot']);
    const storyFlagStore = new StoryStore(storyFlagRoot);
    storyFlagStore.writeStory('B-story-flag-smoke', {
      storyId: 'B-story-flag-smoke', name: 'story-flag-smoke', title: 'story flag smoke',
      description: 'seeded so the alias validate can persist evidence', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: '2026-05-16T04:00:00.000Z', startedAt: '2026-05-16T04:00:00.000Z', endedAt: null,
      currentReviewRound: '2026-05-16T04:00:00.000Z', events: [],
    });
    const storyFlagNow = new Date().toISOString();
    storyFlagStore.writeStory('B-story-flag-smoke', {
      storyId: 'B-story-flag-smoke', name: 'story-flag-smoke', title: 'Story flag smoke',
      description: 'validate story flag persists evidence', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: storyFlagNow, startedAt: storyFlagNow, endedAt: null,
      currentReviewRound: storyFlagNow, events: [],
    });
    storyFlagStore.writeChecklist('B-story-flag-smoke', { items: [] });
    // Match the real CLI ownership precondition for this direct verifier call.
    acquireOwnerLease(storyFlagStore.storyDirPath('B-story-flag-smoke'), { command: 'validate', cwd: storyFlagRoot });
    const storyFlagJson = await createVerifierHandlers({
      root: storyFlagRoot,
      scanRoot: storyFlagRoot,
      store: storyFlagStore,
      log: () => {},
    }).validate({ story: 'B-story-flag-smoke', json: true, noSync: true });
    const storyFlagResult = JSON.parse(storyFlagJson);
    assert.equal(storyFlagResult.provider, 'proof-or-stop-verifier-no-validation-entry', '--story flag: expected no-validation-entry provider');
    const storyFlagEvidence = storyFlagStore.readTestEvidence('B-story-flag-smoke');
    assert.ok(storyFlagEvidence !== null, '--story flag: test evidence must be written (regression guard)');
  } finally {
    rmSync(storyFlagRoot, { recursive: true, force: true });
  }

  // 4. No-story validate is diagnostic/read-only: must not write any .proof-or-stop/ state
  const noStoryReadOnlyRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-no-story-'));
  try {
    resetConfigCache();
    initSmokeGitRepo(noStoryReadOnlyRoot);
    gitQuiet(noStoryReadOnlyRoot, ['commit', '--allow-empty', '-m', 'seed noStoryReadOnlyRoot']);
    const noStoryJson = await createVerifierHandlers({
      root: noStoryReadOnlyRoot,
      scanRoot: noStoryReadOnlyRoot,
      store: new StoryStore(noStoryReadOnlyRoot),
      log: () => {},
    }).validate({ json: true });
    const noStoryResult = JSON.parse(noStoryJson);
    assert.equal(noStoryResult.provider, 'proof-or-stop-verifier-no-validation-entry', 'no-story: expected diagnostic provider');
    // B-dc2e CHK-001: since this smoke was orphaned, official validation
    // execution serialises through a workspace capacity mkdir-lock under
    // .proof-or-stop/locks/ (keyed by git-common-dir identity), and the empty
    // lock directory outlives the run. That is runtime coordination
    // scaffolding, not story or evidence state, so the read-only claim is now
    // stated precisely: no story store, no evidence, no activity, and nothing
    // under .proof-or-stop/ other than the locks/ scaffold.
    const stateDir = join(noStoryReadOnlyRoot, '.proof-or-stop');
    const leftovers = existsSync(stateDir) ? readdirSync(stateDir).sort() : [];
    assert.equal(existsSync(join(stateDir, 'story')), false, 'no-story validate must not create a story store');
    assert.equal(existsSync(join(stateDir, 'activity.jsonl')), false, 'no-story validate must not record activity');
    assert.deepEqual(leftovers.filter((entry) => entry !== 'locks'), [], `no-story validate must not create .proof-or-stop/ state beyond the locks/ scaffold; found: ${leftovers.join(', ')}`);
    console.log(`[PASS] no-story validate is read-only for story state (.proof-or-stop/ entries after run: ${leftovers.join(', ') || 'none'})`);
  } finally {
    rmSync(noStoryReadOnlyRoot, { recursive: true, force: true });
  }

  // B-45a0: the immutable threshold pin must validate a signed current artifact
  // without spawning a campaign. Only explicit --execute may produce/repair one,
  // and a mutation subprocess failure must not be masked by another success.
  const replayWrapperRoot = join(tmp, 'replay-wrapper');
  const replayWrapperPath = join(replayWrapperRoot, 'scripts', 'run-dynamic-validation-replay.mjs');
  const fakeBunPath = join(replayWrapperRoot, 'fake-bun.mjs');
  mkdirSync(dirname(replayWrapperPath), { recursive: true });
  writeFileSync(
    replayWrapperPath,
    readFileSync(join(projectRoot, 'scripts', 'run-dynamic-validation-replay.mjs'), 'utf8'),
  );
  writeFileSync(fakeBunPath, `#!/usr/bin/env node
const target = process.argv[2] || '';
if (target.endsWith('story-aware-validation-historical-replay.ts')) {
  const args = new Set(process.argv.slice(3));
  const mode = args.has('--execute') ? 'execute' : 'plan-only';
  const paired = args.has('--paired') ? 'paired-performance: fake\\n' : '';
  const resume = args.has('--resume') ? 'historical replay resume: enabled\\n' : '';
  const repair = args.has('--repair-missing') ? 'historical replay repair: enabled\\n' : '';
  process.stdout.write('historical stories: 30\\nhistorical replay mode: ' + mode + '\\n' + paired + resume + repair);
} else if (target.endsWith('story-aware-validation-historical-replay-artifact-verify.ts')) {
  if (process.env.FAKE_ARTIFACT_STATUS) {
    process.stderr.write('historical replay artifact rejected: fake artifact rejection\\n');
    process.exit(Number(process.env.FAKE_ARTIFACT_STATUS));
  }
  process.stdout.write('historical replay artifact admission PASS\\n');
} else {
  process.stdout.write('dynamic-validation mutation audit PASS\\n');
  if (process.env.FAKE_MUTATION_STATUS) process.exit(Number(process.env.FAKE_MUTATION_STATUS));
}
`);
  chmodSync(fakeBunPath, 0o755);
  const runReplayWrapper = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [replayWrapperPath, ...args], {
    cwd: replayWrapperRoot,
    env: { ...process.env, ...extraEnv, BUN_BINARY: fakeBunPath },
    encoding: 'utf8',
  });

  const thresholdPass = runReplayWrapper(['--verify-threshold']);
  assert.equal(thresholdPass.status, 0, '--verify-threshold must admit a valid artifact');
  assert.match(thresholdPass.stdout, /historical replay artifact admission PASS/);
  assert.match(thresholdPass.stdout, /historical replay threshold PASS/);
  assert.doesNotMatch(thresholdPass.stdout, /historical replay mode:/, '--verify-threshold must not spawn a replay producer');
  assert.doesNotMatch(thresholdPass.stdout, /historical replay repair: enabled/, '--verify-threshold must not request repair');

  const thresholdBlocked = runReplayWrapper(['--verify-threshold'], { FAKE_ARTIFACT_STATUS: '19' });
  assert.equal(thresholdBlocked.status, 19, '--verify-threshold must fail closed when artifact admission rejects');
  assert.match(`${thresholdBlocked.stdout}${thresholdBlocked.stderr}`, /historical replay artifact rejected: fake artifact rejection/);
  assert.doesNotMatch(`${thresholdBlocked.stdout}${thresholdBlocked.stderr}`, /dynamic-validation mutation audit PASS/, 'rejected admission must not continue to another probe');
  assert.doesNotMatch(`${thresholdBlocked.stdout}${thresholdBlocked.stderr}`, /historical replay mode:/, 'rejected admission must not spawn a producer');

  const pairedWithoutExecute = runReplayWrapper(['--paired']);
  assert.notEqual(pairedWithoutExecute.status, 0, '--paired alone must not become an implicit producer');
  assert.match(`${pairedWithoutExecute.stdout}${pairedWithoutExecute.stderr}`, /--paired requires explicit --execute/);

  const planOnly = runReplayWrapper([]);
  assert.equal(planOnly.status, 0, 'plan-only replay remains diagnostic');
  assert.match(planOnly.stdout, /historical replay mode: plan-only/);
  assert.doesNotMatch(planOnly.stdout, /paired-performance: fake/);
  assert.match(planOnly.stdout, /historical replay assurance BLOCKED \(plan-only or incomplete\)/);
  assert.doesNotMatch(planOnly.stdout, /historical replay threshold PASS/);

  const executeRepair = runReplayWrapper(['--execute']);
  assert.equal(executeRepair.status, 0, '--execute must run a repair-capable executable campaign');
  assert.match(executeRepair.stdout, /historical replay mode: execute/);
  assert.match(executeRepair.stdout, /historical replay artifact admission PASS/);
  assert.match(executeRepair.stdout, /historical replay repair: enabled/);

  const mutationFailure = runReplayWrapper(['--mutation=missing-evidence'], { FAKE_MUTATION_STATUS: '23' });
  assert.equal(mutationFailure.status, 23, 'a failing mutation probe must propagate its own non-zero status');
  assert.match(`${mutationFailure.stdout}${mutationFailure.stderr}`, /dynamic-validation mutation audit PASS/);

  console.log('✓ validation protocol smoke passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
