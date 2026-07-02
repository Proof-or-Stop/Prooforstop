#!/usr/bin/env node
/**
 * B-521d smoke: read-only playbook_promotion_observe.
 *
 * Runs in OS temp projects. Empty-store observation must not create
 * `.lattice/learning` or any other `.lattice` directory.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import type {
  Playbook,
  PlaybookOutcomeEvent,
  PlaybookPromotionDecisionRow,
  PlaybookPromotionObserveReport,
} from '../core/experience-layer-types.js';
import {
  aggregatePlaybookPromotion,
  appendPlaybookOutcomeEvent,
  appendPlaybookPromotionDecision,
  computePlaybookDigest,
  markNonDeducibleSource,
  readPlaybooks,
  writePlaybooks,
} from '../core/learning-store.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from '../handlers/context.js';
import { createPlaybookHandlers } from '../handlers/playbook.js';

const NOW = '2026-07-02T00:00:00.000Z';
const SINCE_ISO = '2026-07-01T00:00:00.000Z';

let total = 0;
let passed = 0;

function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} - PASS`);
  } catch (err) {
    console.error(`check: ${label} - FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf-8');
}

function mkProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'b521d-playbook-observe-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return root;
}

function mkCtx(root: string): HandlerContext {
  resetConfigCache();
  const store = new StoryStore(root);
  const config = loadConfig(root);
  return { store, root, scanRoot: join(root, config.scanRoot), log: () => {} };
}

function candidate(id: string): Playbook {
  const suffix = id.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  return {
    id,
    title: `Candidate ${id}`,
    trigger: {
      keywords: ['promotion', suffix],
      fileKinds: ['ts'],
      storyPhases: ['REVIEW'],
    },
    check: `Check candidate ${id}`,
    pitfalls: [`Pitfall ${id}`],
    verification: [`Verify ${id}`],
    lineage: {
      sourceStoryId: `B-${suffix}`,
      sourceFindingId: `B-${suffix}:F-001`,
      sourceSignature: `sig-${suffix}`,
    },
    status: 'candidate',
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function outcome(
  playbook: Playbook,
  overrides: Partial<{
    eventId: string;
    idempotencyKey: string;
    observedAt: string;
    playbookStatusAtObservation: 'candidate' | 'active';
    exposureMode: 'candidate-inspection' | 'active-advisory' | 'none';
    verdict: 'helped' | 'neutral' | 'dismissed' | 'harmful' | 'unknown';
    verdictSource: string;
  }> = {},
): PlaybookOutcomeEvent {
  const eventId = overrides.eventId ?? `PBO-${playbook.id}-${overrides.exposureMode ?? 'candidate'}`;
  const verdict = overrides.verdict ?? 'helped';
  return {
    schemaVersion: 'proofbound.playbook-outcome.v1',
    eventId,
    idempotencyKey: overrides.idempotencyKey ?? eventId,
    observedAt: overrides.observedAt ?? NOW,
    storyId: 'B-observe',
    playbookId: playbook.id,
    playbookStatusAtObservation: overrides.playbookStatusAtObservation ?? 'candidate',
    exposureMode: overrides.exposureMode ?? 'candidate-inspection',
    consumer: 'observe-smoke',
    context: {
      storyPhase: 'REVIEW',
      storyType: 'chore',
      fileKinds: ['ts'],
      triggerClasses: [eventId],
      host: 'host-neutral-smoke',
    },
    outcome: {
      verdict,
      verdictSource: overrides.verdictSource ?? 'reviewer',
      causedNoise: verdict === 'dismissed',
      causedWrongClaim: verdict === 'harmful',
      preventedRepeatFinding: verdict === 'helped',
      note: `observe smoke ${eventId}`,
    },
    bindings: {},
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function decision(
  playbook: Playbook,
  action: PlaybookPromotionDecisionRow['action'] = 'recommend_activate',
  decidedAt = NOW,
): PlaybookPromotionDecisionRow {
  const aggregate = aggregatePlaybookPromotion(playbook, [], []);
  return {
    schemaVersion: 'proofbound.playbook-promotion-decision.v1',
    decisionId: `PBD-${playbook.id}-${action}`,
    idempotencyKey: `observe:${playbook.id}:${action}:${aggregate.aggregateDigest}`,
    decidedAt,
    playbookId: playbook.id,
    evaluatedStatus: playbook.status,
    action,
    reasonCodes: action === 'recommend_activate' ? ['activation_threshold_met'] : [`seed_${action}`],
    aggregateDigest: aggregate.aggregateDigest,
    aggregate,
    before: {
      playbookStatus: playbook.status,
      playbookDigest: computePlaybookDigest(playbook),
      sourceKey: aggregate.source.sourceKey,
    },
    after: {
      playbookStatus: playbook.status,
      recommendation: action,
      ...(action === 'mark_non_deducible' ? { nonDeducibleSourceKey: aggregate.source.sourceKey } : {}),
    },
    workerVersion: 'playbook-promotion-worker-v1',
    dryRun: false,
    applied: true,
    alreadyApplied: false,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function observe(ctx: HandlerContext, args: { since?: string } = {}): PlaybookPromotionObserveReport {
  const handlers = createPlaybookHandlers(ctx);
  return JSON.parse(handlers.playbook_promotion_observe({ ...args, json: true })) as PlaybookPromotionObserveReport;
}

const roots: string[] = [];

try {
  check('empty store is read-only and supports relative since', () => {
    const root = mkProject(); roots.push(root);
    const ctx = mkCtx(root);
    assert.equal(existsSync(join(root, '.lattice')), false, 'fresh project starts with no .lattice dir');
    const report = observe(ctx);
    assert.equal(report.candidateGenerated.currentCandidates, 0);
    assert.equal(report.candidateGenerated.count, 0);
    assert.equal(report.candidateConsumed.consumedCandidateCount, 0);
    assert.equal(report.candidateConsumed.count, 0);
    assert.equal(report.recommendationHandling.actionableCount, 0);
    assert.equal(report.authority, 'non_authoritative');
    assert.equal(report.gateEvidence, false);
    assert.equal(existsSync(join(root, '.lattice')), false, 'observe creates no .lattice dir on empty store');
    const relative = observe(ctx, { since: '14d' });
    assert.equal(relative.since.mode, 'relative');
    assert.equal(relative.since.input, '14d');
    assert.equal(existsSync(join(root, '.lattice')), false, 'relative observe also creates no files');
  });

  check('synthetic candidate generation is current candidate existence only', () => {
    const root = mkProject(); roots.push(root);
    const ctx = mkCtx(root);
    const pb = candidate('PB-OBS-001');
    writePlaybooks(root, [pb]);
    const report = observe(ctx, { since: SINCE_ISO });
    assert.equal(report.candidateGenerated.currentCandidates, 1);
    assert.equal(report.candidateGenerated.count, 1);
    assert.equal(report.candidateGenerated.candidates[0].playbookId, pb.id);
    assert.equal(report.candidateGenerated.candidates[0].status, 'candidate');
    assert.equal(report.candidateConsumed.consumedCandidateCount, 0, 'candidate existence alone is not consumption/help');
    assert.equal(report.candidateConsumed.count, 0, 'candidate existence alone is not consumption/help');
    const text = createPlaybookHandlers(ctx).playbook_promotion_observe({ since: SINCE_ISO });
    assert.match(text, /candidateGenerated\.currentCandidates: 1/);
    assert.match(text, /candidateConsumed\.consumedCandidateCount: 0/);
  });

  check('explicit candidate consumption counts and exposureMode none is excluded', () => {
    const root = mkProject(); roots.push(root);
    const ctx = mkCtx(root);
    const pb = candidate('PB-OBS-002');
    writePlaybooks(root, [pb]);
    appendPlaybookOutcomeEvent(root, outcome(pb, { eventId: 'PBO-consumed', exposureMode: 'candidate-inspection', verdict: 'helped' }));
    appendPlaybookOutcomeEvent(root, outcome(pb, { eventId: 'PBO-none', exposureMode: 'none', verdict: 'neutral' }));
    appendPlaybookOutcomeEvent(root, outcome(pb, { eventId: 'PBO-active', playbookStatusAtObservation: 'active', exposureMode: 'active-advisory', verdict: 'helped' }));
    appendPlaybookOutcomeEvent(root, outcome(pb, { eventId: 'PBO-old', observedAt: '2026-06-01T00:00:00.000Z', exposureMode: 'candidate-inspection', verdict: 'helped' }));

    const report = observe(ctx, { since: SINCE_ISO });
    assert.equal(report.candidateConsumed.consumedCandidateCount, 1);
    assert.equal(report.candidateConsumed.count, 1);
    assert.equal(report.candidateConsumed.rows[0].eventId, 'PBO-consumed');
    assert.equal(report.candidateConsumed.uniquePlaybookCount, 1);
    assert.equal(report.candidateConsumed.excluded.exposureModeNone, 1);
    assert.equal(report.candidateConsumed.excluded.nonCandidateStatus, 1);
    assert.equal(report.candidateConsumed.excluded.outsideSince, 1);
  });

  check('unhandled recommend_activate remains unhandled while candidate stays candidate', () => {
    const root = mkProject(); roots.push(root);
    const ctx = mkCtx(root);
    const pb = candidate('PB-OBS-003');
    writePlaybooks(root, [pb]);
    appendPlaybookPromotionDecision(root, decision(pb));

    const report = observe(ctx, { since: SINCE_ISO });
    assert.equal(report.recommendationHandling.actionableCount, 1);
    assert.equal(report.recommendationHandling.handledCount, 0);
    assert.equal(report.recommendationHandling.unhandledCount, 1);
    assert.equal(report.recommendationHandling.recommendations[0].handlingStatus, 'unhandled');
    assert.equal(report.recommendationHandling.recommendations[0].handledBy, 'current_status_still_candidate');
  });

  check('reject/archive/mark_non_deducible are actionable while hold is non-actionable', () => {
    const root = mkProject(); roots.push(root);
    const ctx = mkCtx(root);
    const rejectPb = candidate('PB-OBS-010');
    const archivePb = candidate('PB-OBS-011');
    const markPb = candidate('PB-OBS-012');
    const holdPb = candidate('PB-OBS-013');
    writePlaybooks(root, [rejectPb, archivePb, markPb, holdPb]);
    appendPlaybookPromotionDecision(root, decision(rejectPb, 'reject'));
    appendPlaybookPromotionDecision(root, decision(archivePb, 'archive'));
    appendPlaybookPromotionDecision(root, decision(markPb, 'mark_non_deducible'));
    appendPlaybookPromotionDecision(root, decision(holdPb, 'hold'));

    const report = observe(ctx, { since: SINCE_ISO });
    assert.equal(report.recommendationHandling.actionableCount, 3);
    assert.equal(report.recommendationHandling.handledCount, 0);
    assert.equal(report.recommendationHandling.unhandledCount, 3);
    assert.equal(report.recommendationHandling.excluded.nonActionableAction, 1);
    const byAction = new Map(report.recommendationHandling.recommendations.map((row) => [row.action, row]));
    assert.equal(byAction.get('reject')?.handledBy, 'current_status_still_candidate');
    assert.equal(byAction.get('archive')?.handledBy, 'current_status_still_candidate');
    assert.equal(byAction.get('mark_non_deducible')?.handledBy, 'non_deducible_source_missing');
    assert.equal(new Set(report.recommendationHandling.recommendations.map((row) => row.action as string)).has('hold'), false);
  });

  check('reject/archive/mark_non_deducible are handled by status update or registry entry', () => {
    const root = mkProject(); roots.push(root);
    const ctx = mkCtx(root);
    const rejectPb = candidate('PB-OBS-020');
    const archivePb = candidate('PB-OBS-021');
    const markPb = candidate('PB-OBS-022');
    writePlaybooks(root, [rejectPb, archivePb, markPb]);
    appendPlaybookPromotionDecision(root, decision(rejectPb, 'reject'));
    appendPlaybookPromotionDecision(root, decision(archivePb, 'archive'));
    appendPlaybookPromotionDecision(root, decision(markPb, 'mark_non_deducible'));
    writePlaybooks(root, readPlaybooks(root).map((row) =>
      row.id === rejectPb.id ? { ...row, status: 'archived' as const }
        : row.id === archivePb.id ? { ...row, status: 'stale' as const }
          : row));
    const source = aggregatePlaybookPromotion(markPb, [], []).source;
    markNonDeducibleSource(root, {
      source,
      reasonCodes: ['source_rejected_sibling_threshold'],
      reason: 'observe smoke registry fixture',
      sourceRejectedSiblingCount: 3,
      markedAt: NOW,
    });

    const report = observe(ctx, { since: SINCE_ISO });
    assert.equal(report.recommendationHandling.actionableCount, 3);
    assert.equal(report.recommendationHandling.handledCount, 3);
    assert.equal(report.recommendationHandling.unhandledCount, 0);
    const byAction = new Map(report.recommendationHandling.recommendations.map((row) => [row.action, row]));
    assert.equal(byAction.get('reject')?.handledBy, 'current_status_archived');
    assert.equal(byAction.get('archive')?.handledBy, 'current_status_stale');
    assert.equal(byAction.get('mark_non_deducible')?.handledBy, 'non_deducible_after_source_key_present');
  });

  check('recommend_activate is handled after explicit activation or status update', () => {
    const root = mkProject(); roots.push(root);
    const ctx = mkCtx(root);
    const activate = candidate('PB-OBS-004');
    const statusUpdate = candidate('PB-OBS-005');
    writePlaybooks(root, [activate, statusUpdate]);
    appendPlaybookPromotionDecision(root, decision(activate));
    appendPlaybookPromotionDecision(root, decision(statusUpdate));

    const handlers = createPlaybookHandlers(ctx);
    handlers.playbook_activate({ playbookId: activate.id, expectedPlaybookDigest: computePlaybookDigest(activate) });
    writePlaybooks(root, readPlaybooks(root).map((row) =>
      row.id === statusUpdate.id ? { ...row, status: 'archived' as const } : row));

    const report = observe(ctx, { since: SINCE_ISO });
    assert.equal(report.recommendationHandling.actionableCount, 2);
    assert.equal(report.recommendationHandling.handledCount, 2);
    assert.equal(report.recommendationHandling.unhandledCount, 0);
    const byId = new Map(report.recommendationHandling.recommendations.map((row) => [row.playbookId, row]));
    assert.equal(byId.get(activate.id)?.handledBy, 'current_status_active');
    assert.equal(byId.get(statusUpdate.id)?.handledBy, 'current_status_changed');
  });

  check('invalid since diagnostic names playbook_promotion_observe', () => {
    const root = mkProject(); roots.push(root);
    const ctx = mkCtx(root);
    const handlers = createPlaybookHandlers(ctx);
    assert.throws(
      () => handlers.playbook_promotion_observe({ since: 'not-a-window' }),
      /playbook_promotion_observe: since must be an ISO timestamp or relative duration like 14d/,
    );
  });

  check('command metadata is read-only L0 and host-neutral', () => {
    const names = MAIN_TOOLS.map((tool) => tool.name);
    assert.ok(names.includes('playbook_promotion_observe'));
    assert.equal(names.filter((name) => name.endsWith('playbook_promotion_observe')).length, 1);
    assert.equal(names.includes('codex_playbook_promotion_observe'), false);
    assert.equal(names.includes('playbook_codex_promotion_observe'), false);
    assert.equal(COMMAND_POLICIES.playbook_promotion_observe.ownershipClass, 'readOnly');
    assert.equal(COMMAND_POLICIES.playbook_promotion_observe.destructiveRisk, 'none');
    assert.ok(PROCESS_FACT_LEVELS.some((fact) => fact.name === 'playbook_promotion_observe' && fact.level === 'L0'));
  });
} finally {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.exitCode === 1) {
  console.error(`smoke failed: TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
} else {
  console.log(`smoke passed: TOTAL ${total} | PASS ${passed} | FAIL 0`);
}
