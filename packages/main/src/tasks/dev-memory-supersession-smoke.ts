#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPreflightPack,
  buildSupersessionProjection,
  formatEntryShort,
  getSupersessionStatus,
  resolveProjectMemoryPath,
  searchEntries,
  writeEntries,
  type DevMemoryEntry,
} from '../core/dev-memory.js';
import { StoryStore } from '../core/store.js';
import { createDevMemoryHandlers } from '../handlers/dev-memory.js';

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`check: ${label} - PASS`);
}

function entry(input: Partial<DevMemoryEntry> & Pick<DevMemoryEntry, 'id' | 'createdAt' | 'summary' | 'trigger' | 'lesson' | 'reusePrompt'>): DevMemoryEntry {
  return {
    sourceAgent: 'codex',
    category: 'workflow',
    scope: 'project',
    tags: [],
    evidenceRefs: [],
    gateEvidence: false,
    authority: 'non_authoritative',
    ...input,
  };
}

const legacy = entry({
  id: 'legacy1',
  createdAt: '2026-05-29T00:00:00.000Z',
  summary: 'Koala self-hosting CLI dist can lag behind source.',
  trigger: 'A Koala story worktree added a command but the installed CLI still showed unknown command.',
  lesson: 'Rebuild the Koala CLI dist after self-hosting work and verify the checkout used by the global command.',
  reusePrompt: 'When Koala CLI commands look stale, check dist and global checkout wiring.',
  tags: ['koala-cli', 'legacy-term'],
});

const current = entry({
  id: 'current1',
  createdAt: '2026-06-30T00:00:00.000Z',
  summary: 'Proofbound/Lattice self-hosting CLI dist can lag behind source.',
  trigger: 'Legacy Koala guidance now maps to current Proofbound/Lattice CLI self-hosting work.',
  lesson: 'Use the story worktree build for new Proofbound/Lattice commands, then rebuild the canonical main package after merge before trusting the global lattice binary.',
  reusePrompt: 'When a Koala-era memory mentions stale CLI commands, apply the current Proofbound/Lattice dist and global lattice checkout guidance.',
  tags: ['proofbound', 'lattice', 'supersedes-legacy1'],
  evidenceRefs: ['dev-memory:legacy1'],
});

const previousEnv = process.env.LATTICE_GLOBAL_MEMORY_DIR;
const root = mkdtempSync(join(tmpdir(), 'dev-memory-supersession-'));

try {
  process.env.LATTICE_GLOBAL_MEMORY_DIR = join(root, 'global-memory');
  const entries = [legacy, current];
  const projection = buildSupersessionProjection(entries);

  check('projection marks current entry as superseding legacy entry', () => {
    const status = getSupersessionStatus(current, projection);
    assert.equal(status.isSuperseding, true);
    assert.deepEqual(status.supersedes, ['legacy1']);
  });

  check('projection marks legacy entry as superseded but readable', () => {
    const status = getSupersessionStatus(legacy, projection);
    assert.equal(status.isSuperseded, true);
    assert.deepEqual(status.supersededBy, ['current1']);
  });

  check('search ranks superseding entry before superseded legacy entry', () => {
    const results = searchEntries(entries, { query: 'koala', limit: 2 });
    assert.deepEqual(results.map(e => e.id), ['current1', 'legacy1']);
  });

  check('preflight ranks superseding entry before superseded legacy entry', () => {
    writeEntries(resolveProjectMemoryPath(root), entries);
    const preflight = buildPreflightPack({ projectRoot: root, query: 'koala', maxEntries: 2 });
    assert.deepEqual(preflight.entries.map(e => e.id), ['current1', 'legacy1']);
  });

  check('legacy entry remains readable and visibly annotated', () => {
    const formatted = formatEntryShort(legacy, projection);
    assert.match(formatted, /superseded \/ legacy-readable/);
    assert.match(formatted, /superseded by current1/);
    assert.match(formatted, /Koala self-hosting CLI dist can lag/);
  });

  check('current entry is visibly annotated with supersedes id', () => {
    const formatted = formatEntryShort(current, projection);
    assert.match(formatted, /supersedes legacy1/);
    assert.match(formatted, /Proofbound\/Lattice self-hosting CLI dist/);
  });

  check('dev_memory_list annotates supersession status', () => {
    const handlers = createDevMemoryHandlers({
      store: new StoryStore(root),
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const listed = handlers.dev_memory_list({ scope: 'project', limit: 10 });
    assert.match(listed, /supersedes legacy1/);
    assert.match(listed, /superseded \/ legacy-readable/);
  });

  check('entries remain non-authoritative and not gate evidence', () => {
    assert.equal(current.gateEvidence, false);
    assert.equal(current.authority, 'non_authoritative');
    assert.equal(legacy.gateEvidence, false);
    assert.equal(legacy.authority, 'non_authoritative');
  });

  check('Koala legacy term maps to current Proofbound/Lattice guidance', () => {
    const [first] = searchEntries(entries, { query: 'koala', limit: 1 });
    assert.equal(first.id, 'current1');
    assert.match(first.lesson, /Proofbound\/Lattice/);
    assert.match(first.reusePrompt, /Koala-era memory/);
  });
} finally {
  if (previousEnv === undefined) {
    delete process.env.LATTICE_GLOBAL_MEMORY_DIR;
  } else {
    process.env.LATTICE_GLOBAL_MEMORY_DIR = previousEnv;
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`dev-memory supersession smoke passed (${passed} checks)`);
