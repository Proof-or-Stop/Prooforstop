#!/usr/bin/env node
/**
 * B-9958 smoke: deduped historical playbook seed promotion loop (M2-M8).
 *
 * Uses hermetic temp projects and a temp global-memory dir. Learning/playbook
 * artifacts remain non-authoritative and never become gate evidence.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { READ_ONLY_COMMANDS } from '../cli/activity-policy.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { isCommandAllowed, loadConfig, resetConfigCache } from '../core/config.js';
import { resolveProjectMemoryPath, writeEntries, type DevMemoryEntry } from '../core/dev-memory.js';
import type {
  FindingSignalsCache,
  Playbook,
  PlaybookOutcomeEvent,
  PlaybookPromotionDecisionRow,
  PlaybookProposal,
} from '../core/experience-layer-types.js';
import {
  aggregatePlaybookPromotion,
  appendPlaybookOutcomeEvent,
  appendPlaybookPromotionDecision,
  buildPlaybookSourceReference,
  computePlaybookDigest,
  computePlaybookProposalDigest,
  evaluatePlaybookPromotion,
  listProposals,
  markNonDeducibleSource,
  readPlaybookAutoActivationEvents,
  readPlaybookOutcomeEvents,
  readPlaybooks,
  readPlaybookPromotionDecisionRows,
  readPlaybookPromotionHealthEvents,
  readProposal,
  resolveFindingSignalsPath,
  resolvePlaybookAutoActivationsPath,
  writeProposal,
  writePlaybooks,
} from '../core/learning-store.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { Finding, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { runPostDoneLearningSettlement } from '../handlers/done-effects.js';
import { createPlaybookHandlers } from '../handlers/playbook.js';

const NOW = '2026-07-02T00:00:00.000Z';
const STORY_ID = 'B-seed1';
const FINDING_ID = `${STORY_ID}:F-001`;
const DONE_STORY_ID = 'B-done1';
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

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
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function mkProject(prefix = 'b9958-playbook-seed-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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
  return { store, ctx: { store, root, scanRoot: join(root, config.scanRoot), log: () => {} } };
}

function story(storyId: string, phase: StoryInfo['phase'] = 'REVIEW'): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: `${storyId} playbook seed smoke`,
    description: 'Historical seed promotion loop smoke story.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: phase === 'DONE' ? NOW : null,
    events: [{ phase, action: 'advance', timestamp: NOW }],
  };
}

function finding(storyId: string, suffix: string, signature?: string): Finding {
  return {
    id: `${storyId}:F-${suffix}`,
    desc: `Historical lineage source ${suffix} should produce one deduped seed proposal.`,
    severity: 'high',
    category: 'missing',
    status: 'resolved',
    createdAt: NOW,
    reviewRound: 'R-1',
    files: [`packages/main/src/${suffix}.ts`],
    ...(signature ? { signatureTag: signature } : {}),
  };
}

function seedStory(store: StoryStore, storyId = STORY_ID, findings: Finding[] = [finding(STORY_ID, '001')]): void {
  store.writeStory(storyId, story(storyId));
  store.writeChecklist(storyId, { items: [] });
  store.writeFindings(storyId, { findings });
}

function memoryEntry(id: string, patch: Partial<DevMemoryEntry> = {}): DevMemoryEntry {
  return {
    id,
    createdAt: NOW,
    sourceAgent: 'playbook-seed-smoke',
    category: 'workflow',
    scope: 'project',
    summary: 'Historical lineage memory should become preferred seed material.',
    trigger: 'B-9958 source lineage seed promotion smoke',
    lesson: 'Use dev-memory with explicit finding lineage before lower-priority seed sources.',
    reusePrompt: 'Use playbook_seed_observe before proposing historical playbooks.',
    sourceStoryId: STORY_ID,
    evidenceRefs: [FINDING_ID],
    tags: [],
    gateEvidence: false,
    authority: 'non_authoritative',
    ...patch,
  };
}

function findingSignals(): FindingSignalsCache {
  return {
    schemaVersion: 1,
    updatedAt: NOW,
    signals: [{
      localSignature: 'missing||ts|review',
      category: 'missing',
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
      lastSeen: NOW,
      exampleStoryIds: [STORY_ID],
      exampleFindingIds: [FINDING_ID],
      anchorFiles: ['packages/main/src/001.ts'],
    }],
    coveredFindingCount: 1,
    coveredStoryCount: 1,
    coveredThrough: NOW,
  };
}

function seedLearning(root: string, store: StoryStore): void {
  seedStory(store);
  write(root, 'packages/main/src/001.ts', 'export const presentAnchor = true;\n');
  writeEntries(resolveProjectMemoryPath(root), [
    memoryEntry('mem-seed-preferred'),
    memoryEntry('mem-missing-lineage', {
      sourceStoryId: undefined,
      evidenceRefs: [],
      summary: 'Memory without lineage must be blocked from seed promotion.',
      lesson: 'Missing lineage remains memory-only until it has explicit source evidence.',
    }),
  ]);
  write(root, resolveFindingSignalsPath(root).slice(root.length + 1), JSON.stringify(findingSignals(), null, 2));
}

function doneSummary(storyId: string): any {
  return {
    storyId,
    changes: 'DONE experience summary captured durable behavior without granting runtime authority.',
    usage: 'Run playbook_seed_observe with done-experience to review the candidate seed.',
    expectedOutcome: 'Operators see a done_experience seed, not active guidance.',
    actualTranscript: 'playbook_seed_observe reports sourceArtifactKind done_experience.',
    outcomeDiff: 'No difference: the seed is non-authoritative candidate material only.',
    acceptanceVerdict: 'accepted',
    realMachineCoverage: {
      ran: [{ name: 'done-experience-smoke', where: 'packages/main/src/tasks/playbook-seed-promotion-loop-smoke.ts' }],
      skipped: [],
    },
    limitations: 'DONE success alone never records helped or activates runtime guidance.',
    pitfalls: 'Avoid assuming DONE settlement means helped; require explicit candidate exposure and structured outcome rows.',
  };
}

function doneDeliveryCheck(storyId: string): any {
  return {
    storyId,
    checkedAt: NOW,
    reviewRound: 'RR-done-experience',
    agentId: 'lattice-review-delivery',
    docsPromises: [{
      docPath: 'docs/requirements/decisions/source-lineage-dedup-playbook-seed-promotion-execution-plan.md',
      promise: 'DONE experience seeds create candidate playbooks only.',
      status: 'verified',
      verifiedBy: 'smoke',
      evidence: 'done_experience observe/propose/approve smoke',
    }],
    realMachineTests: [{
      featureId: 'done-experience-seed',
      transcript: 'observe -> propose -> approve leaves one candidate playbook and zero outcome rows',
    }],
    closingSelfCheck: {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'Delivery confirms DONE material can become an inert candidate seed only.',
    },
    _hash: 'smoke-delivery-hash',
  };
}

function seedDoneExperienceStory(store: StoryStore, storyId = DONE_STORY_ID): void {
  store.writeStory(storyId, story(storyId, 'DONE'));
  store.writeChecklist(storyId, { items: [] });
  store.writeFindings(storyId, { findings: [] });
  store.writeSummary(storyId, doneSummary(storyId));
  store.writeDeliveryCheck(storyId, doneDeliveryCheck(storyId));
}

function unrelatedSeedProposal(): PlaybookProposal {
  const proposal: PlaybookProposal = {
    id: 'PBP-777',
    title: 'Unrelated pre-existing proposal',
    trigger: { keywords: ['unrelated', 'proposal'], fileKinds: ['ts'], storyPhases: ['REVIEW'] },
    check: 'Keep unrelated staged proposals out of candidate ingest approval scope.',
    pitfalls: ['This proposal must remain staged after DONE candidate ingestion.'],
    verification: ['Confirm scoped candidate ingest does not approve unrelated proposals.'],
    lineage: {
      sourceStoryId: STORY_ID,
      sourceFindingId: FINDING_ID,
      sourceSignature: 'unrelated-preexisting',
    },
    seed: {
      sourceArtifactKind: 'dev_memory',
      sourceArtifactId: 'mem-unrelated-preexisting',
      sourceRef: 'smoke:unrelated-preexisting',
      canonicalSourceKey: 'PBLS-unrelatedpre001',
      canonicalSourceKeyVersion: 'proofbound.learning-source-key.v1',
      canonicalizationPolicyHash: 'smoke-unrelated-canonicalization',
    },
    status: 'proposed',
    proposalDigest: '',
  };
  proposal.proposalDigest = computePlaybookProposalDigest(proposal);
  return proposal;
}

function snapshotDir(root: string, rel: string): string {
  const dir = join(root, rel);
  if (!existsSync(dir)) return '<missing>';
  const rows: string[] = [];
  function walk(current: string): void {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        walk(path);
      } else {
        rows.push(`${path.slice(root.length + 1)}\n${readFileSync(path, 'utf8')}`);
      }
    }
  }
  walk(dir);
  return rows.join('\n---\n');
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function runCli(root: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI_PATH, '--root', root, ...args], {
    cwd: root,
    env: {
      ...process.env,
      LATTICE_NO_HOOKS: '1',
    },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runCliJson<T>(root: string, args: string[]): T {
  return parseJson<T>(runCli(root, args));
}

function runCliFailure(root: string, args: string[]): string {
  let output = '';
  try {
    output = runCli(root, args);
  } catch (err) {
    const child = err as { stdout?: string; stderr?: string; message?: string };
    return [child.stderr, child.stdout, child.message].filter(Boolean).join('\n');
  }
  assert.fail(`expected CLI failure for ${args.join(' ')}, got output:\n${output}`);
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function approveSeedCandidate(root: string, handlers: ReturnType<typeof createPlaybookHandlers>): Playbook {
  const observe = parseJson<any>(handlers.playbook_seed_observe({ json: true }));
  const propose = parseJson<any>(handlers.playbook_seed_propose_batch({
    apply: true,
    observeDigest: observe.observeDigest,
    json: true,
  }));
  assert.equal(propose.applied, true);
  const manifest = parseJson<any>(handlers.playbook_candidate_batch_approve({ json: true }));
  const approved = parseJson<any>(handlers.playbook_candidate_batch_approve({
    apply: true,
    manifestDigest: manifest.manifestDigest,
    json: true,
  }));
  assert.equal(approved.applied, true);
  const candidate = readPlaybooks(root).find((row) => row.id === approved.candidatePlaybookIds[0]);
  assert.ok(candidate, 'candidate persisted');
  return candidate!;
}

function approveSeedCandidateViaCli(root: string): Playbook {
  const observe = runCliJson<any>(root, ['playbook_seed_observe', '--json']);
  const propose = runCliJson<any>(root, [
    'playbook_seed_propose_batch',
    '--apply',
    '--observeDigest',
    observe.observeDigest,
    '--json',
  ]);
  assert.equal(propose.applied, true);
  const manifest = runCliJson<any>(root, ['playbook_candidate_batch_approve', '--json']);
  const approved = runCliJson<any>(root, [
    'playbook_candidate_batch_approve',
    '--apply',
    '--manifestDigest',
    manifest.manifestDigest,
    '--json',
  ]);
  assert.equal(approved.applied, true);
  const candidate = readPlaybooks(root).find((row) => row.id === approved.candidatePlaybookIds[0]);
  assert.ok(candidate, 'candidate persisted through built CLI');
  return candidate!;
}

function playbook(id: string, status: Playbook['status'], keyword: string): Playbook {
  return {
    id,
    title: `${keyword} runtime claim guard`,
    trigger: { keywords: [keyword, 'lineage', 'runtime'], fileKinds: ['ts'], storyPhases: ['REVIEW', 'DONE'] },
    check: `Check ${keyword} before making a final claim.`,
    pitfalls: [`Do not treat ${keyword} as gate evidence.`],
    verification: [`Confirm ${keyword} remains advisory.`],
    lineage: {
      sourceStoryId: STORY_ID,
      sourceFindingId: FINDING_ID,
      sourceSignature: keyword,
    },
    status,
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function doneSettlementOutcome(playbookId: string): PlaybookOutcomeEvent {
  return {
    schemaVersion: 'proofbound.playbook-outcome.v1',
    eventId: 'PBO-DONE-NEUTRAL',
    idempotencyKey: 'done-neutral',
    observedAt: NOW,
    storyId: STORY_ID,
    playbookId,
    playbookStatusAtObservation: 'candidate',
    exposureMode: 'none',
    consumer: 'done_closure',
    context: { storyPhase: 'DONE', storyType: 'chore', fileKinds: ['ts'], triggerClasses: ['done'] },
    outcome: {
      verdict: 'neutral',
      verdictSource: 'done-settlement',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: false,
    },
    bindings: {},
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function recordHelpedOutcomeViaCli(
  root: string,
  playbookId: string,
  index: number,
  patch: { host?: string; trigger?: string } = {},
): void {
  runCli(root, [
    'playbook_outcome_record',
    '--storyId',
    STORY_ID,
    '--playbookId',
    playbookId,
    '--exposureMode',
    'candidate-inspection',
    '--consumer',
    'reviewer',
    '--context',
    JSON.stringify({
      storyPhase: 'REVIEW',
      storyType: 'feature',
      fileKinds: ['ts'],
      triggerClasses: [patch.trigger ?? `cli-activation-${index}`],
      host: patch.host ?? `cli-host-${index}`,
      hostProvider: 'codex',
      hostCapabilityId: `cli-cap-${index}`,
    }),
    '--outcome',
    JSON.stringify({
      verdict: 'helped',
      verdictSource: 'reviewer',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: true,
      note: 'Built CLI candidate inspection prevented a repeated claim boundary error.',
    }),
    '--bindings',
    '{}',
    '--eventId',
    `PBO-CLI-ACTIVATE-${index}`,
    '--idempotencyKey',
    `cli-activate-helped-${index}`,
    '--observedAt',
    `2026-07-02T01:0${index}:00.000Z`,
  ]);
}

function recordNoExposureOutcomeViaCli(root: string, playbookId: string): void {
  runCli(root, [
    'playbook_outcome_record',
    '--storyId',
    STORY_ID,
    '--playbookId',
    playbookId,
    '--exposureMode',
    'none',
    '--consumer',
    'reviewer',
    '--context',
    JSON.stringify({
      storyPhase: 'REVIEW',
      storyType: 'feature',
      fileKinds: ['ts'],
      triggerClasses: ['no-exposure'],
      host: 'cli-no-exposure-host',
      hostProvider: 'codex',
      hostCapabilityId: 'cli-no-exposure-capability',
    }),
    '--outcome',
    JSON.stringify({
      verdict: 'neutral',
      verdictSource: 'reviewer',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: false,
      note: 'No concrete candidate exposure occurred.',
    }),
    '--bindings',
    '{}',
    '--eventId',
    'PBO-CLI-NO-EXPOSURE',
    '--idempotencyKey',
    'cli-no-exposure-neutral',
    '--observedAt',
    '2026-07-02T01:10:00.000Z',
  ]);
}

function appendAppliedRecommendActivateDecision(root: string, playbook: Playbook): PlaybookPromotionDecisionRow {
  const aggregate = aggregatePlaybookPromotion(
    playbook,
    readPlaybookOutcomeEvents(root),
    readPlaybookPromotionDecisionRows(root).decisions,
  );
  const evaluation = evaluatePlaybookPromotion(aggregate);
  assert.equal(evaluation.action, 'recommend_activate');
  const row: PlaybookPromotionDecisionRow = {
    schemaVersion: 'proofbound.playbook-promotion-decision.v1',
    decisionId: 'PBD-SMOKE-STALE',
    idempotencyKey: [
      'playbook-promotion-v1',
      'recommend_activate',
      aggregate.playbookId,
      aggregate.aggregateDigest,
      aggregate.source.sourceKey,
    ].join(':'),
    decidedAt: '2026-07-02T01:20:00.000Z',
    playbookId: playbook.id,
    evaluatedStatus: playbook.status,
    action: 'recommend_activate',
    reasonCodes: evaluation.reasonCodes,
    aggregateDigest: aggregate.aggregateDigest,
    aggregate,
    before: {
      playbookStatus: playbook.status,
      playbookDigest: computePlaybookDigest(playbook),
      sourceKey: aggregate.source.sourceKey,
    },
    after: {
      playbookStatus: playbook.status,
      recommendation: 'recommend_activate',
    },
    workerVersion: 'playbook-promotion-worker-v1',
    dryRun: false,
    applied: true,
    alreadyApplied: false,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
  appendPlaybookPromotionDecision(root, row);
  return row;
}

function recordDoneSettlementHelpedOutcome(
  handlers: ReturnType<typeof createPlaybookHandlers>,
  playbookId: string,
  index: number,
): void {
  handlers.playbook_outcome_record({
    eventId: `PBO-DONE-HELPED-${index}`,
    idempotencyKey: `done-settlement-helped-${index}`,
    observedAt: `2026-07-02T00:1${index}:00.000Z`,
    storyId: STORY_ID,
    playbookId,
    exposureMode: 'candidate-inspection',
    consumer: 'done_closure',
    context: {
      storyPhase: 'DONE',
      storyType: 'feature',
      fileKinds: ['ts'],
      triggerClasses: [`done-settlement-${index}`],
    },
    outcome: {
      verdict: 'helped',
      verdictSource: 'done-settlement',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: true,
      note: 'Settlement label must remain health-only, not activation evidence.',
    },
    bindings: {},
  } as any);
}

function recordNeutralReviewerOutcome(
  handlers: ReturnType<typeof createPlaybookHandlers>,
  playbookId: string,
): void {
  handlers.playbook_outcome_record({
    eventId: 'PBO-REVIEWER-NEUTRAL',
    idempotencyKey: 'reviewer-neutral-candidate-inspection',
    observedAt: '2026-07-02T00:19:00.000Z',
    storyId: STORY_ID,
    playbookId,
    exposureMode: 'candidate-inspection',
    consumer: 'reviewer',
    context: {
      storyPhase: 'REVIEW',
      storyType: 'feature',
      fileKinds: ['ts'],
      triggerClasses: ['reviewer-neutral'],
      host: 'reviewer-neutral-host',
      hostProvider: 'codex',
      hostCapabilityId: 'reviewer-neutral-capability',
    },
    outcome: {
      verdict: 'neutral',
      verdictSource: 'reviewer',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: false,
      note: 'Real candidate inspection exposure, but not a helped sample.',
    },
    bindings: {},
  } as any);
}

function run(): void {
  const roots: string[] = [];
  const priorGlobal = process.env.LATTICE_GLOBAL_MEMORY_DIR;
  const globalRoot = mkdtempSync(join(tmpdir(), 'b9958-global-memory-'));
  process.env.LATTICE_GLOBAL_MEMORY_DIR = globalRoot;
  try {
    check('M2 observe prefers dev-memory, reports blockers, and does not mutate stores', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const before = snapshotDir(root, '.lattice');
      const report = parseJson<any>(createPlaybookHandlers(ctx).playbook_seed_observe({ json: true }));
      const after = snapshotDir(root, '.lattice');
      assert.equal(after, before, 'observe must not write');
      assert.equal(report.authority, 'non_authoritative');
      assert.equal(report.gateEvidence, false);
      assert.equal(report.proposableSeeds[0].sourceArtifactKind, 'dev_memory');
      assert.ok(report.duplicateSeedGroups.length >= 1, 'duplicate seed group reported');
      assert.ok(report.missingLineage.length >= 1, 'missing lineage reported');
      assert.match(report.observeDigest, /^[a-f0-9]{64}$/);
      const findingSignalReport = parseJson<any>(createPlaybookHandlers(ctx).playbook_seed_observe({
        source: 'finding-signals',
        json: true,
      }));
      assert.equal(findingSignalReport.proposableSeeds[0].sourceArtifactKind, 'finding_signal');
    });

    check('M2 finding-signal seeds require support and valid anchors before proposal', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedStory(store);
      const weakSignals: FindingSignalsCache = {
        ...findingSignals(),
        signals: [{
          ...findingSignals().signals[0],
          localSignature: 'missing||ts|weak',
          support: 0,
          anchorFiles: [],
        }],
      };
      write(root, resolveFindingSignalsPath(root).slice(root.length + 1), JSON.stringify(weakSignals, null, 2));
      const report = parseJson<any>(createPlaybookHandlers(ctx).playbook_seed_observe({
        source: 'finding-signals',
        json: true,
      }));
      assert.equal(report.proposableSeeds.length, 0, 'weak finding-signal is not proposable');
      assert.ok(report.blockingSeeds.some((seed: any) =>
        seed.sourceArtifactKind === 'finding_signal'
        && seed.blockReasons.includes('finding_signal_insufficient_support')
        && seed.blockReasons.includes('finding_signal_missing_valid_anchors')));

      const staleSignals: FindingSignalsCache = {
        ...findingSignals(),
        signals: [{
          ...findingSignals().signals[0],
          localSignature: 'missing||ts|stale-anchor',
          support: 1,
          anchorFiles: ['packages/main/src/no-such-anchor.ts'],
        }],
      };
      write(root, resolveFindingSignalsPath(root).slice(root.length + 1), JSON.stringify(staleSignals, null, 2));
      const staleReport = parseJson<any>(createPlaybookHandlers(ctx).playbook_seed_observe({
        source: 'finding-signals',
        json: true,
      }));
      assert.equal(staleReport.proposableSeeds.length, 0, 'stale-anchor finding-signal is not proposable');
      assert.ok(staleReport.blockingSeeds.some((seed: any) =>
        seed.sourceArtifactKind === 'finding_signal'
        && seed.blockReasons.includes('finding_signal_missing_valid_anchors')));

      write(root, 'packages/main/src/present-anchor.ts', 'export const presentFindingSignalAnchor = true;\n');
      const presentSignals: FindingSignalsCache = {
        ...findingSignals(),
        signals: [{
          ...findingSignals().signals[0],
          localSignature: 'missing||ts|present-anchor',
          support: 1,
          anchorFiles: ['packages/main/src/present-anchor.ts'],
        }],
      };
      write(root, resolveFindingSignalsPath(root).slice(root.length + 1), JSON.stringify(presentSignals, null, 2));
      const presentReport = parseJson<any>(createPlaybookHandlers(ctx).playbook_seed_observe({
        source: 'finding-signals',
        json: true,
      }));
      assert.equal(presentReport.proposableSeeds.length, 1, 'present-anchor finding-signal is proposable');
      assert.equal(presentReport.proposableSeeds[0].sourceArtifactKind, 'finding_signal');
    });

    check('B-c28f DONE experience observes stable seeds and approves inert candidates idempotently', () => {
      const root = mkProject('bc28f-done-experience-');
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedDoneExperienceStory(store);
      const handlers = createPlaybookHandlers(ctx);

      const cliObserve = runCliJson<any>(root, ['playbook_seed_observe', '--source=done-experience', '--json']);
      assert.equal(cliObserve.proposableSeeds.length, 1, 'dist CLI accepts done-experience observe source');
      assert.equal(cliObserve.proposableSeeds[0].sourceArtifactKind, 'done_experience');

      const cliPropose = runCliJson<any>(root, [
        'playbook_seed_propose_batch',
        '--source=done-experience',
        '--limit=1',
        '--json',
      ]);
      assert.equal(cliPropose.dryRun, true);
      assert.equal(cliPropose.applied, false);
      assert.equal(cliPropose.proposals[0].seed.sourceArtifactKind, 'done_experience');
      assert.equal(listProposals(root).length, 0, 'dist CLI done-experience propose dry-run does not stage proposals');

      const observe1 = parseJson<any>(handlers.playbook_seed_observe({
        source: 'done-experience',
        json: true,
      }));
      assert.equal(observe1.proposableSeeds.length, 1);
      const seed1 = observe1.proposableSeeds[0];
      assert.equal(seed1.sourceArtifactKind, 'done_experience');
      assert.equal(seed1.sourceArtifactId, DONE_STORY_ID);
      assert.match(seed1.canonicalSourceKey, /^PBLS-[a-f0-9]{16}$/);
      assert.equal(seed1.canonicalSourceKeyVersion, observe1.audit.canonicalSourceKeyVersion);
      assert.match(seed1.sourceSummary, /DONE experience summary/);
      assert.ok(seed1.sourcePitfalls.some((text: string) => /DONE settlement means helped/.test(text)));
      assert.ok(seed1.sourceVerification.some((text: string) => /done-experience-seed/.test(text)));

      const observe2 = parseJson<any>(handlers.playbook_seed_observe({
        source: 'done-experience',
        json: true,
      }));
      assert.equal(observe2.proposableSeeds[0].canonicalSourceKey, seed1.canonicalSourceKey);
      assert.equal(observe2.proposableSeeds[0].canonicalSourceKeyVersion, seed1.canonicalSourceKeyVersion);

      const proposed = runCliJson<any>(root, [
        'playbook_seed_propose_batch',
        '--source=done-experience',
        '--apply',
        `--observeDigest=${observe1.observeDigest}`,
        '--limit=1',
        '--json',
      ]);
      assert.equal(proposed.applied, true);
      assert.equal(proposed.proposalCount, 1);
      assert.equal(proposed.proposals[0].seed.sourceArtifactKind, 'done_experience');
      assert.equal(listProposals(root).length, 1);

      const observeAfterProposal = parseJson<any>(handlers.playbook_seed_observe({
        source: 'done-experience',
        json: true,
      }));
      assert.equal(observeAfterProposal.proposableSeeds.length, 0, 'staged proposal represents the DONE source');
      assert.ok(observeAfterProposal.alreadyRepresentedSources.some((row: any) =>
        row.sourceArtifactKind === 'done_experience'
        && row.blockReasons.includes('already_represented')));

      const repeatedPropose = parseJson<any>(handlers.playbook_seed_propose_batch({
        source: 'done-experience',
        apply: true,
        observeDigest: observeAfterProposal.observeDigest,
        json: true,
      }));
      assert.equal(repeatedPropose.proposalCount, 0);
      assert.equal(listProposals(root).length, 1, 'repeated propose did not duplicate proposal rows');

      const manifest = runCliJson<any>(root, ['playbook_candidate_batch_approve', '--json']);
      assert.equal(manifest.proposalCount, 1);
      assert.equal(manifest.proposals[0].sourceArtifactKind, 'done_experience');
      const approved = runCliJson<any>(root, [
        'playbook_candidate_batch_approve',
        '--apply',
        `--manifestDigest=${manifest.manifestDigest}`,
        '--json',
      ]);
      assert.equal(approved.applied, true);
      assert.equal(readPlaybooks(root).length, 1);
      const candidate = readPlaybooks(root)[0];
      assert.equal(candidate.status, 'candidate', 'DONE experience approval never activates');
      assert.equal(listProposals(root).length, 0);
      assert.equal(readPlaybookOutcomeEvents(root).length, 0, 'DONE success alone wrote no helped/outcome rows');
      assert.equal(aggregatePlaybookPromotion(candidate, readPlaybookOutcomeEvents(root), []).helpedCount, 0);

      const observeAfterApprove = parseJson<any>(handlers.playbook_seed_observe({
        source: 'done-experience',
        json: true,
      }));
      assert.equal(observeAfterApprove.proposableSeeds.length, 0, 'candidate represents the DONE source');
      const secondPropose = parseJson<any>(handlers.playbook_seed_propose_batch({
        source: 'done-experience',
        apply: true,
        observeDigest: observeAfterApprove.observeDigest,
        json: true,
      }));
      assert.equal(secondPropose.proposalCount, 0);
      const emptyManifest = parseJson<any>(handlers.playbook_candidate_batch_approve({ json: true }));
      const secondApprove = parseJson<any>(handlers.playbook_candidate_batch_approve({
        apply: true,
        manifestDigest: emptyManifest.manifestDigest,
        json: true,
      }));
      assert.equal(secondApprove.proposalCount, 0);
      assert.equal(readPlaybooks(root).length, 1, 'repeated observe/propose/approve did not duplicate candidates');
      assert.equal(readPlaybooks(root)[0].status, 'candidate');
    });

    check('B-a4f7 candidate ingest dry-run/apply is scoped, inert, and idempotent', () => {
      const root = mkProject('ba4f7-candidate-ingest-');
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedDoneExperienceStory(store, DONE_STORY_ID);
      seedDoneExperienceStory(store, 'B-done2');
      seedStory(store);
      writeProposal(root, unrelatedSeedProposal());
      const handlers = createPlaybookHandlers(ctx);

      const beforeDryRun = snapshotDir(root, '.lattice');
      const dryRun = parseJson<any>(handlers.playbook_candidate_ingest({
        storyId: DONE_STORY_ID,
        json: true,
      }));
      assert.equal(dryRun.dryRun, true);
      assert.equal(dryRun.applied, false);
      assert.equal(dryRun.sourceFilter, 'done-experience');
      assert.equal(dryRun.storyId, DONE_STORY_ID);
      assert.equal(dryRun.proposedCount, 1);
      assert.equal(dryRun.candidateCreatedCount, 0);
      assert.match(dryRun.observeDigest, /^[a-f0-9]{64}$/);
      assert.match(dryRun.proposalManifestDigest, /^[a-f0-9]{64}$/);
      assert.match(dryRun.manifestDigest, /^[a-f0-9]{64}$/);
      assert.equal(snapshotDir(root, '.lattice'), beforeDryRun, 'candidate ingest dry-run must not write');

      const cliDryRun = runCliJson<any>(root, [
        'playbook_candidate_ingest',
        '--storyId',
        DONE_STORY_ID,
        '--json',
      ]);
      assert.equal(cliDryRun.dryRun, true);
      assert.equal(cliDryRun.sourceFilter, 'done-experience');
      assert.equal(readPlaybooks(root).length, 0);
      assert.equal(readPlaybookOutcomeEvents(root).length, 0);
      assert.equal(readPlaybookAutoActivationEvents(root).length, 0);

      const applied = parseJson<any>(handlers.playbook_candidate_ingest({
        storyId: DONE_STORY_ID,
        apply: true,
        json: true,
      }));
      assert.equal(applied.applied, true);
      assert.equal(applied.proposedCount, 1);
      assert.equal(applied.candidateCreatedCount, 1);
      assert.equal(applied.candidatePlaybookIds.length, 1);
      const playbooks = readPlaybooks(root);
      assert.equal(playbooks.length, 1);
      assert.equal(playbooks[0].status, 'candidate', 'candidate ingest never activates');
      assert.notEqual(playbooks[0].id, 'PBP-777', 'unrelated pre-existing proposal was not approved');
      assert.ok(readProposal(root, 'PBP-777'), 'unrelated pre-existing proposal remains staged');
      assert.equal(readPlaybookOutcomeEvents(root).length, 0, 'candidate ingest writes no outcome rows');
      assert.equal(readPlaybookAutoActivationEvents(root).length, 0, 'candidate ingest writes no auto-activation rows');

      const repeated = parseJson<any>(handlers.playbook_candidate_ingest({
        storyId: DONE_STORY_ID,
        apply: true,
        json: true,
      }));
      assert.equal(repeated.proposedCount, 0);
      assert.equal(repeated.candidateCreatedCount, 0);
      assert.equal(readPlaybooks(root).length, 1, 'second ingest does not duplicate candidates');
      assert.ok(readProposal(root, 'PBP-777'), 'idempotent rerun still does not consume unrelated proposals');
      assert.equal(readPlaybookOutcomeEvents(root).length, 0);
      assert.equal(readPlaybookAutoActivationEvents(root).length, 0);
    });

    check('B-a4f7 post-DONE settlement hook ingests candidates best-effort with opt-out', () => {
      const root = mkProject('ba4f7-done-hook-');
      roots.push(root);
      const { store } = mkCtx(root);
      seedDoneExperienceStory(store, DONE_STORY_ID);

      const recorded = withEnv({
        PLAYBOOK_DONE_SETTLEMENT_ENABLED: undefined,
        PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED: undefined,
      }, () => runPostDoneLearningSettlement(root, DONE_STORY_ID));
      assert.equal(recorded.settlementStatus, 'recorded');
      assert.equal(recorded.candidateIngestStatus, 'applied');
      assert.equal(recorded.candidateIngestCandidateCreatedCount, 1);
      assert.match(recorded.candidateIngestObserveDigest ?? '', /^[a-f0-9]{64}$/);
      assert.match(recorded.candidateIngestProposalManifestDigest ?? '', /^[a-f0-9]{64}$/);
      assert.match(recorded.candidateIngestManifestDigest ?? '', /^[a-f0-9]{64}$/);
      assert.equal(readPlaybooks(root).length, 1);
      assert.equal(readPlaybooks(root)[0].status, 'candidate');
      assert.equal(readPlaybookOutcomeEvents(root).length, 0, 'DONE hook writes no outcome rows');
      assert.equal(readPlaybookAutoActivationEvents(root).length, 0, 'DONE hook writes no auto-activation rows');
      assert.ok(readPlaybookPromotionHealthEvents(root).events.some((row) =>
        row.storyId === DONE_STORY_ID
        && /DONE candidate ingest applied/.test(row.message)
        && row.gateEvidence === false));

      const repeated = withEnv({
        PLAYBOOK_DONE_SETTLEMENT_ENABLED: '1',
        PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED: '1',
      }, () => runPostDoneLearningSettlement(root, DONE_STORY_ID));
      assert.equal(repeated.settlementStatus, 'recorded');
      assert.equal(repeated.candidateIngestStatus, 'no_candidates');
      assert.equal(repeated.candidateIngestCandidateCreatedCount, 0);
      assert.equal(readPlaybooks(root).length, 1, 'DONE hook candidate ingest is idempotent');

      const disabledRoot = mkProject('ba4f7-done-hook-disabled-');
      roots.push(disabledRoot);
      const { store: disabledStore } = mkCtx(disabledRoot);
      seedDoneExperienceStory(disabledStore, DONE_STORY_ID);
      const disabled = withEnv({
        PLAYBOOK_DONE_SETTLEMENT_ENABLED: '1',
        PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED: 'off',
      }, () => runPostDoneLearningSettlement(disabledRoot, DONE_STORY_ID));
      assert.equal(disabled.settlementStatus, 'recorded');
      assert.equal(disabled.candidateIngestStatus, 'disabled');
      assert.equal(readPlaybooks(disabledRoot).length, 0, 'candidate opt-out prevents DONE candidate creation');
      assert.equal(readPlaybookOutcomeEvents(disabledRoot).length, 0);
      assert.equal(readPlaybookAutoActivationEvents(disabledRoot).length, 0);
    });

    check('B-c28f partial DONE artifacts do not crash done_experience observation', () => {
      const root = mkProject('bc28f-done-partial-');
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      const partialStoryId = 'B-done-partial';
      store.writeStory(partialStoryId, story(partialStoryId, 'DONE'));
      store.writeChecklist(partialStoryId, { items: [] });
      store.writeFindings(partialStoryId, { findings: [] });
      write(root, `.lattice/story/actives/${partialStoryId}/summary.json`, JSON.stringify({
        storyId: partialStoryId,
        pitfalls: 'Partial DONE summary pitfall is enough to create a stable non-authoritative seed.',
      }, null, 2));

      const report = parseJson<any>(createPlaybookHandlers(ctx).playbook_seed_observe({
        source: 'done-experience',
        json: true,
      }));
      assert.ok(report.proposableSeeds.some((seed: any) =>
        seed.sourceArtifactKind === 'done_experience'
        && seed.sourceArtifactId === partialStoryId
        && seed.sourcePitfalls.some((text: string) => /Partial DONE summary/.test(text))));
      assert.match(report.observeDigest, /^[a-f0-9]{64}$/);
    });

    check('M3/M4/M8 default dry-run writer surfaces do not mutate learning stores', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const handlers = createPlaybookHandlers(ctx);

      const beforeProposeDryRun = snapshotDir(root, '.lattice');
      const proposeDryRun = parseJson<any>(handlers.playbook_seed_propose_batch({ json: true }));
      assert.equal(proposeDryRun.dryRun, true);
      assert.equal(proposeDryRun.applied, false);
      assert.equal(snapshotDir(root, '.lattice'), beforeProposeDryRun, 'default propose dry-run must not write');

      const observe = parseJson<any>(handlers.playbook_seed_observe({ json: true }));
      handlers.playbook_seed_propose_batch({ apply: true, observeDigest: observe.observeDigest, json: true });
      const beforeApproveDryRun = snapshotDir(root, '.lattice');
      const approveDryRun = parseJson<any>(handlers.playbook_candidate_batch_approve({ json: true }));
      assert.equal(approveDryRun.dryRun, true);
      assert.equal(approveDryRun.applied, false);
      assert.equal(snapshotDir(root, '.lattice'), beforeApproveDryRun, 'default approve dry-run must not write candidates or clear proposals');

      const manifest = parseJson<any>(handlers.playbook_candidate_batch_approve({ json: true }));
      handlers.playbook_candidate_batch_approve({ apply: true, manifestDigest: manifest.manifestDigest, json: true });
      const beforeAutoDryRun = snapshotDir(root, '.lattice');
      const autoDryRun = parseJson<any>(handlers.playbook_auto_promotion_apply({ json: true }));
      assert.equal(autoDryRun.dryRun, true);
      assert.equal(autoDryRun.applied, false);
      assert.equal(snapshotDir(root, '.lattice'), beforeAutoDryRun, 'default auto-promotion dry-run must not write');
    });

    check('M3 observeDigest drift fails closed without proposal writes', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const handlers = createPlaybookHandlers(ctx);
      const observe = parseJson<any>(handlers.playbook_seed_observe({ json: true }));
      writeEntries(resolveProjectMemoryPath(root), [
        memoryEntry('mem-seed-preferred'),
        memoryEntry('mem-drift', {
          sourceStoryId: STORY_ID,
          evidenceRefs: [FINDING_ID],
          summary: 'Digest drift memory changes reviewed seed material.',
        }),
      ]);
      assert.throws(
        () => handlers.playbook_seed_propose_batch({ apply: true, observeDigest: observe.observeDigest, json: true }),
        /observeDigest drift/,
      );
      assert.equal(listProposals(root).length, 0, 'drift failure wrote no proposals');
    });

    check('M3/M4 batch apply stages proposals then approves candidates only', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const handlers = createPlaybookHandlers(ctx);
      const observe = parseJson<any>(handlers.playbook_seed_observe({ json: true }));
      const proposed = parseJson<any>(handlers.playbook_seed_propose_batch({
        apply: true,
        observeDigest: observe.observeDigest,
        json: true,
      }));
      assert.equal(proposed.applied, true);
      assert.equal(listProposals(root).length, proposed.proposalCount);
      const proposal = readProposal(root, proposed.proposals[0].proposalId);
      assert.ok(proposal?.seed?.canonicalSourceKey, 'proposal records seed canonical source key');
      const manifest = parseJson<any>(handlers.playbook_candidate_batch_approve({ json: true }));
      assert.match(manifest.manifestDigest, /^[a-f0-9]{64}$/);
      assert.throws(
        () => handlers.playbook_candidate_batch_approve({ apply: true, manifestDigest: '0'.repeat(64), json: true }),
        /manifestDigest drift/,
      );
      const approved = parseJson<any>(handlers.playbook_candidate_batch_approve({
        apply: true,
        manifestDigest: manifest.manifestDigest,
        json: true,
      }));
      assert.equal(approved.applied, true);
      assert.equal(listProposals(root).length, 0, 'approved proposals cleared');
      const playbooks = readPlaybooks(root);
      assert.ok(playbooks.length > 0, 'candidate written');
      assert.ok(playbooks.every((row) => row.status === 'candidate'), 'batch approval never activates');
    });

    check('M4 batch approval rejects duplicate canonicalSourceKey proposal rows', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const handlers = createPlaybookHandlers(ctx);
      const observe = parseJson<any>(handlers.playbook_seed_observe({ json: true }));
      const proposed = parseJson<any>(handlers.playbook_seed_propose_batch({
        apply: true,
        observeDigest: observe.observeDigest,
        json: true,
      }));
      const original = readProposal(root, proposed.proposals[0].proposalId);
      assert.ok(original, 'original proposal exists');
      const duplicate: PlaybookProposal = {
        ...original!,
        id: 'PBP-999',
        proposalDigest: '',
      };
      duplicate.proposalDigest = computePlaybookProposalDigest(duplicate);
      writeProposal(root, duplicate);

      const manifest = parseJson<any>(handlers.playbook_candidate_batch_approve({ json: true }));
      assert.ok(manifest.invalidProposals.some((row: any) => /duplicate canonicalSourceKey/.test(row.reason)));
      assert.throws(
        () => handlers.playbook_candidate_batch_approve({ apply: true, manifestDigest: manifest.manifestDigest, json: true }),
        /duplicate canonicalSourceKey/,
      );
      assert.equal(readPlaybooks(root).length, 0, 'duplicate canonical proposals cannot become duplicate candidates');
      assert.equal(listProposals(root).length, 2, 'failed approval leaves proposals staged for operator review');
    });

    check('M4 batch approval rejects proposals whose canonical source is already represented', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const handlers = createPlaybookHandlers(ctx);
      const observe = parseJson<any>(handlers.playbook_seed_observe({ json: true }));
      handlers.playbook_seed_propose_batch({
        apply: true,
        observeDigest: observe.observeDigest,
        json: true,
      });
      const represented = playbook('PB-existing', 'candidate', 'represented-seed');
      delete represented.lineage.sourceSignature;
      writePlaybooks(root, [represented]);

      const manifest = parseJson<any>(handlers.playbook_candidate_batch_approve({ json: true }));
      assert.ok(manifest.invalidProposals.some((row: any) => /canonicalSourceKey already represented/.test(row.reason)));
      assert.throws(
        () => handlers.playbook_candidate_batch_approve({ apply: true, manifestDigest: manifest.manifestDigest, json: true }),
        /canonicalSourceKey already represented/,
      );
      assert.equal(readPlaybooks(root).length, 1, 'represented source approval does not add a second candidate');
    });

    check('M5 non_promotable blocks future seed promotion while preserving non_deducible storage', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      const f = finding(STORY_ID, '001');
      seedStory(store, STORY_ID, [f]);
      writeEntries(resolveProjectMemoryPath(root), [memoryEntry('mem-nonpromo')]);
      markNonDeducibleSource(root, {
        source: buildPlaybookSourceReference({
          sourceStoryId: STORY_ID,
          sourceFindingId: FINDING_ID,
        }),
        reasonCodes: ['source_rejected_sibling_threshold'],
        reason: 'smoke marks source non_promotable through legacy non_deducible registry',
        sourceRejectedSiblingCount: 3,
        markedAt: NOW,
      });
      const text = createPlaybookHandlers(ctx).playbook_seed_observe({});
      assert.match(text, /non_promotable: 1/);
      assert.match(text, /legacy storage: non_deducible/);
      const report = parseJson<any>(createPlaybookHandlers(ctx).playbook_seed_observe({ json: true }));
      assert.ok(report.nonPromotableBlocks.some((row: any) => row.blockReasons.includes('non_promotable')));
    });

    check('M5 DONE-style neutral settlement does not infer helped outcome', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const handlers = createPlaybookHandlers(ctx);
      const candidate = approveSeedCandidate(root, handlers);
      assert.throws(
        () => handlers.playbook_outcome_record({
          storyId: STORY_ID,
          playbookId: candidate.id,
          exposureMode: 'none',
          consumer: 'done_closure',
          context: { storyPhase: 'DONE', storyType: 'chore', fileKinds: ['ts'], triggerClasses: ['done'] },
          outcome: {
            verdict: 'helped',
            verdictSource: 'done-settlement',
            causedNoise: false,
            causedWrongClaim: false,
            preventedRepeatFinding: true,
          },
          bindings: {},
        }),
        /helped outcomes require exposureMode other than none/,
      );
      handlers.playbook_outcome_record(doneSettlementOutcome(candidate.id));
      const aggregate = aggregatePlaybookPromotion(candidate, [{
        ...doneSettlementOutcome(candidate.id),
        playbookId: candidate.id,
      }], []);
      assert.equal(aggregate.helpedCount, 0);
      assert.equal(aggregate.neutralCount, 1);
    });

    check('M8 DONE-settlement helped rows cannot drive evidence activation', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const handlers = createPlaybookHandlers(ctx);
      const candidate = approveSeedCandidate(root, handlers);

      recordDoneSettlementHelpedOutcome(handlers, candidate.id, 1);
      recordDoneSettlementHelpedOutcome(handlers, candidate.id, 2);
      recordDoneSettlementHelpedOutcome(handlers, candidate.id, 3);
      recordNeutralReviewerOutcome(handlers, candidate.id);

      const aggregate = aggregatePlaybookPromotion(candidate, readPlaybookOutcomeEvents(root), []);
      assert.equal(aggregate.helpedCount, 0, 'DONE-settlement helped rows are not helped promotion evidence');
      assert.equal(aggregate.decisiveSamples, 0, 'DONE-settlement helped rows are not decisive promotion evidence');
      assert.equal(aggregate.contextClassCount, 0, 'DONE-settlement rows do not satisfy context diversity');
      assert.equal(evaluatePlaybookPromotion(aggregate).action, 'hold');

      const dry = runCliJson<any>(root, ['playbook_auto_promotion_apply', '--json']);
      const guard = dry.candidateGuards.find((row: any) => row.playbookId === candidate.id);
      assert.ok(guard, 'auto-promotion guard reported candidate');
      assert.equal(guard.realOutcomeCount, 1, 'only the real reviewer exposure counts as real outcome evidence');
      assert.equal(guard.exposureCount, 1, 'reviewer neutral exposure remains observable');
      assert.notEqual(guard.recommendation, 'recommend_activate');
      assert.equal(guard.eligible, false);
      assert.ok(guard.blockers.includes('promotion_recommendation_hold'));
      const beforeApply = snapshotDir(root, '.lattice/learning');
      assert.match(runCliFailure(root, ['playbook_auto_promotion_apply', '--apply', '--json']), /fail-closed/);
      assert.equal(snapshotDir(root, '.lattice/learning'), beforeApply, 'DONE-settlement apply does not write learning artifacts on failure');
    });

    check('M6 runtime verification consumes active playbooks and keeps candidates inert', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedStory(store);
      writePlaybooks(root, [
        playbook('PB-active', 'active', 'runtime-seed'),
        playbook('PB-candidate', 'candidate', 'runtime-seed'),
      ]);
      const report = parseJson<any>(createPlaybookHandlers(ctx).playbook_runtime_consumption_verify({ json: true }));
      assert.equal(report.authority, 'non_authoritative');
      assert.equal(report.gateEvidence, false);
      assert.ok(report.activeChecks.some((row: any) => row.playbookId === 'PB-active' && row.consumedByAll));
      assert.ok(report.candidateInertness.some((row: any) => row.playbookId === 'PB-candidate' && row.inert));
    });

    check('M8 evidence activation fails closed without evidence and activates qualified candidates', () => {
      const preOutcomeRoot = mkProject();
      roots.push(preOutcomeRoot);
      const { store: preOutcomeStore } = mkCtx(preOutcomeRoot);
      seedLearning(preOutcomeRoot, preOutcomeStore);
      const preOutcomeCandidate = approveSeedCandidateViaCli(preOutcomeRoot);

      const noEvidenceDry = runCliJson<any>(preOutcomeRoot, ['playbook_auto_promotion_apply', '--json']);
      assert.equal(noEvidenceDry.activationImplemented, true);
      assert.equal(noEvidenceDry.activatedCount, 0);
      assert.ok(noEvidenceDry.candidateGuards.some((guard: any) =>
        guard.playbookId === preOutcomeCandidate.id
        && guard.blockers.includes('no_real_candidate_consumption_outcomes')
        && guard.blockers.includes('promotion_recommendation_hold')));
      const beforeNoEvidenceApply = snapshotDir(preOutcomeRoot, '.lattice/learning');
      assert.match(runCliFailure(preOutcomeRoot, ['playbook_auto_promotion_apply', '--apply', '--json']), /fail-closed/);
      assert.equal(snapshotDir(preOutcomeRoot, '.lattice/learning'), beforeNoEvidenceApply, 'pre-outcome apply did not write learning artifacts');
      assert.ok(readPlaybooks(preOutcomeRoot).every((row) => row.status !== 'active'), 'pre-outcome apply did not activate');

      const noExposureRoot = mkProject();
      roots.push(noExposureRoot);
      const { store: noExposureStore } = mkCtx(noExposureRoot);
      seedLearning(noExposureRoot, noExposureStore);
      const noExposureCandidate = approveSeedCandidateViaCli(noExposureRoot);
      recordNoExposureOutcomeViaCli(noExposureRoot, noExposureCandidate.id);
      const noExposureBeforeApply = snapshotDir(noExposureRoot, '.lattice/learning');
      assert.match(runCliFailure(noExposureRoot, ['playbook_auto_promotion_apply', '--apply', '--json']), /fail-closed/);
      assert.equal(snapshotDir(noExposureRoot, '.lattice/learning'), noExposureBeforeApply, 'no-exposure apply did not write recommendation or activation rows');
      assert.equal(readPlaybooks(noExposureRoot).find((row) => row.id === noExposureCandidate.id)?.status, 'candidate');

      const staleRoot = mkProject();
      roots.push(staleRoot);
      const { store: staleStore } = mkCtx(staleRoot);
      seedLearning(staleRoot, staleStore);
      const staleCandidate = approveSeedCandidateViaCli(staleRoot);
      recordHelpedOutcomeViaCli(staleRoot, staleCandidate.id, 1, { host: 'codex-a', trigger: 'claim-boundary' });
      recordHelpedOutcomeViaCli(staleRoot, staleCandidate.id, 2, { host: 'claude-b', trigger: 'stale-authority-wording' });
      recordHelpedOutcomeViaCli(staleRoot, staleCandidate.id, 3, { host: 'codex-c', trigger: 'claim-boundary' });
      const staleDecision = appendAppliedRecommendActivateDecision(staleRoot, staleCandidate);
      const staleDecisionCountBeforeDuplicate = readPlaybookPromotionDecisionRows(staleRoot).decisions.length;
      appendPlaybookPromotionDecision(staleRoot, {
        ...staleDecision,
        decisionId: 'PBD-SMOKE-STALE-DUPLICATE',
        decidedAt: '2026-07-02T01:21:00.000Z',
        alreadyApplied: true,
      });
      assert.equal(
        readPlaybookPromotionDecisionRows(staleRoot).decisions.length,
        staleDecisionCountBeforeDuplicate,
        'duplicate applied promotion decision idempotency keys no-op at append time',
      );
      writePlaybooks(staleRoot, readPlaybooks(staleRoot).map((row) =>
        row.id === staleCandidate.id ? { ...row, check: `${row.check} Edited after stale recommendation.` } : row));
      const staleDry = runCliJson<any>(staleRoot, ['playbook_auto_promotion_apply', '--json']);
      const staleGuard = staleDry.candidateGuards.find((row: any) => row.playbookId === staleCandidate.id);
      assert.ok(staleGuard?.blockers.includes('applied_recommend_activate_decision_digest_mismatch'));
      const staleBeforeApply = snapshotDir(staleRoot, '.lattice/learning');
      assert.match(runCliFailure(staleRoot, ['playbook_auto_promotion_apply', '--apply', '--json']), /fail-closed/);
      assert.equal(snapshotDir(staleRoot, '.lattice/learning'), staleBeforeApply, 'stale decision apply did not write replacement evidence or activation rows');
      assert.equal(readPlaybooks(staleRoot).find((row) => row.id === staleCandidate.id)?.status, 'candidate');
      assert.equal(readPlaybookAutoActivationEvents(staleRoot).filter((row) => row.playbookId === staleCandidate.id).length, 0);
      const staleDecisionRows = readPlaybookPromotionDecisionRows(staleRoot).decisions.filter((row) =>
        row.playbookId === staleCandidate.id && row.action === 'recommend_activate' && row.applied);
      assert.equal(staleDecisionRows.length, 1);
      assert.equal(staleDecisionRows[0].decisionId, staleDecision.decisionId);

      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const handlers = createPlaybookHandlers(ctx);
      const candidate = approveSeedCandidateViaCli(root);

      recordHelpedOutcomeViaCli(root, candidate.id, 1, { host: 'codex-a', trigger: 'claim-boundary' });
      recordHelpedOutcomeViaCli(root, candidate.id, 2, { host: 'claude-b', trigger: 'stale-authority-wording' });
      recordHelpedOutcomeViaCli(root, candidate.id, 3, { host: 'codex-c', trigger: 'claim-boundary' });
      const duplicateOutcome = {
        ...readPlaybookOutcomeEvents(root).find((row) => row.idempotencyKey === 'cli-activate-helped-1')!,
        eventId: 'PBO-ACTIVATE-1-DUPLICATE',
        observedAt: '2026-07-02T00:04:00.000Z',
      };
      const duplicateAppendBefore = readPlaybookOutcomeEvents(root).length;
      appendPlaybookOutcomeEvent(root, duplicateOutcome);
      assert.equal(
        readPlaybookOutcomeEvents(root).length,
        duplicateAppendBefore,
        'duplicate outcome idempotency keys no-op at append time',
      );
      const duplicatedRowsAggregate = aggregatePlaybookPromotion(candidate, [
        duplicateOutcome,
        duplicateOutcome,
        {
          ...duplicateOutcome,
          eventId: 'PBO-ACTIVATE-1-DUPLICATE-HISTORICAL',
          observedAt: '2026-07-02T00:05:00.000Z',
        },
      ], []);
      assert.equal(duplicatedRowsAggregate.helpedCount, 1, 'historical duplicate idempotency rows count once');
      assert.equal(duplicatedRowsAggregate.decisiveSamples, 1, 'historical duplicate idempotency rows remain one decisive sample');
      assert.notEqual(
        evaluatePlaybookPromotion(duplicatedRowsAggregate).action,
        'recommend_activate',
        'duplicate idempotency rows alone cannot satisfy activation thresholds',
      );
      const beforeDryRun = snapshotDir(root, '.lattice/learning');
      const noDecisionDry = runCliJson<any>(root, ['playbook_auto_promotion_apply', '--json']);
      assert.equal(snapshotDir(root, '.lattice/learning'), beforeDryRun, 'auto-promotion dry-run remains read-only for learning artifacts');
      const noDecisionGuard = noDecisionDry.candidateGuards.find((row: any) => row.playbookId === candidate.id);
      assert.equal(noDecisionGuard?.recommendation, 'recommend_activate');
      assert.ok(noDecisionGuard?.blockers.includes('missing_applied_recommend_activate_decision'));

      const activationLogPath = resolvePlaybookAutoActivationsPath(root);
      mkdirSync(dirname(activationLogPath), { recursive: true });
      writeFileSync(activationLogPath, '{malformed activation row\n', 'utf8');
      const beforeMalformedAuditApply = snapshotDir(root, '.lattice/learning');
      assert.match(
        runCliFailure(root, ['playbook_auto_promotion_apply', '--apply', '--json']),
        /fail-closed|Expected property name|Unexpected token|JSON/,
      );
      assert.equal(snapshotDir(root, '.lattice/learning'), beforeMalformedAuditApply, 'malformed activation log must not leave candidate active or write recommendations');
      assert.equal(readPlaybooks(root).find((row) => row.id === candidate.id)?.status, 'candidate');
      assert.equal(readPlaybookAutoActivationEvents(root).filter((row) => row.playbookId === candidate.id).length, 0);
      assert.equal(readPlaybookPromotionDecisionRows(root).decisions.filter((row) => row.playbookId === candidate.id).length, 0);
      rmSync(activationLogPath, { force: true });

      const applied = runCliJson<any>(root, ['playbook_auto_promotion_apply', '--apply', '--json']);
      assert.equal(applied.applied, true);
      assert.equal(applied.activatedCount, 1);
      assert.equal(applied.activatedPlaybooks[0].playbookId, candidate.id);
      assert.match(applied.activatedPlaybooks[0].promotionDecisionDigest, /^[a-f0-9]{64}$/);
      assert.equal(applied.authority, 'non_authoritative');
      assert.equal(applied.gateEvidence, false);
      assert.equal(readPlaybooks(root).find((row) => row.id === candidate.id)?.status, 'active');
      const decisionRows = readPlaybookPromotionDecisionRows(root).decisions.filter((row) =>
        row.playbookId === candidate.id && row.action === 'recommend_activate' && row.applied);
      assert.equal(decisionRows.length, 1);
      assert.match(decisionRows[0].decisionId, /^PBD-AUTO-/);
      assert.equal(decisionRows[0].before.playbookDigest, applied.activatedPlaybooks[0].candidatePlaybookDigest);
      assert.equal(decisionRows[0].authority, 'non_authoritative');
      assert.equal(decisionRows[0].gateEvidence, false);
      const activationRows = readPlaybookAutoActivationEvents(root).filter((row) => row.playbookId === candidate.id);
      assert.equal(activationRows.length, 1);
      assert.match(activationRows[0].evidence.decisionDigest, /^[a-f0-9]{64}$/);
      assert.equal(activationRows[0].authority, 'non_authoritative');
      assert.equal(activationRows[0].gateEvidence, false);

      const runtime = runCliJson<any>(root, ['playbook_runtime_consumption_verify', '--json']);
      assert.ok(runtime.activeChecks.some((row: any) => row.playbookId === candidate.id && row.consumedByAll));

      const second = runCliJson<any>(root, ['playbook_auto_promotion_apply', '--apply', '--json']);
      assert.equal(second.applied, true);
      assert.equal(second.activatedCount, 0, 'second apply is idempotent after candidate is active');
      assert.equal(readPlaybookAutoActivationEvents(root).filter((row) => row.playbookId === candidate.id).length, 1);
      assert.equal(readPlaybookPromotionDecisionRows(root).decisions.filter((row) =>
        row.playbookId === candidate.id && row.action === 'recommend_activate' && row.applied).length, 1);

      handlers.playbook_outcome_record({
        eventId: 'PBO-ACTIVE-HARMFUL',
        idempotencyKey: 'active-harmful',
        observedAt: '2026-07-02T00:10:00.000Z',
        storyId: STORY_ID,
        playbookId: candidate.id,
        exposureMode: 'active-advisory',
        consumer: 'final_response_check',
        context: { storyPhase: 'DONE', storyType: 'feature', fileKinds: ['ts'], triggerClasses: ['claim-boundary'], host: 'codex-a' },
        outcome: {
          verdict: 'harmful',
          verdictSource: 'reviewer',
          causedNoise: true,
          causedWrongClaim: true,
          preventedRepeatFinding: false,
        },
        bindings: {},
      } as any);
      const demote = parseJson<any>(handlers.playbook_auto_promotion_apply({ json: true }));
      assert.ok(demote.demotionRecommendations.some((row: any) =>
        row.playbookId === candidate.id
        && row.recommendation === 'recommend_demote'
        && row.autoActivated === true));
    });

    check('M7 CLI status/readiness and read-only command surfaces execute through dist CLI', () => {
      const root = mkProject();
      roots.push(root);
      const { store } = mkCtx(root);
      seedLearning(root, store);

      const beforeObserveCli = snapshotDir(root, '.lattice');
      const observe = runCliJson<any>(root, ['playbook_seed_observe', '--json']);
      assert.match(observe.observeDigest, /^[a-f0-9]{64}$/);
      assert.equal(snapshotDir(root, '.lattice'), beforeObserveCli, 'CLI playbook_seed_observe is read-only');

      const beforeRuntimeCli = snapshotDir(root, '.lattice');
      const runtime = runCliJson<any>(root, ['playbook_runtime_consumption_verify', '--json']);
      assert.equal(runtime.authority, 'non_authoritative');
      assert.equal(runtime.gateEvidence, false);
      assert.equal(snapshotDir(root, '.lattice'), beforeRuntimeCli, 'CLI playbook_runtime_consumption_verify is read-only');

      const status = runCliJson<any>(root, ['playbook_promotion_status', '--json']);
      assert.equal(status.authority, 'non_authoritative');
      assert.equal(status.gateEvidence, false);
      assert.ok(Array.isArray(status.nonPromotableSources));
      assert.equal(status.nonDeducibleSources, undefined);
      assert.equal(typeof status.paths.nonPromotableSources, 'string');
      assert.equal(status.paths.nonDeducibleSources, undefined);
      assert.equal(status.compatibility.legacyStorage, 'non_deducible');
      assert.match(status.seedPromotionReadiness.v1.observeDigest, /^[a-f0-9]{64}$/);
      assert.equal(typeof status.seedPromotionReadiness.v1.proposableSeeds, 'number');
      assert.equal(status.seedPromotionReadiness.v2.activationImplemented, true);
      assert.equal(status.seedPromotionReadiness.v2.posture, 'evidence-activated/apply-eligible-candidates');
      assert.match(status.seedPromotionReadiness.v2.activationPolicyDigest, /^[a-f0-9]{64}$/);

      const statusText = runCli(root, ['playbook_promotion_status']);
      assert.match(statusText, /seedPromotionReadiness\.v1\.proposableSeeds:/);
      assert.match(statusText, /seedPromotionReadiness\.v2\.posture: evidence-activated\/apply-eligible-candidates/);
      assert.match(statusText, /^nonPromotableSources: \d+ \(legacy storage: non_deducible\)$/m);
      assert.doesNotMatch(statusText, /^nonDeducibleSources:/m);
    });

    check('command policy, fact levels, and phase allowlist classify new commands', () => {
      const names = [
        'playbook_seed_observe',
        'playbook_seed_propose_batch',
        'playbook_candidate_batch_approve',
        'playbook_candidate_ingest',
        'playbook_runtime_consumption_verify',
        'playbook_auto_promotion_apply',
      ] as const;
      for (const name of names) {
        assert.ok(MAIN_TOOLS.some((tool) => tool.name === name), `MAIN_TOOLS includes ${name}`);
        assert.equal((COMMAND_POLICIES as any)[name]?.gateEvidence, undefined, `${name} is not gate evidence`);
        assert.ok(PROCESS_FACT_LEVELS.some((entry) => entry.name === name), `PROCESS_FACT_LEVELS includes ${name}`);
        assert.equal(isCommandAllowed(name, 'DEV'), true, `${name} allowed in DEV by playbook_* phase pattern`);
      }
      assert.equal(COMMAND_POLICIES.playbook_seed_observe.ownershipClass, 'readOnly');
      assert.equal(COMMAND_POLICIES.playbook_runtime_consumption_verify.ownershipClass, 'readOnly');
      assert.equal(READ_ONLY_COMMANDS.has('playbook_seed_observe'), true);
      assert.equal(READ_ONLY_COMMANDS.has('playbook_runtime_consumption_verify'), true);
      assert.equal(COMMAND_POLICIES.playbook_seed_propose_batch.ownershipClass, 'mainSharedMutating');
      assert.equal(COMMAND_POLICIES.playbook_candidate_ingest.ownershipClass, 'mainSharedMutating');
      assert.equal(READ_ONLY_COMMANDS.has('playbook_candidate_ingest'), false);
      assert.equal(PROCESS_FACT_LEVELS.find((entry) => entry.name === 'playbook_seed_observe')?.level, 'L0');
      assert.equal(PROCESS_FACT_LEVELS.find((entry) => entry.name === 'playbook_candidate_batch_approve')?.level, 'L2');
      assert.equal(PROCESS_FACT_LEVELS.find((entry) => entry.name === 'playbook_candidate_ingest')?.level, 'L2');
    });
  } finally {
    if (priorGlobal === undefined) delete process.env.LATTICE_GLOBAL_MEMORY_DIR;
    else process.env.LATTICE_GLOBAL_MEMORY_DIR = priorGlobal;
    rmSync(globalRoot, { recursive: true, force: true });
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }

  console.log(`playbook-seed-promotion-loop smoke: ${passed}/${total} checks passed`);
  if (passed !== total) process.exitCode = 1;
}

run();
