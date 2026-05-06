#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { collectProject, renderProject } from '../dashboard.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo, StorySummaryData } from '../core/types.js';
import { buildVerificationCoverage, renderVerificationCoverage } from '../core/verification.js';
import { createSessionHandlers } from '../handlers/session.js';
import { createSummaryHandlers } from '../handlers/summary.js';

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function configureRoot(root: string): void {
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  resetConfigCache();
}

function makeStory(storyId: string, phase: StoryInfo['phase'] = 'DONE'): StoryInfo {
  const now = '2026-05-06T12:00:00.000Z';
  return {
    storyId,
    name: storyId.toLowerCase(),
    title: `${storyId} outcome smoke`,
    description: 'Synthetic story for outcome semantics smoke coverage.',
    type: 'feature',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: phase === 'DONE' ? now : null,
    events: [{ phase, action: 'advance', timestamp: now }],
  };
}

function makeSummary(storyId: string, outcomeKind?: StorySummaryData['outcomeKind']): StorySummaryData {
  return {
    storyId,
    changes: 'Synthetic outcome semantics change summary',
    usage: 'Run the smoke task to verify outcome wording',
    expectedOutcome: 'User sees separate lifecycle and outcome semantics',
    actualTranscript: 'Lifecycle and outcome counts are rendered separately',
    outcomeDiff: 'No difference remains',
    acceptanceVerdict: 'accepted',
    ...(outcomeKind ? { outcomeKind } : {}),
    realMachineCoverage: { ran: [], skipped: [] },
    limitations: 'none — smoke fixture',
    pitfalls: 'Keep DONE lifecycle distinct from outcome success',
    createdAt: '2026-05-06T12:00:00.000Z',
    updatedAt: '2026-05-06T12:00:00.000Z',
  };
}

function schemaFor(name: string) {
  const tool = MAIN_TOOLS.find(t => t.name === name);
  assert.ok(tool, `missing tool schema: ${name}`);
  return z.object(tool.schema);
}

function assertOutcomeDashboard(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-outcome-dashboard-'));
  try {
    configureRoot(root);
    const store = new StoryStore(root);
    store.writeStory('B-success', makeStory('B-success'));
    store.writeSummary('B-success', makeSummary('B-success', 'success'));
    store.writeStory('B-blocked', makeStory('B-blocked'));
    store.writeSummary('B-blocked', makeSummary('B-blocked', 'blocked'));
    store.writeStory('B-audit', makeStory('B-audit'));
    store.writeSummary('B-audit', makeSummary('B-audit', 'audit_only'));
    store.writeStory('B-legacy', makeStory('B-legacy'));

    const snapshot = collectProject(root);
    const dashboard = renderProject(snapshot, 0, true).join('\n');
    assert.match(dashboard, /Lifecycle DONE: 4\/4 \(100%\)/);
    assert.match(dashboard, /DONE-success\/default=2/);
    assert.match(dashboard, /DONE-blocked=1/);
    assert.match(dashboard, /DONE-audit-only=1/);
    assert.doesNotMatch(dashboard, /^\s+\d+\/\d+ DONE \(\d+%\)/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSessionDashboardAndAuthorityWording(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-outcome-session-'));
  try {
    configureRoot(root);
    const store = new StoryStore(root);
    store.writeStory('B-smoke', makeStory('B-smoke', 'INIT_CHECK'));
    store.writeChecklist('B-smoke', { items: [] });
    write(root, 'packages/main/src/index.ts', 'export {};\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['worktree', 'add', '-b', 'story/B-smoke', '.worktrees/B-smoke']);

    resetConfigCache();
    const linkedStore = new StoryStore(join(root, '.worktrees/B-smoke'));
    linkedStore.writeStory('B-smoke', makeStory('B-smoke', 'REVIEW'));
    linkedStore.writeChecklist('B-smoke', { items: [] });

    resetConfigCache();
    const brief = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).session_brief();

    assert.match(brief, /Lifecycle DONE: 0\/1 \(0%\)/);
    assert.match(brief, /outcomes: DONE-success\/default=0 DONE-blocked=0 DONE-audit-only=0/);
    assert.match(brief, /worktree phase REVIEW is authoritative; main metadata mirror is lagging at INIT_CHECK/);
    assert.doesNotMatch(brief, /main metadata still says/);
    assert.doesNotMatch(brief, /^\*\*Dashboard\*\*: \d+\/\d+ DONE \(\d+%\)/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSummaryOutcomeKind(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-outcome-summary-'));
  try {
    configureRoot(root);
    const store = new StoryStore(root);
    store.writeStory('B-summary', makeStory('B-summary', 'TEST'));
    const handlers = createSummaryHandlers({ store, root, scanRoot: join(root, 'packages/main') });

    for (const outcomeKind of ['success', 'blocked', 'audit_only'] as const) {
      const output = handlers.summary_set({
        storyId: 'B-summary',
        changes: 'Summary outcomeKind smoke changes',
        usage: 'Call summary_set with an explicit outcomeKind',
        expectedOutcome: 'User sees explicit terminal outcome semantics',
        actualTranscript: 'summary_get returns the explicit terminal outcome',
        outcomeDiff: 'No gap',
        acceptanceVerdict: 'accepted',
        outcomeKind,
        limitations: 'none — smoke fixture',
        pitfalls: 'Do not collapse blocked outcomes into success wording',
      });
      assert.match(output, new RegExp(`outcome:\\s+${outcomeKind === 'audit_only' ? 'audit-only' : outcomeKind}`));
      assert.equal((handlers.summary_get({ storyId: 'B-summary' }) as StorySummaryData).outcomeKind, outcomeKind);
    }

    const invalid = schemaFor('summary_set').safeParse({
      storyId: 'B-invalid',
      changes: 'Summary outcomeKind smoke changes',
      usage: 'Call summary_set with an explicit outcomeKind',
      limitations: 'none — smoke fixture',
      pitfalls: 'Invalid outcomeKind should stop before writing metadata',
      outcomeKind: 'maybe',
    });
    assert.equal(invalid.success, false);
    assert.match(JSON.stringify(invalid.error.issues), /success|blocked|audit_only/);
    assert.equal(store.readSummary('B-invalid'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertVerificationEvidenceVerdict(): void {
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Classify blocked evidence',
      status: 'done',
      startTime: null,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: 'Failure is classified without being hidden', type: 'cli', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
      verificationEvidence: [{
        intentRef: 'CHK-001:happy:0',
        kind: 'integration_test',
        verdict: 'blocked_classified',
        result: 'fail',
        note: 'The failure is classified, but the gate must still see result=fail.',
      }],
    }],
  };

  const parsed = schemaFor('verification_evidence_add').safeParse({
    storyId: 'B-smoke',
    itemId: 'CHK-001',
    intentRef: 'CHK-001:happy:0',
    kind: 'integration_test',
    verdict: 'blocked_classified',
    result: 'pass',
    note: 'Schema accepts explicit verdict values.',
  });
  assert.equal(parsed.success, true);

  const coverage = buildVerificationCoverage(checklist);
  assert.equal(coverage.entries[0]?.status, 'failed');
  assert.equal(coverage.missingRequired, 1);
  assert.match(renderVerificationCoverage(coverage), /verdict=blocked_classified/);
}

assertOutcomeDashboard();
assertSessionDashboardAndAuthorityWording();
assertSummaryOutcomeKind();
assertVerificationEvidenceVerdict();

console.log('outcome semantics smoke passed');
