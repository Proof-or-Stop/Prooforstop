#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  enforceStoryOwnerLeaseGate,
  MAIN_TOOLS,
  resolveEffectiveOwnershipClass,
} from '../cli-engine.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { LiveSmokeTranscriptReport } from '../handlers/live-smoke-transcript.js';
import { acquireOwnerLease, ownerLeasePath, resetSessionIdForTest } from '../core/story-owner-lease.js';
import { commandCliMaxBudget, liveSmokeCaptureBudget } from '../core/done-required-timeout-budget.js';
import { validationExecutionLockPath } from '../core/validation-execution-lock.js';

const STORY_ID = 'B-livesmoke';
const NOW = '2026-06-20T00:00:00.000Z';
const MARKER = 'P5-MARKER-7f3a';
const USER_SEES = 'lattice live_smoke_transcript --storyId=<story> prints the expected output and transcript status.';
const ARTIFACT_REL = 'evidence/live-smoke-transcript.json';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'live-smoke-transcript-smoke',
      GIT_AUTHOR_EMAIL: 'live-smoke-transcript-smoke@example.com',
      GIT_COMMITTER_NAME: 'live-smoke-transcript-smoke',
      GIT_COMMITTER_EMAIL: 'live-smoke-transcript-smoke@example.com',
    },
  }).trim();
}

function gitStatus(root: string): string {
  return git(root, ['status', '--short']);
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'lattice.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function baseStory(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'live-smoke-transcript-smoke',
    title: 'Implement live_smoke_transcript',
    description: 'Explicit live-smoke transcript producer with independent capture/write opt-ins.',
    type: 'feature',
    phase: 'TEST',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

function checklistWithUserSees(): ChecklistData {
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'Item with a userSees expected output',
        context: 'live-smoke transcript expected vs actual',
        status: 'done',
        startTime: null,
        endTime: null,
        userSees: USER_SEES,
      },
    ],
  };
}

function createFixture(
  seedChecklist: () => ChecklistData,
  storyPhase: StoryInfo['phase'] = 'TEST',
): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-live-smoke-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# live smoke transcript smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, { ...baseStory(), phase: storyPhase });
  store.writeChecklist(STORY_ID, seedChecklist());
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

function snapshotDir(root: string, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  function walk(abs: string): void {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  }
  walk(dir);
  return out;
}

function assertNoAuthorityOrEvidenceArtifacts(store: StoryStore): void {
  for (const artifact of [
    'test-evidence.json',
    'review-runs.json',
    'review-passes.json',
    'findings.json',
    'delivery-check.json',
    'summary.json',
    'done-required-evidence.json',
    'authority-receipt-refs.json',
    'verification-evidence.json',
  ]) {
    assert.equal(existsSync(store.storyFilePath(STORY_ID, artifact)), false, `${artifact} must not be written`);
  }
}

function artifactPath(store: StoryStore): string {
  return store.storyFilePath(STORY_ID, ARTIFACT_REL);
}

function assertOnlyTranscriptArtifactInEvidenceDir(store: StoryStore): void {
  const evidenceDir = join(store.storyDirPath(STORY_ID), 'evidence');
  const entries = readdirSync(evidenceDir).sort();
  assert.deepEqual(entries, ['live-smoke-transcript.json'], 'evidence dir contains only the transcript artifact after --write');
  assert.equal(entries.some((entry) => entry.includes('.tmp-')), false, 'evidence dir contains no live-smoke transcript temp residue');
}

// ---- Policy / registration assertions -------------------------------------

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'live_smoke_transcript'), 'MAIN_TOOLS exposes live_smoke_transcript');
const policy = getCommandPolicy('live_smoke_transcript');
assert.equal(policy?.ownershipClass, 'readOnly', 'live_smoke_transcript base policy is readOnly');
assert.equal(policy?.destructiveRisk, 'none', 'live_smoke_transcript policy has no static destructive risk');
assert.equal(isCommandAllowed('live_smoke_transcript', 'REVIEW', DEFAULT_PHASE_TOOLS), true, 'available in REVIEW');
assert.equal(isCommandAllowed('live_smoke_transcript', 'TEST', DEFAULT_PHASE_TOOLS), true, 'available in TEST');
assert.equal(isCommandAllowed('live_smoke_transcript', 'DONE', DEFAULT_PHASE_TOOLS), true, 'available in DONE');

// The ownership gate escalates --write only; default and --capture-only stay readOnly for WRITES.
assert.equal(
  resolveEffectiveOwnershipClass('live_smoke_transcript', { storyId: STORY_ID }, STORY_ID),
  'readOnly',
  'read-only default remains effectively readOnly',
);
assert.equal(
  resolveEffectiveOwnershipClass('live_smoke_transcript', { storyId: STORY_ID, capture: 'echo hi' }, STORY_ID),
  'readOnly',
  '--capture-without-write is NOT a story-scoped metadata write (it runs a command but persists nothing)',
);
assert.equal(
  resolveEffectiveOwnershipClass('live_smoke_transcript', { storyId: STORY_ID, write: true }, STORY_ID),
  'storyScopedMutating',
  '--write is effectively storyScopedMutating',
);
assert.equal(
  resolveEffectiveOwnershipClass('live_smoke_transcript', { storyId: STORY_ID, write: 'true' }, STORY_ID),
  'storyScopedMutating',
  '--write string truth is still owner-gated before schema-normalized callers',
);

// ---- Fail-closed boundary (no store read on side-effect flags) ------------

{
  const throwingStore = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`store read should not happen before live_smoke_transcript rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/live-smoke-no-read', scanRoot: '/tmp/live-smoke-no-read/packages/main' };
  const handler = createMainRegistry(ctx).get('live_smoke_transcript');
  assert.ok(handler, 'registry exposes live_smoke_transcript for rejection test');
  for (const flag of ['runCommands', 'advancePhase', 'launchReviewers', 'authorityDone', 'fullAuthorityDone', 'productionDone'] as const) {
    assert.throws(
      () => handler!({ storyId: 'B-no-read', [flag]: true, json: true }),
      /refuses unsupported side effects|no story facts were read/,
      `${flag}=true fails closed before store reads`,
    );
  }
  // --capture and --write are the sanctioned opt-ins and must NOT be rejected by assertBoundary.
  for (const ok of [{ capture: 'echo ok' }, { write: true }] as const) {
    try {
      handler!({ storyId: 'B-no-read', ...ok, json: true });
    } catch (err) {
      assert.doesNotMatch(
        err instanceof Error ? err.message : String(err),
        /refuses unsupported side effects/,
        `${JSON.stringify(ok)} is NOT rejected by assertBoundary (sanctioned opt-in)`,
      );
    }
  }
}

// ---- invalid storyId is rejected before storyExists/path use ---------------

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for invalid storyId test');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const invalidCases = [
      { storyId: '../../outside', rogueDir: join(root, '.lattice', 'outside') },
      { storyId: 'B-bad/leaf', rogueDir: join(root, '.lattice', 'story', 'actives', 'B-bad', 'leaf') },
    ];

    for (const { storyId, rogueDir } of invalidCases) {
      mkdirSync(rogueDir, { recursive: true });
      writeFileSync(join(rogueDir, 'index.json'), JSON.stringify({ ...baseStory(), storyId }, null, 2) + '\n', 'utf8');
      assert.throws(
        () => handler!({ storyId, write: true, json: true }),
        /live_smoke_transcript: invalid storyId .*path traversal/,
        `invalid storyId ${storyId} is rejected before path-derived writes`,
      );
      assert.equal(existsSync(join(rogueDir, ARTIFACT_REL)), false, `invalid storyId ${storyId} writes no outside transcript`);
      assert.equal(existsSync(join(rogueDir, 'evidence')), false, `invalid storyId ${storyId} creates no outside evidence dir`);
    }

    assert.equal(existsSync(artifactPath(store)), false, 'invalid storyId attempts do not write the real story artifact');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'invalid storyId attempts leave the real story metadata unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (a) default read-only: no command run, no artifact written ------------

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    const report = handler!({ storyId: STORY_ID, json: true }) as LiveSmokeTranscriptReport;
    assert.equal(report.storyId, STORY_ID);
    assert.equal(report.mode.runCommands, false, 'default runs no command');
    assert.equal(report.mode.writeEvidence, false, 'default writes nothing');
    assert.equal(report.expected, USER_SEES, 'expected is read from checklist userSees');
    assert.equal(report.transcript.status, 'missing', 'no artifact yet → transcript missing');
    assert.equal(report.actual, null, 'no actual captured by default');
    assert.equal(report.write.requested, false);
    assert.equal(report.write.persisted, false);
    assert.equal(report.claims.authorityDone, false);
    assert.equal(report.claims.fullAuthorityDone, false);
    assert.equal(report.claims.productionDone, false);

    // text render is coherent and read-only.
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /Live smoke transcript \(B-livesmoke\)/);
    assert.match(text, /mode: read-only status \(no command run, no artifact written\)/);
    assert.match(text, /expected \(from userSees\):/);
    assert.match(text, /current transcript: missing/);
    assert.match(text, /Live-smoke readiness row:/);
    assert.match(text, /admissibilityStatus: transcript-context/);

    assert.equal(existsSync(artifactPath(store)), false, 'default writes no transcript artifact');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'default must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'default must leave git status unchanged');
    assertNoAuthorityOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', 'default must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (b) --capture runs ONLY that command; NOTHING persisted ---------------

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for capture test');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);

    const report = await handler!({ storyId: STORY_ID, capture: `echo ${MARKER}`, json: true }) as LiveSmokeTranscriptReport;
    assert.equal(report.mode.runCommands, true, '--capture ran the provided command');
    assert.equal(report.mode.writeEvidence, false, '--capture alone writes nothing (writeEvidence=false)');
    assert.ok(report.actual, '--capture records an actual transcript');
    assert.equal(report.actual!.command, `echo ${MARKER}`, 'records exactly the provided command');
    assert.equal(report.actual!.exitCode, 0, 'records the exit code');
    assert.match(report.actual!.stdout, new RegExp(MARKER), 'captured stdout contains the marker');
    assert.equal(report.write.persisted, false, '--capture-without-write persists no artifact');

    assert.equal(existsSync(artifactPath(store)), false, 'capture-only writes no transcript artifact');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'capture-only must not mutate story metadata');
    assertNoAuthorityOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', 'capture must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (c) --write persists the expected-vs-actual artifact ------------------

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for write test');

    const report = await handler!({ storyId: STORY_ID, capture: `echo ${MARKER}`, write: true, json: true }) as LiveSmokeTranscriptReport;
    assert.equal(report.mode.runCommands, true, '--capture + --write ran the command');
    assert.equal(report.mode.writeEvidence, true, '--write persisted the artifact');
    assert.equal(report.write.requested, true);
    assert.equal(report.write.persisted, true);
    assert.equal(report.write.artifactPath, artifactPath(store), 'reports the persisted artifact path');
    assert.equal(report.transcript.status, 'present-fresh', 'after a fresh --write the artifact is present(fresh)');

    assert.equal(existsSync(artifactPath(store)), true, '--write created the transcript artifact');
    assertOnlyTranscriptArtifactInEvidenceDir(store);
    const persisted = JSON.parse(readFileSync(artifactPath(store), 'utf8'));
    assert.equal(persisted.storyId, STORY_ID, 'artifact records storyId');
    assert.equal(persisted.expected, USER_SEES, 'artifact records expected from userSees');
    assert.ok(persisted.actual, 'artifact records the captured actual');
    assert.equal(persisted.actual.command, `echo ${MARKER}`, 'artifact records the exact command');
    assert.equal(persisted.actual.exitCode, 0, 'artifact records the exit code');
    assert.match(persisted.actual.stdout, new RegExp(MARKER), 'artifact stdout contains the marker');
    assert.equal(persisted.mode.runCommands, true, 'artifact mode reflects the capture');
    assert.equal(persisted.mode.writeEvidence, true, 'artifact mode reflects the write');
    assert.equal(persisted.claims.authorityDone, false, 'artifact claims authorityDone=false');
    assert.equal(persisted.claims.productionDone, false, 'artifact claims productionDone=false');
    assert.equal(typeof persisted.headHash, 'string', 'artifact records a headHash for freshness');

    assertNoAuthorityOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', '--write must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- capture budgets: direct closeout commands get their legal budget only --

{
  const { root } = createFixture(checklistWithUserSees);
  const savedOverride = process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
  try {
    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
      doneRequiredCommands: [{ label: 'long legal suite', command: 'npm', args: ['test'], timeoutMs: 120_000 }],
    }, null, 2) + '\n', 'utf8');
    resetConfigCache();

    const direct = liveSmokeCaptureBudget(root, 'LATTICE_SESSION_ID=stable lattice done_required_validate --storyId=B-livesmoke --json', {});
    assert.equal(direct.timeoutMs, 150_000, 'direct DONE-required capture derives command timeout plus grace');
    assert.equal(direct.recognizedCommand, 'done_required_validate');
    assert.equal(
      commandCliMaxBudget(root, 'live_smoke_transcript', {
        capture: 'lattice done_required_validate --storyId=B-livesmoke --json',
      }).timeoutMs,
      180_000,
      'outer CLI max watchdog allows the derived capture budget plus handler grace',
    );

    const arbitrary = liveSmokeCaptureBudget(root, 'node long-arbitrary-script.js', {});
    assert.equal(arbitrary.timeoutMs, 60_000, 'arbitrary captures retain the fixed safety ceiling');
    const composed = liveSmokeCaptureBudget(root, 'lattice done_required_validate --storyId=B-livesmoke; node extra.js', {});
    assert.equal(composed.timeoutMs, 60_000, 'shell-composed input cannot obtain the wider closeout budget');

    const boundedHighOverride = liveSmokeCaptureBudget(root, 'node arbitrary.js', {
      LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS: '999999999',
    });
    assert.equal(boundedHighOverride.timeoutMs, 60_000, 'explicit override cannot raise arbitrary-command safety ceiling');
    const boundedLowOverride = liveSmokeCaptureBudget(root, 'lattice done_required_validate --storyId=B-livesmoke', {
      LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS: '75',
    });
    assert.equal(boundedLowOverride.timeoutMs, 75, 'explicit override may lower a recognized command budget for testing/operations');
  } finally {
    if (savedOverride === undefined) delete process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
    else process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS = savedOverride;
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- timeout kills the process group and reclaims its dead validation lock --

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  const savedOverride = process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
  try {
    const lockPath = validationExecutionLockPath(root, STORY_ID);
    const descendantPidPath = join(root, 'descendant.pid');
    const scriptPath = join(root, 'hanging-capture.cjs');
    writeFileSync(scriptPath, [
      "const { spawn } = require('node:child_process');",
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { hostname } = require('node:os');",
      `const lockPath = ${JSON.stringify(lockPath)};`,
      `const pidPath = ${JSON.stringify(descendantPidPath)};`,
      "mkdirSync(lockPath, { recursive: true });",
      "writeFileSync(lockPath + '/holder.json', JSON.stringify({ pid: process.pid, hostname: hostname(), command: 'done_required_validate for B-livesmoke', acquiredAt: new Date().toISOString() }));",
      "const child = spawn(process.execPath, ['-e', 'process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });",
      "writeFileSync(pidPath, String(child.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join('\n') + '\n', 'utf8');
    process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS = '150';
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler);
    const report = await handler!({
      storyId: STORY_ID,
      capture: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      json: true,
    }) as LiveSmokeTranscriptReport;

    assert.equal(report.actual?.exitCode, null, 'capture timeout is represented as a null terminal exit');
    assert.match(report.actual?.stderr ?? '', /exceeded 150ms timeout; process group terminated/);
    const descendantPid = Number(readFileSync(descendantPidPath, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/, 'timed-out capture leaves no descendant process');
    assert.equal(existsSync(lockPath), false, 'dead validation lock is reclaimed after timeout cleanup');
    assert.equal(existsSync(artifactPath(store)), false, 'capture-only timeout still persists no transcript artifact');
  } finally {
    if (savedOverride === undefined) delete process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
    else process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS = savedOverride;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (d) INDEPENDENCE: capture-without-write & write-without-capture --------

{
  // capture-without-write: runs the command, writes no artifact (already proven in
  // block (b)); here we additionally prove write-without-capture: persists from the
  // (absent) actual without running any command.
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for independence test');

    const report = handler!({ storyId: STORY_ID, write: true, json: true }) as LiveSmokeTranscriptReport;
    assert.equal(report.mode.runCommands, false, '--write-without-capture runs NO command');
    assert.equal(report.actual, null, '--write-without-capture has no actual (none captured)');
    assert.equal(report.mode.writeEvidence, true, '--write persisted even without a capture');
    assert.equal(report.write.persisted, true);

    assert.equal(existsSync(artifactPath(store)), true, '--write-without-capture still creates the artifact');
    assertOnlyTranscriptArtifactInEvidenceDir(store);
    const persisted = JSON.parse(readFileSync(artifactPath(store), 'utf8'));
    assert.equal(persisted.actual, null, 'write-without-capture records actual=null (no command was run)');
    assert.equal(persisted.expected, USER_SEES, 'write-without-capture still records the expected output');
    assert.equal(persisted.mode.runCommands, false, 'artifact mode records that no command ran');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (e) --write through a FAILING owner/scope gate leaves state unchanged --

{
  const { root, store } = createFixture(checklistWithUserSees);
  const savedSession = process.env.LATTICE_SESSION_ID;
  try {
    const storyDir = store.storyDirPath(STORY_ID);
    process.env.LATTICE_SESSION_ID = 'sess-owner';
    resetSessionIdForTest();
    acquireOwnerLease(storyDir, { command: 'checklist_add', cwd: '/tmp/owner-worktree' });
    const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf8');
    const snapshotBefore = snapshotDir(root, storyDir);
    const statusBefore = gitStatus(root);

    process.env.LATTICE_SESSION_ID = 'sess-intruder';
    resetSessionIdForTest();

    // Default read-only is ungated even on a foreign-owned story.
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('live_smoke_transcript', { storyId: STORY_ID }, store, null, root),
      'read-only default is not owner-gated on a foreign-owned story',
    );
    // --capture-without-write is ungated for writes (it runs a command but persists nothing).
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('live_smoke_transcript', { storyId: STORY_ID, capture: 'echo hi' }, store, null, root),
      '--capture-without-write is not owner-gated on a foreign-owned story',
    );
    // --write is owner-gated and must throw before any write.
    assert.throws(
      () => enforceStoryOwnerLeaseGate('live_smoke_transcript', { storyId: STORY_ID, write: true }, store, null, root),
      /owner|owned by another/i,
      '--write is owner-gated on a foreign-owned story',
    );

    assert.equal(readFileSync(ownerLeasePath(storyDir), 'utf8'), leaseBefore, 'rejected --write leaves the foreign owner lease untouched');
    assert.equal(existsSync(artifactPath(store)), false, 'rejected owner gate leaves no transcript artifact (no partial write)');
    assert.deepEqual(snapshotDir(root, storyDir), snapshotBefore, 'rejected owner gate leaves story metadata unchanged');
    assert.equal(gitStatus(root), statusBefore, 'rejected owner gate leaves git status unchanged');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    if (savedSession === undefined) delete process.env.LATTICE_SESSION_ID;
    else process.env.LATTICE_SESSION_ID = savedSession;
    resetSessionIdForTest();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (f) degenerate input: no userSees / no transcript → missing, no crash --

{
  const { root, store, ctx } = createFixture(() => ({
    items: [
      {
        id: 'CHK-001',
        title: 'Item with no userSees',
        context: 'degenerate',
        status: 'done',
        startTime: null,
        endTime: null,
      },
    ],
  }));
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for degenerate test');

    const report = handler!({ storyId: STORY_ID, json: true }) as LiveSmokeTranscriptReport;
    assert.equal(report.expected, null, 'no userSees → expected is null (no crash)');
    assert.equal(report.transcript.status, 'missing', 'no artifact → missing (no crash)');
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /expected \(from userSees\): \(none authored\)/, 'renders the no-userSees case');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- nonexistent story errors clearly and writes nothing -------------------

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for nonexistent-story test');

    const MISSING_ID = 'B-nonexistent';
    assert.equal(store.storyExists(MISSING_ID), false, 'precondition: the missing story id does not exist');
    const statusBefore = gitStatus(root);

    for (const extra of [{}, { capture: 'echo hi' }, { write: true }] as const) {
      assert.throws(
        () => handler!({ storyId: MISSING_ID, ...extra, json: true }),
        /live_smoke_transcript: story B-nonexistent not found/,
        `nonexistent story (${JSON.stringify(extra)}) throws a clear not-found error`,
      );
    }
    assert.equal(existsSync(store.storyDirPath(MISSING_ID)), false, 'no story directory was created for the missing id');
    assert.equal(gitStatus(root), statusBefore, 'nonexistent-story rejection leaves git status unchanged');
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', 'real story is unaffected by the rejected missing-id calls');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('live_smoke_transcript smoke passed\n');
