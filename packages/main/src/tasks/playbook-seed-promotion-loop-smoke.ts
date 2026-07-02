#!/usr/bin/env node
/**
 * B-9958 smoke: deduped historical playbook seed promotion loop (M2-M8).
 *
 * Uses hermetic temp projects and a temp global-memory dir. Learning/playbook
 * artifacts remain non-authoritative and never become gate evidence.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { isCommandAllowed, loadConfig, resetConfigCache } from '../core/config.js';
import { resolveProjectMemoryPath, writeEntries, type DevMemoryEntry } from '../core/dev-memory.js';
import type {
  FindingSignalsCache,
  Playbook,
  PlaybookOutcomeEvent,
} from '../core/experience-layer-types.js';
import {
  aggregatePlaybookPromotion,
  buildPlaybookSourceReference,
  listProposals,
  markNonDeducibleSource,
  readPlaybooks,
  readProposal,
  resolveFindingSignalsPath,
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

    check('M8 auto-promotion guard is disabled by default and apply fails closed', () => {
      const root = mkProject();
      roots.push(root);
      const { ctx, store } = mkCtx(root);
      seedLearning(root, store);
      const handlers = createPlaybookHandlers(ctx);
      approveSeedCandidate(root, handlers);
      const dry = parseJson<any>(handlers.playbook_auto_promotion_apply({ json: true }));
      assert.equal(dry.activationImplemented, false);
      assert.ok(dry.globalBlockers.includes('PLAYBOOK_AUTO_ACTIVE_ENABLED_not_enabled'));
      assert.throws(
        () => handlers.playbook_auto_promotion_apply({ apply: true, json: true }),
        /fail-closed/,
      );
      assert.ok(readPlaybooks(root).every((row) => row.status !== 'active'), 'auto guard did not activate');
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
