#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';
import {
  buildDoneRequiredCommandSpecEnvelope,
  DONE_REQUIRED_EVIDENCE_SCHEMA,
  DONE_REQUIRED_EVIDENCE_VERSION,
  evaluateDoneRequiredEvidence,
  resolveDoneRequiredPolicy,
  runDoneRequiredValidation,
} from '../core/done-required-validation.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { DoneRequiredCommandReceipt, DoneRequiredEvidenceData, StoryInfo, TestEvidenceData } from '../core/types.js';

const STORY_ID = 'B-ac25';

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
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
  };
  if (doneRequiredCommands !== undefined) config.doneRequiredCommands = doneRequiredCommands;
  if (proofAdmissibility !== undefined) config.proofAdmissibility = proofAdmissibility;
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify(config, null, 2), 'utf-8');
  resetConfigCache();
}

function fixture(doneRequiredCommands?: unknown, proofAdmissibility?: unknown): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-required-'));
  writeConfig(root, doneRequiredCommands, proofAdmissibility);
  writeFileSync(join(root, 'README.md'), '# done required fixture\n', 'utf-8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json']);
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
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  });
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
    command: `lattice validate --story=${STORY_ID} --json`,
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

// Ordinary validate can pass while required gate fails, and missing artifact blocks required policy.
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
    assert.equal(evidence.receipts[0].commandSpec?.schema, 'lattice.command-spec.v1');
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
