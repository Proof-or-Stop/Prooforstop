#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { Finding, StoryInfo, StoryPhase } from '../core/types.js';
import { checkConvergence } from './gap-analyze.js';

const tmp = mkdtempSync(join(tmpdir(), 'koala-convergence-discarded-'));
const auditStoryId = 'B-META-framework-audit';

function story(storyId: string, phase: StoryPhase): StoryInfo {
  const now = new Date().toISOString();
  return {
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

  const store = new StoryStore(tmp);
  store.writeStory('B-done', story('B-done', 'DONE'));
  store.writeStory('B-discarded', story('B-discarded', 'DISCARDED'));
  store.writeStory(auditStoryId, story(auditStoryId, 'META'));

  const terminalOnly = checkConvergence(tmp, store);
  const terminalStoryCheck = checkByName(terminalOnly, '所有 Story 完成');
  assert.equal(terminalStoryCheck?.passed, true);
  assert.doesNotMatch(terminalStoryCheck.detail, new RegExp(auditStoryId));

  store.writeStory('B-init', story('B-init', 'INIT'));

  const withInit = checkConvergence(tmp, store);
  const initStoryCheck = checkByName(withInit, '所有 Story 完成');
  assert.equal(initStoryCheck.passed, false);
  assert.match(initStoryCheck.detail, /B-init/);
  assert.doesNotMatch(initStoryCheck.detail, /B-discarded/);
  assert.doesNotMatch(initStoryCheck.detail, new RegExp(auditStoryId));

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
