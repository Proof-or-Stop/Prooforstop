#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { Finding, StoryInfo, StoryPhase } from '../core/types.js';
import { checkConvergence } from './gap-analyze.js';

const tmp = mkdtempSync(join(tmpdir(), 'koala-convergence-discarded-'));
const auditStoryId = 'B-META-framework-audit';

function story(storyId: string, phase: StoryPhase, options: { withWorktree?: boolean } = {}): StoryInfo {
  const now = new Date().toISOString();
  const info: StoryInfo = {
    storyId,
    name: storyId.toLowerCase(),
    title: `${storyId} smoke`,
    description: 'Smoke story for convergence terminal phase filtering.',
    type: 'chore',
    phase,
    priority: 'low',
    createdAt: now,
    startedAt: phase === 'DONE' || phase === 'DISCARDED' ? now : null,
    endedAt: phase === 'DONE' || phase === 'DISCARDED' ? now : null,
    events: [{ phase, action: phase === 'DONE' || phase === 'DISCARDED' ? 'advance' : 'create', timestamp: now }],
  };
  if (options.withWorktree) {
    info.worktree = {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: now,
    };
  }
  return info;
}

function finding(id: string, severity: Finding['severity'], evidenceState?: Finding['evidenceState']): Finding {
  return {
    id: `${auditStoryId}:${id}`,
    desc: `${id} audit smoke`,
    severity,
    category: 'missing',
    status: 'open',
    ...(evidenceState ? { evidenceState } : {}),
  };
}

function checkByName(result: ReturnType<typeof checkConvergence>, name: string) {
  const check = result.checks.find(entry => entry.name === name);
  assert.ok(check, `missing convergence check: ${name}`);
  return check;
}

function git(args: string[]): void {
  execFileSync('git', args, {
    cwd: tmp,
    stdio: 'ignore',
  });
}

try {
  mkdirSync(join(tmp, 'packages/main/src'), { recursive: true });
  writeFileSync(join(tmp, 'packages/main/src/empty.ts'), 'export const noop = true;\n');
  writeFileSync(join(tmp, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  resetConfigCache();
  git(['init']);
  git(['config', 'user.email', 'koala-smoke@example.invalid']);
  git(['config', 'user.name', 'Koala Smoke']);
  git(['add', 'koala.config.json', 'packages/main/src/empty.ts']);
  git(['commit', '-m', 'initial smoke project']);

  const store = new StoryStore(tmp);
  store.writeStory('B-done', story('B-done', 'DONE'));
  store.writeStory('B-discarded', story('B-discarded', 'DISCARDED'));
  store.writeStory(auditStoryId, story(auditStoryId, 'META'));

  const terminalOnly = checkConvergence(tmp, store);
  const terminalStoryCheck = checkByName(terminalOnly, 'All stories complete');
  assert.equal(terminalStoryCheck?.passed, true);
  assert.doesNotMatch(terminalStoryCheck.detail, new RegExp(auditStoryId));
  const emptyParkedBacklogCheck = checkByName(terminalOnly, 'Parked backlog');
  assert.equal(emptyParkedBacklogCheck.passed, true);
  assert.match(emptyParkedBacklogCheck.detail, /no parked backlog/);
  assert.equal(terminalOnly.converged, true);

  store.writeStory('B-parked', story('B-parked', 'INIT'));

  const withParked = checkConvergence(tmp, store);
  const parkedStoryCheck = checkByName(withParked, 'All stories complete');
  assert.equal(parkedStoryCheck.passed, true);
  assert.doesNotMatch(parkedStoryCheck.detail, /B-parked/);
  assert.doesNotMatch(parkedStoryCheck.detail, /B-discarded/);
  assert.doesNotMatch(parkedStoryCheck.detail, new RegExp(auditStoryId));
  const parkedBacklogCheck = checkByName(withParked, 'Parked backlog');
  assert.equal(parkedBacklogCheck.passed, true);
  assert.match(parkedBacklogCheck.detail, /B-parked/);
  assert.equal(withParked.converged, true);

  store.writeStory('B-active-worktree', story('B-active-worktree', 'PLAN', { withWorktree: true }));

  const withActiveWorktree = checkConvergence(tmp, store);
  const activeStoryCheck = checkByName(withActiveWorktree, 'All stories complete');
  assert.equal(activeStoryCheck.passed, false);
  assert.match(activeStoryCheck.detail, /B-active-worktree/);
  assert.doesNotMatch(activeStoryCheck.detail, /B-parked/);
  const activeParkedBacklogCheck = checkByName(withActiveWorktree, 'Parked backlog');
  assert.equal(activeParkedBacklogCheck.passed, true);
  assert.match(activeParkedBacklogCheck.detail, /B-parked/);

  store.writeStory('B-init-worktree', story('B-init-worktree', 'INIT', { withWorktree: true }));

  const withInitWorktree = checkConvergence(tmp, store);
  const initWorktreeStoryCheck = checkByName(withInitWorktree, 'All stories complete');
  assert.equal(initWorktreeStoryCheck.passed, false);
  assert.match(initWorktreeStoryCheck.detail, /B-active-worktree/);
  assert.match(initWorktreeStoryCheck.detail, /B-init-worktree/);
  assert.doesNotMatch(initWorktreeStoryCheck.detail, /B-parked/);

  const runtimeWorktreeStoryId = 'B-runtime-worktree';
  mkdirSync(join(tmp, '.worktrees'), { recursive: true });
  git(['worktree', 'add', '-b', `story/${runtimeWorktreeStoryId}`, join(tmp, '.worktrees', runtimeWorktreeStoryId)]);
  store.writeStory(runtimeWorktreeStoryId, story(runtimeWorktreeStoryId, 'INIT'));

  const withRuntimeWorktree = checkConvergence(tmp, store);
  const runtimeWorktreeStoryCheck = checkByName(withRuntimeWorktree, 'All stories complete');
  assert.equal(runtimeWorktreeStoryCheck.passed, false);
  assert.match(runtimeWorktreeStoryCheck.detail, new RegExp(runtimeWorktreeStoryId));
  const runtimeParkedBacklogCheck = checkByName(withRuntimeWorktree, 'Parked backlog');
  assert.equal(runtimeParkedBacklogCheck.passed, true);
  assert.doesNotMatch(runtimeParkedBacklogCheck.detail, new RegExp(runtimeWorktreeStoryId));
  assert.match(runtimeParkedBacklogCheck.detail, /B-parked/);

  store.writeFindings(auditStoryId, {
    findings: [
      finding('F-001', 'high', 'suspected'),
      finding('F-002', 'low', 'verified'),
      finding('F-003', 'medium', 'verified'),
    ],
  });
  const advisoryOnly = checkConvergence(tmp, store);
  const advisoryAuditCheck = checkByName(advisoryOnly, 'Audit backlog');
  assert.equal(advisoryAuditCheck.passed, true);
  assert.match(advisoryAuditCheck.detail, /3 advisory/);
  assert.match(advisoryAuditCheck.detail, /F-001/);
  assert.match(advisoryAuditCheck.detail, /F-002/);
  assert.match(advisoryAuditCheck.detail, /F-003/);

  store.writeFindings(auditStoryId, {
    findings: [
      finding('F-004', 'high', 'verified'),
      finding('F-005', 'critical', 'verified'),
    ],
  });
  const verifiedBlockers = checkConvergence(tmp, store);
  const verifiedAuditCheck = checkByName(verifiedBlockers, 'Audit backlog');
  assert.equal(verifiedAuditCheck.passed, false);
  assert.match(verifiedAuditCheck.detail, /2 blocking/);
  assert.match(verifiedAuditCheck.detail, /F-004/);
  assert.match(verifiedAuditCheck.detail, /F-005/);

  store.writeFindings(auditStoryId, {
    findings: [finding('F-006', 'high')],
  });
  const legacyBlocker = checkConvergence(tmp, store);
  const legacyAuditCheck = checkByName(legacyBlocker, 'Audit backlog');
  assert.equal(legacyAuditCheck.passed, false);
  assert.match(legacyAuditCheck.detail, /verified\(legacy\)/);

  console.log('✓ convergence discarded smoke passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
