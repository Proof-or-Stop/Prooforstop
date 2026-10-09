#!/usr/bin/env node
/**
 * Old-PoS runs 24-29 (bench-staging/oldpos/run28-29-analysis.md §5.1 A and B):
 * catch the defect classes the finding rounds found before REVIEW.
 *
 * A. The DEV implementer prompt carries the probe matrix (operand position x
 *    value class x operation) and the `[probes]` return line; before, only the
 *    finding-repair prompt had the input-variant rule.
 * B. PLAN coverage matrix (core/plan-coverage-matrix.ts): on the real
 *    abs-stepped-slices request and the run 28 / run 29 owner checklists,
 *    next's pre-scope authoring demands the rows whose absence produced
 *    28/F-001, 28/F-002, 29/F-001, 29/F-002 and 29/F-003; a request without
 *    those patterns demands nothing; an excludes entry naming a row's key
 *    excludes it; the scope-plan prompt carries the coverage rule.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { preScopeAuthoringStep } from '../handlers/next-driver.js';
import { planPreScopeBlockers } from '../core/plan-pre-scope-blockers.js';
import { StoryStore } from '../core/store.js';
import { writeStoryRequest } from '../core/story-request.js';
import { ABS_STEPPED_SLICES_REQUEST, RUN28_ITEMS, RUN29_ITEMS, type FixtureItem } from './helpers/abs-stepped-slices-fixture.js';

const STRS_REQUEST = [
  'Implement the string helpers documented in docs/types/string.md:',
  '',
  '- `strs.Upper(s)` returns the upper-case form of `s`, for example `Upper("ab")` is `"AB"`.',
  '- `strs.Reverse(s)` returns `s` reversed by rune, for example `Reverse("héllo")` is `"olléh"`.',
].join('\n');

const root = mkdtempSync(join(tmpdir(), 'catch-earlier-'));
type Gap = { key: string; itemId: string; rule: string; sentences: string[] };
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', testsDir: 'tests', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'catch@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Catch Smoke'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const store = new StoryStore(root);

  const seed = (storyId: string, request: string, items: FixtureItem[], phase = 'PLAN', excludes: Record<string, string[]> = {}): void => {
    store.writeStory(storyId, { storyId, title: 'Stepped slices', description: 'abs stepped slices', phase, priority: 'medium' } as never);
    store.writeChecklist(storyId, { items: items.map(item => ({
      id: item.id, title: item.title, context: 'abs stepped slices', status: 'pending', relatedDocs: [], userSees: `${item.title} works as the request states.`,
      files: { modify: ['evaluator/evaluator.go'], create: [], test: ['evaluator/evaluator_test.go'] },
      ...(excludes[item.id] ? { excludes: excludes[item.id] } : {}),
      verificationIntent: Object.fromEntries((['happy', 'edge', 'adversarial'] as const).map(lane => [lane, item.rows.filter(row => row[0] === lane)
        .map(([, desc], index) => ({ id: `${item.id}:${lane}:${index}`, desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
          verification: { command: 'go test ./evaluator', selector: 'ok' } }))])),
    })) } as never);
    writeStoryRequest(store, { storyId, phase: 'INIT', request, source: 'smoke' });
  };
  const gapsOf = (storyId: string): Gap[] => {
    const blockers = planPreScopeBlockers(store, store.readStory(storyId), { profile: 'balanced' } as never) as unknown as { coverageGaps?: Gap[] };
    assert.ok(Array.isArray(blockers.coverageGaps), `${storyId}: planPreScopeBlockers reports the PLAN coverage rows (coverageGaps)`);
    return blockers.coverageGaps!;
  };
  const keys = (gaps: Gap[]): string[] => gaps.map(gap => gap.key);

  // ---- B on run 29's checklist: every finding of R1 has its row demanded.
  seed('B-c029', ABS_STEPPED_SLICES_REQUEST, RUN29_ITEMS);
  const r29 = gapsOf('B-c029');
  for (const expected of [
    'coverage read or write: form [::]', 'coverage read or write: form [:end:]', // 29/F-001: [::] and [:2:] panic
    'coverage write: multibyte (non-ASCII) text', // 29/F-002: string assignment tested with ASCII only
    'coverage write: negative step', 'coverage write: omitted start', 'coverage write: omitted end', // 29/F-003
    'coverage read: explicit null start', 'coverage read: explicit null end', 'coverage read: explicit null step', // omitted vs explicit null (24/F-005, 28/F-001)
  ]) assert.ok(keys(r29).includes(expected), `run 29: the coverage matrix demands "${expected}"; got ${keys(r29).join(' | ')}`);
  assert.ok(!keys(r29).some(key => /form \[start:end:step\]|form \[::step\]|read: negative step|read: 0 step|via single index/.test(key)),
    `run 29: rows its checklist already has are not demanded: ${keys(r29).join(' | ')}`);
  for (const gap of r29) assert.ok(gap.sentences.length > 0 && gap.sentences.every(sentence => ABS_STEPPED_SLICES_REQUEST.includes(sentence)), `run 29: ${gap.key} lists the request sentences that triggered it`);
  assert.equal(r29.find(gap => gap.key === 'coverage write: negative step')!.itemId, 'CHK-003', 'run 29: the write rows go to the assignment item');
  const r29Mirror = r29.find(gap => gap.key === 'coverage write: negative step')!;
  assert.ok(r29Mirror.sentences.includes('Use the same index-selection semantics as read slicing.'), 'run 29: the write mirror cites the same-semantics sentence');

  // The pre-scope authoring step: one checklist_update per target item, grouped placeholder rows with the request sentence as requestQuote.
  const authoring = preScopeAuthoringStep({ storyId: 'B-c029', phase: 'PLAN' }, planPreScopeBlockers(store, store.readStory('B-c029'), { profile: 'balanced' } as never), store.readChecklist('B-c029').items);
  assert.ok(authoring, 'run 29: next proposes the coverage rows before the scope-plan reviewer');
  assert.match(authoring!.why, /Coverage rows the request demands/, 'run 29: the authoring Why names the coverage rows');
  assert.ok(authoring!.why.includes('"Use the same index-selection semantics as read slicing."'), 'run 29: the Why lists the matched request sentence');
  const update = (authoring!.batch ?? []).find(call => call.cli.command === 'checklist_update' && call.cli.payload.itemId === 'CHK-003');
  const edge = ((update?.cli.payload.verificationIntent as { edge?: Array<Record<string, unknown>> } | undefined)?.edge ?? []);
  const placeholder = edge.find(row => /^<write-mirror:/.test(String(row.desc)));
  assert.ok(placeholder, `run 29: CHK-003 gets a write-mirror placeholder intent: ${JSON.stringify(edge.map(row => row.desc))}`);
  assert.equal((placeholder!.derivation as { requestQuote?: string }).requestQuote, 'Use the same index-selection semantics as read slicing.', 'run 29: the placeholder cites the triggering sentence');
  assert.ok(edge.filter(row => /^</.test(String(row.desc))).length <= 4, 'run 29: placeholders are grouped per rule (4 rules since run 30: exact-text), not one per row');

  // ---- B on run 28's checklist: F-002 (assignment with a non-numeric start panics) and F-001 (explicit null end/step).
  seed('B-c028', ABS_STEPPED_SLICES_REQUEST, RUN28_ITEMS);
  const r28 = gapsOf('B-c028');
  for (const expected of ['coverage write: non-numeric start', 'coverage read: explicit null end', 'coverage read: explicit null step']) {
    assert.ok(keys(r28).includes(expected), `run 28: the coverage matrix demands "${expected}"; got ${keys(r28).join(' | ')}`);
  }
  assert.ok(!keys(r28).includes('coverage write: negative step') && !keys(r28).includes('coverage write: multibyte (non-ASCII) text'),
    `run 28 already has negative-step and multibyte assignment rows: ${keys(r28).join(' | ')}`);
  assert.ok(keys(r28).includes('coverage read or write: form [::]'), `run 28: "non-numeric omitted step [1,2,3][::{}]" is the [::step] form, not [::]: ${keys(r28).join(' | ')}`);

  // The rows written as the owner would: every demanded row then present, nothing left.
  const filled: FixtureItem[] = RUN29_ITEMS.map(item => ({ ...item, rows: [...item.rows] }));
  filled.find(item => item.id === 'CHK-002')!.rows.push(
    ['edge', '[1,2,3][:2:1] and [1,2,3][1::1] read forward'],
    ['edge', '[1,2,3][0:2:], [1,2,3][:2:], [1,2,3][1::] and [1,2,3][::] read like the two-part form'],
    ['edge', '[1,2,3][{}:2:1] on an array keeps index operator not supported: {} on ARRAY'],
    ['edge', '[1,2,3][null:2:1], [1,2,3][0:null:1] and [1,2,3][0:2:null] keep the index-operator / numeric-range errors'],
  );
  filled.find(item => item.id === 'CHK-003')!.rows.push(
    ['edge', 'a=[1,2,3,4,5]; a[::-1]=[5,4,3,2,1] writes backward'],
    ['edge', 'a=[1,2,3]; a[{}:2]=[1], a[0:{}]=[1] and a[0:2:{}]=[1] keep the read-side errors'],
    ['edge', 'a=[1,2,3]; a[0:2:0]=[1] keeps slice step cannot be 0'],
    ['edge', 's="aéb"; s[0:3:2]="éx" writes runes'],
    ['edge', 'a=[1,2,3]; a[null:2:1]=[1], a[0:null:1]=[1], a[0:2:null]=[1] and a[0:2:]=[1,2] keep the read-side results'],
  );
  seed('B-c030', ABS_STEPPED_SLICES_REQUEST, filled);
  // The run-30 rows (stringify, per-form size mismatch / broadcast, exact text) are catch-earlier-run30-smoke's;
  // the run-31 rows (assignment receiver kinds, per-form explicit null writes) request-probes-run31-smoke's.
  assert.deepEqual(keys(gapsOf('B-c030')).filter(key => !/stringify|size mismatch|broadcast|exact text|assignment receiver|explicit null \w+ on \w+ via/.test(key)), [], 'run 29 + the demanded rows: nothing left to demand');

  // An excludes entry naming a row's key excludes it (a row that does not apply).
  seed('B-c031', ABS_STEPPED_SLICES_REQUEST, RUN29_ITEMS, 'PLAN', { 'CHK-002': ['coverage read or write: form [::]: the parser rejects an all-omitted stepped slice by design'] });
  assert.ok(!keys(gapsOf('B-c031')).includes('coverage read or write: form [::]'), 'an excludes entry naming the key excludes the row');

  // A request without the patterns demands nothing (no false-positive blockers).
  seed('B-c032', STRS_REQUEST, [{ id: 'CHK-001', title: 'Upper and Reverse', rows: [['happy', 'Upper("ab") -> "AB"'], ['edge', 'Reverse("héllo") -> "olléh"'], ['adversarial', 'Reverse("") -> ""']] }]);
  assert.deepEqual(keys(gapsOf('B-c032')), [], 'a request without coverage patterns demands no row');

  // The scope-plan prompt carries the coverage rule (judgment form).
  const dispatch = createStoryDispatchHandlers({ root, scanRoot: root, store } as never);
  const scope = dispatch.dispatch({ storyId: 'B-c029', agentType: 'proof-or-stop-review-scope-plan' }).prompt;
  assert.match(scope, /Coverage matrix \(blocking\)/, 'the scope-plan prompt carries the coverage-matrix rule');

  // ---- A: the implementer prompt carries the probe matrix and the [probes] return line.
  seed('B-c033', ABS_STEPPED_SLICES_REQUEST, RUN29_ITEMS, 'DEV');
  const implementer = dispatch.dispatch({ storyId: 'B-c033', itemId: 'CHK-003', agentType: 'proof-or-stop-implementer' }).prompt;
  assert.match(implementer, /Probe matrix before handoff/, 'the implementer prompt carries the probe matrix');
  assert.match(implementer, /explicit null/, 'the matrix names explicit null');
  assert.match(implementer, /aliased/, 'the matrix names an aliased value (29/F-004)');
  assert.match(implementer, /\[probes\]/, 'the implementer reports its probes');
  assert.match(implementer, /Story base: [0-9a-f]{40}|Story base: `git merge-base HEAD main`/, 'the implementer prompt names the Story base for the base probes');
  const start = implementer.indexOf('Probe matrix before handoff');
  const end = implementer.indexOf('\n\n', start);
  console.log(`catch-earlier-smoke: implementer probe matrix section ${Buffer.byteLength(implementer.slice(start, end < 0 ? undefined : end))} bytes; run 29 coverage rows demanded ${r29.length}, run 28 ${r28.length}`);
  console.log('catch-earlier-smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
