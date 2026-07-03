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
  PlaybookAutoActivationEvent,
  PlaybookOutcomeEvent,
  PlaybookProposal,
} from '../core/experience-layer-types.js';
import {
  aggregatePlaybookPromotion,
  appendPlaybookOutcomeEvent,
  appendPlaybookAutoActivationEvent,
  buildPlaybookSourceReference,
  computePlaybookDigest,
  computePlaybookProposalDigest,
  evaluatePlaybookPromotion,
  listProposals,
  markNonDeducibleSource,
  readPlaybookAutoActivationEvents,
  readPlaybookOutcomeEvents,
  readPlaybooks,
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
import { createPlaybookHandlers } from '../handlers/playbook.js';

const NOW = '2026-07-02T00:00:00.000Z';
const STORY_ID = 'B-seed1';
const FINDING_ID = `${STORY_ID}:F-001`;
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

function story(storyId: string): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: `${storyId} playbook seed smoke`,
    description: 'Historical seed promotion loop smoke story.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: NOW }],
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

function recordHelpedOutcome(
  handlers: ReturnType<typeof createPlaybookHandlers>,
  playbookId: string,
  index: number,
  patch: { host?: string; trigger?: string } = {},
): void {
  handlers.playbook_outcome_record({
    eventId: `PBO-ACTIVATE-${index}`,
    idempotencyKey: `activate-helped-${index}`,
    observedAt: `2026-07-02T00:0${index}:00.000Z`,
    storyId: STORY_ID,
    playbookId,
    exposureMode: 'candidate-inspection',
    consumer: 'reviewer',
    context: {
      storyPhase: 'REVIEW',
      storyType: 'feature',
      fileKinds: ['ts'],
      triggerClasses: [patch.trigger ?? `activation-${index}`],
      host: patch.host ?? `host-${index}`,
      hostProvider: 'codex',
      hostCapabilityId: `cap-${index}`,
    },
    outcome: {
      verdict: 'helped',
      verdictSource: 'reviewer',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: true,
      note: 'Candidate prevented a repeated claim boundary error after explicit inspection.',
    },
    bindings: {},
  } as any);
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

function syntheticActivationEvent(candidate: Playbook, guard: any, policy: any): PlaybookAutoActivationEvent {
  const activeDigest = computePlaybookDigest({ ...candidate, status: 'active' });
  return {
    schemaVersion: 'proofbound.playbook-auto-activation.v1',
    activationId: `PBA-${guard.activationIdempotencyKey.slice(0, 16)}`,
    idempotencyKey: guard.activationIdempotencyKey,
    activatedAt: '2026-07-02T00:09:00.000Z',
    playbookId: candidate.id,
    before: {
      playbookStatus: 'candidate',
      playbookDigest: guard.playbookDigest,
    },
    after: {
      playbookStatus: 'active',
      playbookDigest: activeDigest,
    },
    policy: {
      policyId: policy.policyId,
      policyDigest: policy.policyDigest,
      reviewedBy: policy.reviewedBy,
    },
    evidence: {
      aggregateDigest: guard.aggregateDigest,
      decisionId: guard.promotionDecisionId,
      decisionIdempotencyKey: guard.promotionDecisionIdempotencyKey,
      decisionDigest: guard.promotionDecisionDigest,
      recommendation: 'recommend_activate',
      reasonCodes: guard.reasonCodes,
      decisiveSamples: guard.decisiveSamples,
      helpedCount: guard.helpedCount,
      dismissedCount: guard.dismissedCount,
      harmfulCount: guard.harmfulCount,
      wrongClaimCount: guard.wrongClaimCount,
      contextClassCount: guard.contextClassCount,
      realOutcomeCount: guard.realOutcomeCount,
      exposureCount: guard.exposureCount,
      lineageCanonicalSourceKey: guard.lineageCanonicalSourceKey,
    },
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function withSweepEnabled<T>(fn: () => T): T {
  const prior = process.env.PLAYBOOK_PROMOTION_SWEEP_ENABLED;
  process.env.PLAYBOOK_PROMOTION_SWEEP_ENABLED = 'true';
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.PLAYBOOK_PROMOTION_SWEEP_ENABLED;
    else process.env.PLAYBOOK_PROMOTION_SWEEP_ENABLED = prior;
  }
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

      const sweep = withSweepEnabled(() => parseJson<any>(handlers.playbook_promotion_sweep({ json: true })));
      const decision = sweep.decisions.find((row: any) => row.playbookId === candidate.id);
      assert.ok(decision, 'promotion sweep reported candidate decision');
      assert.notEqual(decision.action, 'recommend_activate', 'DONE-settlement helped rows must not recommend activation');

      const dry = parseJson<any>(handlers.playbook_auto_promotion_apply({ json: true }));
      const guard = dry.candidateGuards.find((row: any) => row.playbookId === candidate.id);
      assert.ok(guard, 'auto-promotion guard reported candidate');
      assert.equal(guard.realOutcomeCount, 1, 'only the real reviewer exposure counts as real outcome evidence');
      assert.equal(guard.exposureCount, 1, 'reviewer neutral exposure remains observable');
      assert.notEqual(guard.recommendation, 'recommend_activate');
      assert.equal(guard.eligible, false);
      assert.ok(guard.blockers.includes('promotion_recommendation_hold'));
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
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const handlers = createPlaybookHandlers(ctx);
      const candidate = approveSeedCandidate(root, handlers);

      const noEvidenceDry = parseJson<any>(handlers.playbook_auto_promotion_apply({ json: true }));
      assert.equal(noEvidenceDry.activationImplemented, true);
      assert.equal(noEvidenceDry.activatedCount, 0);
      assert.ok(noEvidenceDry.candidateGuards.some((guard: any) =>
        guard.playbookId === candidate.id
        && guard.blockers.includes('no_real_candidate_consumption_outcomes')
        && guard.blockers.includes('promotion_recommendation_hold')));
      assert.throws(
        () => handlers.playbook_auto_promotion_apply({ apply: true, json: true }),
        /fail-closed/,
      );
      assert.ok(readPlaybooks(root).every((row) => row.status !== 'active'), 'no-evidence apply did not activate');

      recordHelpedOutcome(handlers, candidate.id, 1, { host: 'codex-a', trigger: 'claim-boundary' });
      recordHelpedOutcome(handlers, candidate.id, 2, { host: 'claude-b', trigger: 'stale-authority-wording' });
      recordHelpedOutcome(handlers, candidate.id, 3, { host: 'codex-c', trigger: 'claim-boundary' });
      const duplicateOutcome = {
        ...readPlaybookOutcomeEvents(root).find((row) => row.idempotencyKey === 'activate-helped-1')!,
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
      const noDecisionDry = parseJson<any>(handlers.playbook_auto_promotion_apply({ json: true }));
      const noDecisionGuard = noDecisionDry.candidateGuards.find((row: any) => row.playbookId === candidate.id);
      assert.equal(noDecisionGuard?.recommendation, 'recommend_activate');
      assert.ok(noDecisionGuard?.blockers.includes('missing_applied_recommend_activate_decision'));
      const beforeNoDecisionApply = snapshotDir(root, '.lattice');
      assert.throws(
        () => handlers.playbook_auto_promotion_apply({ apply: true, json: true }),
        /fail-closed/,
      );
      assert.equal(snapshotDir(root, '.lattice'), beforeNoDecisionApply, 'outcomes alone must not activate or write');
      assert.equal(readPlaybooks(root).find((row) => row.id === candidate.id)?.status, 'candidate');

      const sweep = withSweepEnabled(() => parseJson<any>(handlers.playbook_promotion_sweep({ apply: true, json: true })));
      assert.ok(sweep.decisions.some((row: any) => row.playbookId === candidate.id && row.action === 'recommend_activate' && row.applied));

      const originalPlaybooks = readPlaybooks(root);
      writePlaybooks(root, originalPlaybooks.map((row) =>
        row.id === candidate.id ? { ...row, check: `${row.check} Extra stale edit after recommendation.` } : row));
      const staleDecisionDry = parseJson<any>(handlers.playbook_auto_promotion_apply({ json: true }));
      const staleGuard = staleDecisionDry.candidateGuards.find((row: any) => row.playbookId === candidate.id);
      assert.ok(staleGuard?.blockers.includes('applied_recommend_activate_decision_digest_mismatch'));
      assert.throws(
        () => handlers.playbook_auto_promotion_apply({ apply: true, json: true }),
        /fail-closed/,
      );
      writePlaybooks(root, originalPlaybooks);

      const eligibleDry = parseJson<any>(handlers.playbook_auto_promotion_apply({ json: true }));
      const guard = eligibleDry.candidateGuards.find((row: any) => row.playbookId === candidate.id);
      assert.ok(guard?.eligible, 'candidate became eligible after explicit outcome + recommend_activate evidence');
      assert.match(guard.promotionDecisionDigest, /^[a-f0-9]{64}$/);
      assert.equal(eligibleDry.globalBlockers.length, 0);
      assert.equal(eligibleDry.activationPolicy.policyId, 'proofbound.evidence-activated-advisory-playbook.v1');
      assert.doesNotMatch(JSON.stringify(eligibleDry), /PLAYBOOK_AUTO_ACTIVE_ENABLED/, 'old default-off env flag is not part of the activation contract');

      const activationLogPath = resolvePlaybookAutoActivationsPath(root);
      mkdirSync(dirname(activationLogPath), { recursive: true });
      writeFileSync(activationLogPath, '{malformed activation row\n', 'utf8');
      const beforeMalformedAuditApply = snapshotDir(root, '.lattice');
      assert.throws(
        () => handlers.playbook_auto_promotion_apply({ apply: true, json: true }),
        /fail-closed|Expected property name|Unexpected token|JSON/,
      );
      assert.equal(snapshotDir(root, '.lattice'), beforeMalformedAuditApply, 'malformed activation log must not leave candidate active');
      assert.equal(readPlaybooks(root).find((row) => row.id === candidate.id)?.status, 'candidate');
      assert.equal(readPlaybookAutoActivationEvents(root).filter((row) => row.playbookId === candidate.id).length, 0);
      rmSync(activationLogPath, { force: true });

      appendPlaybookAutoActivationEvent(root, syntheticActivationEvent(candidate, guard, eligibleDry.activationPolicy));
      const beforeExistingAuditApply = snapshotDir(root, '.lattice');
      assert.throws(
        () => handlers.playbook_auto_promotion_apply({ apply: true, json: true }),
        /activation_audit_already_exists|fail-closed/,
      );
      assert.equal(snapshotDir(root, '.lattice'), beforeExistingAuditApply, 'pre-existing activation audit blocks without extra writes');
      assert.equal(readPlaybooks(root).find((row) => row.id === candidate.id)?.status, 'candidate');
      assert.equal(readPlaybookAutoActivationEvents(root).filter((row) => row.playbookId === candidate.id).length, 1);
      rmSync(activationLogPath, { force: true });

      const applied = parseJson<any>(handlers.playbook_auto_promotion_apply({ apply: true, json: true }));
      assert.equal(applied.applied, true);
      assert.equal(applied.activatedCount, 1);
      assert.equal(applied.activatedPlaybooks[0].playbookId, candidate.id);
      assert.match(applied.activatedPlaybooks[0].promotionDecisionDigest, /^[a-f0-9]{64}$/);
      assert.equal(applied.authority, 'non_authoritative');
      assert.equal(applied.gateEvidence, false);
      assert.equal(readPlaybooks(root).find((row) => row.id === candidate.id)?.status, 'active');
      const activationRows = readPlaybookAutoActivationEvents(root).filter((row) => row.playbookId === candidate.id);
      assert.equal(activationRows.length, 1);
      assert.match(activationRows[0].evidence.decisionDigest, /^[a-f0-9]{64}$/);
      assert.equal(activationRows[0].authority, 'non_authoritative');
      assert.equal(activationRows[0].gateEvidence, false);

      const runtime = parseJson<any>(handlers.playbook_runtime_consumption_verify({ json: true }));
      assert.ok(runtime.activeChecks.some((row: any) => row.playbookId === candidate.id && row.consumedByAll));

      const second = parseJson<any>(handlers.playbook_auto_promotion_apply({ apply: true, json: true }));
      assert.equal(second.applied, true);
      assert.equal(second.activatedCount, 0, 'second apply is idempotent after candidate is active');
      assert.equal(readPlaybookAutoActivationEvents(root).filter((row) => row.playbookId === candidate.id).length, 1);

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
      assert.equal(PROCESS_FACT_LEVELS.find((entry) => entry.name === 'playbook_seed_observe')?.level, 'L0');
      assert.equal(PROCESS_FACT_LEVELS.find((entry) => entry.name === 'playbook_candidate_batch_approve')?.level, 'L2');
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
