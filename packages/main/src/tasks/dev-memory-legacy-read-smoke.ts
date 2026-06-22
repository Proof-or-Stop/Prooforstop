#!/usr/bin/env node

// Negative smoke (B-a4e3): the legacy `.koala/dev-memory` READ fallback has been
// removed. This smoke writes fake entries ONLY into the legacy `.koala` location
// and asserts they do NOT appear in any dev-memory read result — proving the
// fallback is gone. The canonical `.lattice/dev-memory` path still reads/writes.

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  readGlobalMemoryEntries,
  readProjectMemoryEntries,
  resolveGlobalMemoryPath,
  resolveGlobalMemoryReadPaths,
  resolveProjectMemoryPath,
  resolveProjectMemoryReadPaths,
  type DevMemoryEntry,
} from '../core/dev-memory.js';
import {
  buildParallelDispatch,
  buildParallelReport,
  PARALLEL_WAVE_SCHEMA_VERSION,
  type LatticeParallelWave,
} from '../core/lattice-parallel-wave.js';
import { createDevMemoryHandlers } from '../handlers/dev-memory.js';
import type { HandlerContext } from '../handlers/context.js';

// The legacy `.koala/dev-memory` path is built inline here ONLY to seed an entry
// that must be ignored; production code no longer exposes a resolver for it.
function legacyProjectMemoryPath(projectRoot: string): string {
  return join(projectRoot, '.koala', 'dev-memory', 'experience.jsonl');
}
function legacyGlobalMemoryPath(home: string): string {
  return join(home, '.koala', 'dev-memory', 'experience.jsonl');
}

function makeEntry(id: string, summary: string, scope: DevMemoryEntry['scope']): DevMemoryEntry {
  return {
    id,
    createdAt: `2026-06-11T22:00:0${id.length % 10}.000Z`,
    sourceAgent: 'dev-memory-legacy-read-smoke',
    category: 'workflow',
    scope,
    summary,
    trigger: 'legacy read smoke trigger',
    lesson: 'legacy read smoke lesson stays non-authoritative',
    reusePrompt: 'reuse legacy read smoke entry',
    tags: ['legacy-read-smoke'],
    gateEvidence: false,
    authority: 'non_authoritative',
  };
}

function writeEntry(filePath: string, entry: DevMemoryEntry): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

function assertNonAuthoritative(entries: DevMemoryEntry[], label: string): void {
  assert.ok(entries.length > 0, `${label} should have entries`);
  for (const entry of entries) {
    assert.equal(entry.gateEvidence, false, `${label} ${entry.id} must not be gate evidence`);
    assert.equal(entry.authority, 'non_authoritative', `${label} ${entry.id} must remain non-authoritative`);
  }
}

function legacySmokeWave(): LatticeParallelWave {
  return {
    schemaVersion: PARALLEL_WAVE_SCHEMA_VERSION,
    waveId: 'dev-memory-legacy-read-smoke-wave',
    generatedAt: '2026-06-11T22:00:00.000Z',
    storyRefs: [{
      storyId: 'B-smoke',
      title: 'dev-memory legacy read smoke',
      phase: 'DEV',
      lane: 'supporting',
      safety: 'yes',
      recommendation: 'parallel_dev',
      parallelDevRecommended: true,
      recommendedHostIds: [],
      dependencies: {
        declared: [],
        active: [],
        satisfied: [],
        missing: [],
        inWave: [],
        blockingForActive: [],
      },
      hotspots: [],
      sharedHotspots: [],
      degradations: [],
      evidenceRefs: [],
      canonicalStoryRef: {
        schemaVersion: 'canonical-story-v0',
        storyId: 'B-smoke',
      },
      recoveryRefs: [],
    }],
    hostCandidates: [],
    evidenceRefs: [],
    mergeOrder: [{
      storyId: 'B-smoke',
      after: [],
      safety: 'yes',
      recommendation: 'parallel_dev',
      blockers: [],
    }],
    authority: {
      productionDone: false,
      authorityChanged: false,
      receiptRefs: [],
      notes: [],
    },
  };
}

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalLatticeGlobalMemoryDir = process.env.LATTICE_GLOBAL_MEMORY_DIR;

const root = mkdtempSync(join(tmpdir(), 'lattice-dev-memory-legacy-read-'));

try {
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });

  // Seed canonical .lattice entries AND a legacy .koala entry that must be ignored.
  const projectCurrent = makeEntry('project-current', 'project current lattice memory entry', 'project');
  const projectLegacyIgnored = makeEntry('project-legacy-ignored', 'project legacy entry must be ignored', 'project');

  writeEntry(resolveProjectMemoryPath(projectRoot), projectCurrent);
  writeEntry(legacyProjectMemoryPath(projectRoot), projectLegacyIgnored);

  const projectEntries = readProjectMemoryEntries(projectRoot);
  assert.deepEqual(
    projectEntries.map(entry => entry.id),
    ['project-current'],
    'project read must include only the .lattice entry; the legacy .koala read fallback is removed',
  );
  assert.ok(
    !projectEntries.some(entry => entry.id === 'project-legacy-ignored'),
    'legacy project .koala entry must NOT be read',
  );
  // Confirm the read path set itself no longer points at any .koala location.
  assert.ok(
    !resolveProjectMemoryReadPaths(projectRoot).some(p => p.replace(/\\/g, '/').includes('/.koala/')),
    'project read paths must not include any .koala fallback path',
  );
  assertNonAuthoritative(projectEntries, 'project entries');

  const fakeHome = join(root, 'home');
  mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.LATTICE_GLOBAL_MEMORY_DIR;

  const globalCurrent = makeEntry('global-current', 'global current lattice memory entry', 'global');
  const globalLegacyIgnored = makeEntry('global-legacy-ignored', 'global legacy entry must be ignored', 'global');

  writeEntry(resolveGlobalMemoryPath(), globalCurrent);
  writeEntry(legacyGlobalMemoryPath(fakeHome), globalLegacyIgnored);

  const globalEntries = readGlobalMemoryEntries();
  assert.deepEqual(
    globalEntries.map(entry => entry.id),
    ['global-current'],
    'global read must include only the ~/.lattice entry; the legacy ~/.koala read fallback is removed',
  );
  assert.ok(
    !globalEntries.some(entry => entry.id === 'global-legacy-ignored'),
    'legacy global .koala entry must NOT be read',
  );
  const globalReadPaths = resolveGlobalMemoryReadPaths();
  assert.deepEqual(
    globalReadPaths,
    [resolveGlobalMemoryPath()],
    'global read paths must contain only the canonical ~/.lattice path with no legacy fallback',
  );
  assert.ok(
    !globalReadPaths.some(p => p.replace(/\\/g, '/').includes('/.koala/')),
    'global read paths must not include any .koala fallback path',
  );
  assertNonAuthoritative(globalEntries, 'global entries');

  // Parallel dispatch / report must surface only the canonical entries, never legacy ones.
  const wave = legacySmokeWave();
  const dispatch = buildParallelDispatch(wave, {
    projectRoot,
    includeExperience: true,
    experienceQuery: 'memory',
    maxExperienceRefs: 10,
  });
  const dispatchExperienceIds = dispatch.dispatchEntries.flatMap(entry => entry.experienceRefs.map(ref => ref.id));
  assert.ok(
    !dispatchExperienceIds.includes('project-legacy-ignored'),
    'parallel dispatch experienceRefs must NOT include legacy project .koala memory',
  );
  assert.ok(
    !dispatchExperienceIds.includes('global-legacy-ignored'),
    'parallel dispatch experienceRefs must NOT include legacy global .koala memory',
  );
  const report = buildParallelReport(wave, {
    projectRoot,
    includeExperience: true,
    experienceQuery: 'memory',
    maxExperienceRefs: 10,
  });
  const reportExperienceIds = report.experienceRefs.map(ref => ref.id);
  assert.ok(
    !reportExperienceIds.includes('project-legacy-ignored'),
    'parallel report experienceRefs must NOT include legacy project .koala memory',
  );
  assert.ok(
    !reportExperienceIds.includes('global-legacy-ignored'),
    'parallel report experienceRefs must NOT include legacy global .koala memory',
  );

  const captureRoot = join(root, 'capture-project');
  mkdirSync(captureRoot, { recursive: true });
  const handlers = createDevMemoryHandlers({ root: captureRoot } as HandlerContext);
  const startOutput = handlers.dev_memory_start({ agent: 'dev-memory-legacy-read-smoke' });
  assert.match(
    startOutput,
    /lattice dev_memory_finish/,
    'dev_memory_start should remind users to finish with lattice dev_memory_finish',
  );
  const captureOutput = handlers.dev_memory_capture({
    category: 'workflow',
    scope: 'project',
    summary: 'capture writes only lattice memory',
    trigger: 'capture smoke trigger',
    lesson: 'capture should only write the canonical lattice dev memory path',
    reusePrompt: 'check lattice dev memory path only',
    sourceAgent: 'dev-memory-legacy-read-smoke',
  });

  assert.match(captureOutput, /Captured dev-memory experience:/);
  const capturePath = resolveProjectMemoryPath(captureRoot);
  const legacyCapturePath = legacyProjectMemoryPath(captureRoot);
  assert.equal(existsSync(capturePath), true, 'capture should write .lattice/dev-memory/experience.jsonl');
  assert.equal(existsSync(legacyCapturePath), false, 'capture must not write the legacy .koala dev-memory path');
  const capturedEntries = readProjectMemoryEntries(captureRoot);
  assert.equal(capturedEntries.length, 1);
  assertNonAuthoritative(capturedEntries, 'captured entries');
} finally {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  if (originalLatticeGlobalMemoryDir === undefined) {
    delete process.env.LATTICE_GLOBAL_MEMORY_DIR;
  } else {
    process.env.LATTICE_GLOBAL_MEMORY_DIR = originalLatticeGlobalMemoryDir;
  }
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ dev-memory legacy read removal smoke passed (.koala no longer read)');
