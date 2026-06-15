#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProcessEvent } from '../core/types.js';
import {
  computeDecisionDocMaterialDigest,
  evaluateDecisionDocQuorum,
  formatDecisionDocQuorumFailure,
  listChangedDecisionDocs,
} from '../core/decision-doc-quorum.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'decision-doc-quorum-'));
  write(root, 'README.md', 'decision-doc quorum smoke\n');
  write(root, 'docs/requirements/decisions/unchanged.md', '# Unchanged\n');
  write(root, 'docs/requirements/decisions/nested/ignored.md', '# Nested ignored\n');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.invalid']);
  git(root, ['config', 'user.name', 'Decision Doc Quorum Smoke']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  git(root, ['checkout', '-B', 'story/B-decision-doc-quorum']);
  return root;
}

function verdict(runId: string, hostId: string, materialDigest: string, overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    type: 'host_verdict',
    timestamp: '2026-06-13T12:00:00.000Z',
    verdictId: `${runId}-${hostId}`,
    runId,
    hostId,
    provider: hostId,
    decision: 'pass',
    materialDigest,
    ...overrides,
  };
}

function validEvents(materialDigest: string): ProcessEvent[] {
  return [
    verdict('round-1', 'codex-a', materialDigest),
    verdict('round-1', 'claude-a', materialDigest),
    verdict('round-2', 'codex-b', materialDigest),
    verdict('round-2', 'claude-b', materialDigest),
    verdict('round-3', 'codex-c', materialDigest),
    verdict('round-3', 'claude-c', materialDigest),
  ];
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const root = makeRepo();
try {
  check('no decision-doc changes is not applicable and does not block', () => {
    const report = evaluateDecisionDocQuorum({ projectRoot: root, processEvents: [] });
    assert.equal(report.ok, true);
    assert.equal(report.applicable, false);
    assert.deepEqual(report.changedFiles, []);
  });

  write(root, 'docs/requirements/decisions/quorum.md', '# Quorum\n\nMaterial change.\n');
  git(root, ['add', 'docs/requirements/decisions/quorum.md']);
  git(root, ['commit', '-m', 'change decision doc']);
  const changedFiles = listChangedDecisionDocs(root);
  const materialDigest = computeDecisionDocMaterialDigest(root, changedFiles);

  check('valid three-round two-host fresh-digest diagnostic quorum passes', () => {
    const report = evaluateDecisionDocQuorum({ projectRoot: root, processEvents: validEvents(materialDigest) });
    assert.equal(report.applicable, true);
    assert.equal(report.ok, true);
    assert.equal(report.materialDigest, materialDigest);
    assert.deepEqual(report.changedFiles.map(f => f.path), ['docs/requirements/decisions/quorum.md']);
    assert.equal(report.validRounds.length, 3);
    assert.equal(report.validRounds.every(round => round.passingHostIds.length === 2), true);
  });

  check('decision-doc diagnostic wording does not claim DONE is blocked', () => {
    const report = evaluateDecisionDocQuorum({ projectRoot: root, processEvents: [] });
    const text = formatDecisionDocQuorumFailure(report);
    assert.equal(text.includes('Cannot enter DONE'), false);
    assert.equal(text.includes('classification/diagnostic only') || text.includes('diagnostic only'), true);
    assert.equal(text.includes('review_escalation_status'), true);
  });

  check('duplicate hosts do not satisfy a round', () => {
    const events = [
      verdict('round-1', 'codex-a', materialDigest),
      verdict('round-1', 'codex-a', materialDigest, { verdictId: 'duplicate-host' }),
      ...validEvents(materialDigest).filter(event => event.runId !== 'round-1'),
    ];
    const report = evaluateDecisionDocQuorum({ projectRoot: root, processEvents: events });
    assert.equal(report.ok, false);
    assert.equal(report.validRounds.length, 2);
    assert.equal(report.invalidRounds[0]?.runId, 'round-1');
    assert.equal(report.ignoredVerdicts.some(v => v.reasons.some(reason => reason.includes('duplicate hostId'))), true);
  });

  check('duplicate run ids count as one round, not three', () => {
    const report = evaluateDecisionDocQuorum({
      projectRoot: root,
      processEvents: [
        verdict('same-round', 'host-a', materialDigest),
        verdict('same-round', 'host-b', materialDigest),
        verdict('same-round', 'host-c', materialDigest),
        verdict('same-round', 'host-d', materialDigest),
      ],
    });
    assert.equal(report.ok, false);
    assert.equal(report.validRounds.length, 1);
    assert.equal(report.missing.rounds, 2);
  });

  check('stale digest and prose-only events are ignored', () => {
    const stale = 'stale-digest';
    const report = evaluateDecisionDocQuorum({
      projectRoot: root,
      processEvents: [
        { type: 'review_pass', timestamp: '2026-06-13T12:00:00.000Z', note: 'Looks good in prose' } as ProcessEvent,
        ...validEvents(stale),
      ],
    });
    assert.equal(report.ok, false);
    assert.equal(report.validRounds.length, 0);
    assert.equal(report.ignoredVerdicts.length, 7);
    assert.equal(formatDecisionDocQuorumFailure(report).includes('materialDigest mismatch'), true);
  });

  check('non-pass decisions do not count as passing hosts', () => {
    const events = validEvents(materialDigest);
    events[1] = verdict('round-1', 'claude-a', materialDigest, { decision: 'fail' });
    const report = evaluateDecisionDocQuorum({ projectRoot: root, processEvents: events });
    assert.equal(report.ok, false);
    assert.equal(report.invalidRounds[0]?.runId, 'round-1');
    assert.equal(report.ignoredVerdicts.some(v => v.decision === 'fail'), true);
  });

  console.log(`\ndecision-doc-quorum smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
