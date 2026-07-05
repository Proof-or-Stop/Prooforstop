#!/usr/bin/env node
/**
 * @task B-8128
 * @checklist M4
 * @title playbook candidate capability-release lineage binding smoke
 * @type feature
 * @priority high
 * @description
 *   Proves B-8128 M4: the DONE playbook-candidate ingest path binds a candidate's
 *   PlaybookLineage to the product capability release recorded for its source
 *   story, via the REAL production functions (buildPlaybookSeedProposalBatch /
 *   buildPlaybookSeedBackfillReport call enrichSeedWithCapabilityLineage, and
 *   lineageFromSeed copies the fields).
 *
 *   Coverage:
 *     - happy:       capability release present -> candidate lineage carries
 *                    capabilityReleaseId/capabilityId/capabilityVersion/
 *                    artifactReleaseId/artifactSetDigest matching the record.
 *     - edge:        a pre-existing 3-field PlaybookLineage still parses; the
 *                    source story is `already_represented`, so re-applying the
 *                    ingest is a no-op (no duplicate candidate). Enrichment is a
 *                    no-op when no capability release exists (lineage stays 3
 *                    fields but valid).
 *     - adversarial: enrichment DOES change the proposal/candidate digest, yet
 *                    re-running produces no duplicate and trips no
 *                    stale-proposal / digest-drift rejection (idempotency is
 *                    keyed on canonicalSourceKey, not digest); a tampered
 *                    capability ledger fails open (lineage stays 3-field).
 * @changes
 *   - [M4] Cover the capability-release lineage binding with a smoke test.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveProjectMemoryPath, writeEntries, type DevMemoryEntry } from '../core/dev-memory.js';
import {
  buildPlaybookSeedObservation,
  buildPlaybookSeedProposalBatch,
  enrichSeedWithCapabilityLineage,
  lineageFromSeed,
  type PlaybookSeedCandidate,
} from '../core/playbook-seed.js';
import {
  computePlaybookProposalDigest,
  listProposals,
  readPlaybooks,
  validatePlaybook,
} from '../core/learning-store.js';
import {
  buildCapabilityReleaseRecord,
  writeCapabilityReleaseLedgerForTest,
} from '../core/capability-release.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';

const NOW = '2026-07-05T00:00:00.000Z';

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

function mkProject(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'b8128-cap-lineage-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return { root, store: new StoryStore(root) };
}

function story(storyId: string): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: `Story ${storyId}`,
    description: 'Synthetic capability-lineage smoke story.',
    type: 'feature',
    phase: 'DONE',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: NOW,
    events: [{ phase: 'DONE', action: 'advance', timestamp: NOW }],
  };
}

function memoryEntry(storyId: string): DevMemoryEntry {
  return {
    id: `mem-${storyId}`,
    createdAt: NOW,
    sourceAgent: 'playbook-capability-lineage-smoke',
    category: 'workflow',
    scope: 'project',
    summary: `${storyId} lesson has explicit lineage.`,
    trigger: 'B-8128 capability lineage smoke',
    lesson: `Lesson for ${storyId} should become candidate material only.`,
    reusePrompt: 'Use the DONE ingest to convert history into inert candidates.',
    sourceStoryId: storyId,
    evidenceRefs: [`${storyId}:F-001`],
    tags: ['capability-lineage'],
    gateEvidence: false,
    authority: 'non_authoritative',
  };
}

function seedStory(root: string, store: StoryStore, storyId: string): void {
  store.writeStory(storyId, story(storyId));
  store.writeChecklist(storyId, { items: [] });
  store.writeFindings(storyId, { findings: [] });
  write(root, `packages/main/src/${storyId}-change.ts`, `export const ${storyId.replace(/[^a-z0-9]/gi, '')} = true;\n`);
}

function withIsolatedGlobalMemory<T>(root: string, fn: () => T): T {
  const prior = process.env.LATTICE_GLOBAL_MEMORY_DIR;
  process.env.LATTICE_GLOBAL_MEMORY_DIR = join(root, 'global-memory');
  mkdirSync(process.env.LATTICE_GLOBAL_MEMORY_DIR, { recursive: true });
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.LATTICE_GLOBAL_MEMORY_DIR;
    else process.env.LATTICE_GLOBAL_MEMORY_DIR = prior;
  }
}

function capabilityReleaseFor(root: string, storyId: string) {
  return buildCapabilityReleaseRecord({
    root,
    storyId,
    mainCommit: 'a'.repeat(40),
    capabilityId: 'experiments-multi-model-ablation',
    capabilityKind: 'experiment-launch-control',
    changedPaths: ['experiments/multi-model-ablation/m2-provider-execution-check.mjs'],
    capabilityPaths: ['experiments/multi-model-ablation/m2-provider-execution-check.mjs'],
    artifactReleaseId: 'AR-4e885ed0209e5a32330cdc33',
    artifactSetDigest: 'sha256:9896bd874641b73c2f1e11bec561d1769d974d12cc2c5fc75592991c212d7bc9',
    runtimeSemverChanged: false,
    now: NOW,
  });
}

/** Drive the real DONE-shaped ingest: observe -> propose (apply) -> candidate. */
function applyIngest(root: string, store: StoryStore) {
  const observe = buildPlaybookSeedObservation({ projectRoot: root, store, now: NOW });
  buildPlaybookSeedProposalBatch({
    projectRoot: root,
    store,
    apply: true,
    limit: 20,
    observeDigest: observe.observeDigest,
    now: NOW,
  });
}

const roots: string[] = [];

try {
  // ── HAPPY ──────────────────────────────────────────────────────────────────
  check('happy: candidate lineage binds the capability release', () => {
    const { root, store } = mkProject();
    roots.push(root);
    const storyId = 'B-cap01';
    seedStory(root, store, storyId);
    writeEntries(resolveProjectMemoryPath(root), [memoryEntry(storyId)]);
    const release = capabilityReleaseFor(root, storyId);
    writeCapabilityReleaseLedgerForTest(root, [release]);

    withIsolatedGlobalMemory(root, () => {
      applyIngest(root, store);
      const proposals = listProposals(root);
      assert.equal(proposals.length, 1, 'one proposal produced');
      const lineage = proposals[0].lineage;
      assert.equal(lineage.capabilityReleaseId, release.id);
      assert.equal(lineage.capabilityId, release.capabilityId);
      assert.equal(lineage.capabilityVersion, release.capabilityVersion);
      assert.equal(lineage.artifactReleaseId, release.artifactReleaseId);
      assert.equal(lineage.artifactSetDigest, release.artifactSetDigest);
      // the persisted proposal's digest must be self-consistent over the
      // ENRICHED lineage (enrichment does not leave a stale digest behind).
      assert.equal(proposals[0].proposalDigest, computePlaybookProposalDigest(proposals[0]));
    });
  });

  // ── EDGE 1: no capability release -> lineage stays 3-field but valid ─────────
  check('edge: no capability release keeps the 3-field lineage (still valid)', () => {
    const { root, store } = mkProject();
    roots.push(root);
    const storyId = 'B-cap02';
    seedStory(root, store, storyId);
    writeEntries(resolveProjectMemoryPath(root), [memoryEntry(storyId)]);
    // NO capability release ledger written.

    withIsolatedGlobalMemory(root, () => {
      applyIngest(root, store);
      const proposals = listProposals(root);
      assert.equal(proposals.length, 1);
      const lineage = proposals[0].lineage;
      assert.equal(lineage.capabilityReleaseId, undefined);
      assert.equal(lineage.capabilityId, undefined);
      assert.ok(lineage.sourceStoryId && lineage.sourceFindingId, 'core 3 fields present');
    });
  });

  // ── EDGE 2: a pre-existing 3-field lineage still parses via validatePlaybook ──
  check('edge: a legacy 3-field PlaybookLineage still parses', () => {
    const legacy = {
      id: 'PBP-legacy',
      title: 'Legacy playbook',
      trigger: { keywords: [], fileKinds: [], storyPhases: [] },
      check: 'check something',
      pitfalls: ['a pitfall'],
      verification: ['a verification'],
      lineage: { sourceStoryId: 'B-old', sourceFindingId: 'B-old:F-001', sourceSignature: 'sig' },
      status: 'candidate',
      usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
    };
    const result = validatePlaybook(legacy);
    assert.equal(result.ok, true, result.ok ? '' : result.error);
  });

  // ── EDGE 3: enrichment is a pure no-op on a seed with no matching release ─────
  check('edge: enrichSeedWithCapabilityLineage is a no-op with no matching release', () => {
    const { root } = mkProject();
    roots.push(root);
    const seed: PlaybookSeedCandidate = {
      seedId: 'PBS-noop',
      sourceArtifactKind: 'done_experience',
      sourceArtifactId: 'B-none',
      sourceRef: 'done-experience/B-none',
      canonicalSourceKey: 'done_experience:B-none',
      canonicalSourceKeyVersion: 'v1',
      canonicalizationPolicyHash: 'sha256:policy',
      sourceStoryId: 'B-none',
      sourceFindingId: 'B-none:F-001',
      priority: 3,
      priorityReason: 'p3',
    };
    const enriched = enrichSeedWithCapabilityLineage(root, seed);
    assert.deepEqual(enriched, seed, 'no ledger -> seed unchanged');
    const lineage = lineageFromSeed(enriched);
    assert.equal(lineage.capabilityReleaseId, undefined);
  });

  // ── ADVERSARIAL: re-apply is idempotent despite digest change; ledger fail-open
  check('adversarial: re-apply produces no duplicate and trips no stale/drift rejection', () => {
    const { root, store } = mkProject();
    roots.push(root);
    const storyId = 'B-cap03';
    seedStory(root, store, storyId);
    writeEntries(resolveProjectMemoryPath(root), [memoryEntry(storyId)]);
    const release = capabilityReleaseFor(root, storyId);
    writeCapabilityReleaseLedgerForTest(root, [release]);

    withIsolatedGlobalMemory(root, () => {
      applyIngest(root, store);
      const firstProposals = listProposals(root);
      assert.equal(firstProposals.length, 1);
      const boundDigest = firstProposals[0].proposalDigest;
      // The enriched proposal's digest differs from a bare 3-field one.
      const bareLineageProposal = { ...firstProposals[0], lineage: {
        sourceStoryId: firstProposals[0].lineage.sourceStoryId,
        sourceFindingId: firstProposals[0].lineage.sourceFindingId,
        ...(firstProposals[0].lineage.sourceSignature ? { sourceSignature: firstProposals[0].lineage.sourceSignature } : {}),
      } };
      assert.notEqual(
        boundDigest,
        computePlaybookProposalDigest(bareLineageProposal),
        'enrichment MUST change the proposal digest (proves digest is not the idempotency key)',
      );

      // Re-run the ingest: the source story is now `already_represented`
      // (canonicalSourceKey-keyed), so NOTHING is re-proposed. No duplicate, and
      // no stale-proposal / digest-drift error is thrown.
      const observe2 = buildPlaybookSeedObservation({ projectRoot: root, store, now: NOW });
      const rerun = buildPlaybookSeedProposalBatch({
        projectRoot: root,
        store,
        apply: true,
        limit: 20,
        observeDigest: observe2.observeDigest,
        now: NOW,
      });
      assert.equal(rerun.proposalCount, 0, 're-apply proposes nothing (source already represented)');
      assert.equal(listProposals(root).length, 1, 'no duplicate proposal created');
      assert.equal(listProposals(root)[0].proposalDigest, boundDigest, 'existing proposal untouched');
    });
  });

  check('adversarial: a tampered capability ledger fails open (lineage stays 3-field)', () => {
    const { root } = mkProject();
    roots.push(root);
    // Write a non-JSON / invalid ledger line so readCapabilityReleaseLedger throws.
    write(root, '.lattice/capability-releases.jsonl', '{ this is not valid json\n');
    const seed: PlaybookSeedCandidate = {
      seedId: 'PBS-tamper',
      sourceArtifactKind: 'done_experience',
      sourceArtifactId: 'B-tamper',
      sourceRef: 'done-experience/B-tamper',
      canonicalSourceKey: 'done_experience:B-tamper',
      canonicalSourceKeyVersion: 'v1',
      canonicalizationPolicyHash: 'sha256:policy',
      sourceStoryId: 'B-tamper',
      sourceFindingId: 'B-tamper:F-001',
      priority: 3,
      priorityReason: 'p3',
    };
    // Must NOT throw; enrichment fails open and returns the seed unchanged.
    const enriched = enrichSeedWithCapabilityLineage(root, seed);
    assert.deepEqual(enriched, seed);
    const lineage = lineageFromSeed(enriched);
    assert.equal(lineage.capabilityReleaseId, undefined);
  });
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error(`playbook capability lineage smoke failed: ${passed}/${total} checks passed`);
  process.exit(process.exitCode);
}

console.log(`playbook capability lineage smoke passed: ${passed}/${total} checks`);
