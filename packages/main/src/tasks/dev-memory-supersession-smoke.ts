#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  formatEntryShort,
  readGlobalMemoryEntries,
  readProjectMemoryEntries,
  resolveGlobalMemoryPath,
  resolveProjectMemoryPath,
  searchEntries,
  type DevMemoryEntry,
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
const globalCurrentIds = ['a4d08a8', '9890b83'];

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

function assertSearchFinds(entries: DevMemoryEntry[], query: string, expectedIds: string[]): void {
  const ids = searchEntries(entries, { query, limit: 20 }).map(entry => entry.id);
  for (const id of expectedIds) {
    assert(ids.includes(id), `${query} should find ${id}; got ${ids.join(',')}`);
  }
}

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

check('current global memories are preserved', () => {
  assertEntriesPresent('global memory', globalEntries, globalCurrentIds);
  const globalById = entriesById(globalEntries);
  for (const id of globalCurrentIds) {
    const entry = globalById.get(id);
    assert(entry);
    assertNonAuthoritative('global', entry);
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

console.log(`dev-memory supersession smoke passed (${passed} checks)`);
