#!/usr/bin/env node

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  readGlobalMemoryEntries,
  readProjectMemoryEntries,
  resolveGlobalMemoryPath,
  resolveGlobalMemoryReadPaths,
  resolveLegacyGlobalMemoryPath,
  resolveLegacyProjectMemoryPath,
  resolveProjectMemoryPath,
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

  const projectCurrent = makeEntry('project-current', 'project current lattice memory entry', 'project');
  const projectLegacy = makeEntry('project-legacy', 'project legacy koala memory entry', 'project');
  const projectDuplicateCurrent = makeEntry('project-dupe', 'project duplicate current lattice entry wins', 'project');
  const projectDuplicateLegacy = makeEntry('project-dupe', 'project duplicate legacy koala entry loses', 'project');

  writeEntry(resolveProjectMemoryPath(projectRoot), projectCurrent);
  writeEntry(resolveLegacyProjectMemoryPath(projectRoot), projectLegacy);
  writeEntry(resolveProjectMemoryPath(projectRoot), projectDuplicateCurrent);
  writeEntry(resolveLegacyProjectMemoryPath(projectRoot), projectDuplicateLegacy);

  const projectEntries = readProjectMemoryEntries(projectRoot);
  assert.deepEqual(
    projectEntries.map(entry => entry.id),
    ['project-current', 'project-dupe', 'project-legacy'],
    'project read should include .lattice and legacy .koala entries with .lattice winning duplicate ids',
  );
  assert.equal(projectEntries.find(entry => entry.id === 'project-dupe')?.summary, 'project duplicate current lattice entry wins');
  assertNonAuthoritative(projectEntries, 'project entries');

  const fakeHome = join(root, 'home');
  mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.LATTICE_GLOBAL_MEMORY_DIR;

  const globalCurrent = makeEntry('global-current', 'global current lattice memory entry', 'global');
  const globalLegacy = makeEntry('global-legacy', 'global legacy koala memory entry', 'global');
  const globalDuplicateCurrent = makeEntry('global-dupe', 'global duplicate current lattice entry wins', 'global');
  const globalDuplicateLegacy = makeEntry('global-dupe', 'global duplicate legacy koala entry loses', 'global');

  writeEntry(resolveGlobalMemoryPath(), globalCurrent);
  writeEntry(resolveLegacyGlobalMemoryPath(), globalLegacy);
  writeEntry(resolveGlobalMemoryPath(), globalDuplicateCurrent);
  writeEntry(resolveLegacyGlobalMemoryPath(), globalDuplicateLegacy);

  const globalEntries = readGlobalMemoryEntries();
  assert.deepEqual(
    globalEntries.map(entry => entry.id),
    ['global-current', 'global-dupe', 'global-legacy'],
    'global read should include ~/.lattice and legacy ~/.koala entries with .lattice winning duplicate ids',
  );
  assert.equal(globalEntries.find(entry => entry.id === 'global-dupe')?.summary, 'global duplicate current lattice entry wins');
  assertNonAuthoritative(globalEntries, 'global entries');

  process.env.LATTICE_GLOBAL_MEMORY_DIR = join(root, 'global-override');
  const maskedLegacyEntries = readGlobalMemoryEntries();
  assert.deepEqual(
    maskedLegacyEntries,
    [],
    'LATTICE_GLOBAL_MEMORY_DIR override should mask legacy global .koala fallback',
  );
  delete process.env.LATTICE_GLOBAL_MEMORY_DIR;

  const writableGlobalPath = resolveGlobalMemoryPath();
  const legacyGlobalPath = resolveLegacyGlobalMemoryPath();
  assert.equal(
    writableGlobalPath,
    join(fakeHome, '.lattice', 'dev-memory', 'experience.jsonl'),
    'writable global memory path must resolve under ~/.lattice',
  );
  assert.equal(
    legacyGlobalPath,
    join(fakeHome, '.koala', 'dev-memory', 'experience.jsonl'),
    'legacy global read fallback is the fixed ~/.koala/dev-memory path with no separate override env',
  );
  assert.deepEqual(
    resolveGlobalMemoryReadPaths(),
    [writableGlobalPath, legacyGlobalPath],
    'global read paths should keep current writable path first, then legacy .koala fallback',
  );
  const wave = legacySmokeWave();
  const dispatch = buildParallelDispatch(wave, {
    projectRoot,
    includeExperience: true,
    experienceQuery: 'koala',
    maxExperienceRefs: 10,
  });
  const dispatchExperienceIds = dispatch.dispatchEntries.flatMap(entry => entry.experienceRefs.map(ref => ref.id));
  assert.ok(
    dispatchExperienceIds.includes('project-legacy'),
    'parallel dispatch experienceRefs should include legacy project .koala memory through includeExperience',
  );
  assert.ok(
    dispatchExperienceIds.includes('global-legacy'),
    'parallel dispatch experienceRefs should include legacy global .koala memory through includeExperience',
  );
  const report = buildParallelReport(wave, {
    projectRoot,
    includeExperience: true,
    experienceQuery: 'koala',
    maxExperienceRefs: 10,
  });
  const reportExperienceIds = report.experienceRefs.map(ref => ref.id);
  assert.ok(
    reportExperienceIds.includes('project-legacy'),
    'parallel report experienceRefs should include legacy project .koala memory through includeExperience',
  );
  assert.ok(
    reportExperienceIds.includes('global-legacy'),
    'parallel report experienceRefs should include legacy global .koala memory through includeExperience',
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
  assert.doesNotMatch(
    startOutput,
    /koala dev_memory_finish/,
    'dev_memory_start should not suggest the legacy koala dev_memory_finish command',
  );
  const captureOutput = handlers.dev_memory_capture({
    category: 'workflow',
    scope: 'project',
    summary: 'capture writes only lattice memory',
    trigger: 'capture smoke trigger',
    lesson: 'capture should never write legacy koala memory',
    reusePrompt: 'check lattice dev memory path only',
    sourceAgent: 'dev-memory-legacy-read-smoke',
  });

  assert.match(captureOutput, /Captured dev-memory experience:/);
  const capturePath = resolveProjectMemoryPath(captureRoot);
  const legacyCapturePath = resolveLegacyProjectMemoryPath(captureRoot);
  assert.equal(existsSync(capturePath), true, 'capture should write .lattice/dev-memory/experience.jsonl');
  assert.equal(existsSync(legacyCapturePath), false, 'capture must not write .koala/dev-memory/experience.jsonl');
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

console.log('✓ dev-memory legacy read smoke passed');
