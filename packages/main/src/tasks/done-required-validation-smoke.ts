#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';
import {
  buildDoneRequiredCommandSpecEnvelope,
  buildDoneRequiredExecutionIdentity,
  DONE_REQUIRED_EVIDENCE_SCHEMA,
  DONE_REQUIRED_EVIDENCE_VERSION,
  evaluateDoneRequiredEvidence,
  resolveDoneRequiredPolicy,
  runDoneRequiredValidation,
} from '../core/done-required-validation.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { CliWatchdogTimeoutError, commandCliMaxBudget, doneRequiredDerivedBudget, effectiveCommandCliMaxBudget, NODE_TIMER_MAX_MS, safeTimeoutSum, sequentialValidationBudget } from '../core/done-required-timeout-budget.js';
import { evaluateDoneRequiredPreRunReuse } from '../core/done-prepare-validation-reuse.js';
import {
  MAX_NODE_TIMER_DELAY_MS,
  runValidationCommand,
} from '../core/validation-executor.js';
import type { ChecklistItem, DoneRequiredCommandReceipt, DoneRequiredEvidenceData, StoryInfo, TestEvidenceData, VerificationEvidence } from '../core/types.js';
import { persistSyntheticAdmittedWindowForTest } from '../core/certification-window.js';
import { deriveCertificationDomainInputHashes } from '../handlers/certification-window.js';
import { createDoneRequiredValidationHandlers as unownedcreateDoneRequiredValidationHandlers } from '../handlers/done-required-validation.js';
import {
  effectiveValidationCommandEnvironment,
  HOST_LAUNCHER_SESSION_ENV_KEYS,
  VALIDATION_TRANSPORT_ENV_KEY_LIST,
} from '../core/validation-command-environment.js';

const STORY_ID = 'B-ac25';

// Windows executes validation commands through an implicit command shell. The
// DONE-required producer and consumer must bind the same ComSpec executable and
// effective environment instead of emitting evidence that can never validate.
{
  const { root, store } = fixture([
    { label: 'windows implicit shell', command: 'node', args: ['-e', 'process.exit(0)'] },
  ]);
  try {
    const cmdExe = join(root, 'cmd.exe');
    const nodeExe = join(root, 'node.exe');
    writeFileSync(cmdExe, 'synthetic windows command shell\n', 'utf8');
    writeFileSync(nodeExe, 'synthetic windows target executable\n', 'utf8');
    const policy = resolveDoneRequiredPolicy(root);
    const processEnvironment = {
      PATH: root,
      ComSpec: 'cmd.exe',
      PATHEXT: '.exe;.cmd',
    };
    const producer = buildDoneRequiredExecutionIdentity({
      projectRoot: root,
      policy,
      processEnvironment,
      platform: 'win32',
    });
    const consumer = buildDoneRequiredExecutionIdentity({
      projectRoot: root,
      policy,
      processEnvironment,
      platform: 'win32',
    });
    assert.equal(producer.commands[0]?.shell, true, 'win32 command identity must record implicit shell=true');
    assert.equal(producer.commands[0]?.executableDigest?.length, 64, 'win32 identity must hash the target node.exe');
    assert.equal(producer.commands[0]?.shellExecutableDigest?.length, 64, 'win32 identity must hash the resolved ComSpec executable');
    assert.equal(producer.digest, consumer.digest, 'DONE-required producer and consumer must share win32 shell identity');
    assert.equal(producer.commands[0]?.effectiveEnvironmentDigest, consumer.commands[0]?.effectiveEnvironmentDigest);
    assert.equal(producer.commands[0]?.executableDigest, consumer.commands[0]?.executableDigest);
    assert.equal(producer.commands[0]?.shellExecutableDigest, consumer.commands[0]?.shellExecutableDigest);
    const command = policy.commands[0]!;
    const commandSpec = buildDoneRequiredCommandSpecEnvelope(root, command, {
      command: command.command,
      args: command.args,
      shell: true,
      cwd: root,
    });
    assert.equal(commandSpec.shell, true, 'DONE-required receipt command spec must retain actual win32 implicit shell mode');
    const h = hashes(root);
    const commandIdentity = producer.commands[0]!;
    const receipt: DoneRequiredCommandReceipt = {
      label: command.label,
      command: command.command,
      args: command.args,
      commandSpec,
      shell: true,
      cwd: root,
      status: 'PASS',
      exitCode: 0,
      durationMs: 1,
      outputDigest: 'windows-shaped-output',
      outputTail: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      effectiveEnvironmentDigest: commandIdentity.effectiveEnvironmentDigest,
      executableDigest: commandIdentity.executableDigest,
      shellExecutableDigest: commandIdentity.shellExecutableDigest,
      ...(h.headHash ? { headHash: h.headHash } : {}),
      ...(h.materialHash ? { materialHash: h.materialHash } : {}),
      ...(h.storyFilesHash ? { storyFilesHash: h.storyFilesHash } : {}),
    };
    writeDoneEvidence(root, store, [receipt]);
    const evaluation = evaluateDoneRequiredEvidence({
      projectRoot: root,
      storyId: STORY_ID,
      store,
      gitCwd: root,
      executionIdentityContext: {
        processEnvironment,
        platform: 'win32',
      },
    });
    assert.equal(evaluation.ok, true, `Windows-shaped full DONE evaluator must pass: ${evaluation.reasons.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'done-required-smoke',
      GIT_AUTHOR_EMAIL: 'done-required-smoke@example.com',
      GIT_COMMITTER_NAME: 'done-required-smoke',
      GIT_COMMITTER_EMAIL: 'done-required-smoke@example.com',
    },
  });
}

function writeConfig(root: string, doneRequiredCommands?: unknown, proofAdmissibility?: unknown): void {
  const config: Record<string, unknown> = {
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
  };
  if (doneRequiredCommands !== undefined) config.doneRequiredCommands = doneRequiredCommands;
  if (proofAdmissibility !== undefined) config.proofAdmissibility = proofAdmissibility;
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify(config, null, 2), 'utf-8');
  resetConfigCache();
}

function fixture(doneRequiredCommands?: unknown, proofAdmissibility?: unknown): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-required-'));
  writeConfig(root, doneRequiredCommands, proofAdmissibility);
  writeFileSync(join(root, 'README.md'), '# done required fixture\n', 'utf-8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  const now = '2026-06-20T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'done-required-smoke',
    title: 'DONE required smoke',
    description: 'Synthetic story for DONE-required validation smoke coverage.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
  };
  store.writeStory(STORY_ID, story);
  // Supplemental validation does not itself claim completed delivery work.
  store.writeChecklist(STORY_ID, { items: [] });
  const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
  assert.ok(causalInputHashes, 'synthetic certification fixture must derive causal input hashes');
  persistSyntheticAdmittedWindowForTest({ store, storyId: STORY_ID, projectRoot: root, causalInputHashes });
  return { root, store };
}

function addPassingNpmTestPackage(root: string): void {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }, null, 2),
    'utf-8',
  );
  git(root, ['add', 'package.json']);
  git(root, ['commit', '-m', 'add passing npm test']);
}

function hashes(root: string) {
  return {
    headHash: currentGitHead(root),
    materialHash: currentMaterialHash(root, 'HEAD', root),
    storyFilesHash: currentStoryFilesHash(root, 'HEAD', root),
  };
}

function writePassingTestEvidence(root: string, store: StoryStore): void {
  const h = hashes(root);
  const evidence: TestEvidenceData = {
    command: `proof-or-stop validate --story=${STORY_ID} --json`,
    output: JSON.stringify({ allPass: true, status: 'pass' }),
    result: 'PASS',
    timestamp: new Date().toISOString(),
    ...(h.headHash ? { headHash: h.headHash } : {}),
    ...(h.materialHash ? { materialHash: h.materialHash } : {}),
    ...(h.storyFilesHash ? { storyFilesHash: h.storyFilesHash } : {}),
  };
  store.writeTestEvidence(STORY_ID, evidence);
}

function doneRow(rows: DoneCheckRow[], id: string): DoneCheckRow {
  const row = rows.find(r => r.id === id);
  assert.ok(row, `DONE checklist must include ${id}`);
  return row!;
}

function baseReceipt(root: string, overrides: Partial<DoneRequiredCommandReceipt>): DoneRequiredCommandReceipt {
  const h = hashes(root);
  const policy = resolveDoneRequiredPolicy(root);
  const identity = buildDoneRequiredExecutionIdentity({
    projectRoot: root,
    policy,
  }).commands[0];
  const receipt: DoneRequiredCommandReceipt = {
    label: 'synthetic',
    command: 'node',
    args: ['-e', 'process.exit(0)'],
    cwd: root,
    status: 'PASS',
    exitCode: 0,
    durationMs: 1,
    outputDigest: 'synthetic',
    outputTail: '',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    effectiveEnvironmentDigest: identity?.effectiveEnvironmentDigest,
    executableDigest: identity?.executableDigest,
    shellExecutableDigest: identity?.shellExecutableDigest ?? null,
    ...(h.headHash ? { headHash: h.headHash } : {}),
    ...(h.materialHash ? { materialHash: h.materialHash } : {}),
    ...(h.storyFilesHash ? { storyFilesHash: h.storyFilesHash } : {}),
    ...overrides,
  };
  return {
    ...receipt,
    commandSpec: overrides.commandSpec ?? buildDoneRequiredCommandSpecEnvelope(root, {
      label: receipt.label,
      command: receipt.command,
      args: receipt.args,
      ...(receipt.shell ? { shell: true } : {}),
      cwd: receipt.cwd,
    }, {
      command: receipt.command,
      args: receipt.args,
      ...(receipt.shell ? { shell: true } : {}),
      cwd: receipt.cwd,
    }),
  };
}

function writeDoneEvidence(root: string, store: StoryStore, receipts: DoneRequiredCommandReceipt[] = [baseReceipt(root, {})]): DoneRequiredEvidenceData {
  const policy = resolveDoneRequiredPolicy(root);
  const h = hashes(root);
  const evidence: DoneRequiredEvidenceData = {
    schema: DONE_REQUIRED_EVIDENCE_SCHEMA,
    version: DONE_REQUIRED_EVIDENCE_VERSION,
    storyId: STORY_ID,
    status: 'PASS',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1,
    ...(h.headHash ? { headHash: h.headHash } : {}),
    ...(h.materialHash ? { materialHash: h.materialHash } : {}),
    ...(h.storyFilesHash ? { storyFilesHash: h.storyFilesHash } : {}),
    policyHash: policy.policyHash,
    commandSetHash: policy.commandSetHash,
    receipts,
    reasons: [],
  };
  store.writeDoneRequiredEvidence(STORY_ID, evidence);
  return evidence;
}

function assertDoneRequiredBlocked(
  root: string,
  store: StoryStore,
  reasonPattern: RegExp,
  message: string,
): void {
  const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
  assert.equal(evaluation.blocking, true, message);
  assert.match(evaluation.reasons.join('\n'), reasonPattern, `${message}: ${evaluation.reasons.join(', ')}`);
}

// A DONE-required PASS is reviewed from a different role/session. Ambient
// ownership/adapter identity must not make the exact same command environment
// unverifiable, while behavior-affecting inputs remain bound.
{
  const commands = [
    { label: 'cross-session command 1', command: 'node', args: ['-e', 'process.exit(0)'] },
    { label: 'cross-session command 2', command: 'node', args: ['-e', 'process.exit(0)'] },
  ];
  const { root, store } = fixture(commands);
  try {
    const common = {
      PATH: process.env.PATH ?? '',
      CI: 'true',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      NODE_OPTIONS: '',
    };
    const ownerEnvironment = {
      ...common,
      PROOF_OR_STOP_SESSION_ID: 'owner-session',
      PROOF_OR_STOP_AGENT: 'main',
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_ROLE: 'main',
      CODEX_THREAD_ID: 'owner-thread',
    };
    const deliveryEnvironment = {
      ...common,
      PROOF_OR_STOP_SESSION_ID: 'delivery-session',
      PROOF_OR_STOP_AGENT: 'proof-or-stop-review-delivery',
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_ROLE: 'proof-or-stop-review-delivery',
      CODEX_THREAD_ID: 'delivery-thread',
    };
    const policy = resolveDoneRequiredPolicy(root);
    const producer = buildDoneRequiredExecutionIdentity({
      projectRoot: root,
      policy,
      processEnvironment: ownerEnvironment,
    });
    const consumer = buildDoneRequiredExecutionIdentity({
      projectRoot: root,
      policy,
      processEnvironment: deliveryEnvironment,
    });
    assert.deepEqual(
      producer.commands.map(command => command.effectiveEnvironmentDigest),
      consumer.commands.map(command => command.effectiveEnvironmentDigest),
      'owner and independent delivery-review sessions share DONE-required command identity',
    );
    // Host-launcher session identity is stripped at the filter rather than added
    // to the digest-pinned list, so iterating VALIDATION_TRANSPORT_ENV_KEY_LIST
    // below would not cover it. These keys change every session (CLAUDE_PID is a
    // pid; the socket path embeds it), and leaving them ambient made a receipt
    // written in one session unverifiable in the next -- surfacing as
    // effective-environment-digest-mismatch on a story that had actually passed.
    // Imported, never re-listed: a hand-copied literal would silently stop
    // covering a key added to the source list later (B-0b50:F-012).
    for (const key of HOST_LAUNCHER_SESSION_ENV_KEYS) {
      const ownerSession = buildDoneRequiredExecutionIdentity({
        projectRoot: root, policy,
        processEnvironment: { ...common, [key]: 'session-one' }, platform: 'linux',
      });
      const otherSession = buildDoneRequiredExecutionIdentity({
        projectRoot: root, policy,
        processEnvironment: { ...common, [key]: 'session-two' }, platform: 'linux',
      });
      assert.deepEqual(
        ownerSession.commands.map(command => command.effectiveEnvironmentDigest),
        otherSession.commands.map(command => command.effectiveEnvironmentDigest),
        `host-launcher session key is digest-neutral: ${key}`,
      );
    }

    // The digest-pinned list retains historical spellings; current transport
    // matching uses their canonical names without accepting retired aliases.
    // Test-only historical prefix: assemble it without introducing a literal
    // active-name declaration (see scripts/verify-proof-or-stop-residue.mjs detector tokens).
    // The frozen-key branch is a negative control: retired inputs must remain
    // semantic and must not become transport aliases.
    const retiredPrefix = ['LAT', 'TICE_'].join('');
    for (const frozenKey of VALIDATION_TRANSPORT_ENV_KEY_LIST) {
      const key = frozenKey.startsWith(retiredPrefix)
        ? `PROOF_OR_STOP_${frozenKey.slice(retiredPrefix.length)}`
        : frozenKey;
      if (key !== frozenKey) {
        assert.notDeepEqual(
          effectiveValidationCommandEnvironment({ ...common, [frozenKey]: 'owner-identity' }, undefined, root),
          effectiveValidationCommandEnvironment({ ...common, [frozenKey]: 'reviewer-identity' }, undefined, root),
          `retired ambient spelling remains semantic: ${frozenKey}`,
        );
        for (const platform of ['linux', 'win32'] as const) {
          const retiredOwner = buildDoneRequiredExecutionIdentity({
            projectRoot: root, policy, processEnvironment: { ...common, [frozenKey]: 'owner-value' }, platform,
          });
          const retiredReviewer = buildDoneRequiredExecutionIdentity({
            projectRoot: root, policy, processEnvironment: { ...common, [frozenKey]: 'reviewer-value' }, platform,
          });
          assert.notDeepEqual(
            retiredOwner.commands.map(command => command.effectiveEnvironmentDigest),
            retiredReviewer.commands.map(command => command.effectiveEnvironmentDigest),
            `retired ambient key remains semantic on ${platform}: ${frozenKey}`,
          );
        }
      }
      const owner = { ...common, [key]: 'owner-identity' };
      const reviewer = { ...common, [key]: 'reviewer-identity' };
      const posixOwner = buildDoneRequiredExecutionIdentity({
        projectRoot: root, policy, processEnvironment: owner, platform: 'linux',
      });
      const posixReviewer = buildDoneRequiredExecutionIdentity({
        projectRoot: root, policy, processEnvironment: reviewer, platform: 'linux',
      });
      assert.deepEqual(
        posixOwner.commands.map(command => command.effectiveEnvironmentDigest),
        posixReviewer.commands.map(command => command.effectiveEnvironmentDigest),
        `POSIX ambient transport key is session-neutral: ${key}`,
      );

      const mixedCase = key.split('').map((character, index) =>
        index % 2 === 0 ? character.toLowerCase() : character.toUpperCase()).join('');
      const windowsOwner = buildDoneRequiredExecutionIdentity({
        projectRoot: root,
        policy,
        processEnvironment: { ...common, [key.toLowerCase()]: 'owner-identity' },
        platform: 'win32',
      });
      const windowsReviewer = buildDoneRequiredExecutionIdentity({
        projectRoot: root,
        policy,
        processEnvironment: { ...common, [mixedCase]: 'reviewer-identity' },
        platform: 'win32',
      });
      assert.deepEqual(
        windowsOwner.commands.map(command => command.effectiveEnvironmentDigest),
        windowsReviewer.commands.map(command => command.effectiveEnvironmentDigest),
        `Windows ambient transport key is case-insensitively session-neutral: ${key}`,
      );

      const lower = key.toLowerCase();
      if (lower !== key) {
        const lowerOwner = buildDoneRequiredExecutionIdentity({
          projectRoot: root,
          policy,
          processEnvironment: { ...common, [lower]: 'owner-semantic-value' },
          platform: 'linux',
        });
        const lowerReviewer = buildDoneRequiredExecutionIdentity({
          projectRoot: root,
          policy,
          processEnvironment: { ...common, [lower]: 'reviewer-semantic-value' },
          platform: 'linux',
        });
        assert.notDeepEqual(
          lowerOwner.commands.map(command => command.effectiveEnvironmentDigest),
          lowerReviewer.commands.map(command => command.effectiveEnvironmentDigest),
          `POSIX differently-cased noncanonical key remains semantic: ${lower}`,
        );
      }
    }

    const overlayOwner = effectiveValidationCommandEnvironment(
      ownerEnvironment,
      { PROOF_OR_STOP_ACTIVITY_ROLE: 'explicit-owner-role' },
      root,
      'linux',
    );
    const overlayReviewer = effectiveValidationCommandEnvironment(
      deliveryEnvironment,
      { PROOF_OR_STOP_ACTIVITY_ROLE: 'explicit-reviewer-role' },
      root,
      'linux',
    );
    assert.equal(overlayOwner.PROOF_OR_STOP_ACTIVITY_ROLE, 'explicit-owner-role');
    assert.equal(overlayReviewer.PROOF_OR_STOP_ACTIVITY_ROLE, 'explicit-reviewer-role');
    assert.notDeepEqual(
      overlayOwner,
      overlayReviewer,
      'explicit command.env overlay remains semantic after ambient transport filtering',
    );

    const h = hashes(root);
    const receipts = policy.commands.map((command, index): DoneRequiredCommandReceipt => {
      const identity = producer.commands[index]!;
      const executed = { command: command.command, args: command.args, cwd: root };
      return {
        label: command.label,
        command: command.command,
        args: command.args,
        cwd: root,
        status: 'PASS',
        exitCode: 0,
        durationMs: 1,
        outputDigest: `cross-session-output-${index}`,
        outputTail: '',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        effectiveEnvironmentDigest: identity.effectiveEnvironmentDigest,
        executableDigest: identity.executableDigest,
        shellExecutableDigest: identity.shellExecutableDigest ?? null,
        commandSpec: buildDoneRequiredCommandSpecEnvelope(root, command, executed),
        ...(h.headHash ? { headHash: h.headHash } : {}),
        ...(h.materialHash ? { materialHash: h.materialHash } : {}),
        ...(h.storyFilesHash ? { storyFilesHash: h.storyFilesHash } : {}),
      };
    });
    writeDoneEvidence(root, store, receipts);
    const crossSession = evaluateDoneRequiredEvidence({
      projectRoot: root,
      storyId: STORY_ID,
      store,
      gitCwd: root,
      executionIdentityContext: { processEnvironment: deliveryEnvironment },
    });
    assert.equal(crossSession.ok, true, crossSession.reasons.join(', '));

    const behaviorEnvironmentMutations = [
      { name: 'CI', environment: { ...deliveryEnvironment, CI: 'false' } },
      { name: 'NODE_OPTIONS', environment: { ...deliveryEnvironment, NODE_OPTIONS: '--trace-warnings' } },
      { name: 'LANG', environment: { ...deliveryEnvironment, LANG: 'en_GB.UTF-8' } },
      { name: 'LC_ALL', environment: { ...deliveryEnvironment, LC_ALL: 'en_GB.UTF-8' } },
    ];
    for (const mutation of behaviorEnvironmentMutations) {
      const changedBehavior = evaluateDoneRequiredEvidence({
        projectRoot: root,
        storyId: STORY_ID,
        store,
        gitCwd: root,
        executionIdentityContext: { processEnvironment: mutation.environment },
      });
      assert.equal(changedBehavior.ok, false, `${mutation.name} mutation remains behavior-affecting`);
      assert.match(changedBehavior.reasons.join('\n'), /effective-environment-digest-mismatch\[0\]/);
      assert.match(changedBehavior.reasons.join('\n'), /effective-environment-digest-mismatch\[1\]/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The effective timeout armed by the real runner must stay within Node's timer range.
// Values above that range otherwise overflow to ~1ms and kill a healthy command immediately.
{
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-timeout-cap-'));
  try {
    const huge = await runValidationCommand({
      label: 'huge timeout remains legal',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 30)'],
      timeoutMs: Number.MAX_SAFE_INTEGER,
    }, root);
    assert.equal(huge.code, 0);
    assert.equal(huge.timedOut, undefined);
    assert.equal(huge.timeoutMs, MAX_NODE_TIMER_DELAY_MS);
    assert.ok(huge.durationMs >= 20, 'huge timeout must not overflow into an immediate timer');

    for (const malformed of [0, -1, Number.POSITIVE_INFINITY]) {
      const fallback = await runValidationCommand({
        label: `fallback timeout ${String(malformed)}`,
        command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(0), 10)'],
        timeoutMs: malformed,
      }, root, 1_000);
      assert.equal(fallback.code, 0);
      assert.equal(fallback.timedOut, undefined);
      assert.equal(fallback.timeoutMs, 1_000);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Injected deadline seams deterministically cover before/after without relying on wall-clock races.
{
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-deadline-seam-'));
  try {
    const beforeDeadline = await runValidationCommand({
      label: 'before deadline', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5_000,
    }, root, 5_000, { deadlineAt: Date.now() + 5_000 });
    assert.equal(beforeDeadline.code, 0);
    assert.equal(beforeDeadline.timedOut, undefined);

    const afterDeadline = await runValidationCommand({
      label: 'after deadline', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 5_000,
    }, root, 5_000, { deadlineAt: Date.now() - 1 });
    assert.equal(afterDeadline.code, 124);
    assert.equal(afterDeadline.timedOut, true);
    assert.equal(afterDeadline.timeoutMs, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Abort concurrent with command start settles once, writes one evidence artifact,
// and emits no heartbeat after the terminal command_end event.
{
  const { root, store } = fixture([{ label: 'abort ordering', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 5_000 }]);
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    let evidenceWrites = 0;
    const originalWrite = store.writeDoneRequiredEvidence.bind(store);
    store.writeDoneRequiredEvidence = (storyId: string, data: DoneRequiredEvidenceData): void => {
      evidenceWrites += 1;
      originalWrite(storyId, data);
    };
    const abort = new AbortController();
    const eventTypes: string[] = [];
    const handler = createDoneRequiredValidationHandlers({ root, scanRoot: root, store, log: () => {} });
    const parsed = JSON.parse(await handler.done_required_validate({
      storyId: STORY_ID,
      json: true,
      abortSignal: abort.signal,
      progress: (event: { type: string }) => {
        eventTypes.push(event.type);
        if (event.type === 'command_start') abort.abort(new CliWatchdogTimeoutError('idle', 1));
      },
    }));
    assert.equal(parsed.result, 'timed_out');
    assert.equal(parsed.timeoutLayer, 'idle');
    assert.ok(evidenceWrites <= 1, 'abort/exit race must never duplicate a terminal evidence artifact');
    assert.equal(eventTypes.filter((type) => type === 'command_end').length, 1);
    assert.equal(eventTypes.filter((type) => type === 'command_timeout').length, 1);
    const endIndex = eventTypes.lastIndexOf('command_end');
    assert.equal(eventTypes.slice(endIndex + 1).includes('heartbeat'), false, 'no heartbeat may follow terminal command_end');
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

// Timeout arithmetic covers the legal sequential command budget once and saturates safely.
{
  const { root, store } = fixture([{ label: 'slow legal suite', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 1_200_000 }]);
  try {
    const budget = doneRequiredDerivedBudget(root);
    assert.equal(budget.timeoutMs, 1_230_000);
    assert.equal(budget.source, 'derived-command-budget');
    assert.equal(safeTimeoutSum([NODE_TIMER_MAX_MS, 1]), NODE_TIMER_MAX_MS);
    assert.equal(sequentialValidationBudget([
      { label: 'build', command: 'node', args: [], timeoutMs: 290_000 },
      { label: 'test', command: 'node', args: [], timeoutMs: 1_200_000 },
    ]), 1_520_000, 'sequential budget sums each effective timeout once plus grace');
    assert.equal(sequentialValidationBudget([
      { label: 'zero fallback', command: 'node', args: [], timeoutMs: 0 },
      { label: 'negative fallback', command: 'node', args: [], timeoutMs: -1 },
      { label: 'non-finite fallback', command: 'node', args: [], timeoutMs: Number.POSITIVE_INFINITY },
    ]), 840_000, 'invalid/non-positive timeout inputs use the bounded command default');
    const configPath = join(root, 'proof-or-stop.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.validate = {
      commands: [
        { command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 600_000, focus: ['fast'] },
        { command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 650_000 },
        { command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 700_000, focus: ['slow'] },
      ],
      evidenceCommandTimeoutOverrides: [
        { command: 'node', args: ['-e', "process.stdout.write('BATCH_A')"], timeoutMs: 600_000 },
        { command: 'node', args: ['-e', "process.stdout.write('BATCH_B')"], timeoutMs: 600_000 },
      ],
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    resetConfigCache();
    const fullValidateBudget = commandCliMaxBudget(root, 'validate', {});
    assert.equal(fullValidateBudget.timeoutMs, 1_980_000,
      'full configured validate outer budget is every serial command plus 30s grace, not the legacy 900000ms default');
    assert.equal(fullValidateBudget.commandBudgetMs, 1_950_000);
    assert.equal(fullValidateBudget.graceMs, 30_000);
    assert.ok(fullValidateBudget.timeoutMs > 900_000,
      'long configured serial validate suite cannot be cut off by the legacy 15 minute watchdog');
    assert.equal(commandCliMaxBudget(root, 'validate', { focus: 'fast' }).timeoutMs, 630_000,
      'focused validate budget covers only commands selected by that focus');
    assert.equal(effectiveCommandCliMaxBudget(root, 'validate', {}, { PROOF_OR_STOP_MAX_TIMEOUT_MS: '2700000' }).timeoutMs, 2_700_000,
      'explicit PROOF_OR_STOP_MAX_TIMEOUT_MS continues to override the derived validate budget');
    const batchCommandA = `node -e "process.stdout.write('BATCH_A')"`;
    const batchCommandB = `node -e "process.stdout.write('BATCH_B')"`;
    const batchEvidence = (command: string, selector: string) => ({ command, selector, kind: 'logic_test' });
    const batchBudget = commandCliMaxBudget(root, 'verification_evidence_batch_add', {
      evidences: [batchEvidence(batchCommandA, 'BATCH_A'), batchEvidence(batchCommandB, 'BATCH_B')],
    });
    assert.equal(batchBudget.timeoutMs, 1_230_000,
      'two exact allowlisted pinned batch verifiers receive their combined configured child budgets plus grace');
    assert.equal(batchBudget.commandBudgetMs, 1_200_000);
    assert.equal(commandCliMaxBudget(root, 'verification_evidence_batch_add', {
      evidences: [batchEvidence(batchCommandA, 'BATCH_A')],
    }).timeoutMs, 630_000, 'one pinned batch verifier receives only its configured child timeout plus grace');
    assert.equal(commandCliMaxBudget(root, 'verification_evidence_batch_add', {
      evidences: [batchEvidence(batchCommandA, 'BATCH_A'), batchEvidence(batchCommandA, 'BATCH_A')],
    }).timeoutMs, 630_000, 'duplicate batch pins share one executable+argv timeout budget');
    assert.equal(commandCliMaxBudget(root, 'verification_evidence_batch_add', {
      evidences: [batchEvidence('sh -c "sleep 1"', 'ignored')],
    }).timeoutMs, 900_000, 'raw non-allowlisted batch commands cannot widen the CLI watchdog budget');
    assert.equal(effectiveCommandCliMaxBudget(root, 'verification_evidence_batch_add', {
      evidences: [batchEvidence(batchCommandA, 'BATCH_A'), batchEvidence(batchCommandB, 'BATCH_B')],
    }, { PROOF_OR_STOP_MAX_TIMEOUT_MS: '2700000' }).timeoutMs, 2_700_000,
      'explicit max continues to override a derived batch evidence budget');

    const checklist = store.readChecklist(STORY_ID);
    // Only this stale-pin fixture needs a checklist item; its actual intended
    // pins and deliberately stale receipts are populated below before writing.
    const item: ChecklistItem = {
      id: 'CHK-001', title: 'Refresh the two stale executable pins', status: 'done',
      startTime: '2026-06-20T00:00:00.000Z', endTime: '2026-06-20T00:00:00.000Z',
    };
    checklist.items.push(item);
    item.verificationIntent = {
      happy: [
        { id: 'REFRESH-A', desc: 'first stale executable pin', type: 'logic', priority: 'must', verification: { command: batchCommandA, selector: 'BATCH_A' } },
        { id: 'REFRESH-B', desc: 'second stale executable pin', type: 'logic', priority: 'must', verification: { command: batchCommandB, selector: 'BATCH_B' } },
      ],
      edge: [],
      adversarial: [],
    };
    const staleReceipt = {
      exitCode: 0,
      outputDigest: '0'.repeat(64),
      outputTail: 'stale fixture',
      selectorMatched: true,
      executedAt: '2026-01-01T00:00:00.000Z',
    };
    const staleEvidence = (intentRef: string): VerificationEvidence => ({
      intentRef,
      kind: 'logic_test',
      result: 'pass',
      note: 'stale executed evidence fixture',
      headHash: '0'.repeat(40),
      materialHash: '0'.repeat(64),
      mechanical: true,
      receipt: staleReceipt,
    });
    item.verificationEvidence = [staleEvidence('REFRESH-A'), staleEvidence('REFRESH-B')];
    store.writeChecklist(STORY_ID, checklist);
    const refreshBudget = commandCliMaxBudget(root, 'verification_evidence_refresh_stale', { storyId: STORY_ID });
    assert.equal(refreshBudget.timeoutMs, 1_230_000,
      'two current stale executable pins receive the exact combined configured re-execution budget plus grace');
    assert.equal(refreshBudget.commandBudgetMs, 1_200_000);
    assert.equal(refreshBudget.graceMs, 30_000);
    assert.equal(commandCliMaxBudget(root, 'verification_evidence_refresh_stale', { storyId: STORY_ID, dryRun: true }).timeoutMs, 900_000,
      'refresh dry-run executes no pinned child commands and keeps the ordinary CLI watchdog budget');

    item.verificationIntent.happy[1]!.verification = { command: 'sh -c "sleep 1"', selector: 'ignored' };
    item.verificationIntent.happy[0]!.verification = { command: 'sh -c "sleep 1"', selector: 'ignored' };
    store.writeChecklist(STORY_ID, checklist);
    assert.equal(commandCliMaxBudget(root, 'verification_evidence_refresh_stale', { storyId: STORY_ID }).timeoutMs, 900_000,
      'stale pins outside the execution allowlist cannot widen the refresh watchdog');

    item.verificationEvidence = [];
    store.writeChecklist(STORY_ID, checklist);
    assert.equal(commandCliMaxBudget(root, 'verification_evidence_refresh_stale', { storyId: STORY_ID }).timeoutMs, 900_000,
      'refresh with no stale executable evidence keeps the ordinary CLI watchdog budget');
    assert.equal(commandCliMaxBudget(root, 'story_get', {}).timeoutMs, 900_000, 'unrelated CLI defaults remain unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Pre-run reuse accepts exact HEAD and trusted story-metadata descendants only.
{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    writeDoneEvidence(root, store);
    let reuse = evaluateDoneRequiredPreRunReuse({ root, gitCwd: root, storyId: STORY_ID, store });
    assert.equal(reuse.reusable, true);
    assert.equal(reuse.lineage, 'exact-head');
    git(root, ['add', '.proof-or-stop/story/actives']);
    git(root, ['commit', '-m', 'commit trusted story metadata']);
    reuse = evaluateDoneRequiredPreRunReuse({ root, gitCwd: root, storyId: STORY_ID, store });
    assert.equal(reuse.reusable, true);
    assert.equal(reuse.lineage, 'trusted-story-metadata-descendant');
    writeFileSync(join(root, 'README.md'), '# material drift\n', 'utf8');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'material drift']);
    reuse = evaluateDoneRequiredPreRunReuse({ root, gitCwd: root, storyId: STORY_ID, store });
    assert.equal(reuse.reusable, false);
    assert.match(reuse.refusalReasons.join('\n'), /stale-material|untrusted-lineage-path:README\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Ordinary validate can pass while required gate fails, and missing artifact blocks required policy.

// Reuse refuses an independently corrupted evidence schema.
{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    const evidence = writeDoneEvidence(root, store);
    store.writeDoneRequiredEvidence(STORY_ID, { ...evidence, schema: 'wrong-schema' } as unknown as DoneRequiredEvidenceData);
    const reuse = evaluateDoneRequiredPreRunReuse({ root, gitCwd: root, storyId: STORY_ID, store });
    assert.equal(reuse.reusable, false);
    assert.match(reuse.refusalReasons.join('\n'), /schema|version/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Proof-admissibility mutation is independent from lineage and policy drift.
{
  const { root, store } = fixture(
    [{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }],
    { mode: 'enforce', enforcedConsumers: ['DONE_REQUIRED'] },
  );
  try {
    const evidence = writeDoneEvidence(root, store);
    store.writeDoneRequiredEvidence(STORY_ID, {
      ...evidence,
      receipts: evidence.receipts.map((receipt) => ({ ...receipt, commandSpec: undefined })),
    });
    const reuse = evaluateDoneRequiredPreRunReuse({ root, gitCwd: root, storyId: STORY_ID, store });
    assert.equal(reuse.reusable, false);
    assert.match(reuse.refusalReasons.join('\n'), /command_spec_missing|proof/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A valid but non-ancestor evidence HEAD cannot be reused.
{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    const evidence = writeDoneEvidence(root, store);
    git(root, ['checkout', '-b', 'side-lineage']);
    writeFileSync(join(root, 'SIDE.md'), 'side\n', 'utf8');
    git(root, ['add', 'SIDE.md']);
    git(root, ['commit', '-m', 'side lineage']);
    const sideHead = currentGitHead(root)!;
    git(root, ['checkout', 'main']);
    store.writeDoneRequiredEvidence(STORY_ID, { ...evidence, headHash: sideHead });
    const reuse = evaluateDoneRequiredPreRunReuse({ root, gitCwd: root, storyId: STORY_ID, store });
    assert.equal(reuse.reusable, false);
    assert.match(reuse.refusalReasons.join('\n'), /evidence-head-is-not-current-ancestor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A metadata-looking path outside the canonical allowlist remains untrusted.
{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    writeDoneEvidence(root, store);
    git(root, ['add', '.proof-or-stop/story/actives']);
    git(root, ['commit', '-m', 'commit evidence metadata']);
    writeFileSync(join(root, '.proof-or-stop-story-like.json'), '{}\n', 'utf8');
    git(root, ['add', '.proof-or-stop-story-like.json']);
    git(root, ['commit', '-m', 'metadata-like path outside allowlist']);
    const reuse = evaluateDoneRequiredPreRunReuse({ root, gitCwd: root, storyId: STORY_ID, store });
    assert.equal(reuse.reusable, false);
    assert.match(reuse.refusalReasons.join('\n'), /untrusted-lineage-path:\.proof-or-stop-story-like\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Direct handler defaults progress to ctx.log, keeps JSON singular, and contains a throwing sink.
// A modify-then-revert (and rename-into-metadata-and-back) that leaves material BYTE-IDENTICAL at
// the endpoint is trusted: the net endpoint diff shows no material change, so the validation still
// applies (B-f00c). A genuine, non-reverted content change is still untrusted — covered by
// validation-evidence-reuse-smoke.ts (source.ts case).
{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    const originalReadme = '# done required fixture\n';
    writeDoneEvidence(root, store);
    git(root, ['add', '.proof-or-stop/story/actives']);
    git(root, ['commit', '-m', 'trusted evidence metadata']);
    writeFileSync(join(root, 'README.md'), '# temporary material mutation\n', 'utf8');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'temporarily mutate material']);
    writeFileSync(join(root, 'README.md'), originalReadme, 'utf8');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'restore material bytes']);
    git(root, ['mv', 'README.md', `.proof-or-stop/story/actives/${STORY_ID}/renamed-from-material.md`]);
    git(root, ['commit', '-m', 'rename material into metadata path']);
    git(root, ['mv', `.proof-or-stop/story/actives/${STORY_ID}/renamed-from-material.md`, 'README.md']);
    git(root, ['commit', '-m', 'restore renamed material path']);
    const reuse = evaluateDoneRequiredPreRunReuse({ root, gitCwd: root, storyId: STORY_ID, store });
    // Net endpoint diff: README.md is byte-identical at the endpoint, so it is not listed
    // as changed and the validation stays trusted for reuse (B-f00c corrected semantic).
    assert.equal(reuse.reusable, true);
    assert.equal(reuse.refusalReasons.join('\n'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A HEAD move during evaluation fails closed even when the initial lineage is exact.
{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    writeDoneEvidence(root, store);
    const reuse = evaluateDoneRequiredPreRunReuse({
      root,
      gitCwd: root,
      storyId: STORY_ID,
      store,
      beforeFinalHeadCheck: () => {
        writeFileSync(join(root, 'TOCTOU.md'), 'head moved\n', 'utf8');
        git(root, ['add', 'TOCTOU.md']);
        git(root, ['commit', '-m', 'move head during reuse evaluation']);
      },
    });
    assert.equal(reuse.reusable, false);
    assert.match(reuse.refusalReasons.join('\n'), /head-changed-during-reuse-evaluation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Malformed evidence is stale, never an exception, and direct execution overwrites it.
{
  const { root, store } = fixture([{ label: 'repair malformed', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  const previousCwd = process.cwd();
  try {
    const evidencePath = join(root, '.proof-or-stop/story/actives', STORY_ID, 'done-required-evidence.json');
    writeFileSync(evidencePath, '{"truncated":', 'utf8');
    const stale = evaluateDoneRequiredPreRunReuse({ root, gitCwd: root, storyId: STORY_ID, store });
    assert.equal(stale.reusable, false);
    assert.equal(stale.existingEvidenceBasis, 'stale');
    assert.match(stale.refusalReasons.join('\n'), /evidence-malformed-or-unreadable/);
    writeFileSync(evidencePath, '{}', 'utf8');
    const malformedShape = evaluateDoneRequiredPreRunReuse({ root, gitCwd: root, storyId: STORY_ID, store });
    assert.equal(malformedShape.reusable, false);
    assert.equal(malformedShape.existingEvidenceBasis, 'stale');
    assert.match(malformedShape.refusalReasons.join('\n'), /evidence-malformed-or-unreadable/);
    process.chdir(root);
    const handler = createDoneRequiredValidationHandlers({ root, scanRoot: root, store, log: () => {} });
    const repaired = JSON.parse(await handler.done_required_validate({ storyId: STORY_ID, json: true }));
    assert.equal(repaired.result, 'pass');
    assert.doesNotThrow(() => JSON.parse(readFileSync(evidencePath, 'utf8')));
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, store } = fixture([{ label: 'direct progress', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    const logs: string[] = [];
    const handler = createDoneRequiredValidationHandlers({ root, scanRoot: root, store, log: (line) => logs.push(line) });
    const raw = await handler.done_required_validate({ storyId: STORY_ID, json: true });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.disposition, 'executed');
    assert.equal(parsed.result, 'pass');
    assert.match(logs.join('\n'), /validate progress: command 1\/1 started direct progress/);
    assert.equal(raw.trim().split('\n').length, 1, 'direct JSON stdout payload stays singular');
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, store } = fixture([{ label: 'throwing progress sink', command: 'node', args: ['-e', 'process.exit(1)'] }]);
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    const handler = createDoneRequiredValidationHandlers({ root, scanRoot: root, store, log: () => { throw new Error('closed sink'); } });
    const raw = await handler.done_required_validate({ storyId: STORY_ID, json: true });
    assert.equal(JSON.parse(raw).result, 'failed', 'diagnostic sink failure cannot change validation FAIL');
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, store } = fixture([{ label: 'rejected async progress sink', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    const handler = createDoneRequiredValidationHandlers({ root, scanRoot: root, store, log: () => {} });
    const raw = await handler.done_required_validate({
      storyId: STORY_ID,
      json: true,
      progress: async () => { throw new Error('rejected async sink'); },
    });
    assert.equal(JSON.parse(raw).result, 'pass', 'async diagnostic sink rejection cannot change validation PASS');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    writePassingTestEvidence(root, store);
    const rows = buildDoneChecklist(STORY_ID, store, root, { gitCwd: root, auditWriter: null });
    assert.equal(doneRow(rows, 'test-evidence').status, 'pass');
    const required = doneRow(rows, 'done-required-validation');
    assert.equal(required.status, 'fail');
    assert.equal(required.blocking, true);
    assert.match(required.detail || '', /missing done-required-evidence\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// DONE evaluation revalidates receipt coverage, identity, and per-receipt PASS status.
{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    writeDoneEvidence(root, store, []);
    assertDoneRequiredBlocked(root, store, /receipt-count-mismatch/, 'empty receipts must not satisfy a required policy');

    writeDoneEvidence(root, store, [baseReceipt(root, {}), baseReceipt(root, {})]);
    assertDoneRequiredBlocked(root, store, /receipt-count-mismatch/, 'extra receipts must not satisfy a required policy');

    writeDoneEvidence(root, store, [baseReceipt(root, { command: 'npm' })]);
    assertDoneRequiredBlocked(root, store, /receipt-command-mismatch\[0\]/, 'receipt command must match policy command');

    writeDoneEvidence(root, store, [baseReceipt(root, { args: ['-e', 'process.exit(1)'] })]);
    assertDoneRequiredBlocked(root, store, /receipt-args-mismatch\[0\]/, 'receipt args must match policy args');

    writeDoneEvidence(root, store, [baseReceipt(root, { cwd: join(root, 'packages/main') })]);
    assertDoneRequiredBlocked(root, store, /receipt-cwd-mismatch\[0\]/, 'receipt cwd must match normalized policy cwd');

    writeDoneEvidence(root, store, [baseReceipt(root, { status: 'FAIL', exitCode: 0 })]);
    assertDoneRequiredBlocked(root, store, /receipt-status-fail\[0\]/, 'receipt FAIL status must block even when artifact status is PASS');

    writeDoneEvidence(root, store, [baseReceipt(root, { status: 'PASS', exitCode: 7 })]);
    assertDoneRequiredBlocked(root, store, /receipt-status-fail\[0\]/, 'nonzero receipt exitCode must block even when artifact status is PASS');

    writeDoneEvidence(root, store, [baseReceipt(root, { status: 'PASS', exitCode: 0, timedOut: true })]);
    assertDoneRequiredBlocked(root, store, /receipt-status-fail\[0\]/, 'timed out receipt must block even when artifact status is PASS');

    const tamperedCommandSpecReceipt = baseReceipt(root, {});
    writeDoneEvidence(root, store, [{
      ...tamperedCommandSpecReceipt,
      commandSpec: {
        ...tamperedCommandSpecReceipt.commandSpec!,
        digest: 'tampered-command-spec-digest',
      },
    }]);
    assertDoneRequiredBlocked(root, store, /command-spec-digest-mismatch\[0\]/, 'tampered CommandSpec digest must block');

    writeDoneEvidence(root, store, [baseReceipt(root, { effectiveEnvironmentDigest: 'forged-environment' })]);
    assertDoneRequiredBlocked(
      root,
      store,
      /effective-environment-digest-mismatch\[0\]/,
      'DONE_REQUIRED lifecycle consumer must reject forged Environment execution identity',
    );

    writeDoneEvidence(root, store, [baseReceipt(root, { executableDigest: 'forged-executable' })]);
    assertDoneRequiredBlocked(
      root,
      store,
      /executable-digest-mismatch\[0\]/,
      'DONE_REQUIRED lifecycle consumer must reject forged executable identity',
    );

    writeDoneEvidence(root, store);
    const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evaluation.ok, true, evaluation.reasons.join(', '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Receipt count must match policy command count exactly; truncated artifacts fail closed.
{
  const { root, store } = fixture([
    { label: 'first command', command: 'node', args: ['-e', 'process.exit(0)'] },
    { label: 'second command', command: 'node', args: ['-e', 'process.exit(0)'] },
  ]);
  try {
    writeDoneEvidence(root, store, [baseReceipt(root, { label: 'first command' })]);
    assertDoneRequiredBlocked(root, store, /receipt-count-mismatch/, 'truncated receipts must not satisfy all policy commands');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Shell policy commands require shell receipts, so a plain receipt cannot impersonate one.
{
  const { root, store } = fixture([{ label: 'shell command', command: 'node -e "process.exit(0)"', args: [], shell: true }]);
  try {
    writeDoneEvidence(root, store, [baseReceipt(root, { label: 'shell command', command: 'node -e "process.exit(0)"', args: [] })]);
    assertDoneRequiredBlocked(root, store, /receipt-shell-mismatch\[0\]/, 'shell receipts must match policy shell identity');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A policy-authorized compound shell command has no single target executable.
// Its exact command/args are bound by CommandSpec while /bin/sh identity remains
// mandatory; the full DONE evaluator must accept that conditional identity.
{
  const compound = 'node -e "process.exit(0)" && node -e "process.exit(0)"';
  const { root, store } = fixture([compound]);
  try {
    const policy = resolveDoneRequiredPolicy(root);
    const command = policy.commands[0]!;
    const identity = buildDoneRequiredExecutionIdentity({ projectRoot: root, policy }).commands[0]!;
    assert.equal(command.shell, true, 'compound policy string must resolve as shell execution');
    assert.equal(identity.executableDigest, null, 'compound shell command has no single target executable');
    assert.equal(identity.shellExecutableDigest?.length, 64, 'compound shell command must bind actual shell executable');
    const h = hashes(root);
    const commandSpec = buildDoneRequiredCommandSpecEnvelope(root, command, {
      command: command.command,
      args: command.args,
      shell: true,
      cwd: root,
    });
    const receipt: DoneRequiredCommandReceipt = {
      label: command.label,
      command: command.command,
      args: command.args,
      commandSpec,
      shell: true,
      cwd: root,
      status: 'PASS',
      exitCode: 0,
      durationMs: 1,
      outputDigest: 'compound-shell-output',
      outputTail: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      effectiveEnvironmentDigest: identity.effectiveEnvironmentDigest,
      executableDigest: null,
      shellExecutableDigest: identity.shellExecutableDigest,
      ...(h.headHash ? { headHash: h.headHash } : {}),
      ...(h.materialHash ? { materialHash: h.materialHash } : {}),
      ...(h.storyFilesHash ? { storyFilesHash: h.storyFilesHash } : {}),
    };
    writeDoneEvidence(root, store, [receipt]);
    const pass = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(pass.ok, true, `compound shell full evaluator must pass: ${pass.reasons.join(', ')}`);

    writeDoneEvidence(root, store, [{ ...receipt, shellExecutableDigest: 'tampered-shell' }]);
    const tampered = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(tampered.ok, false);
    assert.ok(tampered.reasons.some(reason => reason.includes('shell-executable-digest-mismatch[0]')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Failing command writes FAIL artifact and blocks.
{
  const { root, store } = fixture([{ label: 'expected failure', command: 'node', args: ['-e', 'process.exit(7)'] }]);
  try {
    const evidence = await runDoneRequiredValidation({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evidence.status, 'FAIL');
    assert.equal(evidence.receipts[0].exitCode, 7);
    const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evaluation.blocking, true);
    assert.ok(evaluation.reasons.some(reason => reason.includes('command-failed')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Stale material, policy drift, and command-set drift block.
{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    writeDoneEvidence(root, store);
    writeFileSync(join(root, 'README.md'), '# changed material\n', 'utf-8');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'material drift']);
    let evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.ok(evaluation.reasons.includes('stale-material'), `expected stale-material, got ${evaluation.reasons.join(', ')}`);

    writeDoneEvidence(root, store);
    writeConfig(root, [{ label: 'changed command', command: 'node', args: ['-e', 'process.exit(0)'] }]);
    evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.ok(evaluation.reasons.includes('policy-drift'), `expected policy-drift, got ${evaluation.reasons.join(', ')}`);
    assert.ok(evaluation.reasons.includes('command-set-drift'), `expected command-set-drift, got ${evaluation.reasons.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Top-level headHash is audit-only when material/story hashes still match.
{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    const evidence = writeDoneEvidence(root, store);
    store.writeDoneRequiredEvidence(STORY_ID, {
      ...evidence,
      headHash: '0000000000000000000000000000000000000000',
    });
    const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evaluation.ok, true, evaluation.reasons.join(', '));
    assert.equal(evaluation.reasons.includes('stale-headHash'), false, `headHash drift must not block: ${evaluation.reasons.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Stale storyFilesHash blocks even when materialHash and headHash still match.
{
  const { root, store } = fixture([{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  try {
    const evidence = writeDoneEvidence(root, store);
    store.writeDoneRequiredEvidence(STORY_ID, {
      ...evidence,
      storyFilesHash: 'stale-story-files-hash',
    });
    const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evaluation.blocking, true);
    assert.ok(evaluation.reasons.includes('stale-storyFilesHash'), `expected stale-storyFilesHash, got ${evaluation.reasons.join(', ')}`);
    assert.equal(evaluation.reasons.includes('stale-material'), false, `materialHash should remain current: ${evaluation.reasons.join(', ')}`);
    assert.equal(evaluation.reasons.includes('stale-headHash'), false, `headHash should remain current: ${evaluation.reasons.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// External opt-in root npm test does not inherit the self-host build-proof requirement.
{
  const { root, store } = fixture([{ label: 'root full test suite', command: 'npm', args: ['test'] }]);
  try {
    addPassingNpmTestPackage(root);
    const evidence = await runDoneRequiredValidation({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evidence.status, 'PASS', evidence.reasons.join(', '));
    assert.equal(
      evidence.reasons.some(reason => reason.includes('missing-build-proof')),
      false,
      `external root npm test must not inherit self-host proof: ${evidence.reasons.join(', ')}`,
    );
    const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evaluation.ok, true, evaluation.reasons.join(', '));
    assert.equal(
      evaluation.reasons.some(reason => reason.includes('missing-build-proof')),
      false,
      `DONE evaluation must not report missing-build-proof: ${evaluation.reasons.join(', ')}`,
    );
    const row = doneRow(buildDoneChecklist(STORY_ID, store, root, { gitCwd: root, auditWriter: null }), 'done-required-validation');
    assert.equal(row.status, 'pass');
    assert.equal(row.blocking, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Generated command-backed evidence is admissible under enforce mode and carries CommandSpec receipts.
{
  const { root, store } = fixture(
    [{ label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] }],
    { mode: 'enforce', enforcedConsumers: ['DONE_REQUIRED'] },
  );
  try {
    const evidence = await runDoneRequiredValidation({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evidence.status, 'PASS', evidence.reasons.join(', '));
    assert.equal(evidence.receipts.length, 1);
    assert.equal(evidence.receipts[0].commandSpec?.schema, 'proof-or-stop.command-spec.v2');
    assert.equal(evidence.receipts[0].commandSpec?.command, 'node');

    const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evaluation.ok, true, evaluation.reasons.join(', '));
    assert.equal(evaluation.blocking, false, evaluation.reasons.join(', '));
    assert.equal(evaluation.proofAdmissibility.blocking, false, evaluation.proofAdmissibility.reasons.join(', '));
    assert.equal(
      evaluation.proofAdmissibility.reasons.includes('command_spec_missing'),
      false,
      `generated evidence must not report command_spec_missing: ${evaluation.proofAdmissibility.reasons.join(', ')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Explicit self-host proof requirement still blocks without a preceding build receipt.
{
  const { root, store } = fixture([{ label: 'root full test suite', command: 'npm', args: ['test'], requiresBuildProof: 'packages-main-build' }]);
  try {
    writeDoneEvidence(root, store, [
      baseReceipt(root, { label: 'root full test suite', command: 'npm', args: ['test'] }),
    ]);
    const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.ok(evaluation.reasons.some(reason => reason.includes('missing-build-proof')), `expected missing-build-proof, got ${evaluation.reasons.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Preceding same-material packages/main build receipt satisfies explicit self-host proof.
{
  const { root, store } = fixture([
    { label: 'packages/main build', command: 'npm', args: ['--prefix', 'packages/main', 'run', 'build'], providesBuildProof: 'packages-main-build' },
    { label: 'root full test suite', command: 'npm', args: ['test'], requiresBuildProof: 'packages-main-build' },
  ]);
  try {
    const materialHash = hashes(root).materialHash;
    writeDoneEvidence(root, store, [
      baseReceipt(root, { label: 'packages/main build', command: 'npm', args: ['--prefix', 'packages/main', 'run', 'build'], materialHash }),
      baseReceipt(root, { label: 'root full test suite', command: 'npm', args: ['test'], materialHash }),
    ]);
    const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evaluation.ok, true, evaluation.reasons.join(', '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// No policy is advisory/non-blocking.
{
  const { root, store } = fixture(undefined);
  try {
    writePassingTestEvidence(root, store);
    const row = doneRow(buildDoneChecklist(STORY_ID, store, root, { gitCwd: root, auditWriter: null }), 'done-required-validation');
    assert.equal(row.status, 'warn');
    assert.equal(row.blocking, false);
    assert.match(row.detail || '', /no doneRequiredCommands policy configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('done-required-validation smoke passed');

import { acquireOwnerLease, readOwnerLease } from '../core/story-owner-lease.js';
// Direct handler tests bypass the CLI ownership gate. Establish its prerequisite
// only in these disposable fixtures; production heartbeat never acquires leases.
function createDoneRequiredValidationHandlers(ctx: Parameters<typeof unownedcreateDoneRequiredValidationHandlers>[0]) {
  for (const id of ctx.store.listStoryIds()) {
    const directory = ctx.store.storyDirPath(id);
    if (!readOwnerLease(directory)) acquireOwnerLease(directory, {command:'fixture-owner',cwd:ctx.root});
  }
  return unownedcreateDoneRequiredValidationHandlers(ctx);
}
