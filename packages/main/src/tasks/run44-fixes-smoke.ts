#!/usr/bin/env node
/**
 * Old-PoS run 44 (bench-staging/oldpos/run44-analysis.md §2.3-§2.5, §6.2 N1-N3,
 * N5-N8): unit level, with real git repositories where Git is involved. Generic
 * examples only (a toy key/value `store` module; no benchmark-task material).
 * The REVIEW routing halves (no circular pointer, duplicate review_run_start,
 * the REVIEW->PLAN hop) run end to end in the e2e harness (NMS, NMD, NMP).
 *
 *   M. Metadata corrections with a short quoted literal (detection-neutral):
 *      M1 a cited short quoted literal inside a backticked span of the field is
 *         widened to that span (the wrong literal the sweep and the owner see),
 *         and the sweep lists every userSees / intent row stating it;
 *      M2 a reviewer's sentence that differs from the field's statement only in
 *         the short literal's slot is the corrected value;
 *      M3 correction checkpoints: every applied userSees correction is reverted
 *         from its recorded before/after text (no corrected value needed),
 *         newest first, item by item; an intent-row correction or any other
 *         change of the field stops the chain (fail closed);
 *      M4 the routing input reverts applied userSees corrections without a
 *         corrected value.
 *   X. Exact-text gate: an equality on the result of a same-file test helper
 *      whose body returns a cut of its parameter (head, first line, prefix) is
 *      a prefix comparison, whatever the helper is called; a helper returning
 *      its whole parameter (trimmed) stays exact.
 *   D. Duplicate chains: a duplicate of a duplicate closes against the ROOT
 *      canonical in the same batch once the root is resolved; a cycle has no
 *      root.
 *   R. Repair brief: the finding-repair prompt asks for the whole defect family
 *      found by grepping the same code path and a `[family]` line per checked
 *      shape in the final report.
 *
 * Usage: node packages/main/dist/tasks/run44-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as metadata from '../core/metadata-correction.js';
import * as exactText from '../core/exact-text-assertions.js';
import * as duplicates from '../core/duplicate-finding-coverage.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ChecklistItem, StoryInfo } from '../core/types.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';

type Fn = (...args: unknown[]) => unknown;
const api = (module: object, name: string): Fn => {
  const fn = (module as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `${name} is exported`);
  return fn as Fn;
};
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// ---------------------------------------------------------------------------
// M. metadata corrections with a short quoted literal

const row = (desc: string, test: string) => ({ desc, type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const, expectation: 'absolute_pass' as const,
  requirementSource: 'story' as const, verification: { command: `go test -v ./store -run ^${test}$`, selector: `--- PASS: ${test}` } });
const WRONG_SPAN = 'store closed: "k" not readable';
const RIGHT_SPAN = 'store closed: k not readable';
function storeItems(): ChecklistItem[] {
  return [{
    id: 'CHK-001', title: 'Closed store reads', context: 'store/store.go',
    userSees: `get("k") on a closed store fails with \`${WRONG_SPAN}\`; go test -v ./store -run TestGetClosed prints --- PASS: TestGetClosed`,
    files: { modify: ['store/store.go'], create: [], test: ['store/store_test.go'] },
    verificationIntent: { happy: [row('put("k","v") then get("k") -> "v"', 'TestGet')], edge: [row('get("zz") -> missing key', 'TestGetMissing')],
      adversarial: [row(`close() then get("k") -> ${WRONG_SPAN}`, 'TestGetClosed')] },
    status: 'done', startTime: null, endTime: null,
  }, {
    id: 'CHK-002', title: 'Closed store writes', context: 'store/store.go',
    userSees: `put("k", "v") on a closed store fails with \`${WRONG_SPAN}\` as well`,
    files: { modify: ['store/store.go'], create: [], test: ['store/store_test.go'] },
    verificationIntent: { happy: [row('put("a","b") -> nil', 'TestPut')], edge: [row('put("","b") -> empty key', 'TestPutEmpty')],
      adversarial: [row(`close() then put("k","v") -> ${WRONG_SPAN}`, 'TestPutClosed')] },
    status: 'done', startTime: null, endTime: null,
  }] as unknown as ChecklistItem[];
}

await check('M1 a cited short quoted literal is widened to its backticked span; the sweep lists every row stating it', () => {
  const items = storeItems();
  const pair = api(metadata, 'extractLiteralPair')(
    'CHK-001 userSees still quotes the key "k" in the closed-store error; the request renders the key bare (its placeholder slot), so the acceptance text contradicts the request.',
    metadata.metadataFieldText(items[0]!, 'userSees')) as { wrongLiteral: string | null; correctedValue: string | null };
  assert.equal(pair.wrongLiteral, WRONG_SPAN, `the wrong literal is the enclosing span, not the bare short literal: ${JSON.stringify(pair)}`);
  assert.equal(pair.correctedValue, null, 'no corrected value is stated');
  const refs = (api(metadata, 'literalOccurrences')(items, pair.wrongLiteral) as Array<{ ref: string }>).map(entry => entry.ref);
  assert.deepEqual(refs, ['CHK-001 userSees', 'CHK-001:adversarial:0', 'CHK-002 userSees', 'CHK-002:adversarial:0'], `the sweep lists every row stating it: ${refs.join(', ')}`);
  // A bare short literal alone is still never swept (it would match unrelated text such as get("k")).
  assert.deepEqual(api(metadata, 'literalOccurrences')(items, '"k"'), [], 'a bare short literal is not swept');
});

await check('M2 a reviewer sentence differing only in the short literal slot is the corrected value', () => {
  const items = storeItems();
  const pair = api(metadata, 'extractLiteralPair')(
    `CHK-001 userSees still quotes "k"; the request prints \`${RIGHT_SPAN}\`.`, metadata.metadataFieldText(items[0]!, 'userSees')) as { wrongLiteral: string | null; correctedValue: string | null };
  assert.deepEqual(pair, { wrongLiteral: WRONG_SPAN, correctedValue: RIGHT_SPAN });
});

const applied = (itemId: string, field: string, before: string, after: string) => ({ type: 'metadata_correction_applied', itemId, field, before, after });

await check('M3 correction checkpoints revert applied userSees corrections newest first; an intent-row correction or another edit stops the chain', () => {
  const original = storeItems();
  const fixed1 = original[0]!.userSees!.replace(WRONG_SPAN, RIGHT_SPAN);
  const fixed2 = original[1]!.userSees!.replace(WRONG_SPAN, RIGHT_SPAN);
  const current = original.map(item => ({ ...item, userSees: item.id === 'CHK-001' ? fixed1 : fixed2 }));
  const checkpoints = api(metadata, 'metadataCorrectionCheckpoints') as (events: unknown[], items: ChecklistItem[]) => ChecklistItem[][];
  const events = [applied('CHK-001', 'userSees', original[0]!.userSees!, fixed1), applied('CHK-002', 'userSees', original[1]!.userSees!, fixed2)];
  const states = checkpoints(events, current);
  assert.equal(states.length, 2, 'one checkpoint per applied correction');
  assert.deepEqual(states[0]!.map(item => item.userSees), [fixed1, original[1]!.userSees], 'newest reverted first');
  assert.deepEqual(states[1]!.map(item => item.userSees), original.map(item => item.userSees), 'then the older one: the text the lanes judged');
  assert.deepEqual(states[1]!.map(item => item.verificationIntent), original.map(item => item.verificationIntent), 'every other field is untouched');
  // An intent-row (pinned value) correction is never reverted: older states are unreachable.
  const pinned = [events[0]!, { type: 'metadata_correction_applied', itemId: 'CHK-002', field: 'verificationIntent', beforeHash: 'a', afterHash: 'b' }, events[1]!];
  assert.equal(checkpoints(pinned, current).length, 1, 'the chain stops at the intent-row correction');
  // The field changed again after the correction (not by a correction): nothing is reverted.
  const edited = current.map(item => item.id === 'CHK-002' ? { ...item, userSees: `${fixed2} (edited)` } : item);
  assert.equal(checkpoints(events, edited).length, 0, 'a later non-correction edit stops the chain');
});

await check('M4 the routing input reverts an applied userSees correction without a corrected value', () => {
  const original = storeItems();
  const fixed = original[0]!.userSees!.replace(WRONG_SPAN, RIGHT_SPAN);
  const store = { readProcessEvents: () => [applied('CHK-001', 'userSees', original[0]!.userSees!, fixed)] };
  assert.equal(api(metadata, 'routingUserSees')(store, 'B-44a1', fixed, 'CHK-001'), original[0]!.userSees, 'reverted to the judged text');
  assert.equal(api(metadata, 'routingUserSees')(store, 'B-44a1', `${fixed} plus another edit`, 'CHK-001'), `${fixed} plus another edit`, 'any other edit is kept (the reroute stays the safe fallback)');
});

// ---------------------------------------------------------------------------
// X. exact-text gate: same-file helpers that cut the message

const LIT = 'unknown store key';
const REQUEST = ['## Errors', '- Error strings must match exactly:', `  - \`${LIT}: <key>\``].join('\n');

function exactRepo(): { root: string; gaps: (files: Record<string, string>) => Array<{ literal: string; via: string; line?: number }> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run44-exact-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Smoke']);
  git(root, ['config', 'user.email', 'smoke@example.invalid']);
  write(root, 'store/store.go', 'package store\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  return {
    root,
    gaps: files => {
      for (const [rel, text] of Object.entries(files)) write(root, rel, text);
      git(root, ['add', '-A']); git(root, ['commit', '-qm', 'tests']);
      return exactText.exactTextPrefixAssertions({ gitCwd: root, base, requestText: REQUEST }) as Array<{ literal: string; via: string; line?: number }>;
    },
  };
}

const goTest = (compare: string, helper: string[]): string => ['package store', '', 'import (', '\t"strings"', '\t"testing"', ')', '',
  'func TestGetErrors(t *testing.T) {',
  '\ttests := []struct {', '\t\tkey      string', '\t\texpected string', '\t}{',
  `\t\t{"zz", "${LIT}: zz"},`,
  '\t}',
  '\tfor _, tt := range tests {',
  '\t\terr := get(tt.key)',
  `\t\tif ${compare} != tt.expected {`, '\t\t\tt.Errorf("got %q want %q", err, tt.expected)', '\t\t}',
  '\t}',
  '}', '', ...helper, ''].join('\n');

await check('X4 an equality on a same-file helper that returns a cut of its parameter is a prefix comparison (name-independent)', () => {
  const shapes: Array<[string, string[]]> = [
    ['index slice', ['func messageOnly(msg string) string {', '\tif i := strings.Index(msg, "\\n"); i >= 0 {', '\t\treturn msg[:i]', '\t}', '\treturn msg', '}']],
    ['split part', ['func normalize(text string) string {', '\treturn strings.SplitN(text, "\\n\\t", 2)[0]', '}']],
    ['cut head', ['func stripPosition(s string) string {', '\thead, _, _ := strings.Cut(s, "\\n")', '\treturn head', '}']],
  ];
  for (const [label, helper] of shapes) {
    const name = helper[0]!.match(/func (\w+)/)![1]!;
    const repo = exactRepo();
    try {
      const gaps = repo.gaps({ 'store/get_test.go': goTest(`${name}(err.Error())`, helper) });
      assert.equal(gaps.length, 1, `${label}: the helper-cut comparison is a gap: ${JSON.stringify(gaps)}`);
      assert.match(gaps[0]!.via, new RegExp(name), `${label}: the Why names the helper: ${gaps[0]!.via}`);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  }
});

await check('X5 kept clear: a helper that returns its whole (trimmed) parameter, and a cut helper that is not compared', () => {
  const trim = exactRepo();
  try {
    assert.deepEqual(trim.gaps({ 'store/get_test.go': goTest('clean(err.Error())', ['func clean(s string) string {', '\treturn strings.TrimSpace(s)', '}']) }), [], 'a whole-text helper stays exact');
  } finally { rmSync(trim.root, { recursive: true, force: true }); }
  const unused = exactRepo();
  try {
    assert.deepEqual(unused.gaps({ 'store/get_test.go': goTest('err.Error()', ['func messageOnly(msg string) string {', '\treturn msg[:strings.Index(msg, "\\n")]', '}']) }), [], 'a full equality stays exact beside an unused cut helper');
  } finally { rmSync(unused.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// D. duplicate chains close against the root canonical

function findingStore(): { root: string; store: StoryStore; storyId: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run44-dup-')));
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-44d1';
  const now = '2026-10-10T03:00:00.000Z';
  store.writeStory(storyId, { storyId, name: 'store', title: 'Store', description: 'Store.', type: 'feature', phase: 'DEV', priority: 'high',
    createdAt: now, startedAt: now, endedAt: null, events: [] } as unknown as StoryInfo);
  const finding = (n: number, status: string) => ({ id: `${storyId}:F-00${n}`, severity: 'medium', category: 'edge', desc: `write through a nested target is a silent no-op (${n})`,
    files: ['store/store.go'], status, evidenceState: 'verified', agent: 'proof-or-stop-review-quality', createdAt: now });
  store.writeFindings(storyId, { findings: [finding(1, 'resolved'), finding(2, 'open'), finding(3, 'open'), finding(4, 'open'), finding(5, 'open'), finding(6, 'open')] } as never);
  const dup = (n: number, canonical: number) => ({ findingId: `${storyId}:F-00${n}`, disposition: 'duplicate', canonicalFindingId: `${storyId}:F-00${canonical}`, familyKey: 'nested-target', reason: 'same root cause' });
  const data = store.readReviewInventoryEpochs(storyId);
  // F-002 -> F-001 (resolved), F-003 -> F-002, F-004 -> F-003: a chain; F-005 <-> F-006: a cycle.
  data.criticReceipts.push({ findingDispositions: [dup(2, 1), dup(3, 2), dup(4, 3), dup(5, 6), dup(6, 5)] } as never);
  store.writeReviewInventoryEpochs(storyId, data);
  return { root, store, storyId };
}

await check('D a duplicate chain closes against its resolved root canonical; a cycle has no root', () => {
  const { root, store, storyId } = findingStore();
  try {
    const all = store.readFindings(storyId).findings;
    const candidate = (n: number) => (duplicates.duplicateResolveCandidate(store, storyId, all.find(f => f.id === `${storyId}:F-00${n}`)!, all)?.canonical.id) ?? null;
    assert.equal(candidate(2), `${storyId}:F-001`, 'direct duplicate of the resolved canonical');
    assert.equal(candidate(3), `${storyId}:F-001`, 'a duplicate of a duplicate closes against the root');
    assert.equal(candidate(4), `${storyId}:F-001`, 'two links deep: still the root');
    assert.equal(candidate(5), null, 'a cycle has no root canonical');
    assert.equal(api(duplicates, 'duplicateRootOf')(store, storyId, `${storyId}:F-004`), `${storyId}:F-001`, 'duplicateRootOf follows the chain');
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// R. repair brief: the whole defect family

await check('R the finding-repair prompt asks for the whole defect family by grepping the code path, and a [family] line per checked shape', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run44-repair-')));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Bench Owner']);
    git(root, ['config', 'user.email', 'owner@bench.invalid']);
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
    write(root, 'README.md', 'fixture\n');
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'baseline']);
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-44r1';
    const now = '2026-10-10T03:00:00.000Z';
    store.writeStory(storyId, { storyId, name: 'store', title: 'Store', description: 'Store.', type: 'feature', phase: 'DEV', priority: 'high',
      createdAt: now, startedAt: now, endedAt: null, events: [] } as unknown as StoryInfo);
    store.writeChecklist(storyId, { items: storeItems() } as ChecklistData);
    store.writeFindings(storyId, { findings: [{ id: `${storyId}:F-001`, severity: 'medium', category: 'edge', desc: 'put through a nested target (m["a"]["b"] = v) is a silent no-op: only a bare name writes back.',
      files: ['store/store.go'], status: 'open', evidenceState: 'verified', agent: 'proof-or-stop-review-quality', createdAt: now }] } as never);
    const prompt = (createStoryDispatchHandlers({ store, root, scanRoot: root } as never).dispatch({ storyId, agentType: 'proof-or-stop-finding-repair', findingId: 'F-001' }) as { prompt: string }).prompt;
    assert.match(prompt, /grep/i, 'the family is found by grepping the code path');
    assert.match(prompt, /receiver|target|operand/i, 'it names the shapes that share the root cause');
    assert.match(prompt, /\[family\]/, 'the final report lists each checked shape on a [family] line');
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

if (failures.length) {
  console.error(`run44-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('run44-fixes-smoke: PASS');
