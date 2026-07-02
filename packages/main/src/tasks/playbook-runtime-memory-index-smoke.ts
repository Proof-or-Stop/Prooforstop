#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { resetConfigCache } from '../core/config.js';
import { writeEntries, resolveProjectMemoryPath, type DevMemoryEntry } from '../core/dev-memory.js';
import type { Playbook } from '../core/experience-layer-types.js';
import { writePlaybooks, writeSignatureRegistry } from '../core/learning-store.js';
import {
  buildRuntimeMemoryIndex,
  readRuntimeMemoryIndex,
  rebuildRuntimeMemoryIndex,
  resolveRuntimeMemoryIndexPath,
  selectRuntimeMemoryIndexCandidates,
  validateRuntimeMemoryIndex,
  writeRuntimeMemoryIndexAtomically,
} from '../core/playbook-runtime-memory-index.js';
import {
  buildMemoryFreshnessPack,
  classifyMemoryFreshnessPack,
} from '../core/playbook-runtime-memory.js';
import {
  clearRuntimeMemoryPackCache,
  getRuntimeMemoryPackCacheStats,
} from '../core/playbook-runtime-memory-cache.js';

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

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pb-memory-index-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  resetConfigCache();
  return root;
}

function memoryEntry(id: string, patch: Partial<DevMemoryEntry> = {}): DevMemoryEntry {
  return {
    id,
    createdAt: NOW,
    sourceAgent: 'index-smoke',
    category: 'workflow',
    scope: 'project',
    summary: 'Runtime memory index smoke lesson',
    trigger: 'runtime index query',
    lesson: 'Use indexed runtime memory without changing proof boundaries',
    reusePrompt: 'runtime index query',
    tags: [],
    evidenceRefs: [],
    gateEvidence: false,
    authority: 'non_authoritative',
    ...patch,
  };
}

function playbook(id: string, status: Playbook['status'], keyword = 'host-policy'): Playbook {
  return {
    id,
    title: `${keyword} runtime reminder ${id}`,
    trigger: {
      keywords: [keyword, 'runtime', 'memory'],
      fileKinds: ['ts'],
      storyPhases: ['DEV'],
    },
    check: `Check ${keyword} before making a runtime claim`,
    pitfalls: [`Forgetting ${keyword} causes stale work`],
    verification: [`Confirm ${keyword} was considered`],
    lineage: {
      sourceStoryId: 'B-source',
      sourceFindingId: 'B-source:F-001',
      sourceSignature: keyword,
    },
    status,
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function seed(root: string): void {
  writeEntries(resolveProjectMemoryPath(root), [
    memoryEntry('mem-old', {
      summary: 'Deprecated runtime memory old plan',
      trigger: 'old plan says task missing',
      lesson: 'Old stale-doc lesson should be superseded',
      reusePrompt: 'old plan task missing',
    }),
    memoryEntry('mem-current', {
      summary: 'Current stale-doc truth-first lesson',
      trigger: 'old plan says task missing',
      lesson: 'Check current facts before telling the user a task is missing',
      reusePrompt: 'truth-first stale-doc task missing',
      tags: ['supersedes-mem-old'],
    }),
    memoryEntry('mem-host', {
      summary: 'Host policy Codex Claude agy fallback',
      trigger: 'codex claude agy fallback',
      lesson: 'Use Codex and Claude as primary hosts, agy only as fallback',
      reusePrompt: 'codex claude agy fallback',
    }),
  ]);
  writePlaybooks(root, [
    playbook('PB-active', 'active', 'host-policy'),
    playbook('PB-candidate', 'candidate', 'host-policy'),
    { id: 'PB-bad', status: 'active' } as unknown as Playbook,
  ]);
  writeSignatureRegistry(root, {
    tags: [
      {
        tag: 'legacy-brand',
        status: 'deprecated',
        aliases: ['old-brand'],
        mergedInto: 'current-brand',
        createdBy: 'index-smoke',
        approvedBy: null,
      },
    ],
  });
}

function packPair(root: string, query: string) {
  const index = rebuildRuntimeMemoryIndex(root, NOW);
  const reference = buildMemoryFreshnessPack({
    projectRoot: root,
    query,
    consumer: 'session_brief',
    storyPhase: 'DEV',
    touchedPaths: ['packages/main/src/core/playbook-runtime-memory.ts'],
    useIndex: false,
    generatedAt: NOW,
  });
  const indexed = buildMemoryFreshnessPack({
    projectRoot: root,
    query,
    consumer: 'session_brief',
    storyPhase: 'DEV',
    touchedPaths: ['packages/main/src/core/playbook-runtime-memory.ts'],
    runtimeIndex: index,
    generatedAt: NOW,
  });
  return { reference, indexed, index };
}

async function run(): Promise<void> {
  const roots: string[] = [];
  const previousGlobal = process.env.LATTICE_GLOBAL_MEMORY_DIR;
  const globalRoot = mkdtempSync(join(tmpdir(), 'pb-memory-index-global-'));
  process.env.LATTICE_GLOBAL_MEMORY_DIR = globalRoot;
  try {
    check('M0 profiling baseline remains non-authoritative report-only', () => {
      const root = mkRoot(); roots.push(root); seed(root);
      const start = performance.now();
      const pack = buildMemoryFreshnessPack({ projectRoot: root, query: 'host-policy', generatedAt: NOW });
      const elapsedMs = Math.max(0, Math.round(performance.now() - start));
      assert.equal(pack.authority, 'non_authoritative');
      assert.equal(pack.gateEvidence, false);
      assert.match(pack.packDigest, /^[0-9a-f]{64}$/);
      console.log(`m0ProfilingRecorded=true runtimePackElapsedMs=${elapsedMs} authority=${pack.authority} gateEvidence=${pack.gateEvidence}`);
    });

    check('M1 atomic rebuild validates manifest and swaps readable active index', () => {
      const root = mkRoot(); roots.push(root); seed(root);
      const index = rebuildRuntimeMemoryIndex(root, NOW);
      const active = readRuntimeMemoryIndex(root);
      assert.ok(active, 'active index is readable');
      assert.equal(active!.manifest.indexVersion, index.manifest.indexVersion);
      assert.equal(active!.manifest.authority, 'non_authoritative');
      assert.equal(active!.manifest.gateEvidence, false);
      assert.equal(validateRuntimeMemoryIndex(active).ok, true);
      console.log(`atomicIndexRebuild=true indexVersion=${active!.manifest.indexVersion}`);
    });

    check('M1 malformed temp index rejects and previous active index remains readable', () => {
      const root = mkRoot(); roots.push(root); seed(root);
      const previous = rebuildRuntimeMemoryIndex(root, NOW);
      const malformed = {
        ...buildRuntimeMemoryIndex(root, NOW),
        manifest: {
          ...previous.manifest,
          manifestDigest: '0'.repeat(64),
        },
      };
      assert.throws(
        () => writeRuntimeMemoryIndexAtomically(root, malformed),
        /runtime memory index validation failed/,
      );
      const active = readRuntimeMemoryIndex(root);
      assert.equal(active?.manifest.indexVersion, previous.manifest.indexVersion);
      assert.equal(existsSync(resolveRuntimeMemoryIndexPath(root)), true);
      console.log('partialIndexReadPrevented=true');
    });

    check('M2 indexed retrieval matches reference ids and boundaries', () => {
      const root = mkRoot(); roots.push(root); seed(root);
      const { reference, indexed, index } = packPair(root, 'old plan says task missing host-policy old-brand');
      assert.deepEqual(indexed.results.devMemoryEntryIds, reference.results.devMemoryEntryIds);
      assert.deepEqual(indexed.results.playbookIds, reference.results.playbookIds);
      assert.deepEqual(indexed.results.suppressedSupersededIds, reference.results.suppressedSupersededIds);
      assert.deepEqual(indexed.results.deprecatedTermHits, reference.results.deprecatedTermHits);
      assert.equal(indexed.results.playbookIds.includes('PB-candidate'), false);
      assert.equal(indexed.results.playbookIds.includes('PB-bad'), false);
      assert.equal(indexed.authority, 'non_authoritative');
      assert.equal(indexed.gateEvidence, false);
      const candidates = selectRuntimeMemoryIndexCandidates(index, {
        query: 'old plan says task missing host-policy',
        consumer: 'session_brief',
        storyPhase: 'DEV',
        touchedPaths: ['x.ts'],
      });
      assert.ok(candidates.playbooks.some((item) => item.id === 'PB-active'));
      assert.equal(candidates.playbooks.some((item) => item.id === 'PB-candidate'), false);
      assert.ok(candidates.stats.exactFastPathHits > 0, 'exact token lookup should be used');
      assert.ok(candidates.stats.fuzzyIndexHits > 0, 'fuzzy auxiliary index should be used for hyphenated/contains matches');
      assert.equal(candidates.stats.tokenScanFallbacks, 0, 'normal smoke query should not scan every token-map entry');
      console.log([
        'indexedReferenceParity=true',
        'candidateFalseSurface=0',
        `exactFastPathHits=${candidates.stats.exactFastPathHits}`,
        `fuzzyIndexHits=${candidates.stats.fuzzyIndexHits}`,
        `fuzzyFallbacks=${candidates.stats.fuzzyFallbacks}`,
        `tokenScanFallbacks=${candidates.stats.tokenScanFallbacks}`,
        `authority=${indexed.authority}`,
        `gateEvidence=${indexed.gateEvidence}`,
      ].join(' '));
    });

    check('M2 fuzzy overflow falls back instead of trusting capped buckets', () => {
      const root = mkRoot(); roots.push(root);
      const count = 4_120;
      writeEntries(resolveProjectMemoryPath(root), Array.from({ length: count }, (_, index) => memoryEntry(
        `mem-overflow-${String(index).padStart(4, '0')}`,
        {
          summary: `Overflow fuzzy token row ${index}`,
          trigger: `overflowneedle${String(index).padStart(4, '0')} runtime memory`,
          lesson: 'Fuzzy overflow fallback must scan token map instead of trusting capped buckets',
          reusePrompt: `overflowneedle${String(index).padStart(4, '0')} runtime memory`,
        },
      )));
      writePlaybooks(root, []);
      writeSignatureRegistry(root, { tags: [] });
      const index = rebuildRuntimeMemoryIndex(root, NOW);
      const candidates = selectRuntimeMemoryIndexCandidates(index, {
        query: 'overflowneedle runtime memory',
        consumer: 'session_brief',
        maxEntries: count,
        maxPlaybooks: 0,
        candidateLimit: count,
      });
      const ids = candidates.devMemoryEntries.map((entry) => entry.id);
      assert.ok(ids.includes('mem-overflow-4119'), 'candidate beyond fuzzy cap must still surface');
      assert.ok(candidates.stats.tokenScanFallbacks > 0, 'overflow query must record token-map fallback');
      assert.ok(candidates.stats.tokenMapScannedEntries > 0, 'overflow fallback must scan token map');
      console.log([
        'fuzzyOverflowFallback=true',
        `tokenScanFallbacks=${candidates.stats.tokenScanFallbacks}`,
        `tokenMapScannedEntries=${candidates.stats.tokenMapScannedEntries}`,
      ].join(' '));
    });

    check('M2 indexed freshness classification preserves stale-relevant and stale-irrelevant semantics', () => {
      clearRuntimeMemoryPackCache();
      const root = mkRoot(); roots.push(root); seed(root);
      const { indexed } = packPair(root, 'old plan says task missing');
      writeEntries(resolveProjectMemoryPath(root), [
        memoryEntry('mem-old', {
          summary: 'Deprecated runtime memory old plan',
          trigger: 'old plan says task missing',
          lesson: 'Old stale-doc lesson should be superseded',
          reusePrompt: 'old plan task missing',
        }),
        memoryEntry('mem-current', {
          summary: 'Current stale-doc truth-first lesson',
          trigger: 'old plan says task missing',
          lesson: 'Changed current facts lesson',
          reusePrompt: 'truth-first stale-doc task missing',
          tags: ['supersedes-mem-old'],
        }),
      ]);
      const relevant = classifyMemoryFreshnessPack(indexed, { useIndex: false });
      assert.equal(relevant.freshness.class, 'stale-relevant');

      const root2 = mkRoot(); roots.push(root2); seed(root2);
      const { indexed: indexed2 } = packPair(root2, 'old plan says task missing');
      assert.equal(indexed2.projectRoot, root2, 'runtime pack cache must not reuse a pack from another project root');
      writeEntries(resolveProjectMemoryPath(root2), [
        memoryEntry('mem-old', {
          summary: 'Deprecated runtime memory old plan',
          trigger: 'old plan says task missing',
          lesson: 'Old stale-doc lesson should be superseded',
          reusePrompt: 'old plan task missing',
        }),
        memoryEntry('mem-current', {
          summary: 'Current stale-doc truth-first lesson',
          trigger: 'old plan says task missing',
          lesson: 'Check current facts before telling the user a task is missing',
          reusePrompt: 'truth-first stale-doc task missing',
          tags: ['supersedes-mem-old'],
        }),
        memoryEntry('mem-host', {
          summary: 'Host policy Codex Claude agy fallback',
          trigger: 'codex claude agy fallback',
          lesson: 'Use Codex and Claude as primary hosts, agy only as fallback',
          reusePrompt: 'codex claude agy fallback',
        }),
        memoryEntry('mem-unrelated', {
          summary: 'Unrelated runtime note',
          trigger: 'banana orchard',
          lesson: 'This unrelated append-only row should not affect surfaced refs',
          reusePrompt: 'banana orchard',
        }),
      ]);
      const cachedIrrelevant = buildMemoryFreshnessPack({
        projectRoot: root2,
        query: 'old plan says task missing',
        consumer: 'session_brief',
        storyPhase: 'DEV',
        touchedPaths: ['packages/main/src/core/playbook-runtime-memory.ts'],
        generatedAt: NOW,
      });
      assert.equal(cachedIrrelevant.projectRoot, root2);
      assert.equal(cachedIrrelevant.freshness.class, 'stale-irrelevant');
      assert.equal(getRuntimeMemoryPackCacheStats().staleIrrelevantHits, 1);
      const irrelevant = classifyMemoryFreshnessPack(indexed2, { useIndex: false });
      assert.equal(irrelevant.freshness.class, 'stale-irrelevant');
    });

    if (process.exitCode) process.exit(process.exitCode);
    console.log(`playbook-runtime-memory index smoke passed: TOTAL ${total} | PASS ${passed} | FAIL 0`);
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
