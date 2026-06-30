#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatEntryShort,
  readGlobalMemoryEntries,
  readProjectMemoryEntries,
  resolveGlobalMemoryPath,
  resolveProjectMemoryPath,
  searchEntries,
  type DevMemoryEntry,
  writeEntries,
} from '../core/dev-memory.js';

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`check: ${label} - PASS`);
}

const retiredBrand = String.fromCharCode(0x6b, 0x6f, 0x61, 0x6c, 0x61);
const retiredBrandPattern = new RegExp(retiredBrand, 'i');
const retiredMemoryIds = ['7bc20e5', '2de5d6b', 'c948c85', 'f4fe749', 'a6832a1'];

const projectCurrentIds = ['34e97f9', '99aa6c7', 'ee3aef3', '148297b', '7ffe281'];
const projectHostPolicyIds = ['d6f173d', '9bd6b5a'];
const globalFixtureIds = ['globtx1', 'globst1'];

const globalFixtureEntries: DevMemoryEntry[] = [
  {
    id: 'globtx1',
    createdAt: '2026-06-30T00:00:00.000Z',
    sourceAgent: 'lattice-smoke-global',
    category: 'workflow',
    scope: 'global',
    summary: 'Global host taxonomy stays available as advisory memory.',
    trigger: 'physical cleanup smoke fixture',
    lesson: 'Keep current Proofbound host taxonomy memory without retired brand references.',
    reusePrompt: 'Use current Proofbound host taxonomy memory as advisory context only.',
    tags: ['proofbound', 'lattice', 'host-policy'],
    gateEvidence: false,
    authority: 'non_authoritative',
  },
  {
    id: 'globst1',
    createdAt: '2026-06-30T00:00:01.000Z',
    sourceAgent: 'lattice-smoke-global',
    category: 'tool-quirk',
    scope: 'global',
    summary: 'Global stale-doc lessons stay searchable as advisory memory.',
    trigger: 'physical cleanup smoke fixture',
    lesson: 'Keep current Lattice stale-doc lessons available without retired brand references.',
    reusePrompt: 'Use current Lattice stale-doc lessons as advisory context only.',
    tags: ['proofbound', 'lattice', 'stale-doc'],
    gateEvidence: false,
    authority: 'non_authoritative',
  },
];

function readRawMemoryFile(filePath: string): string {
  assert.equal(existsSync(filePath), true, `${filePath} should exist`);
  return readFileSync(filePath, 'utf8');
}

function entriesById(entries: DevMemoryEntry[]): Map<string, DevMemoryEntry> {
  return new Map(entries.map(entry => [entry.id, entry]));
}

function entryJson(entry: DevMemoryEntry): string {
  return JSON.stringify(entry);
}

function assertNoRetiredBrand(label: string, value: string): void {
  assert.doesNotMatch(value, retiredBrandPattern, `${label} should not contain retired brand text`);
}

function assertCleanEntries(label: string, entries: DevMemoryEntry[]): void {
  for (const entry of entries) {
    assertNoRetiredBrand(`${label} entry ${entry.id}`, entryJson(entry));
    const tags = entry.tags || [];
    for (const tag of tags) {
      assertNoRetiredBrand(`${label} entry ${entry.id} tag ${tag}`, tag);
    }
    const formatted = formatEntryShort(entry);
    assertNoRetiredBrand(`${label} formatted entry ${entry.id}`, formatted);
  }
}

function assertEntriesPresent(label: string, entries: DevMemoryEntry[], expectedIds: string[]): void {
  const byId = entriesById(entries);
  for (const id of expectedIds) {
    assert(byId.has(id), `${label} should preserve memory entry ${id}`);
  }
}

function assertNonAuthoritative(label: string, entry: DevMemoryEntry): void {
  assert.equal(entry.gateEvidence, false, `${label} ${entry.id} should not be gate evidence`);
  assert.equal(entry.authority, 'non_authoritative', `${label} ${entry.id} should remain non-authoritative`);
}

function createGlobalMemoryFixture(): { dir: string; restore: () => void } {
  const originalGlobalMemoryDir = process.env.LATTICE_GLOBAL_MEMORY_DIR;
  const fixtureParent = originalGlobalMemoryDir || tmpdir();
  mkdirSync(fixtureParent, { recursive: true });

  const dir = mkdtempSync(join(fixtureParent, 'lattice-global-memory-smoke-'));
  process.env.LATTICE_GLOBAL_MEMORY_DIR = dir;
  writeEntries(resolveGlobalMemoryPath(), globalFixtureEntries);

  return {
    dir,
    restore: () => {
      if (originalGlobalMemoryDir === undefined) {
        delete process.env.LATTICE_GLOBAL_MEMORY_DIR;
      } else {
        process.env.LATTICE_GLOBAL_MEMORY_DIR = originalGlobalMemoryDir;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function assertCurrentProjectMemory(entry: DevMemoryEntry): void {
  const guidance = [entry.summary, entry.trigger, entry.lesson, entry.reusePrompt].join(' ');
  assert.match(guidance, /Proofbound|Lattice/, `${entry.id} should use current product names`);
  assert(entry.tags?.some(tag => tag === 'proofbound' || tag.includes('proofbound')), `${entry.id} should keep Proofbound tags`);
  assert(entry.tags?.some(tag => tag === 'lattice' || tag.includes('lattice')), `${entry.id} should keep Lattice tags`);
  assert(entry.tags?.some(tag => tag.startsWith('supersedes-')), `${entry.id} should keep supersession id context`);
  assertNonAuthoritative('project', entry);
}

function assertHostPolicyMemory(entry: DevMemoryEntry): void {
  assert(entry.tags?.includes('host-policy'), `${entry.id} should remain a host-policy row`);
  assert.match(entryJson(entry), /codex-cli|claude-cli|agy-cli/, `${entry.id} should preserve host policy labels`);
  assertNonAuthoritative('project host policy', entry);
}

function assertCurrentGlobalMemory(entry: DevMemoryEntry): void {
  assert.equal(entry.scope, 'global', `${entry.id} should be a global memory row`);
  assert.match(entryJson(entry), /Proofbound|Lattice/, `${entry.id} should use current product names`);
  assert(entry.tags?.some(tag => tag === 'proofbound' || tag.includes('proofbound')), `${entry.id} should keep Proofbound tags`);
  assert(entry.tags?.some(tag => tag === 'lattice' || tag.includes('lattice')), `${entry.id} should keep Lattice tags`);
  assertNonAuthoritative('global', entry);
}

function assertSearchFinds(entries: DevMemoryEntry[], query: string, expectedIds: string[]): void {
  const ids = searchEntries(entries, { query, limit: 20 }).map(entry => entry.id);
  for (const id of expectedIds) {
    assert(ids.includes(id), `${query} should find ${id}; got ${ids.join(',')}`);
  }
}

const globalFixture = createGlobalMemoryFixture();
process.on('exit', globalFixture.restore);

const projectPath = resolveProjectMemoryPath(process.cwd());
const globalPath = resolveGlobalMemoryPath();
const projectRaw = readRawMemoryFile(projectPath);
const globalRaw = readRawMemoryFile(globalPath);
const projectEntries = readProjectMemoryEntries(process.cwd());
const globalEntries = readGlobalMemoryEntries();

check('project and global memory files have no retired brand text', () => {
  assertNoRetiredBrand(projectPath, projectRaw);
  assertNoRetiredBrand(globalPath, globalRaw);
});

check('parsed project and global memory entries have no retired brand text or tags', () => {
  assertCleanEntries('project memory', projectEntries);
  assertCleanEntries('global memory', globalEntries);
});

check('retired global rows are physically removed', () => {
  const globalById = entriesById(globalEntries);
  for (const id of retiredMemoryIds) {
    assert.equal(globalById.has(id), false, `global memory should not keep retired row ${id}`);
  }
});

check('current Proofbound and Lattice project memories are preserved', () => {
  assertEntriesPresent('project memory', projectEntries, projectCurrentIds);
  const projectById = entriesById(projectEntries);
  for (const id of projectCurrentIds) {
    const entry = projectById.get(id);
    assert(entry);
    assertCurrentProjectMemory(entry);
  }
});

check('host policy memories are preserved', () => {
  assertEntriesPresent('project memory', projectEntries, projectHostPolicyIds);
  const projectById = entriesById(projectEntries);
  for (const id of projectHostPolicyIds) {
    const entry = projectById.get(id);
    assert(entry);
    assertHostPolicyMemory(entry);
  }
});

check('current global fixture memories are preserved', () => {
  assertEntriesPresent('global memory fixture', globalEntries, globalFixtureIds);
  const globalById = entriesById(globalEntries);
  for (const id of globalFixtureIds) {
    const entry = globalById.get(id);
    assert(entry);
    assertCurrentGlobalMemory(entry);
  }
});

check('current memory search still finds project guidance', () => {
  assertSearchFinds(projectEntries, 'Proofbound reviewer', ['34e97f9', 'ee3aef3']);
  assertSearchFinds(projectEntries, 'Lattice delivery evidence', ['99aa6c7']);
  assertSearchFinds(projectEntries, 'Proofbound self-hosting CLI', ['148297b']);
  assertSearchFinds(projectEntries, 'dev-memory preflight Lattice', ['7ffe281']);
});

check('host policy search still finds preserved rows', () => {
  assertSearchFinds(projectEntries, 'host policy codex claude agy fallback', projectHostPolicyIds);
});

check('global memory search stays current and clean', () => {
  assertSearchFinds(globalEntries, 'host taxonomy advisory', ['globtx1']);
  assertSearchFinds(globalEntries, 'stale-doc lessons', ['globst1']);
  assert.deepEqual(searchEntries(globalEntries, { query: retiredBrand, limit: 20 }).map(entry => entry.id), []);
});

console.log(`dev-memory physical cleanup smoke passed (${passed} checks)`);
