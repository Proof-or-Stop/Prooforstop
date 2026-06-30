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
  readGlobalMemoryEntries,
  readProjectMemoryEntries,
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

const legacyEntries = [
  entry({
    id: 'a6832a1',
    createdAt: '2026-05-29T00:00:00.000Z',
    summary: 'Koala reviewer runs must bind to the latest review round.',
    trigger: 'A Koala reviewer pass was recorded after a stale review-run start.',
    lesson: 'For Koala review blockers, start a fresh reviewer run and bind pass or finding evidence to that run.',
    reusePrompt: 'When Koala reviewer state looks stale, check the review run binding before accepting the pass.',
    tags: ['koala-reviewer', 'legacy-term'],
    evidenceRefs: ['story:B-old-review', 'review-run:legacy-a6832a1'],
  }),
  entry({
    id: 'f4fe749',
    createdAt: '2026-05-30T00:00:00.000Z',
    summary: 'Koala delivery notes must state what changed for the user.',
    trigger: 'A Koala delivery check passed with only engineering plumbing described.',
    lesson: 'Tie Koala delivery evidence to the observable user-facing result, not only internal command success.',
    reusePrompt: 'When Koala delivery feels abstract, ask what the user can now do or see.',
    tags: ['koala-delivery', 'legacy-term'],
    evidenceRefs: ['story:B-old-delivery', 'delivery-check:legacy-f4fe749'],
  }),
  entry({
    id: 'c948c85',
    createdAt: '2026-05-31T00:00:00.000Z',
    summary: 'Koala CLI dist can lag behind source in self-hosting work.',
    trigger: 'A Koala story worktree added a command but the installed CLI still showed unknown command.',
    lesson: 'Rebuild the Koala CLI dist after self-hosting work and verify the checkout used by the global command.',
    reusePrompt: 'When Koala CLI commands look stale, check dist and global checkout wiring.',
    tags: ['koala-cli', 'legacy-term'],
    evidenceRefs: ['story:B-old-cli', 'commit:legacy-c948c85'],
  }),
  entry({
    id: '2de5d6b',
    createdAt: '2026-06-01T00:00:00.000Z',
    summary: 'Koala preflight context must surface blockers before implementation.',
    trigger: 'A Koala preflight warning was skipped and the implementation later hit the same blocker.',
    lesson: 'Read Koala preflight output for path, phase, and stale evidence warnings before writing code.',
    reusePrompt: 'When Koala preflight emits warnings, resolve or explicitly account for them before editing.',
    tags: ['koala-preflight', 'legacy-term'],
    evidenceRefs: ['story:B-old-preflight', 'preflight:legacy-2de5d6b'],
  }),
  entry({
    id: '7bc20e5',
    createdAt: '2026-06-02T00:00:00.000Z',
    summary: 'Koala evidence references must stay historically readable.',
    trigger: 'A cleanup risked removing old Koala evidenceRefs while renaming terminology.',
    lesson: 'Do not rewrite historical Koala evidenceRefs; add current guidance alongside readable legacy entries.',
    reusePrompt: 'When cleaning Koala terminology, preserve original refs and content for auditability.',
    tags: ['koala-evidence', 'legacy-term'],
    evidenceRefs: ['story:B-old-evidence', 'dev-memory:older-koala-context'],
  }),
];

const currentEntries = [
  entry({
    id: 'proof-reviewer-a6832a1',
    createdAt: '2026-06-30T00:00:00.000Z',
    summary: 'Proofbound/Lattice reviewer runs must bind to the latest review round.',
    trigger: 'Legacy review-run lessons now map to current Proofbound/Lattice reviewer metadata.',
    lesson: 'Start a fresh review_run_start in the story worktree and bind review_pass_set or finding_add to that current signed run.',
    reusePrompt: 'For reviewer blockers, apply current Proofbound/Lattice review-run binding and freshness checks.',
    tags: ['proofbound', 'lattice', 'reviewer', 'supersedes-a6832a1'],
  }),
  entry({
    id: 'proof-delivery-f4fe749',
    createdAt: '2026-06-30T00:01:00.000Z',
    summary: 'Proofbound/Lattice delivery notes must state what changed for the user.',
    trigger: 'Legacy delivery lessons now map to current Proofbound/Lattice product-value acceptance.',
    lesson: 'Record the observable user-facing outcome alongside command evidence so delivery review can judge product value.',
    reusePrompt: 'For delivery checks, describe what the user can now do or see and keep command evidence as support.',
    tags: ['proofbound', 'lattice', 'delivery'],
    evidenceRefs: ['dev-memory:f4fe749'],
  }),
  entry({
    id: 'proof-cli-c948c85',
    createdAt: '2026-06-30T00:02:00.000Z',
    summary: 'Proofbound/Lattice CLI dist can lag behind source in self-hosting work.',
    trigger: 'Legacy CLI dist lessons now map to current Proofbound/Lattice package builds.',
    lesson: 'Use the story worktree build for new commands, then rebuild the canonical main package after merge before trusting the global lattice binary.',
    reusePrompt: 'For stale CLI commands, apply current Proofbound/Lattice dist and global lattice checkout guidance.',
    tags: ['proofbound', 'lattice', 'cli', 'supersedes-c948c85'],
  }),
  entry({
    id: 'proof-preflight-2de5d6b',
    createdAt: '2026-06-30T00:03:00.000Z',
    summary: 'Proofbound/Lattice preflight context must surface blockers before implementation.',
    trigger: 'Legacy preflight lessons now map to current Proofbound/Lattice session and scope checks.',
    lesson: 'Run session_brief and relevant preflight checks first, then account for path, phase, ownership, and stale evidence warnings before editing.',
    reusePrompt: 'For preflight warnings, resolve or explicitly account for current Proofbound/Lattice blockers before implementation.',
    tags: ['proofbound', 'lattice', 'preflight'],
    evidenceRefs: ['dev-memory:2de5d6b'],
  }),
  entry({
    id: 'proof-evidence-7bc20e5',
    createdAt: '2026-06-30T00:04:00.000Z',
    summary: 'Proofbound/Lattice memory cleanup keeps historical evidence references readable.',
    trigger: 'Legacy evidence-reference lessons now map to current Proofbound/Lattice non-authoritative memory cleanup.',
    lesson: 'Add superseding current entries for ranking and presentation while preserving original content and evidenceRefs unchanged.',
    reusePrompt: 'For terminology cleanup, preserve old memory content and refs while surfacing current Proofbound/Lattice guidance first.',
    tags: ['proofbound', 'lattice', 'evidence', 'supersedes-7bc20e5'],
  }),
];

const unmatchedLegacy = entry({
  id: 'unmatched-koala-legacy',
  createdAt: '2026-06-03T00:00:00.000Z',
  summary: 'Koala scratchpad reminder remains readable when no current replacement exists.',
  trigger: 'A narrow cleanup should not hide old memories that have no superseding current entry.',
  lesson: 'Keep unmatched Koala entries visible until a current Proofbound/Lattice lesson explicitly supersedes them.',
  reusePrompt: 'When no superseding entry exists, treat the old memory as readable historical context.',
  tags: ['koala-unmatched', 'legacy-term'],
  evidenceRefs: ['story:B-old-unmatched', 'note:do-not-rewrite'],
});

const entries = [...legacyEntries, ...currentEntries, unmatchedLegacy];
const legacyById = new Map(legacyEntries.map(e => [e.id, e]));
const currentByLegacyId = new Map([
  ['a6832a1', currentEntries[0]],
  ['f4fe749', currentEntries[1]],
  ['c948c85', currentEntries[2]],
  ['2de5d6b', currentEntries[3]],
  ['7bc20e5', currentEntries[4]],
]);
const knownLegacyIds = ['a6832a1', 'f4fe749', 'c948c85', '2de5d6b', '7bc20e5'];
const actualCurrentIds = ['34e97f9', '99aa6c7', 'ee3aef3', '148297b', '7ffe281'];
const actualCurrentByLegacyId = new Map([
  ['a6832a1', '34e97f9'],
  ['f4fe749', '99aa6c7'],
  ['c948c85', 'ee3aef3'],
  ['2de5d6b', '148297b'],
  ['7bc20e5', '7ffe281'],
]);
const actualQueryExpectations = [
  { query: 'koala cli', currentIds: ['148297b'], legacyIds: ['2de5d6b'] },
  { query: 'koala reviewer', currentIds: ['ee3aef3', '34e97f9'], legacyIds: ['c948c85', 'a6832a1'] },
  { query: 'koala delivery', currentIds: ['99aa6c7'], legacyIds: ['f4fe749'] },
  { query: 'koala preflight', currentIds: ['7ffe281'], legacyIds: ['7bc20e5'] },
];
const originalLegacyEvidenceRefs = new Map(legacyEntries.map(e => [e.id, [...(e.evidenceRefs || [])]]));
const originalLegacyContent = new Map(legacyEntries.map(e => [e.id, {
  summary: e.summary,
  trigger: e.trigger,
  lesson: e.lesson,
  reusePrompt: e.reusePrompt,
}]));

function assertSupersessionPair(
  projection: ReturnType<typeof buildSupersessionProjection>,
  legacyId: string,
  currentEntry: DevMemoryEntry,
): void {
  const legacyStatus = getSupersessionStatus(legacyId, projection);
  const currentStatus = getSupersessionStatus(currentEntry, projection);
  assert.equal(legacyStatus.isSuperseded, true, `${legacyId} should be superseded`);
  assert.deepEqual(legacyStatus.supersededBy, [currentEntry.id]);
  assert.equal(currentStatus.isSuperseding, true, `${currentEntry.id} should be superseding`);
  assert.deepEqual(currentStatus.supersedes, [legacyId]);
}

function assertCurrentGuidanceFirst(query: string, expectedCurrentId: string, expectedLegacyId: string): void {
  const results = searchEntries(entries, { query, limit: 10 });
  const ids = results.map(e => e.id);
  assert.equal(ids[0], expectedCurrentId, `${query} should rank current guidance first`);
  assert(ids.includes(expectedLegacyId), `${query} should keep old entry visible`);
  assert(ids.indexOf(expectedCurrentId) < ids.indexOf(expectedLegacyId), `${query} should rank current before old`);
}

function assertPreflightGuidanceFirst(query: string, expectedCurrentId: string, expectedLegacyId: string, root: string): void {
  const preflight = buildPreflightPack({ projectRoot: root, query, maxEntries: 10 });
  const ids = preflight.entries.map(e => e.id);
  assert.equal(ids[0], expectedCurrentId, `${query} preflight should rank current guidance first`);
  assert(ids.includes(expectedLegacyId), `${query} preflight should keep old entry visible`);
  assert(ids.indexOf(expectedCurrentId) < ids.indexOf(expectedLegacyId), `${query} preflight should rank current before old`);
}

function assertNoActiveKoalaGuidance(currentEntry: DevMemoryEntry): void {
  const text = [currentEntry.summary, currentEntry.trigger, currentEntry.lesson, currentEntry.reusePrompt].join(' ');
  assert.doesNotMatch(text, /\bKoala\b/);
  assert.doesNotMatch(text, /\bKoala-era\b/);
  assert.doesNotMatch(text, /\bkoala\b/);
}

function assertUsesCurrentProductNames(entry: DevMemoryEntry): void {
  const activeGuidance = [entry.summary, entry.lesson, entry.reusePrompt].join(' ');
  assert.match(activeGuidance, /Proofbound|Lattice/, `${entry.id} active guidance should use current product names`);
  for (const [field, value] of [
    ['summary', entry.summary],
    ['lesson', entry.lesson],
    ['reusePrompt', entry.reusePrompt],
  ] as const) {
    assert.doesNotMatch(value, /\bKoala\b|\bkoala\b/, `${entry.id} ${field} should not use Koala as active product name`);
  }

  if (/\bKoala\b|\bkoala\b/.test(entry.trigger)) {
    assert.match(entry.trigger, /Legacy Koala .* now (applies to|maps to)/, `${entry.id} trigger should mention Koala only as legacy mapping context`);
  }
}

function supersedesLegacyId(entry: DevMemoryEntry, legacyId: string): boolean {
  return Boolean(
    entry.tags?.includes(`supersedes-${legacyId}`)
    || entry.evidenceRefs?.includes(`dev-memory:${legacyId}`),
  );
}

function mergeById(...groups: DevMemoryEntry[][]): DevMemoryEntry[] {
  const seen = new Set<string>();
  const merged: DevMemoryEntry[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }
  }
  return merged;
}

function buildLegacySearchText(entry: DevMemoryEntry): string {
  return [
    entry.summary,
    entry.trigger,
    entry.lesson,
    entry.reusePrompt,
    ...(entry.tags || []),
    entry.category,
    entry.sourceStoryId || '',
    ...(entry.evidenceRefs || []),
  ].join(' ').toLowerCase();
}

function legacyEscapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function legacyTokenScore(entry: DevMemoryEntry, query: string): number {
  const text = buildLegacySearchText(entry);
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean).reduce((score, token) => {
    const hits = (text.match(new RegExp(legacyEscapeRegex(token), 'gi')) || []).length;
    return score + hits * 10;
  }, 0);
}

function legacyTokenSearch(entries: DevMemoryEntry[], query: string, limit = 10): DevMemoryEntry[] {
  return entries
    .map(entry => ({ entry, score: legacyTokenScore(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt))
    .slice(0, limit)
    .map(result => result.entry);
}

function assertCurrentBeforeLegacy(ids: string[], currentIds: string[], legacyIds: string[], query: string): void {
  const presentCurrent = currentIds.filter(id => ids.includes(id));
  const presentLegacy = legacyIds.filter(id => ids.includes(id));
  if (presentLegacy.length === 0) return;
  assert(presentCurrent.length > 0, `${query} should include current guidance when legacy rows are present`);
  const firstCurrent = Math.min(...presentCurrent.map(id => ids.indexOf(id)));
  for (const legacyId of presentLegacy) {
    assert(
      firstCurrent < ids.indexOf(legacyId),
      `${query} should rank current ${presentCurrent.join(',')} before legacy ${legacyId}; got ${ids.join(',')}`,
    );
  }
}

function assertLegacySearchTags(entry: DevMemoryEntry): void {
  const tags = entry.tags || [];
  assert(tags.some(tag => tag.startsWith('legacy-koala-')), `${entry.id} should have legacy-koala search tags`);
  assert(tags.some(tag => tag.includes('current')), `${entry.id} should mark current guidance for legacy search`);
}

const previousEnv = process.env.LATTICE_GLOBAL_MEMORY_DIR;
const root = mkdtempSync(join(tmpdir(), 'dev-memory-supersession-'));

try {
  process.env.LATTICE_GLOBAL_MEMORY_DIR = join(root, 'global-memory');
  const projection = buildSupersessionProjection(entries);

  check('tag-only supersession works without dev-memory evidenceRef', () => {
    const current = currentByLegacyId.get('a6832a1');
    assert(current);
    assert(current.tags?.includes('supersedes-a6832a1'));
    assert.equal(current.evidenceRefs?.some(ref => ref === 'dev-memory:a6832a1'), false);
    assertSupersessionPair(projection, 'a6832a1', current);
  });

  check('evidenceRef-only supersession works without supersedes tag', () => {
    const current = currentByLegacyId.get('f4fe749');
    assert(current);
    assert.equal(current.tags?.some(tag => tag === 'supersedes-f4fe749'), false);
    assert(current.evidenceRefs?.includes('dev-memory:f4fe749'));
    assertSupersessionPair(projection, 'f4fe749', current);
  });

  check('captured legacy Koala inventory is fully superseded and readable', () => {
    for (const legacyId of ['a6832a1', 'f4fe749', 'c948c85', '2de5d6b', '7bc20e5']) {
      const legacy = legacyById.get(legacyId);
      const current = currentByLegacyId.get(legacyId);
      assert(legacy);
      assert(current);
      assertSupersessionPair(projection, legacyId, current);
      const formatted = formatEntryShort(legacy, projection);
      assert.match(formatted, /superseded \/ legacy-readable/);
      assert.match(formatted, new RegExp(`superseded by ${current.id}`));
      assert.match(formatted, /Koala/);
    }
  });

  check('search ranks current Proofbound/Lattice guidance before old Koala entries', () => {
    assertCurrentGuidanceFirst('koala reviewer', 'proof-reviewer-a6832a1', 'a6832a1');
    assertCurrentGuidanceFirst('koala delivery', 'proof-delivery-f4fe749', 'f4fe749');
    assertCurrentGuidanceFirst('koala cli', 'proof-cli-c948c85', 'c948c85');
    assertCurrentGuidanceFirst('koala preflight', 'proof-preflight-2de5d6b', '2de5d6b');
  });

  check('preflight ranks current Proofbound/Lattice guidance before old Koala entries', () => {
    writeEntries(resolveProjectMemoryPath(root), entries);
    assertPreflightGuidanceFirst('koala reviewer', 'proof-reviewer-a6832a1', 'a6832a1', root);
    assertPreflightGuidanceFirst('koala delivery', 'proof-delivery-f4fe749', 'f4fe749', root);
    assertPreflightGuidanceFirst('koala cli', 'proof-cli-c948c85', 'c948c85', root);
    assertPreflightGuidanceFirst('koala preflight', 'proof-preflight-2de5d6b', '2de5d6b', root);
  });

  check('unmatched Koala legacy entry remains readable and not hidden', () => {
    const status = getSupersessionStatus(unmatchedLegacy, projection);
    assert.equal(status.isSuperseded, false);
    assert.equal(status.isSuperseding, false);
    const formatted = formatEntryShort(unmatchedLegacy, projection);
    assert.doesNotMatch(formatted, /superseded \/ legacy-readable/);
    assert.match(formatted, /Koala scratchpad reminder remains readable/);
    const [result] = searchEntries(entries, { query: 'scratchpad unmatched', limit: 1 });
    assert.equal(result.id, unmatchedLegacy.id);
  });

  check('historical Koala evidenceRefs and content are not rewritten deleted or hidden', () => {
    for (const legacy of legacyEntries) {
      assert.deepEqual(legacy.evidenceRefs, originalLegacyEvidenceRefs.get(legacy.id));
      assert.deepEqual({
        summary: legacy.summary,
        trigger: legacy.trigger,
        lesson: legacy.lesson,
        reusePrompt: legacy.reusePrompt,
      }, originalLegacyContent.get(legacy.id));
      const formatted = formatEntryShort(legacy, projection);
      for (const ref of legacy.evidenceRefs || []) {
        assert.match(formatted, new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
    }
  });

  check('current entries are visibly annotated with supersedes ids', () => {
    for (const [legacyId, current] of currentByLegacyId.entries()) {
      const formatted = formatEntryShort(current, projection);
      assert.match(formatted, new RegExp(`supersedes ${legacyId}`));
      assert.match(formatted, /Proofbound\/Lattice/);
    }
  });

  check('current entries do not introduce active Koala guidance', () => {
    for (const current of currentEntries) {
      assertNoActiveKoalaGuidance(current);
    }
  });

  check('dev_memory_list annotates supersession status', () => {
    const handlers = createDevMemoryHandlers({
      store: new StoryStore(root),
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const listed = handlers.dev_memory_list({ scope: 'project', limit: 20 });
    assert.match(listed, /supersedes a6832a1/);
    assert.match(listed, /supersedes f4fe749/);
    assert.match(listed, /superseded \/ legacy-readable/);
    assert.match(listed, /Koala reviewer runs must bind/);
  });

  check('all entries remain non-authoritative and not gate evidence', () => {
    for (const devMemoryEntry of entries) {
      assert.equal(devMemoryEntry.gateEvidence, false);
      assert.equal(devMemoryEntry.authority, 'non_authoritative');
      const formatted = formatEntryShort(devMemoryEntry, projection);
      assert.match(formatted, /Authority: gateEvidence=false, authority=non_authoritative/);
    }
  });

  check('supersession remains ranking and presentation only', () => {
    for (const legacy of legacyEntries) {
      const current = currentByLegacyId.get(legacy.id);
      assert(current);
      assert.equal(legacy.gateEvidence, false);
      assert.equal(current.gateEvidence, false);
      assert.equal(legacy.authority, 'non_authoritative');
      assert.equal(current.authority, 'non_authoritative');
    }
  });

  check('actual project memory contains the five B-a9e7 superseding entries', () => {
    const projectEntries = readProjectMemoryEntries(process.cwd());
    const actualEntriesById = new Map(projectEntries.map(e => [e.id, e]));
    for (const currentId of actualCurrentIds) {
      assert(actualEntriesById.has(currentId), `missing actual project memory entry ${currentId}`);
    }
  });

  check('actual project memory entries cite the known legacy ids and remain non-authoritative', () => {
    const projectEntries = readProjectMemoryEntries(process.cwd());
    const actualEntriesById = new Map(projectEntries.map(e => [e.id, e]));
    for (const legacyId of knownLegacyIds) {
      const currentId = actualCurrentByLegacyId.get(legacyId);
      assert(currentId);
      const actual = actualEntriesById.get(currentId);
      assert(actual, `missing actual project memory entry ${currentId}`);
      assert.equal(supersedesLegacyId(actual, legacyId), true, `${currentId} should cite or supersede ${legacyId}`);
      assert.equal(actual.gateEvidence, false);
      assert.equal(actual.authority, 'non_authoritative');
    }
  });

  check('actual project memory current guidance uses Proofbound Lattice names', () => {
    const projectEntries = readProjectMemoryEntries(process.cwd());
    const actualEntriesById = new Map(projectEntries.map(e => [e.id, e]));
    for (const currentId of actualCurrentIds) {
      const actual = actualEntriesById.get(currentId);
      assert(actual, `missing actual project memory entry ${currentId}`);
      assertUsesCurrentProductNames(actual);
      assertLegacySearchTags(actual);
    }
  });

  check('actual project memory supersedes realistic legacy inventory', () => {
    const projectEntries = readProjectMemoryEntries(process.cwd());
    const actualCurrentEntries = actualCurrentIds.map(id => {
      const found = projectEntries.find(e => e.id === id);
      assert(found, `missing actual project memory entry ${id}`);
      return found;
    });
    const actualProjection = buildSupersessionProjection([...legacyEntries, ...actualCurrentEntries]);
    for (const legacyId of knownLegacyIds) {
      const currentId = actualCurrentByLegacyId.get(legacyId);
      assert(currentId);
      const legacyStatus = getSupersessionStatus(legacyId, actualProjection);
      const currentStatus = getSupersessionStatus(currentId, actualProjection);
      assert.equal(legacyStatus.isSuperseded, true, `${legacyId} should be superseded by actual project memory`);
      assert.deepEqual(legacyStatus.supersededBy, [currentId]);
      assert.equal(currentStatus.isSuperseding, true, `${currentId} should supersede actual legacy id`);
      assert.deepEqual(currentStatus.supersedes, [legacyId]);
    }
  });

  check('actual project and global memory rank current guidance before legacy Koala entries', () => {
    const projectEntries = readProjectMemoryEntries(process.cwd());
    const globalEntries = readGlobalMemoryEntries();
    const allEntries = mergeById(projectEntries, globalEntries);
    for (const expectation of actualQueryExpectations) {
      const ids = searchEntries(allEntries, { query: expectation.query, limit: 20 }).map(e => e.id);
      assertCurrentBeforeLegacy(ids, expectation.currentIds, expectation.legacyIds, expectation.query);
    }
  });

  check('legacy token scorer compatibility ranks current guidance before legacy Koala entries', () => {
    const projectEntries = readProjectMemoryEntries(process.cwd());
    const globalEntries = readGlobalMemoryEntries();
    const allEntries = mergeById(projectEntries, globalEntries);
    for (const expectation of actualQueryExpectations) {
      const ids = legacyTokenSearch(allEntries, expectation.query, 20).map(e => e.id);
      assertCurrentBeforeLegacy(ids, expectation.currentIds, expectation.legacyIds, expectation.query);
      if (expectation.query === 'koala cli' && ids.includes('2de5d6b')) {
        assert.equal(ids[0], '148297b', 'koala cli should show current CLI guidance first under legacy token scoring');
      }
    }
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
