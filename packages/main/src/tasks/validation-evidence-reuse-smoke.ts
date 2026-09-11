#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildValidationExecutableLookup,
  buildRoutineValidationIdentity,
  classifyTrustedValidationLineage,
  evaluateRoutineValidationReuse,
  isCompleteRoutineValidationIdentity,
  summarizeRoutineCommandExecution,
} from '../core/validation-evidence-reuse.js';
import { captureEvidenceHashSnapshot, checkEvidenceHashSnapshotReuse } from '../core/evidence-freshness.js';
import type { TestEvidenceData, VerificationCoverageReport } from '../core/types.js';
import type { RoutineValidationIdentity, RoutineValidationSourceKind, ValidationCommand } from '../core/validation-types.js';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from '../handlers/context.js';
import { assessStoredValidationPassAdmissibility } from '../handlers/phase-gates.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import {
  captureLifecycleMetadataTransaction,
  commitLifecycleMetadataTransaction,
  readLifecycleMetadataOutputHashes,
} from '../core/auto-commit-metadata.js';
import { rawArtifactDigest } from '../core/closeout-trust.js';
import { persistSyntheticAdmittedWindowForTest } from '../core/certification-window.js';
import { deriveCertificationDomainInputHashes } from '../handlers/certification-window.js';
import { signTestValidationEvidence } from '../core/validation-artifact-signing.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'validation-reuse-smoke',
      GIT_AUTHOR_EMAIL: 'validation-reuse-smoke@example.com',
      GIT_COMMITTER_NAME: 'validation-reuse-smoke',
      GIT_COMMITTER_EMAIL: 'validation-reuse-smoke@example.com',
    },
  }).trim();
}

function cliPath(): string {
  return join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'cli.js');
}

function lifecycleHashes(root: string, paths: string[]): Map<string, string> {
  return new Map(paths.map((path) => [path, rawArtifactDigest(readFileSync(join(root, path)))]));
}

function assertLifecycleMetadataTransactionBoundaries(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lifecycle-metadata-transaction-'));
  const storyId = 'B-lifecycle-transaction';
  const storyRel = `.proof-or-stop/story/actives/${storyId}`;
  const transitionPaths = [
    `${storyRel}/index.json`,
    `${storyRel}/process-events.jsonl`,
    `${storyRel}/process-metrics.json`,
  ];
  const terminalPath = `${storyRel}/process-events.jsonl`;
  try {
    mkdirSync(join(root, storyRel), { recursive: true });
    writeFileSync(join(root, transitionPaths[0]), '{"phase":"REVIEW"}\n', 'utf8');
    writeFileSync(join(root, transitionPaths[1]), '{"type":"baseline"}\n', 'utf8');
    writeFileSync(join(root, transitionPaths[2]), '{"count":0}\n', 'utf8');
    writeFileSync(join(root, 'source.ts'), 'export const lifecycleTransaction = true;\n', 'utf8');
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    const transitionCapture = captureLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      storyRel,
      kind: 'test-transition',
    });
    assert.deepEqual(transitionCapture.transaction.paths, [...transitionPaths].sort(),
      'TEST transition transaction must own exactly index/process-events/process-metrics');
    writeFileSync(join(root, transitionPaths[0]), '{"phase":"TEST"}\n', 'utf8');
    writeFileSync(join(root, transitionPaths[1]), '{"type":"baseline"}\n{"type":"phase_transition"}\n', 'utf8');
    writeFileSync(join(root, transitionPaths[2]), '{"count":1}\n', 'utf8');
    const transitionCommit = commitLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      capture: transitionCapture,
      verifiedHashes: lifecycleHashes(root, transitionPaths),
    });
    assert.equal(transitionCommit.ok, true, transitionCommit.reason);
    assert.deepEqual(
      git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').filter(Boolean).sort(),
      [...transitionPaths].sort(),
      'TEST transition commit must contain exactly its three canonical paths',
    );

    const terminalCapture = captureLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      storyRel,
      kind: 'codex-command-terminal',
    });
    assert.deepEqual(terminalCapture.transaction.paths, [terminalPath],
      'Codex terminal transaction must own only process-events');
    const terminalBefore = readFileSync(join(root, terminalPath));
    writeFileSync(join(root, terminalPath), Buffer.concat([
      terminalBefore,
      Buffer.from('{"type":"codex_cli"}\n'),
    ]));
    const terminalCommit = commitLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      capture: terminalCapture,
      verifiedHashes: lifecycleHashes(root, [terminalPath]),
    });
    assert.equal(terminalCommit.ok, true, terminalCommit.reason);
    assert.deepEqual(
      git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').filter(Boolean),
      [terminalPath],
      'Codex terminal commit must contain exactly process-events',
    );

    const failureCapture = captureLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      storyRel,
      kind: 'codex-command-terminal',
    });
    const failureBaseline = readFileSync(join(root, terminalPath));
    writeFileSync(join(root, terminalPath), Buffer.concat([
      failureBaseline,
      Buffer.from('{"type":"owned-before-failure"}\n'),
    ]));
    const failureIndexBefore = git(root, ['ls-files', '--stage', '--', terminalPath]);
    const failed = commitLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      capture: failureCapture,
      verifiedHashes: lifecycleHashes(root, [terminalPath]),
      testHooks: { beforeAdd: () => { throw new Error('deterministic lifecycle writer failure'); } },
    });
    assert.equal(failed.ok, false);
    assert.match(failed.reason ?? '', /deterministic lifecycle writer failure/);
    assert.deepEqual(readFileSync(join(root, terminalPath)), failureBaseline,
      'owned worktree bytes must roll back after commit failure');
    assert.equal(git(root, ['ls-files', '--stage', '--', terminalPath]), failureIndexBefore,
      'isolated writer failure must leave the real index byte-equivalent');

    const contentRaceCapture = captureLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      storyRel,
      kind: 'codex-command-terminal',
    });
    const owned = Buffer.concat([failureBaseline, Buffer.from('{"type":"owned"}\n')]);
    writeFileSync(join(root, terminalPath), owned);
    const ownedHashes = lifecycleHashes(root, [terminalPath]);
    const foreign = Buffer.concat([owned, Buffer.from('{"type":"foreign-concurrent"}\n')]);
    writeFileSync(join(root, terminalPath), foreign);
    const raced = commitLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      capture: contentRaceCapture,
      verifiedHashes: ownedHashes,
    });
    assert.equal(raced.ok, false);
    assert.match(raced.reason ?? '', /concurrent divergence preserved/);
    assert.deepEqual(readFileSync(join(root, terminalPath)), foreign,
      'compare-and-restore must preserve concurrent managed-path bytes');

    writeFileSync(join(root, terminalPath), failureBaseline);
    assert.equal(git(root, ['status', '--porcelain=v1', '--', terminalPath]), '');
    const headRaceCapture = captureLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      storyRel,
      kind: 'codex-command-terminal',
    });
    writeFileSync(join(root, terminalPath), Buffer.concat([
      failureBaseline,
      Buffer.from('{"type":"owned-before-head-race"}\n'),
    ]));
    const headBeforeRace = git(root, ['rev-parse', 'HEAD']);
    const headRaced = commitLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      capture: headRaceCapture,
      verifiedHashes: lifecycleHashes(root, [terminalPath]),
      testHooks: {
        beforeCasUpdate: () => {
          git(root, ['commit', '--allow-empty', '-m', 'concurrent lifecycle head movement']);
        },
      },
    });
    assert.equal(headRaced.ok, false);
    assert.match(headRaced.reason ?? '', /CAS|changed|concurrent/i);
    assert.notEqual(git(root, ['rev-parse', 'HEAD']), headBeforeRace,
      'concurrent HEAD movement must survive the failed lifecycle CAS');
    assert.deepEqual(readFileSync(join(root, terminalPath)), failureBaseline,
      'owned bytes may roll back when concurrent HEAD did not change their content');

    const readFailureCapture = captureLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      storyRel,
      kind: 'codex-command-terminal',
    });
    writeFileSync(join(root, terminalPath), Buffer.concat([
      failureBaseline,
      Buffer.from('{"type":"owned-before-read-failure"}\n'),
    ]));
    rmSync(join(root, terminalPath));
    const unreadable = readLifecycleMetadataOutputHashes({ root, capture: readFailureCapture });
    assert.equal(unreadable.ok, false, 'filesystem verification failure must be classified without throwing');
    const readFailed = commitLifecycleMetadataTransaction({
      root,
      gitCwd: root,
      storyId,
      capture: readFailureCapture,
      verifiedHashes: new Map(),
    });
    assert.equal(readFailed.ok, false);
    assert.match(readFailed.reason ?? '', /hash set incomplete|concurrent divergence preserved/);
    assert.equal(existsSync(join(root, terminalPath)), false,
      'an unverified concurrent deletion must be preserved rather than overwritten during rollback');
    writeFileSync(join(root, terminalPath), failureBaseline);

    writeFileSync(join(root, terminalPath), Buffer.concat([
      failureBaseline,
      Buffer.from('{"type":"preexisting-forged"}\n'),
    ]));
    assert.throws(
      () => captureLifecycleMetadataTransaction({
        root,
        gitCwd: root,
        storyId,
        storyRel,
        kind: 'codex-command-terminal',
      }),
      /canonical metadata was already dirty/,
      'a canonical-looking pre-entry row must never be adopted by path alone',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertPostCommandHookMutationFailsTerminalCloseout(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-terminal-hook-'));
  const counterPath = join(tmpdir(), `proof-or-stop-validation-terminal-hook-${process.pid}-${Date.now()}.log`);
  const storyId = 'B-terminal-hook';
  const processEventsRel = `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`;
  try {
    writeFileSync(join(root, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/runtime/\n', 'utf8');
    writeFileSync(join(root, 'probe.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.VALIDATION_REUSE_SMOKE_COUNTER, 'run\\n');",
      "console.log('terminal hook probe PASS');",
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(root, 'post-hook.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(processEventsRel)}, ${JSON.stringify('{"type":"postCommand_foreign_mutation"}\n')});`,
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(root, 'source.ts'), 'export const terminalHook = true;\n', 'utf8');
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: '.',
      rootDir: '.',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'light' },
      validate: {
        commands: [{
          label: 'terminal hook probe',
          command: process.execPath,
          args: ['probe.mjs'],
          timeoutMs: 10_000,
        }],
      },
      hooks: {
        postCommand: {
          validate: [`${process.execPath} post-hook.mjs`],
        },
      },
    }, null, 2), 'utf8');
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const now = '2026-07-18T00:00:00.000Z';
    const store = new StoryStore(root);
    store.writeStory(storyId, {
      storyId,
      name: 'terminal-hook',
      title: 'terminal hook',
      description: 'Proves a postCommand canonical mutation cannot be reported as a successful terminal closeout.',
      type: 'bug',
      phase: 'TEST',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      riskSignals: [],
      events: [{ phase: 'TEST', action: 'advance', timestamp: now }],
    });
    store.writeChecklist(storyId, { items: [{
      id: 'CHK-001',
      title: 'terminal hook',
      context: 'No required intents keeps current coverage complete.',
      status: 'done',
      verificationIntent: { happy: [{ desc: 'Exercise routine execution and publication behavior', type: 'logic', priority: 'should' }], edge: [], adversarial: [] },
      startTime: now,
      endTime: now,
    }] });
    const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
    assert.ok(causalInputHashes, 'Fixture certification binds actual inputs');
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
    git(root, ['add', '.proof-or-stop']);
    git(root, ['commit', '-m', 'seed story metadata']);

    const result = spawnSync(process.execPath, [cliPath(), 'validate', `--story=${storyId}`, '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROOF_OR_STOP_PROJECT_ROOT: root,
        PROOF_OR_STOP_SESSION_ID: 'validation-terminal-hook',
        PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
        VALIDATION_REUSE_SMOKE_COUNTER: counterPath,
      },
    });
    assert.notEqual(result.status, 0, 'terminal closeout failure must propagate to a nonzero CLI outcome');
    assert.match(`${result.stdout}\n${result.stderr}`, /canonical terminal persistence failed/);
    assert.doesNotMatch(result.stdout, /"status":"pass"/,
      'the original handler PASS must not be printed after terminal persistence fails');
    assert.match(readFileSync(join(root, processEventsRel), 'utf8'), /postCommand_foreign_mutation/,
      'postCommand concurrent bytes must be preserved for diagnosis');
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(counterPath, { force: true });
  }
}

function assertPhaseHookMutationFailsTransitionCloseout(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-phase-hook-'));
  const counterPath = join(tmpdir(), `proof-or-stop-validation-phase-hook-${process.pid}-${Date.now()}.log`);
  const storyId = 'B-phase-hook';
  const processEventsRel = `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`;
  try {
    writeFileSync(join(root, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/runtime/\n', 'utf8');
    writeFileSync(join(root, 'probe.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.VALIDATION_REUSE_SMOKE_COUNTER, 'run\\n');",
      "console.log('phase hook probe PASS');",
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(root, 'phase-hook.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(processEventsRel)}, ${JSON.stringify('{"type":"onPhaseChange_foreign_mutation"}\n')});`,
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(root, 'source.ts'), 'export const phaseHook = true;\n', 'utf8');
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: '.',
      rootDir: '.',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'light' },
      validate: {
        commands: [{
          label: 'phase hook probe',
          command: process.execPath,
          args: ['probe.mjs'],
          timeoutMs: 10_000,
        }],
      },
      hooks: {
        onPhaseChange: {
          'REVIEW->TEST': [`${process.execPath} phase-hook.mjs`],
        },
      },
    }, null, 2), 'utf8');
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const now = '2026-07-18T00:00:00.000Z';
    const store = new StoryStore(root);
    store.writeStory(storyId, {
      storyId,
      name: 'phase-hook',
      title: 'phase hook',
      description: 'Proves an onPhaseChange canonical mutation cannot be swept into TEST transition metadata.',
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
      title: 'phase hook',
      context: 'No required intents keeps current coverage complete.',
      status: 'done',
      verificationIntent: { happy: [{ desc: 'Exercise routine execution and publication behavior', type: 'logic', priority: 'should' }], edge: [], adversarial: [] },
      startTime: now,
      endTime: now,
    }] });
    const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
    assert.ok(causalInputHashes, 'Fixture certification binds actual inputs');
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
    git(root, ['add', '.proof-or-stop']);
    git(root, ['commit', '-m', 'seed story metadata']);
    const runCli = (args: string[]) => spawnSync(process.execPath, [cliPath(), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROOF_OR_STOP_PROJECT_ROOT: root,
        PROOF_OR_STOP_SESSION_ID: 'validation-phase-hook',
        PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
        VALIDATION_REUSE_SMOKE_COUNTER: counterPath,
      },
    });
    const seed = runCli(['validate', `--story=${storyId}`, '--json']);
    assert.equal(seed.status, 0, `${seed.stdout}\n${seed.stderr}`);
    const advance = runCli(['story_advance', JSON.stringify({ storyId, phase: 'TEST' })]);
    assert.notEqual(advance.status, 0, 'phase-hook managed mutation must fail TEST transition closeout');
    assert.match(`${advance.stdout}\n${advance.stderr}`, /TEST transition canonical metadata closeout failed/);
    assert.equal(store.readStory(storyId).phase, 'REVIEW',
      'owned index bytes must roll back so a failed transition does not claim TEST');
    assert.match(readFileSync(join(root, processEventsRel), 'utf8'), /onPhaseChange_foreign_mutation/,
      'phase-hook concurrent bytes must be preserved for diagnosis');
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, 1,
      'internal TEST gate must reuse the seeded PASS before the phase-hook failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(counterPath, { force: true });
  }
}

function assertReviewToTestTransitionLeavesExactReuseRed(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-reuse-transition-red-'));
  const counterPath = join(tmpdir(), `proof-or-stop-validation-reuse-transition-red-${process.pid}-${Date.now()}.log`);
  const storyId = 'B-reuse-transition-red';
  try {
    writeFileSync(join(root, '.gitignore'), [
      '.proof-or-stop/activity.jsonl',
      '.proof-or-stop/locks/',
      '.proof-or-stop/runtime/',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(root, 'probe.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.VALIDATION_REUSE_SMOKE_COUNTER, 'run\\n');",
      "console.log('transition reuse probe PASS');",
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(root, 'source.ts'), 'export const transitionReuse = true;\n', 'utf8');
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: '.',
      rootDir: '.',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'light' },
      validate: {
        commands: [{
          label: 'transition reuse probe',
          command: process.execPath,
          args: ['probe.mjs'],
          timeoutMs: 10_000,
        }],
      },
    }, null, 2), 'utf8');
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    const now = '2026-07-18T00:00:00.000Z';
    const store = new StoryStore(root);
    store.writeStory(storyId, {
      storyId,
      name: 'reuse-transition-red',
      title: 'reuse transition RED',
      description: 'Proves the real REVIEW to TEST transition leaves canonical metadata that blocks immediate reuse.',
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
      title: 'transition reuse RED',
      context: 'No required intents keeps current coverage complete.',
      status: 'done',
      verificationIntent: { happy: [{ desc: 'Exercise routine execution and publication behavior', type: 'logic', priority: 'should' }], edge: [], adversarial: [] },
      startTime: now,
      endTime: now,
    }] });
    const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
    assert.ok(causalInputHashes, 'Fixture certification binds actual inputs');
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
    git(root, ['add', '.proof-or-stop']);
    git(root, ['commit', '-m', 'seed story metadata']);

    const runCli = (args: string[]) => spawnSync(process.execPath, [cliPath(), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROOF_OR_STOP_PROJECT_ROOT: root,
        PROOF_OR_STOP_SESSION_ID: 'validation-reuse-transition-red',
        PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
        VALIDATION_REUSE_SMOKE_COUNTER: counterPath,
      },
    });
    const validateFailureAuditCount = () => {
      const activityPath = join(root, '.proof-or-stop/activity.jsonl');
      if (!existsSync(activityPath)) return 0;
      return readFileSync(activityPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.tool === 'validate' && event.status === 'fail').length;
    };
    const first = runCli(['validate', `--story=${storyId}`, '--json']);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(`${first.stdout}\n${first.stderr}`, /"disposition":"executed"/);
    assert.match(`${first.stdout}\n${first.stderr}`, /"commandExecutions":1/);
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, 1);

    const canonicalPaths = [
      `.proof-or-stop/story/actives/${storyId}/index.json`,
      `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`,
      `.proof-or-stop/story/actives/${storyId}/process-metrics.json`,
      `.proof-or-stop/story/actives/${storyId}/test-evidence.json`,
      `.proof-or-stop/story/actives/${storyId}/closeout-write-receipts.jsonl`,
    ];
    assert.equal(
      git(root, ['status', '--porcelain=v1', '--', ...canonicalPaths]),
      '',
      'the executed PASS and its Codex terminal event must establish a clean reusable baseline without manual commit',
    );

    const advance = runCli(['story_advance', JSON.stringify({ storyId, phase: 'TEST' })]);
    assert.equal(advance.status, 0, `${advance.stdout}\n${advance.stderr}`);
    assert.equal(store.readStory(storyId).phase, 'TEST');
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, 1,
      'internal TEST gate must reuse the fresh PASS without executing the project command');
    const preValidateStatus = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    assert.doesNotMatch(preValidateStatus, /process-events\.jsonl|process-metrics\.json|index\.json/,
      'authorized TEST transition and its Codex terminal event must close their exact canonical deltas');

    const immediate = runCli(['validate', `--story=${storyId}`, '--json']);
    assert.equal(immediate.status, 0, `${immediate.stdout}\n${immediate.stderr}`);
    const output = `${immediate.stdout}\n${immediate.stderr}`;
    assert.match(output, /"status":"pass"/);
    assert.match(output, /"disposition":"reused"/);
    assert.match(output, /"commandExecutions":0/);
    assert.doesNotMatch(output, /canonical-pass-persistence-failed/);
    assert.match(output, /routine validation reused; commandExecutions=0/);
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, 1,
      'the one-shot converged reuse must never hide a validation command rerun');
    assert.equal(
      git(root, ['status', '--porcelain=v1', '--', ...canonicalPaths]),
      '',
      'successful reused PASS and its Codex terminal event must leave canonical metadata clean',
    );

    const closeoutReceiptPath = canonicalPaths[4];
    const eventLinesBeforeRepeat = readFileSync(join(root, canonicalPaths[1]), 'utf8').trim().split('\n').filter(Boolean);
    const receiptLinesBeforeRepeat = readFileSync(join(root, closeoutReceiptPath), 'utf8').trim().split('\n').filter(Boolean);
    const phaseTransitionCountBeforeRepeat = eventLinesBeforeRepeat.filter((line) => line.includes('"type":"phase_transition"')).length;
    const headBeforeRepeat = git(root, ['rev-parse', 'HEAD']);
    const repeated = runCli(['validate', `--story=${storyId}`, '--json']);
    assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
    assert.match(`${repeated.stdout}\n${repeated.stderr}`, /"disposition":"reused"/);
    assert.match(`${repeated.stdout}\n${repeated.stderr}`, /"commandExecutions":0/);
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, 1,
      'repeated unchanged validate must remain idempotent and zero-command');
    const headAfterRepeat = git(root, ['rev-parse', 'HEAD']);
    assert.equal(git(root, ['rev-list', '--count', `${headBeforeRepeat}..${headAfterRepeat}`]), '2',
      'one repeated validate must create exactly the reused-evidence commit and its CLI terminal commit');
    const eventLinesAfterRepeat = readFileSync(join(root, canonicalPaths[1]), 'utf8').trim().split('\n').filter(Boolean);
    const receiptLinesAfterRepeat = readFileSync(join(root, closeoutReceiptPath), 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(eventLinesAfterRepeat.length, eventLinesBeforeRepeat.length + 2,
      'repeated validate must append exactly one validation_terminal and one codex_cli event');
    assert.equal(receiptLinesAfterRepeat.length, receiptLinesBeforeRepeat.length + 1,
      'repeated validate must append exactly one causal test-evidence receipt');
    assert.equal(
      eventLinesAfterRepeat.filter((line) => line.includes('"type":"phase_transition"')).length,
      phaseTransitionCountBeforeRepeat,
      'repeated validate must not duplicate lifecycle phase_transition facts',
    );
    assert.equal(git(root, ['status', '--porcelain=v1', '--', ...canonicalPaths]), '',
      'repeated validate must finish with every canonical path clean');

    store.appendProcessEvent(storyId, {
      type: 'human_confirmation',
      storyId,
      phase: 'TEST',
      command: 'human_confirmation',
      result: 'pass',
    });
    const humanBytes = readFileSync(join(root, canonicalPaths[1]), 'utf8');
    const humanAuditBefore = validateFailureAuditCount();
    const rejected = runCli(['validate', `--story=${storyId}`, '--json']);
    assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /"status":"fail"/);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /canonical metadata was already dirty/);
    assert.equal(readFileSync(join(root, canonicalPaths[1]), 'utf8'), humanBytes,
      'terminal closeout must not append to, commit, or rewrite a pre-existing human-authored managed delta');
    assert.equal(validateFailureAuditCount(), humanAuditBefore + 1,
      'dirty canonical rejection must remain durable as one failed activity audit without laundering process metadata');
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, 1,
      'pre-existing human metadata must fail closed without executing project commands');

    const committedProcessEvents = git(root, ['show', `HEAD:${canonicalPaths[1]}`]) + '\n';
    writeFileSync(join(root, canonicalPaths[1]), committedProcessEvents, 'utf8');
    assert.equal(git(root, ['status', '--porcelain=v1', '--', canonicalPaths[1]]), '');
    store.appendProcessEvent(storyId, {
      type: 'codex_cli',
      source: 'codex',
      session: 'forged-session',
      storyId,
      phase: 'TEST',
      command: 'validate',
      entrypoint: 'forged-entrypoint',
      result: 'pass',
    });
    const forgedBytes = readFileSync(join(root, canonicalPaths[1]), 'utf8');
    const forgedAuditBefore = validateFailureAuditCount();
    const forged = runCli(['validate', `--story=${storyId}`, '--json']);
    assert.equal(forged.status, 1, `${forged.stdout}\n${forged.stderr}`);
    assert.match(`${forged.stdout}\n${forged.stderr}`, /canonical metadata was already dirty/);
    assert.equal(readFileSync(join(root, canonicalPaths[1]), 'utf8'), forgedBytes,
      'a canonical-looking codex_cli row is untrusted unless this CLI invocation itself appended it');
    assert.equal(validateFailureAuditCount(), forgedAuditBefore + 1,
      'forged canonical rejection must persist one failed activity audit while preserving the foreign row byte-for-byte');
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, 1);
    assert.equal(
      git(root, ['diff', '--', 'source.ts', 'proof-or-stop.config.json', 'probe.mjs']),
      '',
      'the fixture must not create source/config dirt that could masquerade as the lifecycle metadata failure',
    );
    console.log('transition fresh-PASS GREEN: status=pass disposition=reused commandExecutions=0; human metadata fail-closed');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(counterPath, { force: true });
  }
}

function assertHandlerExecutedThenReused(
  sourceKind: 'configured' | 'fallback' | 'validate-file',
  commandCount = 1,
  semanticResult?: Record<string, unknown>,
  coverageOnlyRecovery = false,
  rejectPersistence = false,
  rejectReceipt = false,
  concurrentHead = false,
  hookAddsUnrelated = false,
  structuredFailureAudit = false,
): void {
  const root = mkdtempSync(join(tmpdir(), `proof-or-stop-validation-reuse-${sourceKind}-`));
  const counterPath = join(tmpdir(), `proof-or-stop-validation-reuse-counter-${process.pid}-${Date.now()}.log`);
  const storyId = 'B-reuse-handler';
  try {
    writeFileSync(join(root, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/runtime/\n', 'utf8');
    writeFileSync(join(root, 'probe.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.VALIDATION_REUSE_SMOKE_COUNTER, 'run\\n'); console.log('handler probe PASS');\n`, 'utf8');
    writeFileSync(join(root, 'source.ts'), 'export const handlerReuse = true;\n', 'utf8');
    writeFileSync(join(root, 'hook-unrelated.txt'), 'base\n', 'utf8');
    const configuredCommands = Array.from({ length: commandCount }, (_, index) => ({
      label: `handler probe ${index + 1}`,
      command: process.execPath,
      args: ['probe.mjs'],
      timeoutMs: 10_000,
    }));
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: '.',
      rootDir: '.',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'light' },
      ...(sourceKind === 'configured' ? { validate: { commands: configuredCommands } } : {}),
    }, null, 2), 'utf8');
    if (sourceKind === 'fallback') {
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'validation-reuse-fallback-smoke',
        private: true,
        scripts: { test: 'node probe.mjs' },
      }, null, 2), 'utf8');
    }
    if (sourceKind === 'validate-file') {
      const result = semanticResult ?? {
        provider: 'validate-file-smoke',
        status: 'pass',
        allPass: true,
        summary: 'semantic PASS',
        details: [],
        warnings: [],
      };
      writeFileSync(join(root, 'validate.ts'), [
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync(process.env.VALIDATION_REUSE_SMOKE_COUNTER!, 'run\\n');",
        `console.log(JSON.stringify(${JSON.stringify(result)}));`,
        '',
      ].join('\n'), 'utf8');
    }
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    const now = '2026-07-16T00:00:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'reuse-handler',
      title: 'reuse handler smoke',
      description: `Proves ${sourceKind} executed then metadata-descendant reuse through the real validate handler.`,
      type: 'bug',
      phase: 'TEST',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      riskSignals: structuredFailureAudit
        ? [{ category: 'state machine/gate', matched: 'gate' }]
        : [],
      events: [{ phase: 'TEST', action: 'advance', timestamp: now }],
    };
    const checklist: ChecklistData = { items: [{
      id: 'CHK-001',
      title: 'handler reuse',
      context: 'No required intents keeps current coverage complete for the smoke.',
      status: 'done',
      verificationIntent: { happy: [{ desc: 'Exercise routine execution and publication behavior', type: 'logic', priority: 'should' }], edge: [], adversarial: [] },
      startTime: now,
      endTime: now,
      ...(structuredFailureAudit ? {
        verificationIntent: {
          happy: [{ desc: 'semantic validator must report PASS', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [],
      } : {}),
    }] };
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);
    if (structuredFailureAudit) {
      store.appendProcessEvent(storyId, {
        type: 'phase_transition',
        storyId,
        phase: 'TEST',
        command: 'story_advance',
        result: 'pass',
      });
    }
    const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
    assert.ok(causalInputHashes, 'Fixture certification binds actual inputs');
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
    git(root, ['add', '.proof-or-stop']);
    git(root, ['commit', '-m', 'seed story metadata']);

    const runWith = (extraEnv: Record<string, string> = {}) => spawnSync(process.execPath, [cliPath(), 'validate', `--story=${storyId}`, '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root, PROOF_OR_STOP_SESSION_ID: 'validation-reuse-smoke', VALIDATION_REUSE_SMOKE_COUNTER: counterPath, ...extraEnv },
    });
    const semanticPass = sourceKind !== 'validate-file'
      || semanticResult === undefined
      || (String(semanticResult.status ?? '').trim().toLowerCase() === 'pass'
        && semanticResult.allPass !== false
        && semanticResult.allPassed !== false);
    const directTransport = { CI: 'true', _: '/usr/bin/node', OLDPWD: '/direct/launcher', SHLVL: '1', PWD: '/direct/launcher' };
    const wrapperTransport = { CI: 'true', _: '/bin/zsh', OLDPWD: '/live-smoke/wrapper', SHLVL: '9', PWD: '/live-smoke/wrapper' };
    const run = () => runWith({
      ...directTransport,
      ...(structuredFailureAudit ? { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' } : {}),
    });
    const first = run();
    assert.equal(first.status, semanticPass ? 0 : 1, `${first.stdout}\n${first.stderr}`);
    assert.match(`${first.stdout}\n${first.stderr}`, /"disposition":"executed"/);
    if (sourceKind === 'configured' || sourceKind === 'fallback') {
      assert.match(
        `${first.stdout}\n${first.stderr}`,
        /ran:/,
        `${sourceKind} execution must retain per-command ran audit logs`,
      );
    }
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, commandCount);
    if (structuredFailureAudit) {
      const processEventsPath = join(root, '.proof-or-stop/story/actives', storyId, 'process-events.jsonl');
      const processEventBytes = existsSync(processEventsPath) ? readFileSync(processEventsPath, 'utf8') : '';
      const failureEvents = processEventBytes
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.type === 'codex_cli' && event.command === 'validate' && event.result === 'fail');
      assert.equal(failureEvents.length, 1,
        `one structured validate failure must persist exactly one codex_cli failure event\n${first.stdout}\n${first.stderr}\n${processEventBytes}`);
      assert.equal(git(root, ['status', '--porcelain=v1', '--', '.proof-or-stop/story/actives/' + storyId + '/process-events.jsonl']), '',
        'the structured failure terminal event must be durably committed at a clean canonical boundary');
    }
    // Simulate the trusted checklist verificationEvidence refresh that followed
    // B-19ca's command PASS. Some runtime audit rows intentionally remain after
    // the evidence auto-commit; committing those metadata-only rows establishes
    // the clean descendant on which reuse is decided.
    if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
      git(root, ['add', '.proof-or-stop']);
      git(root, ['commit', '-m', 'refresh checklist verificationEvidence metadata']);
    }
    const evidencePath = join(root, '.proof-or-stop/story/actives', storyId, 'test-evidence.json');
    const evidenceBefore = readFileSync(evidencePath, 'utf8');
    const parsedEvidence = JSON.parse(evidenceBefore) as TestEvidenceData;
    const renewFixtureAdmission = () => {
      const freshInputs = deriveCertificationDomainInputHashes(root, 'HEAD', root);
      assert.ok(freshInputs, 'Disposable fixture must classify current inputs');
      persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes: freshInputs });
      git(root, ['add', store.storyFilePath(storyId, 'certification-window.json')]);
      git(root, ['commit', '-m', 'prepare explicit synthetic admission for next test execution']);
    };
    if (!semanticPass) {
      renewFixtureAdmission();
      assert.equal(parsedEvidence.commandExecution?.status, 'FAIL', 'non-PASS semantic JSON must record commandExecution FAIL');
      const secondFailure = run();
      assert.equal(secondFailure.status, 1, `${secondFailure.stdout}\n${secondFailure.stderr}`);
      assert.match(`${secondFailure.stdout}\n${secondFailure.stderr}`, /"disposition":"executed"/);
      const expectedRefusalReasons = structuredFailureAudit
        ? 'current-verification-coverage-incomplete,prior-command-execution-not-pass'
        : parsedEvidence.result === 'PASS'
          ? 'prior-command-execution-not-pass'
          : 'prior-command-execution-not-pass,prior-overall-result-not-reusable';
      assert.match(
        `${secondFailure.stdout}\n${secondFailure.stderr}`,
        new RegExp(
          `routine validation reuse refused: refusalReasons=${expectedRefusalReasons} `
          + `priorIdentityDigest=${parsedEvidence.routineValidationIdentity?.digest} `
          + `currentIdentityDigest=${parsedEvidence.routineValidationIdentity?.digest}`,
        ),
        'refused reuse must expose stable reasons and only identity digests',
      );
      assert.doesNotMatch(
        `${secondFailure.stdout}\n${secondFailure.stderr}`,
        /VALIDATION_REUSE_SMOKE_COUNTER=/,
        'reuse refusal diagnostics must not expose raw environment values',
      );
      assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, commandCount * 2, 'semantic validator non-PASS must never reuse');
      return;
    }
    if (coverageOnlyRecovery) {
      parsedEvidence.result = 'FAIL';
      parsedEvidence.verificationCoverage = {
        total: 1,
        required: 1,
        covered: 0,
        missingRequired: 1,
        entries: [],
      };
      // This is an explicit trusted fixture for a coverage-only failure, not a
      // tamper negative control: authenticate its changed aggregate fields.
      store.writeTestEvidence(storyId, signTestValidationEvidence(storyId, parsedEvidence, root));
      git(root, ['add', '.proof-or-stop']);
      git(root, ['commit', '-m', 'record coverage-only validation failure before evidence refresh']);
    }
    const managedPaths = [
      `.proof-or-stop/story/actives/${storyId}/closeout-write-receipts.jsonl`,
      `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`,
      `.proof-or-stop/story/actives/${storyId}/test-evidence.json`,
    ];
    if (rejectReceipt) {
      writeFileSync(join(root, managedPaths[0]), 'malformed receipt ledger\n', 'utf8');
      git(root, ['add', '--', managedPaths[0]]);
      git(root, ['commit', '-m', 'commit malformed receipt ledger for strict writer rejection']);
    }
    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const unrelatedPath = '.proof-or-stop/story/actives/B-unrelated/index.json';
    mkdirSync(dirname(join(root, unrelatedPath)), { recursive: true });
    writeFileSync(join(root, unrelatedPath), '{"unrelated":"pre-staged"}\n', 'utf8');
    git(root, ['add', '--', unrelatedPath]);
    const unrelatedIndexBefore = git(root, ['ls-files', '--stage', '--', unrelatedPath]);
    const managedIndexBefore = git(root, ['ls-files', '--stage', '--', ...managedPaths]);
    const managedWorktreeBefore = managedPaths.map((path) => ({
      path,
      exists: existsSync(join(root, path)),
      bytes: existsSync(join(root, path)) ? readFileSync(join(root, path)) : null,
    }));
    const statusBefore = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (rejectPersistence) {
      const hook = join(root, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\nexit 1\n', 'utf8');
      chmodSync(hook, 0o755);
    }
    if (concurrentHead) {
      const hook = join(root, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, [
        '#!/bin/sh',
        'old=$(git rev-parse HEAD)',
        'tree=$(git rev-parse HEAD^{tree})',
        'commit=$(printf "concurrent advancement\\n" | git commit-tree "$tree" -p "$old")',
        'git update-ref "$(git symbolic-ref HEAD)" "$commit" "$old"',
        '',
      ].join('\n'), 'utf8');
      chmodSync(hook, 0o755);
      const postHook = join(root, '.git', 'hooks', 'post-commit');
      writeFileSync(postHook, '#!/bin/sh\nprintf "ran\\n" >> post-commit-marker\n', 'utf8');
      chmodSync(postHook, 0o755);
    }
    if (hookAddsUnrelated) {
      const hook = join(root, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\nprintf "hook mutation\\n" > hook-unrelated.txt\ngit add -- hook-unrelated.txt\n', 'utf8');
      chmodSync(hook, 0o755);
    }

    const second = runWith(wrapperTransport);
    assert.equal(second.status, rejectPersistence || rejectReceipt || concurrentHead || hookAddsUnrelated ? 1 : 0, `${second.stdout}\n${second.stderr}`);
    if (rejectPersistence || rejectReceipt || concurrentHead || hookAddsUnrelated) {
      assert.match(`${second.stdout}\n${second.stderr}`, /"status":"fail"/);
      assert.match(`${second.stdout}\n${second.stderr}`, /canonical-pass-persistence-failed/);
      if (rejectReceipt) assert.match(`${second.stdout}\n${second.stderr}`, /closeout-write-receipts\.jsonl: malformed line 1/);
      if (concurrentHead) assert.match(`${second.stdout}\n${second.stderr}`, /HEAD changed before isolated metadata commit CAS/);
      if (hookAddsUnrelated) assert.match(`${second.stdout}\n${second.stderr}`, /isolated index paths do not exactly match/);
      assert.doesNotMatch(`${second.stdout}\n${second.stderr}`, /"disposition":"reused"/);
      assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, commandCount, 'persistence failure must not rerun project commands');
      const failureHead = git(root, ['rev-parse', 'HEAD']);
      if (concurrentHead) {
        assert.notEqual(failureHead, headBefore, 'CAS refusal must preserve the concurrent HEAD advancement');
        assert.equal(git(root, ['show', '-s', '--format=%s', 'HEAD']), 'concurrent advancement');
        assert.equal(existsSync(join(root, 'post-commit-marker')), false, 'post-commit must not run when CAS fails');
      } else {
        assert.equal(failureHead, headBefore, 'failed canonical writer must not move HEAD');
      }
      const committedEvidence = JSON.parse(git(root, ['show', `${headBefore}:.proof-or-stop/story/actives/${storyId}/test-evidence.json`])) as TestEvidenceData;
      assert.equal(committedEvidence.result, coverageOnlyRecovery ? 'FAIL' : 'PASS', 'failed writer must not publish a new canonical PASS commit');
      assert.equal(store.readTestEvidence(storyId)?.result, coverageOnlyRecovery ? 'FAIL' : 'PASS', 'failed writer must restore the prior canonical working-tree evidence');
      assert.equal(git(root, ['ls-files', '--stage', '--', ...managedPaths]), managedIndexBefore, 'failed writer must restore every managed index entry exactly');
      assert.equal(git(root, ['ls-files', '--stage', '--', unrelatedPath]), unrelatedIndexBefore, 'failed writer must preserve unrelated pre-staged index entries');
      for (const prior of managedWorktreeBefore) {
        assert.equal(existsSync(join(root, prior.path)), prior.exists, `${prior.path} existence must roll back exactly`);
        if (prior.bytes) assert.deepEqual(readFileSync(join(root, prior.path)), prior.bytes, `${prior.path} bytes must roll back exactly`);
      }
      return;
    }
    assert.match(`${second.stdout}\n${second.stderr}`, /"disposition":"reused"/);
    assert.match(`${second.stdout}\n${second.stderr}`, /"commandExecutions":0/);
    assert.match(`${second.stdout}\n${second.stderr}`, /trusted-story-metadata-descendant/);
    assert.match(`${second.stdout}\n${second.stderr}`, /routine validation reused; commandExecutions=0/);
    assert.doesNotMatch(
      `${second.stdout}\n${second.stderr}`,
      /ran:/,
      'reuse must not claim that any validation command ran',
    );
    if (sourceKind === 'validate-file') {
      assert.doesNotMatch(
        `${second.stdout}\n${second.stderr}`,
        /running: npx tsx/,
        'validate-file reuse must not claim that the validator is running',
      );
    }
    assert.doesNotMatch(
      `${second.stdout}\n${second.stderr}`,
      /routine validation reuse refused:/,
      'successful reuse must not emit refusal diagnostics',
    );
    assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, commandCount, 'reuse must invoke zero project commands');
    const reusedEvidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as TestEvidenceData;
    assert.equal(reusedEvidence.result, 'PASS', 'real reused handler path must persist canonical PASS evidence');
    assert.equal(reusedEvidence.disposition, 'reused', 'canonical PASS must identify zero-command reuse');
    assert.equal(reusedEvidence.verificationCoverage?.missingRequired, 0, 'canonical PASS must bind refreshed complete coverage');
    assert.equal(reusedEvidence.commandExecution?.status, 'PASS', 'canonical PASS must retain prior command execution proof');
    assert.notEqual(readFileSync(evidencePath, 'utf8'), evidenceBefore, 'real reused handler path must refresh canonical evidence');
    const headAfter = git(root, ['rev-parse', 'HEAD']);
    assert.notEqual(headAfter, headBefore, 'real reused handler path must commit canonical PASS');
    assert.deepEqual(
      git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', headAfter]).split('\n').filter(Boolean).sort(),
      managedPaths,
      'successful canonical reuse must commit exactly evidence, terminal, and closeout receipt',
    );
    assert.equal(git(root, ['status', '--porcelain=v1', '--', ...managedPaths]), '', 'successful canonical reuse must leave no managed worktree/index dirt');
    assert.equal(git(root, ['ls-files', '--stage', '--', unrelatedPath]), unrelatedIndexBefore, 'successful canonical reuse must preserve unrelated pre-staged index entries');
    const statusAfter = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    assert.deepEqual(
      statusAfter.split('\n').filter(Boolean).filter((line) => !line.includes('/owner-lease.json')),
      statusBefore.split('\n').filter(Boolean).filter((line) => !line.includes('/owner-lease.json')),
      'real reused handler path must not create any dirty path beyond the CLI owner heartbeat',
    );

    // B-3434 F-055: the persisted `.command` is a gate contract, not a label.
    // assessStoredValidationPassAdmissibility compares this exact field against
    // the command the phase gate expects and answers `command_mismatch` for any
    // other value — which silently disables reuse. Nothing above ever read
    // `.command`, so a stale command string stayed green here.
    //
    // The expected value is NOT restated in this file. The gate builds it
    // internally from the storyId, so this asserts the written record against
    // the gate's own expression; a production rename cannot leave a second,
    // stale copy passing here.
    const gateContext = { store, root, scanRoot: root } as HandlerContext;
    assert.equal(
      assessStoredValidationPassAdmissibility(gateContext, storyId).reasonCodes.includes('command_mismatch'),
      false,
      `canonical reused evidence command ${JSON.stringify(reusedEvidence.command)} must be the command the phase gate accepts`,
    );
    // Bite: prove that check can observe a wrong command in THIS fixture rather
    // than passing vacuously. The canonical bytes are restored immediately.
    const canonicalEvidenceBytes = readFileSync(evidencePath, 'utf8');
    writeFileSync(
      evidencePath,
      JSON.stringify({ ...reusedEvidence, command: `${reusedEvidence.command} --stale` }, null, 2),
      'utf8',
    );
    assert.ok(assessStoredValidationPassAdmissibility(gateContext, storyId).reasonCodes.includes('validation_evidence_signature_invalid'), 'Unsigned command tamper must fail signature verification first');
    writeFileSync(evidencePath, JSON.stringify(signTestValidationEvidence(storyId, { ...reusedEvidence, command: `${reusedEvidence.command} --stale` }, root), null, 2), 'utf8');
    assert.ok(
      assessStoredValidationPassAdmissibility(gateContext, storyId).reasonCodes.includes('command_mismatch'),
      'mutation bite: a wrong persisted command must be reported as command_mismatch by the same gate call',
    );
    writeFileSync(evidencePath, canonicalEvidenceBytes, 'utf8');
    assert.equal(
      readFileSync(evidencePath, 'utf8'),
      canonicalEvidenceBytes,
      'the command mutation bite must restore the canonical evidence bytes exactly',
    );
    assert.equal(
      git(root, ['status', '--porcelain=v1', '--', ...managedPaths]),
      '',
      'the command mutation bite must leave no managed worktree/index dirt behind',
    );

    if (sourceKind === 'configured' && commandCount === 1) {
      const exhaustedEnvironmentChange = runWith({ ...wrapperTransport, CI: 'false' });
      assert.equal(exhaustedEnvironmentChange.status, 1);
      assert.match(exhaustedEnvironmentChange.stderr, /pre_cert_window_already_consumed/);
      assert.match(exhaustedEnvironmentChange.stderr, /validation-identity-changed/);
      assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, commandCount, 'Changed environment cannot reuse old PASS or bypass consumed admission');
      renewFixtureAdmission();
      const semanticEnvironmentChange = runWith({ ...wrapperTransport, CI: 'false' });
      assert.equal(semanticEnvironmentChange.status, 0, `${semanticEnvironmentChange.stdout}\n${semanticEnvironmentChange.stderr}`);
      assert.match(`${semanticEnvironmentChange.stdout}\n${semanticEnvironmentChange.stderr}`, /"disposition":"executed"/);
      assert.match(
        `${semanticEnvironmentChange.stdout}\n${semanticEnvironmentChange.stderr}`,
        /refusalReasons=validation-identity-changed/,
        'behavior-affecting ambient environment changes must execute instead of reuse',
      );
      assert.equal(readFileSync(counterPath, 'utf8').trim().split('\n').length, commandCount + 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(counterPath, { force: true });
  }
}

const coverage: VerificationCoverageReport = {
  total: 1,
  required: 1,
  covered: 1,
  missingRequired: 0,
  entries: [{
    intentRef: 'CHK-001:happy:0',
    itemId: 'CHK-001',
    lane: 'happy',
    desc: 'commands remain unchanged',
    type: 'logic',
    priority: 'must',
    status: 'covered',
  }],
};

function identity(root: string, sourceKind: RoutineValidationSourceKind, commands: ValidationCommand[], overrides: Partial<{
  full: boolean | string;
  focus: string;
  profile: string;
  policy: unknown;
  sourceInputs: unknown;
  entrypointPath: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}> = {}): RoutineValidationIdentity {
  return buildRoutineValidationIdentity({
    projectRoot: root,
    sourceKind,
    sourceInputs: overrides.sourceInputs ?? { sourceKind },
    commands,
    ...(overrides.full !== undefined ? { full: overrides.full } : {}),
    ...(overrides.focus ? { focus: overrides.focus } : {}),
    profile: overrides.profile ?? 'strict',
    verificationPolicyInputs: overrides.policy ?? { required: ['CHK-001:happy:0'], workflow: 'strict' },
    ...(overrides.entrypointPath ? { entrypointPath: overrides.entrypointPath } : {}),
    processEnvironment: overrides.env ?? { PATH: process.env.PATH, VALIDATION_SECRET: 'smoke-secret-value' },
    ...(overrides.platform ? { platform: overrides.platform } : {}),
  });
}

function main(): void {
  if (process.env.VALIDATION_REUSE_SMOKE_F009_ONLY === '1') {
    assertHandlerExecutedThenReused('validate-file', 1, {
      provider: 'validate-file-smoke',
      status: 'fail',
      allPass: true,
    }, false, false, false, false, false, true);
    console.log('validation-evidence-reuse-smoke F-009 PASS (structured validate failure audit)');
    return;
  }
  assertLifecycleMetadataTransactionBoundaries();
  assertPostCommandHookMutationFailsTerminalCloseout();
  assertPhaseHookMutationFailsTransitionCloseout();
  assertReviewToTestTransitionLeavesExactReuseRed();
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-reuse-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', requirementsDir: 'docs/requirements' }), 'utf8');
    writeFileSync(join(root, 'validate.ts'), 'console.log("pass")\n', 'utf8');
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n', 'utf8');
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    const baseHead = git(root, ['rev-parse', 'HEAD']);

    const baseCommand: ValidationCommand = {
      label: 'root full test suite',
      command: 'node',
      args: ['--test'],
      cwd: '.',
      env: { VALIDATION_MODE: 'strict' },
      timeoutMs: 1_200_000,
      optional: false,
      focus: ['full'],
    };

    for (const sourceKind of ['configured', 'fallback', 'validate-file'] as const) {
      const first = identity(root, sourceKind, [baseCommand], sourceKind === 'validate-file' ? { entrypointPath: join(root, 'validate.ts') } : {});
      const second = identity(root, sourceKind, [baseCommand], sourceKind === 'validate-file' ? { entrypointPath: join(root, 'validate.ts') } : {});
      assert.equal(first.digest, second.digest, `${sourceKind} identity must be deterministic`);
      assert.equal(isCompleteRoutineValidationIdentity(first), true);
    }

    const configured = identity(root, 'configured', [baseCommand]);
    const directWrapperIdentity = identity(root, 'configured', [baseCommand], {
      env: {
        PATH: process.env.PATH,
        CI: 'true',
        _: '/usr/bin/node',
        OLDPWD: '/direct/launcher',
        SHLVL: '1',
        PWD: '/direct/launcher',
      },
    });
    const liveSmokeWrapperIdentity = identity(root, 'configured', [baseCommand], {
      env: {
        PATH: process.env.PATH,
        CI: 'true',
        _: '/bin/zsh',
        OLDPWD: '/live-smoke/wrapper',
        SHLVL: '9',
        PWD: '/live-smoke/wrapper',
      },
    });
    assert.equal(
      liveSmokeWrapperIdentity.digest,
      directWrapperIdentity.digest,
      'direct CLI and shell/live-smoke wrapper transport fields must share one identity',
    );
    assert.notEqual(
      identity(root, 'configured', [baseCommand], { env: { PATH: process.env.PATH, CI: 'false' } }).digest,
      identity(root, 'configured', [baseCommand], { env: { PATH: process.env.PATH, CI: 'true' } }).digest,
      'behavior-affecting ambient environment changes must invalidate identity',
    );
    assert.notEqual(
      identity(root, 'configured', [{ ...baseCommand, env: { SHLVL: '1' } }]).digest,
      identity(root, 'configured', [{ ...baseCommand, env: { SHLVL: '2' } }]).digest,
      'explicit command.env overlay remains semantic even for a transport-named key',
    );
    const winPathA = join(root, 'win-path-a');
    const winPathB = join(root, 'win-path-b');
    mkdirSync(winPathA, { recursive: true });
    mkdirSync(winPathB, { recursive: true });
    writeFileSync(join(winPathA, 'validation-tool.CMD'), 'tool-a-cmd\n', 'utf8');
    writeFileSync(join(winPathB, 'validation-tool.CMD'), 'tool-b-cmd\n', 'utf8');
    writeFileSync(join(winPathB, 'validation-tool.EXE'), 'tool-b-exe\n', 'utf8');
    const winCommand: ValidationCommand = {
      ...baseCommand,
      command: 'validation-tool',
      args: [],
      env: { Path: winPathB, Pathext: '.EXE;.CMD' },
    };
    const winOverlayWins = identity(root, 'configured', [winCommand], {
      platform: 'win32',
      env: { Path: winPathA, PATH: winPathA, PATHEXT: '.CMD;.EXE', CI: 'true' },
    });
    const winOverlayDifferentExecutable = identity(root, 'configured', [{
      ...winCommand,
      env: { PATH: winPathA, PATHEXT: '.CMD;.EXE' },
    }], {
      platform: 'win32',
      env: { Path: winPathB, PATH: winPathB, PATHEXT: '.EXE;.CMD', CI: 'true' },
    });
    assert.notEqual(
      winOverlayWins.commands[0]?.executableDigest,
      winOverlayDifferentExecutable.commands[0]?.executableDigest,
      'win32 Path/PATH canonicalization must resolve the executable from the explicit overlay',
    );
    assert.notEqual(
      winOverlayWins.digest,
      winOverlayDifferentExecutable.digest,
      'a win32 explicit PATH overlay selecting a different executable must invalidate identity',
    );
    const winPathextCmd = identity(root, 'configured', [{
      ...winCommand,
      env: { PATH: winPathB, PATHEXT: '.CMD' },
    }], { platform: 'win32', env: { PATH: winPathB, PATHEXT: '.EXE', CI: 'true' } });
    assert.notEqual(
      winOverlayWins.commands[0]?.executableDigest,
      winPathextCmd.commands[0]?.executableDigest,
      'win32 PATHEXT overlay order/content must select and bind the executable actually resolved',
    );
    assert.notEqual(
      winOverlayWins.digest,
      winPathextCmd.digest,
      'win32 PATHEXT changes must invalidate identity',
    );
    const winExplicitExtension = identity(root, 'configured', [{
      ...winCommand,
      command: 'validation-tool.CMD',
      env: { PATH: winPathB, PATHEXT: '.EXE' },
    }], { platform: 'win32', env: { PATH: winPathB, PATHEXT: '.EXE', CI: 'true' } });
    assert.equal(
      winExplicitExtension.commands[0]?.executableDigest,
      winPathextCmd.commands[0]?.executableDigest,
      'a win32 command with an explicit extension must resolve directly without PATHEXT substitution',
    );
    const winAmbientCollisionA = identity(root, 'configured', [baseCommand], {
      platform: 'win32',
      env: { Path: winPathA, PATH: winPathB, CI: 'true' },
    });
    const winAmbientCollisionB = identity(root, 'configured', [baseCommand], {
      platform: 'win32',
      env: { PATH: winPathB, Path: winPathA, CI: 'true' },
    });
    assert.equal(
      winAmbientCollisionA.digest,
      winAmbientCollisionB.digest,
      'win32 duplicate ambient keys are deterministically deduplicated independent of insertion order',
    );
    const driveAbsoluteLookup = buildValidationExecutableLookup(
      'C:\\tools\\validator',
      { PATH: 'D:\\path-only', PATHEXT: '.EXE;.CMD' },
      'win32',
    );
    assert.deepEqual(driveAbsoluteLookup, {
      kind: 'explicit',
      absolute: true,
      commandCandidates: ['C:\\tools\\validator', 'C:\\tools\\validator.EXE', 'C:\\tools\\validator.CMD'],
    }, 'win32 drive-absolute commands are explicit and never search PATH');
    const uncLookup = buildValidationExecutableLookup(
      '\\\\server\\share\\validator',
      { PATH: 'D:\\path-only', PATHEXT: '.CMD' },
      'win32',
    );
    assert.deepEqual(uncLookup, {
      kind: 'explicit',
      absolute: true,
      commandCandidates: ['\\\\server\\share\\validator', '\\\\server\\share\\validator.CMD'],
    }, 'win32 UNC commands are explicit absolute and retain PATHEXT candidates');
    assert.deepEqual(
      buildValidationExecutableLookup('validator', { PATH: 'D:\\bin', PATHEXT: '.CMD' }, 'win32'),
      { kind: 'path-search', absolute: false, commandCandidates: ['validator', 'validator.CMD'] },
      'a bare win32 command alone uses PATH search',
    );
    assert.deepEqual(
      buildValidationExecutableLookup('tools\\validator', { PATH: 'D:\\bin', PATHEXT: '.CMD' }, 'win32'),
      { kind: 'explicit', absolute: false, commandCandidates: ['tools\\validator', 'tools\\validator.CMD'] },
      'a relative win32 command with separators is explicit, not PATH-searchable',
    );
    const winCommandCwd = join(root, 'win-command-cwd');
    const winCommandTools = join(winCommandCwd, 'tools');
    const winPathOnly = join(root, 'win-path-only');
    mkdirSync(winCommandTools, { recursive: true });
    mkdirSync(winPathOnly, { recursive: true });
    const explicitValidator = join(winCommandTools, 'validator.CMD');
    writeFileSync(explicitValidator, 'cwd-explicit-v1\n', 'utf8');
    writeFileSync(join(winPathOnly, 'validator.CMD'), 'path-bare-binary\n', 'utf8');
    const winExplicitRelative = identity(root, 'configured', [{
      ...baseCommand,
      command: '.\\tools\\validator',
      args: [],
      cwd: 'win-command-cwd',
      env: { PATH: winPathOnly, PATHEXT: '.CMD' },
    }], { platform: 'win32', env: { PATH: winPathOnly, PATHEXT: '.CMD', CI: 'true' } });
    const winExplicitWithExtension = identity(root, 'configured', [{
      ...baseCommand,
      command: 'tools\\validator.CMD',
      args: [],
      cwd: 'win-command-cwd',
      env: { PATH: winPathOnly, PATHEXT: '.EXE' },
    }], { platform: 'win32', env: { PATH: winPathOnly, PATHEXT: '.EXE', CI: 'true' } });
    const winExplicitSlash = identity(root, 'configured', [{
      ...baseCommand,
      command: './tools/validator',
      args: [],
      cwd: 'win-command-cwd',
      env: { PATH: winPathOnly, PATHEXT: '.CMD' },
    }], { platform: 'win32', env: { PATH: winPathOnly, PATHEXT: '.CMD', CI: 'true' } });
    const winBarePathBinary = identity(root, 'configured', [{
      ...baseCommand,
      command: 'validator',
      args: [],
      cwd: 'win-command-cwd',
      env: { PATH: winPathOnly, PATHEXT: '.CMD' },
    }], { platform: 'win32', env: { PATH: winPathOnly, PATHEXT: '.CMD', CI: 'true' } });
    assert.equal(
      winExplicitRelative.commands[0]?.executableDigest,
      winExplicitWithExtension.commands[0]?.executableDigest,
      'win32 cwd-relative backslash paths bind the explicit file with and without PATHEXT',
    );
    assert.equal(
      winExplicitRelative.commands[0]?.executableDigest,
      winExplicitSlash.commands[0]?.executableDigest,
      'win32 cwd-relative slash paths retain the explicit-path envelope',
    );
    assert.notEqual(
      winExplicitRelative.commands[0]?.executableDigest,
      winBarePathBinary.commands[0]?.executableDigest,
      'an explicit win32 path must not bind a same-name binary found through PATH',
    );
    writeFileSync(explicitValidator, 'cwd-explicit-v2\n', 'utf8');
    const winExplicitChanged = identity(root, 'configured', [{
      ...baseCommand,
      command: '.\\tools\\validator',
      args: [],
      cwd: 'win-command-cwd',
      env: { PATH: winPathOnly, PATHEXT: '.CMD' },
    }], { platform: 'win32', env: { PATH: winPathOnly, PATHEXT: '.CMD', CI: 'true' } });
    assert.notEqual(winExplicitRelative.commands[0]?.executableDigest, winExplicitChanged.commands[0]?.executableDigest);
    assert.notEqual(winExplicitRelative.digest, winExplicitChanged.digest, 'explicit win32 path content changes invalidate identity');
    const variations = [
      identity(root, 'configured', [{ ...baseCommand, args: ['--test', 'changed'] }]),
      identity(root, 'configured', [{ ...baseCommand, cwd: 'nested' }]),
      identity(root, 'configured', [{ ...baseCommand, env: { VALIDATION_MODE: 'changed' } }]),
      identity(root, 'configured', [{ ...baseCommand, timeoutMs: 10 }]),
      identity(root, 'configured', [{ ...baseCommand, optional: true }]),
      identity(root, 'configured', [{ ...baseCommand, focus: ['fast'] }]),
      identity(root, 'configured', [baseCommand], { full: 'changed' }),
      identity(root, 'configured', [baseCommand], { focus: 'fast' }),
      identity(root, 'configured', [baseCommand], { profile: 'light' }),
      identity(root, 'configured', [baseCommand], { policy: { required: ['different'] } }),
      identity(root, 'configured', [baseCommand], { sourceInputs: { configured: 'changed' } }),
      identity(root, 'configured', [baseCommand], { env: { PATH: process.env.PATH, VALIDATION_SECRET: 'changed-secret' } }),
    ];
    for (const changed of variations) assert.notEqual(changed.digest, configured.digest, 'each behavior-affecting input must invalidate identity');
    assert.equal(JSON.stringify(configured).includes('smoke-secret-value'), false, 'raw effective environment secret must not be persisted');

    const commandExecution = summarizeRoutineCommandExecution([{
      label: baseCommand.label,
      command: baseCommand.command,
      args: baseCommand.args,
      code: 0,
      output: '',
      durationMs: 1,
    }], 1);
    assert.equal(summarizeRoutineCommandExecution([{
      label: 'polluting optional command',
      command: 'node',
      args: [],
      optional: true,
      code: 0,
      output: '',
      durationMs: 1,
      worktreePollution: { statusLines: [' M source.ts'], paths: ['source.ts'], blocking: true },
    }], 1).status, 'FAIL', 'blocking validation side effects are command-execution failure, not coverage-only failure');
    const evidence: TestEvidenceData = {
      command: 'proof-or-stop validate --story=B-19ca --json',
      output: '{}',
      result: 'FAIL', // coverage-only historical FAIL is intentionally reusable.
      timestamp: '2026-07-16T00:00:00.000Z',
      headHash: baseHead,
      materialHash: 'material',
      storyFilesHash: 'story-files',
      verificationCoverage: { ...coverage, covered: 0, missingRequired: 1 },
      routineValidationIdentity: configured,
      commandExecution,
      disposition: 'executed',
    };
    const evidencePath = join(root, 'evidence-copy.json');
    writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
    const beforeBytes = readFileSync(evidencePath, 'utf8');
    const exact = evaluateRoutineValidationReuse({
      root,
      gitCwd: root,
      evidence,
      currentIdentity: configured,
      currentCoverage: coverage,
      currentMaterialHash: 'material',
      currentStoryFilesHash: 'story-files',
      clean: true,
      headBefore: baseHead,
      headAfter: baseHead,
    });
    assert.equal(exact.reusable, true, 'coverage-only overall FAIL must reuse prior structured command PASS after coverage repair');
    assert.equal(exact.lineage, 'exact-head');
    assert.equal(readFileSync(evidencePath, 'utf8'), beforeBytes, 'reuse classifier must not rewrite evidence');
    assert.equal(git(root, ['rev-parse', 'HEAD']), baseHead, 'reuse classifier must not move HEAD');

    const semanticFailureExecution = summarizeRoutineCommandExecution([{
      label: baseCommand.label,
      command: baseCommand.command,
      args: baseCommand.args,
      code: 0,
      output: '',
      durationMs: 1,
    }], 1, { semanticPass: false });
    const invalidCommandExecutionRows: Array<[string, Record<string, unknown>]> = [
      ['schema mismatch', { ...commandExecution, schema: 'proofOrStop.legacy-command-execution' }],
      ['schema missing', { ...commandExecution, schema: undefined }],
      ['version mismatch', { ...commandExecution, version: 2 }],
      ['version missing', { ...commandExecution, version: undefined }],
      ['status FAIL', { ...commandExecution, status: 'FAIL' }],
      ['status unknown', { ...commandExecution, status: 'WARN' }],
      ['status missing', { ...commandExecution, status: undefined }],
      ['complete false', { ...commandExecution, complete: false }],
      ['complete missing', { ...commandExecution, complete: undefined }],
      ['commandCount zero', { ...commandExecution, commandCount: 0 }],
      ['commandCount mismatch', { ...commandExecution, commandCount: 2 }],
      ['commandCount negative', { ...commandExecution, commandCount: -1 }],
      ['commandCount fractional', { ...commandExecution, commandCount: 1.5 }],
      ['commandCount wrong type', { ...commandExecution, commandCount: '1' }],
      ['commandCount missing', { ...commandExecution, commandCount: undefined }],
      ['requiredFailureCount nonzero', { ...commandExecution, requiredFailureCount: 1 }],
      ['requiredFailureCount negative', { ...commandExecution, requiredFailureCount: -1 }],
      ['requiredFailureCount fractional', { ...commandExecution, requiredFailureCount: 0.5 }],
      ['requiredFailureCount wrong type', { ...commandExecution, requiredFailureCount: '0' }],
      ['requiredFailureCount missing', { ...commandExecution, requiredFailureCount: undefined }],
      ['optionalFailureCount nonzero', { ...commandExecution, optionalFailureCount: 1 }],
      ['optionalFailureCount negative', { ...commandExecution, optionalFailureCount: -1 }],
      ['optionalFailureCount fractional', { ...commandExecution, optionalFailureCount: 0.5 }],
      ['optionalFailureCount wrong type', { ...commandExecution, optionalFailureCount: '0' }],
      ['optionalFailureCount missing', { ...commandExecution, optionalFailureCount: undefined }],
      ['failureKind validation', { ...commandExecution, failureKind: 'validation_failure' }],
      ['failureKind infra', { ...commandExecution, failureKind: 'infra_failure' }],
      ['failureKind unknown', { ...commandExecution, failureKind: 'unknown_failure' }],
      ['semanticPass false summary', semanticFailureExecution],
    ];
    for (const [label, invalidCommandExecution] of invalidCommandExecutionRows) {
      const result = evaluateRoutineValidationReuse({
        root,
        gitCwd: root,
        evidence: {
          ...evidence,
          commandExecution: invalidCommandExecution as unknown as NonNullable<TestEvidenceData['commandExecution']>,
        },
        currentIdentity: configured,
        currentCoverage: coverage,
        currentMaterialHash: 'material',
        currentStoryFilesHash: 'story-files',
        clean: true,
        headBefore: baseHead,
        headAfter: baseHead,
      });
      assert.equal(result.reusable, false, `${label} must execute instead of reusing prior evidence`);
      assert.ok(
        result.refusalReasons.includes('prior-command-execution-not-pass'),
        `${label} must report the command-execution refusal reason`,
      );
    }

    const refusalRows: Array<[string, Partial<Parameters<typeof evaluateRoutineValidationReuse>[0]>]> = [
      ['current-verification-coverage-incomplete', { currentCoverage: { ...coverage, missingRequired: 1 } }],
      ['worktree-dirty', { clean: false }],
      ['material-hash-changed-or-missing', { currentMaterialHash: 'changed' }],
      ['story-files-hash-changed-or-missing', { currentStoryFilesHash: 'changed' }],
      ['validation-identity-changed', { currentIdentity: variations[0] }],
      ['head-changed-during-reuse-evaluation', { headAfter: 'changed-head' }],
      ['prior-overall-result-not-reusable', { evidence: { ...evidence, result: 'FAIL', verificationCoverage: undefined } }],
      ['prior-overall-result-not-reusable', { evidence: { ...evidence, result: 'FAIL', verificationCoverage: { ...coverage, missingRequired: 0 } } }],
      ['prior-overall-result-not-reusable', { evidence: { ...evidence, result: undefined as unknown as 'PASS' } }],
      ['prior-overall-result-not-reusable', { evidence: { ...evidence, result: 'UNKNOWN' as 'PASS' } }],
      ['identity-missing-malformed-or-legacy', { evidence: { ...evidence, routineValidationIdentity: undefined } }],
    ];
    for (const [reason, override] of refusalRows) {
      const result = evaluateRoutineValidationReuse({
        root,
        gitCwd: root,
        evidence,
        currentIdentity: configured,
        currentCoverage: coverage,
        currentMaterialHash: 'material',
        currentStoryFilesHash: 'story-files',
        clean: true,
        headBefore: baseHead,
        headAfter: baseHead,
        ...override,
      });
      assert.equal(result.reusable, false, reason);
      assert.ok(result.refusalReasons.includes(reason), `${reason} must be auditable`);
    }

    mkdirSync(join(root, '.proof-or-stop/story/actives/B-19ca'), { recursive: true });
    writeFileSync(join(root, '.proof-or-stop/story/actives/B-19ca/checklist.json'), '{}\n', 'utf8');
    git(root, ['add', '.proof-or-stop']);
    git(root, ['commit', '-m', 'trusted checklist verificationEvidence refresh']);
    const metadataHead = git(root, ['rev-parse', 'HEAD']);
    assert.equal(classifyTrustedValidationLineage({ root, gitCwd: root, evidenceHead: baseHead, currentHead: metadataHead }).lineage, 'trusted-story-metadata-descendant');

    writeFileSync(join(root, 'source.ts'), 'export const value = 2;\n', 'utf8');
    git(root, ['add', 'source.ts']);
    git(root, ['commit', '-m', 'code change disguised as metadata refresh']);
    const codeHead = git(root, ['rev-parse', 'HEAD']);
    const rejected = classifyTrustedValidationLineage({ root, gitCwd: root, evidenceHead: baseHead, currentHead: codeHead });
    assert.equal(rejected.lineage, 'rejected');
    assert.ok(rejected.reasons.some((reason) => reason === 'untrusted-lineage-path:source.ts'));

    git(root, ['checkout', '--', 'source.ts']);
    const freshnessSnapshot = captureEvidenceHashSnapshot({ gitCwd: root, metadataRoot: root, ref: 'HEAD' });
    writeFileSync(join(root, 'source.ts'), 'export const value = 3;\n', 'utf8');
    const racedFreshness = checkEvidenceHashSnapshotReuse(freshnessSnapshot, { gitCwd: root, metadataRoot: root, ref: 'HEAD' });
    assert.equal(racedFreshness.reusable, false, 'material dirt introduced after the first snapshot must reject reuse');
    assert.equal(racedFreshness.materialDirty, true);
    assert.ok(racedFreshness.materialDirtyFiles.includes('source.ts'));
    git(root, ['checkout', '--', 'source.ts']);

    const fortyFive = Array.from({ length: 45 }, (_, index) => ({ ...baseCommand, label: `command-${index + 1}`, args: ['--test', String(index + 1)] }));
    const b19Identity = identity(root, 'configured', fortyFive);
    const b19Evidence: TestEvidenceData = {
      ...evidence,
      headHash: metadataHead,
      routineValidationIdentity: b19Identity,
      commandExecution: {
        ...commandExecution,
        commandCount: 45,
      },
    };
    const b19 = evaluateRoutineValidationReuse({
      root,
      gitCwd: root,
      evidence: b19Evidence,
      currentIdentity: b19Identity,
      currentCoverage: coverage,
      currentMaterialHash: 'material',
      currentStoryFilesHash: 'story-files',
      clean: true,
      headBefore: metadataHead,
      headAfter: metadataHead,
    });
    assert.equal(b19.reusable, true, 'B-19ca 45-command PASS plus coverage refresh must reuse with zero command runner invocations');

    assert.equal(semanticFailureExecution.status, 'FAIL', 'exit-zero command with semantic validator FAIL must not be reusable command truth');

    assertHandlerExecutedThenReused('configured');
    assertHandlerExecutedThenReused('fallback');
    assertHandlerExecutedThenReused('validate-file');
    assertHandlerExecutedThenReused('validate-file', 1, {
      provider: 'validate-file-smoke',
      status: 'fail',
      allPass: true,
    }, false, false, false, false, false, true);
    for (const semanticResult of [
      { provider: 'validate-file-smoke', status: 'fail', allPass: true },
      { provider: 'validate-file-smoke', status: 'warn', allPass: true },
      { provider: 'validate-file-smoke', status: 'error', allPass: true },
      { provider: 'validate-file-smoke', status: 'unknown', allPass: true },
      { provider: 'validate-file-smoke', allPass: true },
      { provider: 'validate-file-smoke', status: 'pass', allPass: false },
      { provider: 'validate-file-smoke', status: 'pass', allPass: true, allPassed: false },
    ]) assertHandlerExecutedThenReused('validate-file', 1, semanticResult);
    assertHandlerExecutedThenReused('configured', 45, undefined, true);
    assertHandlerExecutedThenReused('configured', 1, undefined, true, true);
    assertHandlerExecutedThenReused('configured', 1, undefined, true, false, true);
    assertHandlerExecutedThenReused('configured', 1, undefined, true, false, false, true);
    assertHandlerExecutedThenReused('configured', 1, undefined, true, false, false, false, true);

    console.log('validation-evidence-reuse-smoke PASS (canonical 3-file isolated transaction, index/worktree rollback, receipt+hook failure fail-closed, coverage-only recovery, 3 sources, B-19ca 45-command reuse)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
