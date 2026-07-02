#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { resolveGlobalMemoryPath, resolveProjectMemoryPath, writeEntries, type DevMemoryEntry } from '../core/dev-memory.js';
import { digestCanonicalJson } from '../core/digest.js';
import type { Playbook } from '../core/experience-layer-types.js';
import { writePlaybooks, writeSignatureRegistry } from '../core/learning-store.js';
import { runPlaybookRuntimeOptimizedParityReport } from '../core/playbook-runtime-baseline.js';
import {
  buildMemoryFreshnessPack,
  classifyMemoryFreshnessPack,
  renderMemoryFreshnessPack,
  type BuildMemoryFreshnessPackOptions,
  type MemoryFreshnessPack,
  type RuntimeConsumer,
} from '../core/playbook-runtime-memory.js';
import {
  clearRuntimeMemoryPackCache,
  getRuntimeMemoryPackCacheStats,
} from '../core/playbook-runtime-memory-cache.js';
import { rebuildRuntimeMemoryIndex } from '../core/playbook-runtime-memory-index.js';

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
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  }
}

function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
}

function mkRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `pb-memory-m3-m6-${label}-`));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  resetConfigCache();
  return root;
}

function memoryEntry(id: string, text: string, patch: Partial<DevMemoryEntry> = {}): DevMemoryEntry {
  return {
    id,
    createdAt: NOW,
    sourceAgent: 'm3-m6-smoke',
    category: 'workflow',
    scope: patch.scope ?? 'project',
    summary: text,
    trigger: text,
    lesson: text,
    reusePrompt: text,
    tags: [],
    evidenceRefs: [],
    gateEvidence: false,
    authority: 'non_authoritative',
    ...patch,
  };
}

function playbook(id: string, status: Playbook['status'], text: string): Playbook {
  return {
    id,
    title: `${id} runtime playbook`,
    trigger: {
      keywords: text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g)?.slice(0, 18) ?? ['runtime'],
      fileKinds: ['ts'],
      storyPhases: ['DEV', 'TEST', 'DONE'],
    },
    check: text,
    pitfalls: [`${id} remains advisory-only runtime memory.`],
    verification: [`${id} is checked by M3-M6 smoke.`],
    lineage: {
      sourceStoryId: 'B-6048',
      sourceFindingId: `${id}:F-001`,
      sourceSignature: id,
    },
    status,
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function seed(root: string): void {
  writeEntries(resolveProjectMemoryPath(root), [
    memoryEntry(
      'mem-old',
      'truth-first stale-doc old plan task missing legacy lesson should be suppressed',
    ),
    memoryEntry(
      'mem-current',
      'truth-first stale-doc current facts task missing runtime lesson',
      { tags: ['supersedes-mem-old'] },
    ),
    memoryEntry(
      'mem-host',
      'host-policy codex-cli claude-cli agy fallback unavailable quota limited runtime guidance',
    ),
  ]);
  writeEntries(resolveGlobalMemoryPath(), [
    memoryEntry(
      'mem-global',
      'global runtime memory source digest matrix relevant lesson',
      { scope: 'global' },
    ),
  ]);
  writePlaybooks(root, [
    playbook('PB-active', 'active', 'host-policy runtime memory active playbook should surface'),
    playbook('PB-candidate', 'candidate', 'host-policy runtime memory candidate should not surface'),
    playbook('PB-stale', 'stale', 'host-policy runtime memory stale should not surface'),
    { id: 'PB-malformed', status: 'active' } as unknown as Playbook,
  ]);
  writeSignatureRegistry(root, {
    tags: [
      {
        tag: 'legacy-brand',
        status: 'deprecated',
        aliases: ['old-brand'],
        mergedInto: 'proofbound',
        createdBy: 'm3-m6-smoke',
        approvedBy: null,
      },
    ],
  });
}

function buildPack(root: string, overrides: Partial<Omit<BuildMemoryFreshnessPackOptions, 'projectRoot'>> = {}) {
  return buildMemoryFreshnessPack({
    projectRoot: root,
    consumer: 'session_brief',
    storyPhase: 'DEV',
    touchedPaths: ['packages/main/src/core/playbook-runtime-memory.ts'],
    query: [
      'truth-first stale-doc old plan task missing host-policy runtime memory legacy-brand',
      'global runtime memory source digest matrix relevant lesson',
    ].join(' '),
    maxEntries: 8,
    maxPlaybooks: 8,
    maxLines: 60,
    generatedAt: NOW,
    ...overrides,
  });
}

function assertSameRelevantResults(left: ReturnType<typeof buildPack>, right: ReturnType<typeof buildPack>): void {
  assert.deepEqual(right.results.devMemoryEntryIds, left.results.devMemoryEntryIds);
  assert.deepEqual(right.results.playbookIds, left.results.playbookIds);
  assert.deepEqual(right.results.suppressedSupersededIds, left.results.suppressedSupersededIds);
  assert.deepEqual(right.results.deprecatedTermHits, left.results.deprecatedTermHits);
}

function expectedPackDigest(pack: MemoryFreshnessPack): string {
  const { packDigest: _packDigest, generatedAt: _generatedAt, ...domain } = pack;
  return digestCanonicalJson(domain);
}

function assertPackDigestMatchesContent(pack: MemoryFreshnessPack): void {
  assert.equal(pack.packDigest, expectedPackDigest(pack));
}

async function run(): Promise<void> {
  const roots: string[] = [];
  const previousGlobal = process.env.LATTICE_GLOBAL_MEMORY_DIR;
  const globalRoot = mkdtempSync(join(tmpdir(), 'pb-memory-m3-m6-global-'));
  process.env.LATTICE_GLOBAL_MEMORY_DIR = globalRoot;
  try {
    check('M3 pack cache hits unchanged requests and misses contributing source changes', () => {
      const root = mkRoot('m3-hit-miss'); roots.push(root); seed(root);
      rebuildRuntimeMemoryIndex(root, NOW);
      clearRuntimeMemoryPackCache();
      const first = buildPack(root);
      const second = buildPack(root);
      assert.equal(second.packDigest, first.packDigest);
      assert.equal(getRuntimeMemoryPackCacheStats().hits, 1);

      writeEntries(resolveProjectMemoryPath(root), [
        memoryEntry(
          'mem-old',
          'truth-first stale-doc old plan task missing legacy lesson should be suppressed',
        ),
        memoryEntry(
          'mem-current',
          'truth-first stale-doc current facts task missing runtime lesson changed contributing digest',
          { tags: ['supersedes-mem-old'] },
        ),
        memoryEntry(
          'mem-host',
          'host-policy codex-cli claude-cli agy fallback unavailable quota limited runtime guidance',
        ),
      ]);
      const changed = buildPack(root);
      assert.notEqual(changed.packDigest, first.packDigest);
      assert.equal(getRuntimeMemoryPackCacheStats().contributingMisses, 1);
      assert.equal(changed.authority, 'non_authoritative');
      assert.equal(changed.gateEvidence, false);
    });

    check('M3 pack cache treats stale-irrelevant broad source changes as soft hits', () => {
      const root = mkRoot('m3-stale-irrelevant'); roots.push(root); seed(root);
      clearRuntimeMemoryPackCache();
      const first = buildPack(root);
      writeEntries(resolveProjectMemoryPath(root), [
        memoryEntry(
          'mem-old',
          'truth-first stale-doc old plan task missing legacy lesson should be suppressed',
        ),
        memoryEntry(
          'mem-current',
          'truth-first stale-doc current facts task missing runtime lesson',
          { tags: ['supersedes-mem-old'] },
        ),
        memoryEntry(
          'mem-host',
          'host-policy codex-cli claude-cli agy fallback unavailable quota limited runtime guidance',
        ),
        memoryEntry(
          'mem-unrelated',
          'banana orchard unrelated append-only row outside active query',
        ),
      ]);
      const second = buildPack(root);
      assert.equal(second.freshness.class, 'stale-irrelevant');
      assertSameRelevantResults(first, second);
      assertPackDigestMatchesContent(second);
      assert.notEqual(second.packDigest, first.packDigest);
      assert.equal(second.authority, 'non_authoritative');
      assert.equal(second.gateEvidence, false);
      assert.equal(getRuntimeMemoryPackCacheStats().staleIrrelevantHits, 1);
    });

    check('M4 shared optimized API covers lifecycle consumers as advisory-only packs', () => {
      const root = mkRoot('m4-consumers'); roots.push(root); seed(root);
      clearRuntimeMemoryPackCache();
      const consumers: RuntimeConsumer[] = [
        'session_brief',
        'host_handoff',
        'story_create',
        'story_advance',
        'done_prepare',
        'done_closure',
        'final_response_check',
      ];
      for (const consumer of consumers) {
        const first = buildPack(root, { consumer });
        const second = buildPack(root, { consumer });
        assert.equal(second.packDigest, first.packDigest);
        assert.equal(second.authority, 'non_authoritative');
        assert.equal(second.gateEvidence, false);
      }
      assert.equal(getRuntimeMemoryPackCacheStats().hits, consumers.length);
    });

    check('M5 reference and optimized matrix preserves surfacing boundaries', () => {
      const root = mkRoot('m5-matrix'); roots.push(root); seed(root);
      const reference = buildPack(root, { useIndex: false, useCache: false });
      const optimized = buildPack(root, { useCache: false });
      assertSameRelevantResults(reference, optimized);
      assert.ok(optimized.results.playbookIds.includes('PB-active'), 'active playbook surfaces');
      assert.equal(optimized.results.playbookIds.includes('PB-candidate'), false, 'candidate playbook stays inert');
      assert.equal(optimized.results.playbookIds.includes('PB-stale'), false, 'stale playbook stays inert');
      assert.equal(optimized.results.playbookIds.includes('PB-malformed'), false, 'malformed playbook is skipped');
      assert.ok(optimized.results.devMemoryEntryIds.includes('mem-current'), 'current memory surfaces');
      assert.equal(optimized.results.devMemoryEntryIds.includes('mem-old'), false, 'superseded memory does not surface');
      assert.ok(optimized.results.suppressedSupersededIds.includes('mem-old'), 'superseded memory is recorded as suppressed');
      assert.ok(optimized.results.deprecatedTermHits.includes('legacy-brand'), 'deprecated term hit is recorded');

      const relevantRoot = mkRoot('m5-stale-relevant'); roots.push(relevantRoot); seed(relevantRoot);
      const staleBase = buildPack(relevantRoot, { useIndex: false, useCache: false });
      writeEntries(resolveProjectMemoryPath(relevantRoot), [
        memoryEntry('mem-current', 'truth-first stale-doc current facts changed relevant runtime lesson'),
      ]);
      assert.equal(classifyMemoryFreshnessPack(staleBase, { useIndex: false }).freshness.class, 'stale-relevant');

      const irrelevantRoot = mkRoot('m5-stale-irrelevant'); roots.push(irrelevantRoot); seed(irrelevantRoot);
      const irrelevantBase = buildPack(irrelevantRoot, { useIndex: false, useCache: false });
      writeEntries(resolveProjectMemoryPath(irrelevantRoot), [
        memoryEntry(
          'mem-old',
          'truth-first stale-doc old plan task missing legacy lesson should be suppressed',
        ),
        memoryEntry(
          'mem-current',
          'truth-first stale-doc current facts task missing runtime lesson',
          { tags: ['supersedes-mem-old'] },
        ),
        memoryEntry(
          'mem-host',
          'host-policy codex-cli claude-cli agy fallback unavailable quota limited runtime guidance',
        ),
        memoryEntry('mem-side-note', 'unrelated banana orchard row outside query'),
      ]);
      assert.equal(classifyMemoryFreshnessPack(irrelevantBase, { useIndex: false }).freshness.class, 'stale-irrelevant');
    });

    check('M5 render line cap reports omittedCount for large packs', () => {
      const root = mkRoot('m5-line-cap'); roots.push(root);
      writeEntries(resolveProjectMemoryPath(root), Array.from({ length: 35 }, (_, index) =>
        memoryEntry(`mem-linecap-${String(index).padStart(2, '0')}`, `linecap runtime memory repeated row ${index}`)));
      writePlaybooks(root, []);
      writeSignatureRegistry(root, { tags: [] });
      const pack = buildMemoryFreshnessPack({
        projectRoot: root,
        consumer: 'session_brief',
        query: 'linecap runtime memory repeated',
        maxEntries: 35,
        maxPlaybooks: 0,
        generatedAt: NOW,
        useCache: false,
      });
      assert.ok(pack.render.omittedCount > 0, 'large pack records omittedCount');
      assert.match(renderMemoryFreshnessPack(pack), /line\(s\) omitted by MemoryFreshnessPack render cap/);
    });

    check('M6 report-first million-record parity report includes optimized timings', () => {
      const report = runPlaybookRuntimeOptimizedParityReport({ profile: 'full' });
      assert.equal(report.recordCount, 1_000_000);
      assert.equal(report.performancePolicy, 'report-first');
      assert.equal(report.parityPass, true);
      assert.equal(report.authority, 'non_authoritative');
      assert.equal(report.gateEvidence, false);
      assert.equal(report.resultDigestSource, 'MemoryFreshnessPack');
      assert.equal(report.runtimeCorpus.sourceRecordCount, 1_000_000);
      assert.equal(report.runtimeCorpus.fullCorpusMaterialized, true);
      assert.equal(
        report.runtimeCorpus.devMemoryRecordCount
          + report.runtimeCorpus.playbookRecordCount
          + report.runtimeCorpus.malformedRowsSkipped,
        report.runtimeCorpus.sourceRecordCount,
      );
      assert.equal(report.indexedColdUsesRuntimeIndex, true);
      assert.equal(report.indexedColdRuntimeIndexRecordCounts.devMemory, report.runtimeCorpus.devMemoryRecordCount);
      assert.equal(report.indexedColdRuntimeIndexRecordCounts.playbooks, report.runtimeCorpus.playbookRecordCount);
      assert.equal(report.warmCacheStats.hits, report.queryCount);
      assert.equal(report.warmCacheStats.entries, report.queryCount);
      assert.equal(report.indexedColdResultDigest, report.referenceResultDigest);
      assert.equal(report.indexedWarmCacheResultDigest, report.referenceResultDigest);
      console.log([
        'm6Report',
        `recordCount=${report.recordCount}`,
        `resultDigestSource=${report.resultDigestSource}`,
        `runtimeCorpusRecords=${report.runtimeCorpus.sourceRecordCount}`,
        `referenceFullScanMs=${report.referenceFullScanMs}`,
        `indexedColdMs=${report.indexedColdMs}`,
        `indexedWarmCacheMs=${report.indexedWarmCacheMs}`,
        `warmCacheHits=${report.warmCacheStats.hits}`,
        `performancePolicy=${report.performancePolicy}`,
      ].join(' '));
    });

    if (process.exitCode) process.exit(process.exitCode);
    console.log(`playbook-runtime-memory M3-M6 smoke passed: TOTAL ${total} | PASS ${passed} | FAIL 0`);
  } finally {
    if (previousGlobal === undefined) {
      delete process.env.LATTICE_GLOBAL_MEMORY_DIR;
    } else {
      process.env.LATTICE_GLOBAL_MEMORY_DIR = previousGlobal;
    }
    rmSync(globalRoot, { recursive: true, force: true });
    for (const root of roots) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
