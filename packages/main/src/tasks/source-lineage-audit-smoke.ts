#!/usr/bin/env node
/**
 * B-01df smoke: read-only source_lineage_audit --domain=learning --json.
 *
 * Exercises a hermetic temp project with every supported learning artifact
 * family present, plus empty/malformed stores. The audit must never write while
 * producing non-authoritative diagnostics only.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MAIN_TOOLS } from '../cli-engine.js';
import { NESTED_SPACE_ALIASES } from '../cli/alias-normalizer.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import type {
  Playbook,
  PlaybookAutoActivationEvent,
  PlaybookOutcomeEvent,
  PlaybookPromotionDecisionRow,
  SourceLineageArtifactKind,
  SourceLineageAuditReport,
} from '../core/experience-layer-types.js';
import {
  aggregatePlaybookPromotion,
  appendPlaybookAutoActivationEvent,
  appendPlaybookOutcomeEvent,
  appendPlaybookPromotionDecision,
  computePlaybookDigest,
  resolvePlaybookAutoActivationsPath,
  resolveFindingSignalsPath,
  resolveProposalsDir,
  writePlaybooks,
  writeProposal,
} from '../core/learning-store.js';
import { digestCanonicalJson } from '../core/digest.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { Finding, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createPlaybookHandlers } from '../handlers/playbook.js';

const NOW = '2026-07-02T00:00:00.000Z';
const STORY_ID = 'B-audit1';
const FINDING_ID = `${STORY_ID}:F-001`;
const SIGNATURE = 'lineage-shared';

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

function writeAbs(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

function mkProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'b01df-source-lineage-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return root;
}

function mkCtx(root: string): { ctx: HandlerContext; store: StoryStore } {
  resetConfigCache();
  const store = new StoryStore(root);
  const config = loadConfig(root);
  return {
    store,
    ctx: { store, root, scanRoot: join(root, config.scanRoot), log: () => {} },
  };
}

function story(storyId: string): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: 'Source lineage audit smoke',
    description: 'Temp story for B-01df source lineage audit smoke.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: NOW }],
  };
}

function finding(): Finding {
  return {
    id: FINDING_ID,
    desc: 'Source lineage duplicate grouping should converge on one canonical finding.',
    severity: 'medium',
    category: 'adversarial',
    status: 'resolved',
    createdAt: NOW,
    reviewRound: 'R-1',
    files: ['packages/main/src/core/source-lineage-audit.ts'],
    signatureTag: SIGNATURE,
  };
}

function playbook(id: string): Playbook {
  return {
    id,
    title: `Lineage candidate ${id}`,
    trigger: {
      keywords: ['lineage', 'audit'],
      fileKinds: ['ts'],
      storyPhases: ['REVIEW'],
    },
    check: 'Check the shared lineage source.',
    pitfalls: ['Do not treat audit-only learning artifacts as gate evidence.'],
    verification: ['Confirm the audit remains read-only.'],
    lineage: {
      sourceStoryId: STORY_ID,
      sourceFindingId: FINDING_ID,
      sourceSignature: SIGNATURE,
    },
    status: 'candidate',
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function outcome(pb: Playbook): PlaybookOutcomeEvent {
  return {
    schemaVersion: 'proofbound.playbook-outcome.v1',
    eventId: 'PBO-LINEAGE-001',
    idempotencyKey: 'source-lineage-audit-smoke:outcome',
    observedAt: NOW,
    storyId: STORY_ID,
    playbookId: pb.id,
    playbookStatusAtObservation: 'candidate',
    exposureMode: 'candidate-inspection',
    consumer: 'source-lineage-audit-smoke',
    context: {
      storyPhase: 'REVIEW',
      storyType: 'chore',
      fileKinds: ['ts'],
      triggerClasses: ['lineage'],
      host: 'Codex CLI',
    },
    outcome: {
      verdict: 'helped',
      verdictSource: 'reviewer',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: true,
      note: 'explicit smoke outcome',
    },
    bindings: {},
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function decision(pb: Playbook): PlaybookPromotionDecisionRow {
  const aggregate = aggregatePlaybookPromotion(pb, [], []);
  return {
    schemaVersion: 'proofbound.playbook-promotion-decision.v1',
    decisionId: 'PBD-LINEAGE-001',
    idempotencyKey: `source-lineage-audit-smoke:${pb.id}:${aggregate.aggregateDigest}`,
    decidedAt: NOW,
    playbookId: pb.id,
    evaluatedStatus: pb.status,
    action: 'recommend_activate',
    reasonCodes: ['activation_threshold_met'],
    aggregateDigest: aggregate.aggregateDigest,
    aggregate,
    before: {
      playbookStatus: pb.status,
      playbookDigest: computePlaybookDigest(pb),
      sourceKey: aggregate.source.sourceKey,
    },
    after: {
      playbookStatus: pb.status,
      recommendation: 'recommend_activate',
    },
    workerVersion: 'playbook-promotion-worker-v1',
    dryRun: false,
    applied: true,
    alreadyApplied: false,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function activation(pb: Playbook, row: PlaybookPromotionDecisionRow): PlaybookAutoActivationEvent {
  const activeDigest = computePlaybookDigest({ ...pb, status: 'active' });
  const lineageCanonicalSourceKey = `PBLS-${digestCanonicalJson({
    kind: 'finding-backed',
    sourceFindingId: FINDING_ID,
    sourceSignature: SIGNATURE,
    sourceStoryId: STORY_ID,
  }).slice(0, 16)}`;
  return {
    schemaVersion: 'proofbound.playbook-auto-activation.v1',
    activationId: 'PBA-LINEAGE-001',
    idempotencyKey: `source-lineage-audit-smoke:${pb.id}:activation`,
    activatedAt: NOW,
    playbookId: pb.id,
    before: {
      playbookStatus: 'candidate',
      playbookDigest: computePlaybookDigest(pb),
    },
    after: {
      playbookStatus: 'active',
      playbookDigest: activeDigest,
    },
    policy: {
      policyId: 'proofbound.evidence-activated-advisory-playbook.v1',
      policyDigest: digestCanonicalJson({ smoke: 'source-lineage-audit', policy: 1 }),
      reviewedBy: 'source-lineage-audit-smoke',
    },
    evidence: {
      aggregateDigest: row.aggregateDigest,
      decisionId: row.decisionId,
      decisionIdempotencyKey: row.idempotencyKey,
      decisionDigest: digestCanonicalJson(row),
      recommendation: 'recommend_activate',
      reasonCodes: row.reasonCodes,
      decisiveSamples: row.aggregate.decisiveSamples,
      helpedCount: row.aggregate.helpedCount,
      dismissedCount: row.aggregate.dismissedCount,
      harmfulCount: row.aggregate.harmfulCount,
      wrongClaimCount: row.aggregate.wrongClaimCount,
      contextClassCount: row.aggregate.contextClassCount,
      realOutcomeCount: 1,
      exposureCount: 1,
      lineageCanonicalSourceKey,
    },
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function devMemoryEntry(id: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    createdAt: NOW,
    sourceAgent: 'source-lineage-audit-smoke',
    category: 'workflow',
    scope: 'project',
    summary: 'Lineage audit smoke memory',
    trigger: 'B-01df source lineage audit smoke',
    lesson: 'Learning artifacts need canonical source lineage diagnostics.',
    reusePrompt: 'Use source_lineage_audit before trusting learning lineage.',
    gateEvidence: false,
    authority: 'non_authoritative',
    ...extras,
  };
}

function seedRichLearningStores(root: string, store: StoryStore): void {
  store.writeStory(STORY_ID, story(STORY_ID));
  store.writeChecklist(STORY_ID, { items: [] });
  store.writeFindings(STORY_ID, { findings: [finding()] });

  write(root, '.lattice/dev-memory/experience.jsonl', [
    JSON.stringify(devMemoryEntry('memline1', {
      sourceStoryId: STORY_ID,
      evidenceRefs: [FINDING_ID],
    })),
    JSON.stringify(devMemoryEntry('memline2')),
    '',
  ].join('\n'));

  writeAbs(resolveFindingSignalsPath(root), JSON.stringify({
    schemaVersion: 1,
    updatedAt: NOW,
    signals: [
      {
        localSignature: 'shared-lineage-signal',
        category: 'adversarial',
        signatureTag: SIGNATURE,
        fileKinds: ['ts'],
        counts: {
          resolved: 1,
          dismissed: 0,
          falsePositive: 0,
          acceptedRisk: 0,
          unclear: 0,
          partiallyMitigated: 0,
        },
        signalScore: 0.5,
        support: 1,
        exampleStoryIds: [STORY_ID],
        exampleFindingIds: [FINDING_ID],
      },
      {
        localSignature: 'missing-lineage-signal',
        category: 'workflow',
        fileKinds: ['ts'],
        counts: {
          resolved: 0,
          dismissed: 0,
          falsePositive: 0,
          acceptedRisk: 0,
          unclear: 0,
          partiallyMitigated: 0,
        },
        signalScore: 0,
        support: 0,
        exampleStoryIds: [],
        exampleFindingIds: [],
      },
    ],
  }, null, 2));

  const proposal = {
    id: 'PBP-LINEAGE-001',
    title: 'Lineage proposal',
    trigger: { keywords: ['lineage'], fileKinds: ['ts'], storyPhases: ['REVIEW'] },
    check: 'Check shared source lineage.',
    pitfalls: ['Missing lineage hides duplicate source learning.'],
    verification: ['Audit groups the shared source.'],
    lineage: {
      sourceStoryId: STORY_ID,
      sourceFindingId: FINDING_ID,
      sourceSignature: SIGNATURE,
    },
    status: 'proposed' as const,
    proposalDigest: 'smoke-digest',
  };
  writeProposal(root, proposal);
  writeAbs(join(resolveProposalsDir(root), 'PBP-MISSING.json'), JSON.stringify({ id: 'PBP-MISSING' }, null, 2));

  const pb = playbook('PB-LINEAGE-001');
  const promotionDecision = decision(pb);
  writePlaybooks(root, [pb]);
  appendPlaybookOutcomeEvent(root, outcome(pb));
  appendPlaybookPromotionDecision(root, promotionDecision);
  appendPlaybookAutoActivationEvent(root, activation(pb, promotionDecision));
}

function snapshot(root: string): string {
  const rows: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = full.slice(root.length + 1);
      const st = statSync(full);
      if (st.isDirectory()) {
        rows.push(`dir:${rel}`);
        walk(full);
      } else {
        rows.push(`file:${rel}:${readFileSync(full, 'utf-8')}`);
      }
    }
  }
  walk(root);
  return rows.join('\n');
}

function audit(ctx: HandlerContext): SourceLineageAuditReport {
  const output = createPlaybookHandlers(ctx).source_lineage_audit({ domain: 'learning', json: true });
  return JSON.parse(output) as SourceLineageAuditReport;
}

function artifactKinds(report: SourceLineageAuditReport): Set<SourceLineageArtifactKind> {
  return new Set(report.records.map((record) => record.artifactKind));
}

const roots: string[] = [];
const savedGlobalMemoryDir = process.env.LATTICE_GLOBAL_MEMORY_DIR;
const globalMemoryRoot = mkdtempSync(join(tmpdir(), 'b01df-source-lineage-global-memory-'));

try {
  process.env.LATTICE_GLOBAL_MEMORY_DIR = globalMemoryRoot;

  check('duplicate grouping and all learning artifact collectors', () => {
    const root = mkProject(); roots.push(root);
    const { ctx, store } = mkCtx(root);
    seedRichLearningStores(root, store);
    const before = snapshot(root);
    const report = audit(ctx);
    const after = snapshot(root);

    assert.equal(after, before, 'source_lineage_audit must not write or normalize stores');
    assert.equal(report.schemaVersion, 'proofbound.source-lineage-audit.v1');
    assert.equal(report.domain, 'learning');
    assert.equal(report.authority, 'non_authoritative');
    assert.equal(report.gateEvidence, false);
    assert.equal(typeof report.canonicalizationPolicyHash, 'string');
    assert.ok(report.canonicalizationPolicyHash.length > 12, 'policy hash is present');

    for (const kind of [
      'dev_memory',
      'finding_signal',
      'finding',
      'playbook_proposal',
      'playbook',
      'playbook_outcome',
      'playbook_promotion_decision',
      'playbook_auto_activation',
    ] as const) {
      assert.equal(artifactKinds(report).has(kind), true, `${kind} collector emitted records`);
    }

    assert.ok(report.records.length >= 9, 'records are emitted');
    for (const record of report.records) {
      assert.equal(record.authority, 'non_authoritative');
      assert.equal(record.gateEvidence, false);
      assert.equal(record.canonicalSourceKeyVersion, 'proofbound.learning-source-key.v1');
      assert.equal(record.canonicalizationPolicyHash, report.canonicalizationPolicyHash);
      assert.ok(Object.hasOwn(record, 'canonicalSourceKey'), 'canonicalSourceKey key is always present');
    }

    const duplicate = report.duplicateCanonicalSourceGroups.find((group) =>
      group.records.some((record) => record.artifactKind === 'finding')
      && group.records.some((record) => record.artifactKind === 'playbook')
      && group.records.some((record) => record.artifactKind === 'playbook_outcome')
      && group.records.some((record) => record.artifactKind === 'playbook_promotion_decision')
      && group.records.some((record) => record.artifactKind === 'playbook_auto_activation'));
    assert.ok(duplicate, 'shared source finding produces a duplicate canonical source group');
    assert.ok(duplicate!.recordCount >= 6, 'duplicate group includes multiple learning artifacts');
  });

  check('missing lineage diagnostics stay non-authoritative', () => {
    const root = mkProject(); roots.push(root);
    const { ctx, store } = mkCtx(root);
    seedRichLearningStores(root, store);
    const report = audit(ctx);

    assert.ok(report.missingLineageCount >= 2, 'missing lineage count includes unbound signal/proposal/dev-memory');
    assert.equal(report.diagnostics.some((diag) => diag.code === 'missing_lineage'), true);
    assert.equal(report.authority, 'non_authoritative');
    assert.equal(report.gateEvidence, false);
  });

  check('unsupported domain fails clearly', () => {
    const root = mkProject(); roots.push(root);
    const { ctx } = mkCtx(root);
    assert.throws(
      () => createPlaybookHandlers(ctx).source_lineage_audit({ domain: 'runtime', json: true }),
      (err: Error) =>
        err.message.includes('source_lineage_audit: unsupported domain')
        && err.message.includes('runtime')
        && err.message.includes('supported: learning'),
    );
  });

  check('empty-store read-only posture', () => {
    const root = mkProject(); roots.push(root);
    const { ctx } = mkCtx(root);
    const before = snapshot(root);
    assert.equal(existsSync(join(root, '.lattice')), false, 'fresh project has no .lattice directory');
    const report = audit(ctx);
    const after = snapshot(root);

    assert.equal(after, before, 'empty audit writes no files or directories');
    assert.equal(existsSync(join(root, '.lattice')), false, 'empty audit does not create .lattice');
    assert.equal(report.sourceRecordCount, 0);
    assert.equal(report.records.length, 0);
    assert.equal(report.missingLineageCount, 0);
    assert.equal(report.duplicateCanonicalSourceGroups.length, 0);
    assert.equal(report.diagnostics.some((diag) => diag.code === 'store_missing'), true);
    assert.equal(report.authority, 'non_authoritative');
    assert.equal(report.gateEvidence, false);
  });

  check('malformed stores produce diagnostics instead of throwing', () => {
    const root = mkProject(); roots.push(root);
    const { ctx } = mkCtx(root);
    writeAbs(resolveFindingSignalsPath(root), '{not json');
    writeAbs(resolvePlaybookAutoActivationsPath(root), '{not json\n');
    const report = audit(ctx);

    assert.equal(report.diagnostics.some((diag) =>
      diag.code === 'store_malformed' && diag.message.includes('finding-signals')), true);
    assert.equal(report.diagnostics.some((diag) =>
      diag.code === 'store_malformed_row' && diag.message.includes('playbook auto activations')), true);
    assert.equal(report.authority, 'non_authoritative');
    assert.equal(report.gateEvidence, false);
  });

  check('command metadata is read-only L0 with no host namespace alias', () => {
    const tool = MAIN_TOOLS.find((item) => item.name === 'source_lineage_audit');
    assert.ok(tool, 'source_lineage_audit is in MAIN_TOOLS');
    assert.equal(tool!.schema.domain.safeParse('learning').success, true);
    assert.equal(tool!.schema.json.safeParse(true).success, true);
    assert.equal(tool!.schema.write.safeParse(true).success, false, 'read-only write flag is rejected');
    assert.equal(tool!.schema.apply.safeParse(true).success, false, 'read-only apply flag is rejected');

    const policy = COMMAND_POLICIES.source_lineage_audit;
    assert.equal(policy.ownershipClass, 'readOnly');
    assert.equal(policy.destructiveRisk, 'none');
    assert.notEqual((policy as { gateEvidence?: unknown }).gateEvidence, true);

    const processFact = PROCESS_FACT_LEVELS.find((entry) => entry.name === 'source_lineage_audit');
    assert.ok(processFact, 'source_lineage_audit has a process fact level entry');
    assert.equal(processFact!.level, 'L0');

    assert.equal(Object.values(NESTED_SPACE_ALIASES).includes('source_lineage_audit'), false);
    assert.equal(MAIN_TOOLS.some((item) => item.name === 'host_source_lineage_audit'), false);
  });
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(globalMemoryRoot, { recursive: true, force: true });
  if (savedGlobalMemoryDir === undefined) delete process.env.LATTICE_GLOBAL_MEMORY_DIR;
  else process.env.LATTICE_GLOBAL_MEMORY_DIR = savedGlobalMemoryDir;
}

if (process.exitCode) {
  console.error(`source-lineage-audit smoke failed: TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
} else {
  console.log(`source-lineage-audit smoke passed: TOTAL ${total} | PASS ${passed} | FAIL 0`);
}
