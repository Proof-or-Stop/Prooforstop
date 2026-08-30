#!/usr/bin/env node
/**
 * B-62c8: init_preflight smoke.
 *
 * init_preflight is a strictly read-only INIT→INIT_CHECK prerequisite surveyor.
 * Where story_advance --phase=INIT_CHECK is fail-fast (first reason only), this
 * lists EVERY prerequisite in one run with a fix command, and echoes the
 * AUTHORITATIVE INIT_CHECK gate (getGuardFailureReason) (gate.ready must always
 * agree with the real gate AND init-check present/valid).
 *
 * Coverage:
 *   (a) virgin INIT story lists scope-boundary + execution-boundary + init-check
 *       all unmet in ONE run, each with a fix;
 *   (b) for EVERY fixture, preflight.gate.ready === (real gate ok AND init-check
 *       present/valid) — assert they agree;
 *   (c) a fully set-up fixture reports all [PASS] and gate READY;
 *   (d) a stale/tampered freeze-check fixture → [STALE];
 *   (e) read-only: story-dir snapshot byte-identical + git unchanged after a run,
 *       and assertBoundary throws on side-effect flags (throwing-store, no read);
 *   (f) a path-traversal storyId is rejected.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { getCommandPolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { StoryStore } from '../core/store.js';
import { evaluateScopeAntiExpansionGate, getGuardFailureReason } from '../core/machine.js';
import {
  recomputeInitCheckHash,
} from '../core/init-check-gate.js';
import {
  buildExecutionBoundary,
  buildScopeBoundary,
  digestScopeFreezeCheck,
  evaluateScopeFreeze,
} from '../core/scope-anti-expansion.js';
import type { ChecklistData, InitCheckData, ScopeFreezeCheckData, StoryInfo } from '../core/types.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { InitPreflightReport } from '../handlers/init-preflight.js';

const STORY_ID = 'B-ipf';
const NOW = '2026-06-22T00:00:00.000Z';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'init-preflight-smoke',
      GIT_AUTHOR_EMAIL: 'init-preflight-smoke@example.com',
      GIT_COMMITTER_NAME: 'init-preflight-smoke',
      GIT_COMMITTER_EMAIL: 'init-preflight-smoke@example.com',
    },
  }).trim();
}

function gitStatus(root: string): string {
  return git(root, ['status', '--short']);
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function baseStory(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'init-preflight-smoke',
    title: 'Fix the INIT preflight surveyor regression',
    description: 'Keep the implementation scoped to the read-only INIT prerequisite survey.',
    type: 'bug',
    phase: 'INIT',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase: 'INIT', action: 'create', timestamp: NOW }],
  };
}

function baseChecklist(): ChecklistData {
  return {
    items: [{
      id: 'CHK-001',
      title: 'Wire the INIT preflight survey',
      context: 'Use the read-only surveyor without expanding scope.',
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  };
}

/**
 * Build a git-backed fixture repo with a story seeded into INIT. `seed` runs
 * AFTER the base commit so callers can stack scope/init artifacts on top.
 */
function createFixture(
  seed: (root: string, store: StoryStore) => void,
): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-init-preflight-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# init preflight smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, baseStory());
  store.writeChecklist(STORY_ID, baseChecklist());
  seed(root, store);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

function writeGoodBoundaries(store: StoryStore): void {
  store.writeScopeBoundary(STORY_ID, buildScopeBoundary({
    storyId: STORY_ID,
    mode: 'correctness_fix',
    allowed: ['INIT preflight surveyor correctness'],
    excluded: ['accepted reviewer expansion without decision'],
    confirmedBy: 'init-preflight-smoke',
    confirmationNote: 'Synthetic user-confirmed boundary for smoke coverage.',
    now: NOW,
  }));
  store.writeExecutionBoundary(STORY_ID, buildExecutionBoundary({
    storyId: STORY_ID,
    allowedCommands: ['npm --prefix packages/main run build'],
    allowedTools: ['shell'],
    excludedCommands: ['rm -rf'],
    excludedTools: [],
    confirmedBy: 'init-preflight-smoke',
    confirmationNote: 'Synthetic execution boundary for smoke coverage.',
    now: NOW,
  }));
}

function projectStory(store: StoryStore) {
  const story = store.readStory(STORY_ID);
  return {
    title: story.title,
    description: story.description,
    background: store.readStoryBackground(STORY_ID) ?? undefined,
  };
}

function projectChecklist(store: StoryStore) {
  return store.readChecklist(STORY_ID).items.map(item => ({
    id: item.id,
    title: item.title,
    ...(item.context ? { context: item.context } : {}),
    ...(item.excludes ? { excludes: [...item.excludes] } : {}),
  }));
}

function freeze(store: StoryStore): ScopeFreezeCheckData {
  const result = evaluateScopeFreeze({
    storyId: STORY_ID,
    scopeBoundary: store.readScopeBoundary(STORY_ID),
    executionBoundary: store.readExecutionBoundary(STORY_ID),
    story: projectStory(store),
    checklist: projectChecklist(store),
    discardDigest: store.readScopeDiscardDigest(STORY_ID),
    now: NOW,
  });
  store.writeScopeFreezeCheck(STORY_ID, result.check);
  return result.check;
}

/** Write a valid signed init-check with both required reviewers and no blocking issues. */
function writeGoodInitCheck(root: string, store: StoryStore): void {
  const data: InitCheckData = {
    storyId: STORY_ID,
    checkedAt: NOW,
    reviewRound: '',
    agentId: 'proof-or-stop-review-story-init',
    issues: [],
    agentResults: [
      { agentId: 'proof-or-stop-review-story-init', checkedAt: NOW, issues: [] },
      { agentId: 'product-reviewer', checkedAt: NOW, issues: [] },
    ],
    _hash: '',
  } as InitCheckData;
  // B-8df9 CHK-002: the reviewer verdict is part of the signature domain, so the record
  // must be signed as a PRODUCER (over `data`) — recomputing against the file on disk
  // would sign whatever verdict was persisted before this one.
  data._hash = recomputeInitCheckHash(STORY_ID, store, root, data);
  store.writeInitCheck(STORY_ID, data);
}

/**
 * Write a structurally-complete init-check (both required reviewers, no blocking
 * issues) but with a TAMPERED/stale _hash that does NOT match its recomputed
 * digest. This is the exact case codex used to break the old code: the old
 * hand-rolled gate said gate.ready:true + init-check PASS, while the real gate
 * blocks with [init_check_tampered].
 */
function writeTamperedInitCheck(root: string, store: StoryStore): void {
  const data: InitCheckData = {
    storyId: STORY_ID,
    checkedAt: NOW,
    reviewRound: '',
    agentId: 'proof-or-stop-review-story-init',
    issues: [],
    agentResults: [
      { agentId: 'proof-or-stop-review-story-init', checkedAt: NOW, issues: [] },
      { agentId: 'product-reviewer', checkedAt: NOW, issues: [] },
    ],
    _hash: 'deadbeef',
  } as InitCheckData;
  // Confirm the tamper truly diverges from the recomputed digest the gate uses.
  assert.notEqual(
    data._hash,
    recomputeInitCheckHash(STORY_ID, store, root, data),
    'tampered init-check _hash must not match its recomputed digest',
  );
  store.writeInitCheck(STORY_ID, data);
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

function statusOf(report: InitPreflightReport, id: string): string {
  const row = report.prerequisites.find((r) => r.id === id);
  assert.ok(row, `prerequisite row ${id} must be present`);
  return row!.status;
}

/**
 * The AUTHORITATIVE reference: the preflight's gate.ready MUST equal
 * `getGuardFailureReason(storyId, store, 'INIT_CHECK', root) === null` for every
 * fixture. This is NOT a re-statement of the handler's predicate — it is the
 * SAME function the real machine gate consults (covers scope anti-expansion AND
 * init-check incl. _hash / init_check_tampered), so it actually catches a
 * disagreement instead of being circular.
 */
function assertAgreement(report: InitPreflightReport, store: StoryStore, root: string, label: string): void {
  const authoritativeReady = getGuardFailureReason(STORY_ID, store, 'INIT_CHECK', root) === null;
  assert.equal(
    report.gate.ready,
    authoritativeReady,
    `${label}: preflight gate.ready must equal getGuardFailureReason(...,'INIT_CHECK')===null (the real gate)`,
  );
}

// ---- Policy / registration assertions -------------------------------------

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'init_preflight'), 'MAIN_TOOLS exposes init_preflight');
const policy = getCommandPolicy('init_preflight');
assert.equal(policy?.ownershipClass, 'readOnly', 'init_preflight policy is readOnly');
assert.equal(policy?.destructiveRisk, 'none', 'init_preflight policy has no destructive risk');
assert.equal(isCommandAllowed('init_preflight', 'INIT', DEFAULT_PHASE_TOOLS), true, 'init_preflight is available in INIT');
assert.equal(isCommandAllowed('init_preflight', 'DEV', DEFAULT_PHASE_TOOLS), true, 'init_preflight is available in DEV');

// ---- (e) fail-closed boundary (no store read on side-effect flags) --------

{
  const throwingStore = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`store read should not happen before init_preflight rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/init-preflight-no-read', scanRoot: '/tmp/init-preflight-no-read/packages/main' };
  const handler = createMainRegistry(ctx).get('init_preflight');
  assert.ok(handler, 'registry exposes init_preflight for rejection test');
  for (const flag of ['runCommands', 'writeEvidence', 'advancePhase', 'launchReviewers', 'authorityDone', 'fullAuthorityDone', 'productionDone', 'write', 'apply', 'execute'] as const) {
    assert.throws(
      () => handler!({ storyId: STORY_ID, [flag]: true, json: true }),
      /read-only INIT→INIT_CHECK prerequisite surveyor|no story facts were read|refuses unsupported side effects/,
      `${flag}=true fails closed before store reads`,
    );
  }
}

// ---- (f) path-traversal storyId is rejected (before any store read) --------

{
  const throwingStore = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`store read should not happen for a non-canonical storyId: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/init-preflight-bad-id', scanRoot: '/tmp/init-preflight-bad-id/packages/main' };
  const handler = createMainRegistry(ctx).get('init_preflight');
  assert.ok(handler, 'registry exposes init_preflight for traversal test');
  for (const bad of ['../../etc/passwd', 'B-../escape', 'not a story', '']) {
    assert.throws(
      () => handler!({ storyId: bad, json: true }),
      /non-canonical storyId|path-safe canonical/,
      `path-traversal storyId ${JSON.stringify(bad)} is rejected`,
    );
  }
}

// ---- (a) + (b) virgin INIT story: all prerequisites unmet in ONE run -------

{
  const { root, store, ctx } = createFixture(() => { /* virgin: no boundaries, no init-check */ });
  try {
    const handler = createMainRegistry(ctx).get('init_preflight');
    assert.ok(handler, 'registry exposes init_preflight');

    const report = handler!({ storyId: STORY_ID, json: true }) as InitPreflightReport;

    // scope-boundary AND execution-boundary AND init-check all unmet in ONE run.
    assert.equal(statusOf(report, 'scope-boundary'), 'MISSING', 'virgin: scope-boundary is MISSING');
    assert.equal(statusOf(report, 'execution-boundary'), 'MISSING', 'virgin: execution-boundary is MISSING');
    assert.equal(statusOf(report, 'init-check'), 'MISSING', 'virgin: init-check is MISSING');

    // Each unmet row carries a fix command (not just the first one).
    for (const id of ['scope-boundary', 'execution-boundary', 'init-check']) {
      const row = report.prerequisites.find((r) => r.id === id)!;
      assert.ok(row.fix && row.fix.length > 0, `virgin: ${id} carries a fix command`);
    }
    // scope-boundary fix names scope_boundary_set; execution names execution_boundary_set.
    assert.match(report.prerequisites.find((r) => r.id === 'scope-boundary')!.fix!, /scope_boundary_set/);
    assert.match(report.prerequisites.find((r) => r.id === 'execution-boundary')!.fix!, /execution_boundary_set/);

    // All 6 prerequisite rows are surveyed in the single run.
    assert.equal(report.prerequisites.length, 6, 'all six prerequisites are surveyed in one run');

    // (b) agreement + gate is BLOCKED on the authoritative first reason.
    assertAgreement(report, store, root, 'virgin');
    assert.equal(report.gate.ready, false, 'virgin gate is BLOCKED');
    assert.ok(report.gate.blockedBy, 'virgin gate names the authoritative blocker');
    assert.equal(report.gate.blockedBy, evaluateScopeAntiExpansionGate(STORY_ID, store).reason, 'blockedBy is the authoritative scope-gate first reason');

    // text render lists every row + the gate line.
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /INIT preflight \(B-ipf → INIT_CHECK\)/);
    assert.match(text, /\[MISSING\] scope-boundary/);
    assert.match(text, /\[MISSING\] execution-boundary/);
    assert.match(text, /\[MISSING\] init-check/);
    assert.match(text, /gate: BLOCKED \(blockedBy=/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (c) fully set-up fixture: all [PASS] + gate READY (read-only) ----------

{
  const { root, store, ctx } = createFixture((r, s) => {
    writeGoodBoundaries(s);
    freeze(s);
    writeGoodInitCheck(r, s);
  });
  try {
    const handler = createMainRegistry(ctx).get('init_preflight');
    assert.ok(handler, 'registry exposes init_preflight for the happy-path fixture');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    const report = handler!({ storyId: STORY_ID, json: true }) as InitPreflightReport;

    for (const row of report.prerequisites) {
      assert.equal(row.status, 'PASS', `fully set-up: ${row.id} is PASS (got ${row.status}: ${row.detail ?? ''})`);
    }
    assert.equal(report.gate.ready, true, 'fully set-up gate is READY');
    assert.equal(report.gate.blockedBy, undefined, 'READY gate carries no blockedBy');

    // (b) agreement holds on the happy path too.
    assertAgreement(report, store, root, 'fully set-up');

    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /gate: READY/);

    // (e) read-only: story-dir snapshot byte-identical + git unchanged.
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'init_preflight must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'init_preflight must leave git status unchanged');
    assert.equal(store.readStory(STORY_ID).phase, 'INIT', 'init_preflight must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (d) stale/tampered freeze-check → [STALE] + agreement -----------------

{
  const { root, store, ctx } = createFixture((r, s) => {
    writeGoodBoundaries(s);
    const pass = freeze(s);
    // Tamper: keep status=pass but corrupt the _hash so it no longer matches its
    // own digest (the gate reports [scope_freeze_check_stale]).
    const tampered: ScopeFreezeCheckData = { ...pass, _hash: 'deadbeef' };
    // Confirm the corruption really diverges from the recomputed digest.
    assert.notEqual(tampered._hash, digestScopeFreezeCheck(tampered), 'tampered hash must not match its own digest');
    s.writeScopeFreezeCheck(STORY_ID, tampered);
    writeGoodInitCheck(r, s);
  });
  try {
    const handler = createMainRegistry(ctx).get('init_preflight');
    assert.ok(handler, 'registry exposes init_preflight for the stale-freeze fixture');

    const report = handler!({ storyId: STORY_ID, json: true }) as InitPreflightReport;
    assert.equal(statusOf(report, 'scope-freeze-check'), 'STALE', 'tampered freeze-check is STALE');
    assert.equal(statusOf(report, 'scope-boundary'), 'PASS', 'scope-boundary still PASS alongside the stale freeze');
    assert.equal(statusOf(report, 'execution-boundary'), 'PASS', 'execution-boundary still PASS alongside the stale freeze');

    // (b) agreement: the stale freeze blocks the real gate, so gate.ready=false.
    assertAgreement(report, store, root, 'stale freeze');
    assert.equal(report.gate.ready, false, 'stale freeze gate is BLOCKED');

    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /\[STALE\] scope-freeze-check/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (g) tampered init-check _hash: gate BLOCKED + init-check [STALE] --------
//        The EXACT codex repro: valid scope artifacts + both INIT reviewers + no
//        blocking issues, but init-check _hash="deadbeef". The old hand-rolled
//        gate said ready:true + init-check PASS; the real gate blocks with
//        [init_check_tampered]. After the F-001 fix the preflight must agree.

{
  const { root, store, ctx } = createFixture((r, s) => {
    writeGoodBoundaries(s);
    freeze(s);
    writeTamperedInitCheck(r, s);
  });
  try {
    const handler = createMainRegistry(ctx).get('init_preflight');
    assert.ok(handler, 'registry exposes init_preflight for the tampered-init-check fixture');

    // The real gate blocks this with init_check_tampered — prove it independently.
    const authoritativeReason = getGuardFailureReason(STORY_ID, store, 'INIT_CHECK', root);
    assert.ok(authoritativeReason, 'tampered init-check: the real gate must BLOCK (getGuardFailureReason !== null)');
    assert.match(authoritativeReason!, /init_check_tampered/, 'real gate blocks specifically on init_check_tampered');

    const report = handler!({ storyId: STORY_ID, json: true }) as InitPreflightReport;

    // The init-check ROW must be [STALE], NOT [PASS] (mirror init_check_tampered).
    assert.equal(statusOf(report, 'init-check'), 'STALE', 'tampered init-check row is STALE, not PASS');
    // Scope side still PASSes alongside the tampered init-check.
    assert.equal(statusOf(report, 'scope-boundary'), 'PASS', 'tampered init-check: scope-boundary still PASS');
    assert.equal(statusOf(report, 'execution-boundary'), 'PASS', 'tampered init-check: execution-boundary still PASS');
    assert.equal(statusOf(report, 'scope-freeze-check'), 'PASS', 'tampered init-check: scope-freeze-check still PASS');

    // The gate MUST be BLOCKED (the bug was gate.ready:true here) and MUST agree
    // with the authoritative function — this is the assertion that breaks the old code.
    assert.equal(report.gate.ready, false, 'tampered init-check: preflight gate is BLOCKED (was the bug: ready:true)');
    assertAgreement(report, store, root, 'tampered init-check');
    assert.equal(report.gate.blockedBy, authoritativeReason, 'blockedBy is the authoritative init_check_tampered reason verbatim');

    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /\[STALE\] init-check/);
    assert.match(text, /gate: BLOCKED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (b) agreement on a boundaries-only fixture (scope present, no freeze) --

{
  const { root, store, ctx } = createFixture((_r, s) => {
    writeGoodBoundaries(s);
    // no freeze, no init-check → gate blocked at missing_scope_freeze_check.
  });
  try {
    const handler = createMainRegistry(ctx).get('init_preflight');
    const report = handler!({ storyId: STORY_ID, json: true }) as InitPreflightReport;
    assert.equal(statusOf(report, 'scope-boundary'), 'PASS', 'boundaries-only: scope-boundary PASS');
    assert.equal(statusOf(report, 'execution-boundary'), 'PASS', 'boundaries-only: execution-boundary PASS');
    assert.equal(statusOf(report, 'scope-freeze-check'), 'MISSING', 'boundaries-only: freeze-check MISSING');
    assert.equal(statusOf(report, 'init-check'), 'MISSING', 'boundaries-only: init-check MISSING');
    assertAgreement(report, store, root, 'boundaries-only');
    assert.equal(report.gate.ready, false, 'boundaries-only gate is BLOCKED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('init_preflight smoke passed\n');
