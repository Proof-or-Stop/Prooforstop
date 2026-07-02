#!/usr/bin/env node
/**
 * B-6241 smoke: V1 playbook promotion worker loop (M3-M6 + M5.5 only).
 *
 * Runs in OS temp projects. It must not use the repository's live
 * `.lattice/learning` store and must not touch runtime-memory-index files.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import type { Playbook, PlaybookPromotionDecisionRow } from '../core/experience-layer-types.js';
import {
  aggregatePlaybookPromotion,
  appendPlaybookPromotionDecision,
  collectPlaybookPromotionLearningHealth,
  computePlaybookDigest,
  evaluatePlaybookPromotion,
  markNonDeducibleSource,
  readNonDeducibleSourcesRegistry,
  readPlaybookOutcomeEvents,
  readPlaybookPromotionDecisionRows,
  readPlaybooks,
  readProposal,
  resolvePlaybookPromotionDecisionsPath,
  resolvePlaybooksPath,
  validatePlaybookOutcomeEvent,
  validatePlaybookPromotionDecisionRow,
  writePlaybooks,
} from '../core/learning-store.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { RUNTIME_ARTIFACT_REGISTRY } from '../core/runtime-artifact-registry.js';
import { StoryStore } from '../core/store.js';
import type { Finding, StoryInfo } from '../core/types.js';
import { runPostDoneLearningSettlement } from '../handlers/done-effects.js';
import { createPlaybookHandlers } from '../handlers/playbook.js';
import type { HandlerContext } from '../handlers/context.js';

const NOW = '2026-07-02T00:00:00.000Z';

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
  const root = mkdtempSync(join(tmpdir(), 'b6241-playbook-promotion-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return root;
}

function newStory(storyId: string): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: storyId,
    description: 'B-6241 promotion smoke story',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: NOW }],
  };
}

function mkCtx(root: string): { ctx: HandlerContext; store: StoryStore } {
  resetConfigCache();
  const store = new StoryStore(root);
  const config = loadConfig(root);
  return { store, ctx: { store, root, scanRoot: join(root, config.scanRoot), log: () => {} } };
}

function finding(storyId: string, suffix: string, signature = 'promotion-worker'): Finding {
  return {
    id: `${storyId}:F-${suffix}`,
    desc: `repeatable process gap ${suffix} should become a concrete playbook`,
    severity: 'high',
    category: 'missing',
    status: 'resolved',
    createdAt: NOW,
    reviewRound: 'R-1',
    files: [`src/${suffix}.ts`],
    signatureTag: signature,
  };
}

function seed(store: StoryStore, storyId: string, findings: Finding[]): void {
  store.writeStory(storyId, newStory(storyId));
  store.writeChecklist(storyId, { items: [] });
  store.writeFindings(storyId, { findings });
}

function approve(root: string, handlers: ReturnType<typeof createPlaybookHandlers>, f: Finding): Playbook {
  const out = handlers.playbook_propose({ finding: f.id });
  const proposalId = out.match(/proposal (\S+) staged/)![1];
  const proposal = readProposal(root, proposalId);
  assert.ok(proposal, 'proposal exists');
  handlers.playbook_approve({ proposalId, expectedProposalDigest: proposal.proposalDigest });
  const playbook = readPlaybooks(root).find((row) => row.id === proposalId);
  assert.ok(playbook, 'candidate exists');
  return playbook!;
}

function recordOutcome(
  handlers: ReturnType<typeof createPlaybookHandlers>,
  storyId: string,
  playbook: Playbook,
  suffix: string,
  verdict: 'helped' | 'neutral' | 'dismissed' | 'harmful' | 'unknown',
  extra: Partial<{
    exposureMode: 'candidate-inspection' | 'active-advisory' | 'none';
    causedWrongClaim: boolean;
    causedNoise: boolean;
    fileKinds: string[];
    triggerClasses: string[];
  }> = {},
): void {
  handlers.playbook_outcome_record({
    storyId,
    playbookId: playbook.id,
    exposureMode: extra.exposureMode ?? (playbook.status === 'active' ? 'active-advisory' : 'candidate-inspection'),
    consumer: 'reviewer',
    context: {
      storyPhase: 'REVIEW',
      storyType: 'chore',
      fileKinds: extra.fileKinds ?? ['ts'],
      triggerClasses: extra.triggerClasses ?? [`class-${suffix}`],
      host: `future-host-${suffix}`,
    },
    outcome: {
      verdict,
      verdictSource: 'reviewer',
      causedNoise: extra.causedNoise ?? verdict === 'dismissed',
      causedWrongClaim: extra.causedWrongClaim ?? false,
      preventedRepeatFinding: verdict === 'helped',
      note: `explicit ${verdict} ${suffix}`,
    },
    bindings: {},
    observedAt: `2026-07-02T00:00:0${suffix.length % 9}.000Z`,
    idempotencyKey: `${storyId}:${playbook.id}:${suffix}:${verdict}`,
  });
}

function decisionFor(root: string, playbook: Playbook, action: PlaybookPromotionDecisionRow['action']): PlaybookPromotionDecisionRow {
  const aggregate = aggregatePlaybookPromotion(playbook, [], []);
  return {
    schemaVersion: 'proofbound.playbook-promotion-decision.v1',
    decisionId: `PBD-${playbook.id}-${action}`,
    idempotencyKey: `seed:${playbook.id}:${action}:${aggregate.aggregateDigest}`,
    decidedAt: NOW,
    playbookId: playbook.id,
    evaluatedStatus: playbook.status,
    action,
    reasonCodes: [`seed_${action}`],
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

function storySnapshot(root: string): string {
  const dir = join(root, '.lattice', 'story');
  if (!existsSync(dir)) return '<missing>';
  const rows: string[] = [];
  function walk(current: string): void {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (existsSync(path) && readdirSyncSafe(path)) {
        walk(path);
      } else {
        rows.push(`${path.slice(root.length + 1)}::${readFileSync(path, 'utf-8')}`);
      }
    }
  }
  walk(dir);
  return rows.join('\n');
}

function readdirSyncSafe(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) prior[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const roots: string[] = [];

try {
  check('CHK-001: aggregate/evaluator recommend_activate, hold, reject, archive, demote, mark_non_deducible', () => {
    const root = mkProject(); roots.push(root);
    const { ctx, store } = mkCtx(root);
    const storyId = 'B-eval';
    const fs = ['001', '002', '003', '004', '005', '006', '007', '008', '009'].map((suffix) => finding(storyId, suffix, 'shared-source'));
    seed(store, storyId, fs);
    const h = createPlaybookHandlers(ctx);

    const promote = approve(root, h, fs[0]);
    recordOutcome(h, storyId, promote, 'a', 'helped', { triggerClasses: ['one'] });
    recordOutcome(h, storyId, promote, 'bb', 'helped', { triggerClasses: ['two'] });
    recordOutcome(h, storyId, promote, 'ccc', 'helped', { triggerClasses: ['two'] });
    const promoteAgg = aggregatePlaybookPromotion(promote, readPlaybookOutcomeEvents(root), []);
    assert.equal(promoteAgg.decisiveSamples, 3);
    assert.equal(evaluatePlaybookPromotion(promoteAgg).action, 'recommend_activate');

    const neutral = approve(root, h, fs[1]);
    recordOutcome(h, storyId, neutral, 'n', 'neutral');
    recordOutcome(h, storyId, neutral, 'u', 'unknown');
    const neutralAgg = aggregatePlaybookPromotion(neutral, readPlaybookOutcomeEvents(root), []);
    assert.equal(neutralAgg.decisiveSamples, 0);
    assert.equal(evaluatePlaybookPromotion(neutralAgg).action, 'hold');

    const harmful = approve(root, h, fs[2]);
    recordOutcome(h, storyId, harmful, 'h1', 'helped', { triggerClasses: ['one'] });
    recordOutcome(h, storyId, harmful, 'h2', 'helped', { triggerClasses: ['two'] });
    recordOutcome(h, storyId, harmful, 'bad', 'harmful', { causedWrongClaim: true, triggerClasses: ['three'] });
    const harmfulDecision = evaluatePlaybookPromotion(aggregatePlaybookPromotion(harmful, readPlaybookOutcomeEvents(root), []));
    assert.equal(harmfulDecision.action, 'reject');
    assert.ok(harmfulDecision.reasonCodes.includes('wrong_claim_present'));

    const stale = { ...approve(root, h, fs[3]), status: 'stale' as const };
    writePlaybooks(root, [...readPlaybooks(root).filter((row) => row.id !== stale.id), stale]);
    assert.equal(evaluatePlaybookPromotion(aggregatePlaybookPromotion(stale, [], [])).action, 'archive');

    const active = { ...approve(root, h, fs[4]), status: 'active' as const };
    writePlaybooks(root, [...readPlaybooks(root).filter((row) => row.id !== active.id), active]);
    recordOutcome(h, storyId, active, 'active-bad', 'harmful', { causedWrongClaim: true, exposureMode: 'active-advisory' });
    assert.equal(evaluatePlaybookPromotion(aggregatePlaybookPromotion(active, readPlaybookOutcomeEvents(root), [])).action, 'recommend_demote');

    const sibling1 = approve(root, h, fs[5]);
    const sibling2 = approve(root, h, fs[5]);
    const sibling3 = approve(root, h, fs[5]);
    for (const sibling of [sibling1, sibling2, sibling3]) appendPlaybookPromotionDecision(root, decisionFor(root, sibling, 'reject'));
    const current = approve(root, h, fs[5]);
    const currentAgg = aggregatePlaybookPromotion(current, [], readPlaybookPromotionDecisionRows(root).decisions);
    assert.equal(currentAgg.sourceRejectedSiblingCount, 3);
    assert.equal(evaluatePlaybookPromotion(currentAgg).action, 'mark_non_deducible');
    console.log(`mark_non_deducible playbook=${current.id} aggregateDigest=${currentAgg.aggregateDigest}`);
  });

  check('CHK-002: sweep dry-run writes nothing, apply is flag-gated/idempotent and never activates candidates', () => {
    const root = mkProject(); roots.push(root);
    const { ctx, store } = mkCtx(root);
    const storyId = 'B-sweep';
    const fs = ['001', '002', '003', '004', '005', '006'].map((suffix) => finding(storyId, suffix, `sig-${suffix}`));
    seed(store, storyId, fs);
    const h = createPlaybookHandlers(ctx);
    const promote = approve(root, h, fs[0]);
    recordOutcome(h, storyId, promote, 'p1', 'helped', { triggerClasses: ['one'] });
    recordOutcome(h, storyId, promote, 'p2', 'helped', { triggerClasses: ['two'] });
    recordOutcome(h, storyId, promote, 'p3', 'helped', { triggerClasses: ['three'] });
    const reject = approve(root, h, fs[1]);
    recordOutcome(h, storyId, reject, 'r1', 'harmful', { causedWrongClaim: true });
    const hold = approve(root, h, fs[2]);
    recordOutcome(h, storyId, hold, 'neutral', 'neutral');
    const active = { ...approve(root, h, fs[3]), status: 'active' as const };
    const stale = { ...approve(root, h, fs[4]), status: 'stale' as const };
    writePlaybooks(root, readPlaybooks(root).map((row) => row.id === active.id ? active : row.id === stale.id ? stale : row));
    recordOutcome(h, storyId, active, 'active-bad', 'harmful', { causedWrongClaim: true, exposureMode: 'active-advisory' });

    const storyBefore = storySnapshot(root);
    const decisionsBefore = readPlaybookPromotionDecisionRows(root).decisions.length;
    const dry = h.playbook_promotion_sweep({});
    console.log(dry);
    assert.match(dry, /dryRun: true/);
    assert.match(dry, /applied: false/);
    assert.match(dry, /recommend_activate/);
    assert.match(dry, /reject/);
    assert.match(dry, /hold/);
    assert.match(dry, /archive/);
    assert.match(dry, /recommend_demote/);
    assert.equal(readPlaybookPromotionDecisionRows(root).decisions.length, decisionsBefore);
    assert.equal(storySnapshot(root), storyBefore, 'dry-run writes no lifecycle files');
    assert.throws(() => h.playbook_promotion_sweep({ apply: true }), /PLAYBOOK_PROMOTION_SWEEP_ENABLED is disabled/);

    const applied = withEnv({ PLAYBOOK_PROMOTION_SWEEP_ENABLED: '1' }, () => h.playbook_promotion_sweep({ apply: true }));
    assert.match(applied, /applied: true/);
    assert.equal(readPlaybookPromotionDecisionRows(root).decisions.length, 5);
    assert.equal(readPlaybooks(root).find((row) => row.id === promote.id)!.status, 'candidate', 'recommend_activate never sets candidate active');
    assert.equal(storySnapshot(root), storyBefore, 'apply writes no lifecycle evidence');
    const repeated = withEnv({ PLAYBOOK_PROMOTION_SWEEP_ENABLED: 'yes' }, () => h.playbook_promotion_sweep({ apply: true }));
    assert.match(repeated, /alreadyApplied: true/);
    assert.equal(readPlaybookPromotionDecisionRows(root).decisions.length, 5, 'repeat apply appends no duplicate rows');
  });

  check('CHK-003: non-deducible registry guards playbook_propose with audited override', () => {
    const root = mkProject(); roots.push(root);
    const { ctx, store } = mkCtx(root);
    const storyId = 'B-guard';
    const f = finding(storyId, '001', 'guard-source');
    const unmarked = finding(storyId, '002', 'other-source');
    seed(store, storyId, [f, unmarked]);
    const h = createPlaybookHandlers(ctx);
    const unmarkedOut = h.playbook_propose({ finding: unmarked.id });
    assert.match(unmarkedOut, /proposal/);
    assert.match(unmarkedOut, /sourceKey: PBSRC-/);
    const proposalCountBefore = readdirSync(join(root, '.lattice', 'learning', 'proposals')).length;
    const lineage = { sourceStoryId: storyId, sourceFindingId: f.id, sourceSignature: f.signatureTag };
    const source = aggregatePlaybookPromotion(approve(root, h, f), [], []).source;
    markNonDeducibleSource(root, {
      source,
      reasonCodes: ['source_rejected_sibling_threshold'],
      reason: 'too local and not operationally checkable',
      sourceRejectedSiblingCount: 3,
      markedAt: NOW,
    });
    assert.equal(source.sourceStoryId, lineage.sourceStoryId);
    assert.equal(source.sourceFindingId, lineage.sourceFindingId);
    assert.equal(source.sourceSignature, lineage.sourceSignature);

    assert.throws(() => h.playbook_propose({ finding: f.id }), /source is marked non_deducible/);
    assert.equal(readdirSync(join(root, '.lattice', 'learning', 'proposals')).length, proposalCountBefore);
    assert.throws(
      () => h.playbook_propose({ finding: f.id, overrideNonDeducible: true, nonDeducibleOverrideReason: 'short' }),
      /override requires a useful reason/,
    );
    const override = h.playbook_propose({
      finding: f.id,
      overrideNonDeducible: true,
      nonDeducibleOverrideReason: 'new cross-story evidence makes this source useful now',
    });
    assert.match(override, /override accepted/);
    assert.match(override, /reasonDigest:/);
    const registry = readNonDeducibleSourcesRegistry(root);
    assert.equal(registry.sources[0].overrideEvents.length, 1);
  });

  check('CHK-004: post-DONE settlement is non-blocking, idempotent, learning-only, and no helped outcome', () => {
    const root = mkProject(); roots.push(root);
    const { ctx, store } = mkCtx(root);
    const storyId = 'B-settle';
    const f = finding(storyId, '001');
    seed(store, storyId, [f]);
    const h = createPlaybookHandlers(ctx);
    approve(root, h, f);
    const beforeOutcomes = readPlaybookOutcomeEvents(root).length;
    const disabled = withEnv({ PLAYBOOK_DONE_SETTLEMENT_ENABLED: undefined }, () => runPostDoneLearningSettlement(root, storyId));
    assert.equal(disabled.settlementStatus, 'disabled');
    assert.equal(existsSync(join(root, '.lattice', 'learning', 'playbook-promotion-health.jsonl')), false);
    const recorded = withEnv({ PLAYBOOK_DONE_SETTLEMENT_ENABLED: 'true' }, () => runPostDoneLearningSettlement(root, storyId));
    assert.equal(recorded.settlementStatus, 'recorded');
    const repeated = withEnv({ PLAYBOOK_DONE_SETTLEMENT_ENABLED: '1' }, () => runPostDoneLearningSettlement(root, storyId));
    assert.equal(repeated.alreadyApplied, true);
    assert.equal(readPlaybookOutcomeEvents(root).length, beforeOutcomes, 'DONE success alone creates no candidate helped outcome');
    const status = h.playbook_promotion_status({});
    assert.match(status, /settlementStatus: recorded/);
    assert.match(status, /gateEvidence: false/);
  });

  check('CHK-005: status shows pending learning, latest decisions, non-deducible sources, health, flags, not runtime guidance', () => {
    const root = mkProject(); roots.push(root);
    const { ctx, store } = mkCtx(root);
    const storyId = 'B-status';
    const fs = ['001', '002'].map((suffix) => finding(storyId, suffix));
    seed(store, storyId, fs);
    const h = createPlaybookHandlers(ctx);
    const candidate = approve(root, h, fs[0]);
    recordOutcome(h, storyId, candidate, 'p1', 'helped', { triggerClasses: ['one'] });
    recordOutcome(h, storyId, candidate, 'p2', 'helped', { triggerClasses: ['two'] });
    recordOutcome(h, storyId, candidate, 'p3', 'helped', { triggerClasses: ['three'] });
    const active = { ...approve(root, h, fs[1]), status: 'active' as const };
    writePlaybooks(root, readPlaybooks(root).map((row) => row.id === active.id ? active : row));
    recordOutcome(h, storyId, active, 'bad', 'harmful', { causedWrongClaim: true, exposureMode: 'active-advisory' });
    withEnv({ PLAYBOOK_PROMOTION_SWEEP_ENABLED: '1' }, () => h.playbook_promotion_sweep({ apply: true }));
    const aggregate = aggregatePlaybookPromotion(candidate, readPlaybookOutcomeEvents(root), readPlaybookPromotionDecisionRows(root).decisions);
    markNonDeducibleSource(root, {
      source: aggregate.source,
      reasonCodes: ['source_rejected_sibling_threshold'],
      reason: 'audit-visible status fixture',
      sourceRejectedSiblingCount: 3,
      aggregateDigest: aggregate.aggregateDigest,
      markedAt: NOW,
    });
    writeFileSync(resolvePlaybookPromotionDecisionsPath(root), `${readFileSync(resolvePlaybookPromotionDecisionsPath(root), 'utf-8')}not-json\n`, 'utf-8');
    const status = h.playbook_promotion_status({});
    assert.match(status, /pendingLearning/);
    assert.match(status, /latestDecisions/);
    assert.match(status, /nonPromotableSources/);
    assert.match(status, /activeNegativeSignals/);
    assert.match(status, /gateEvidence: false/);
    assert.match(status, /candidatesAreRuntimeGuidance: false/);
    assert.match(status, /malformed decision rows skipped: 1/);
    assert.equal(collectPlaybookPromotionLearningHealth(root).malformedDecisionRows, 1);
  });

  check('CHK-001/metadata: validation is own-property fail-closed and learning artifacts are material-hash excluded', () => {
    const root = mkProject(); roots.push(root);
    const { ctx, store } = mkCtx(root);
    const storyId = 'B-meta';
    const f = finding(storyId, '001');
    seed(store, storyId, [f]);
    const h = createPlaybookHandlers(ctx);
    const pb = approve(root, h, f);
    const validDecision = decisionFor(root, pb, 'hold');
    const inheritedDecision = Object.create(validDecision);
    assert.equal(validatePlaybookPromotionDecisionRow(inheritedDecision).ok, false);
    const validOutcome = {
      schemaVersion: 'proofbound.playbook-outcome.v1',
      eventId: 'PBO-owned',
      idempotencyKey: 'owned',
      observedAt: NOW,
      storyId,
      playbookId: pb.id,
      playbookStatusAtObservation: 'candidate',
      exposureMode: 'candidate-inspection',
      consumer: 'reviewer',
      context: { fileKinds: ['ts'], triggerClasses: ['owned'] },
      outcome: { verdict: 'neutral', verdictSource: 'reviewer', causedNoise: false, causedWrongClaim: false, preventedRepeatFinding: false },
      bindings: {},
      authority: 'non_authoritative',
      gateEvidence: false,
    };
    assert.equal(validatePlaybookOutcomeEvent(Object.create(validOutcome)).ok, false);

    assert.ok(resolvePlaybooksPath(root).includes(join('.lattice', 'learning')));
    const learningEntry = RUNTIME_ARTIFACT_REGISTRY.find((entry) => entry.id === 'experience-layer-learning-cache');
    assert.ok(learningEntry);
    assert.equal(learningEntry!.materialHash, 'exclude');
    assert.ok(learningEntry!.matchers.some((matcher) => matcher.kind === 'prefix' && matcher.value === '.lattice/learning/'));
    assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'playbook_promotion_sweep'));
    assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'playbook_promotion_status'));
    assert.equal(COMMAND_POLICIES.playbook_promotion_status.ownershipClass, 'readOnly');
    assert.equal('gateEvidence' in COMMAND_POLICIES.playbook_promotion_sweep, false);
    assert.ok(PROCESS_FACT_LEVELS.some((fact) => fact.name === 'playbook_promotion_sweep' && fact.level === 'L2'));
    assert.ok(PROCESS_FACT_LEVELS.some((fact) => fact.name === 'playbook_promotion_status' && fact.level === 'L0'));
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
