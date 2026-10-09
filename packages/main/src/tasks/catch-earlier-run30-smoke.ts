#!/usr/bin/env node
/**
 * Old-PoS run 30 (abs-stepped-slices, B-c201): four R1 findings that the
 * run 24-29 checks (implementer probe matrix, PLAN coverage matrix) missed.
 *
 *   F-001 tests asserted request-quoted exact error strings with a prefix
 *         helper (logErrorWithPosition / strings.HasPrefix).
 *   F-002 three-part array assignment had no size-mismatch / broadcast test
 *         (the two-part form had both).
 *   F-003 stringification of `[:101:2]` untested (only runtime rows were
 *         demanded per omission pattern).
 *   F-004 explicit step 1 took the legacy two-part path (`[-4:-1:1]` clamped);
 *         the probe matrix had no "explicit value equal to the default" class,
 *         and probed rows needed no test.
 *
 * A. The implementer probe matrix names the explicit-default class, requires
 *    a test for every decided row, and the `[probes]` line separates tested
 *    from probed-only rows; a probed-only decided row reopens the item once
 *    before REVIEW (core/request-authority.ts probeTestGaps; harness NPT).
 * B. PLAN coverage matrix: stringify rows per request-listed omission pattern
 *    when the request specifies printed forms; per-form size mismatch /
 *    broadcast rows for enumerated assignment forms; exact-text rows when the
 *    request quotes strings that must match exactly. Requests without those
 *    patterns demand nothing.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as requestAuthority from '../core/request-authority.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { preScopeAuthoringStep } from '../handlers/next-driver.js';
import { planPreScopeBlockers } from '../core/plan-pre-scope-blockers.js';
import { StoryStore } from '../core/store.js';
import { writeStoryRequest } from '../core/story-request.js';
import { ABS_STEPPED_SLICES_REQUEST, RUN27_ITEMS, RUN28_ITEMS, RUN29_ITEMS, RUN30_ITEMS, type FixtureItem } from './helpers/abs-stepped-slices-fixture.js';

const STRS_REQUEST = [
  'Implement the string helpers documented in docs/types/string.md:',
  '',
  '- `strs.Upper(s)` returns the upper-case form of `s`, for example `Upper("ab")` is `"AB"`.',
  '- `strs.Reverse(s)` returns `s` reversed by rune, for example `Reverse("héllo")` is `"olléh"`.',
].join('\n');

/** Error strings quoted with "starts with" only, a stringify sentence without an omittable syntax: no run-30 rows. */
const PREFIX_ONLY_REQUEST = [
  'Add a `clamp(x, lo, hi)` builtin.',
  '',
  '- A non-numeric argument must raise an error that starts with: `clamp expects NUMBER`.',
  '- The AST stringification of `clamp(1, 2, 3)` is `clamp(1, 2, 3)`.',
].join('\n');

/** Exact strings quoted with no index syntax: only the exact-text rows. */
const EXACT_ONLY_REQUEST = [
  'Add a `clamp(x, lo, hi)` builtin.',
  '',
  '- Error strings must match exactly:',
  '  - Non-numeric argument:',
  '    - `clamp expects NUMBER, got <TYPE>`',
  '  - Bounds out of order:',
  '    - `clamp bounds out of order: lo=<L> hi=<H>`',
  '- Other errors keep the existing format.',
].join('\n');

const EXACT_STRINGS = [
  'range assignment size mismatch: target=<X> value=<Y>',
  'range assignment expects STRING value, got <TYPE>',
  'index assignment expects single-character STRING value, got <N> characters',
];

const root = mkdtempSync(join(tmpdir(), 'catch-earlier-run30-'));
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

  const seed = (storyId: string, request: string, items: FixtureItem[], phase = 'PLAN'): void => {
    store.writeStory(storyId, { storyId, title: 'Stepped slices', description: 'abs stepped slices', phase, priority: 'medium' } as never);
    store.writeChecklist(storyId, { items: items.map(item => ({
      id: item.id, title: item.title, context: 'abs stepped slices', status: 'pending', relatedDocs: [], userSees: `${item.title} works as the request states.`,
      files: { modify: ['evaluator/evaluator.go'], create: [], test: ['evaluator/evaluator_test.go'] },
      verificationIntent: Object.fromEntries((['happy', 'edge', 'adversarial'] as const).map(lane => [lane, item.rows.filter(row => row[0] === lane)
        .map(([, desc], index) => ({ id: `${item.id}:${lane}:${index}`, desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
          verification: { command: 'go test ./evaluator', selector: 'ok' } }))])),
    })) } as never);
    writeStoryRequest(store, { storyId, phase: 'INIT', request, source: 'smoke' });
  };
  const gapsOf = (storyId: string): Gap[] => (planPreScopeBlockers(store, store.readStory(storyId), { profile: 'balanced' } as never) as unknown as { coverageGaps: Gap[] }).coverageGaps;
  const keys = (gaps: Gap[]): string[] => gaps.map(gap => gap.key);
  const exactKey = (text: string): string => `coverage exact text: "${text}"`;

  // ---- B on run 30's checklist: each of F-001..F-003 has its row demanded.
  seed('B-d030', ABS_STEPPED_SLICES_REQUEST, RUN30_ITEMS);
  const r30 = gapsOf('B-d030');
  for (const expected of [
    'coverage stringify: form [:end:step]', // F-003: [:101:2] stringify untested
    'coverage write: size mismatch on array via three-part range', 'coverage write: broadcast on array via three-part range', // F-002
    ...EXACT_STRINGS.map(exactKey), // F-001: prefix-match assertions
  ]) assert.ok(keys(r30).includes(expected), `run 30: the coverage matrix demands "${expected}"; got ${keys(r30).join(' | ')}`);
  assert.ok(!keys(r30).some(key => /stringify: form \[(?:start:end:step|start::step|::step)\]|size mismatch on array via two-part|broadcast on array via two-part|broadcast on string via (?:two|three)-part/.test(key)),
    `run 30: rows its checklist already has are not demanded: ${keys(r30).join(' | ')}`);
  assert.ok(!keys(r30).some(key => /exact text: "slice step cannot be 0"|index operator not supported|index ranges can only be numerical/.test(key)),
    `run 30: "starts with" and "keep the existing format" strings are not exact-text rows: ${keys(r30).join(' | ')}`);
  for (const gap of r30) assert.ok(gap.sentences.length > 0 && gap.sentences.every(sentence => ABS_STEPPED_SLICES_REQUEST.includes(sentence)), `run 30: ${gap.key} lists the request sentences that triggered it`);
  assert.ok(r30.find(gap => gap.key === 'coverage stringify: form [:end:step]')!.sentences.some(sentence => /stringification/.test(sentence)), 'run 30: the stringify row cites the stringification sentence');
  assert.ok(r30.find(gap => gap.key === exactKey(EXACT_STRINGS[0]!))!.sentences.some(sentence => /must match exactly/.test(sentence)), 'run 30: the exact-text row cites the exact-match sentence');
  assert.equal(r30.find(gap => gap.key === 'coverage write: broadcast on array via three-part range')!.itemId, 'CHK-004', 'run 30: the array assignment rows go to the array assignment item');

  // The pre-scope authoring step: grouped placeholders, the exact-text one demands an exact-match assertion.
  const authoring = preScopeAuthoringStep({ storyId: 'B-d030', phase: 'PLAN' }, planPreScopeBlockers(store, store.readStory('B-d030'), { profile: 'balanced' } as never), store.readChecklist('B-d030').items);
  assert.ok(authoring, 'run 30: next proposes the coverage rows before the scope-plan reviewer');
  const placeholders = (authoring!.batch ?? []).flatMap(call => ['happy', 'edge', 'adversarial']
    .flatMap(lane => ((call.cli.payload.verificationIntent as Record<string, Array<Record<string, unknown>>> | undefined)?.[lane] ?? []))
    .map(row => String(row.desc)).filter(desc => desc.startsWith('<')));
  const exactPlaceholder = placeholders.find(desc => desc.startsWith('<exact-text:'));
  assert.ok(exactPlaceholder && /exact|equal/i.test(exactPlaceholder) && /prefix/i.test(exactPlaceholder), `run 30: the exact-text placeholder asks for an exact-match (not prefix) assertion: ${JSON.stringify(placeholders)}`);

  // Rows written as the owner would: nothing left.
  const filled: FixtureItem[] = RUN30_ITEMS.map(item => ({ ...item, rows: [...item.rows] }));
  filled.find(item => item.id === 'CHK-001')!.rows.push(['edge', 'myArray[:101:2] -> (myArray[:101:2]) and myArray[99::2] -> (myArray[99::2])']);
  filled.find(item => item.id === 'CHK-004')!.rows.push(
    ['edge', 'a=[0,1,2,3,4,5]; a[1:6:2]=[9] -> exact error equals range assignment size mismatch: target=3 value=1'],
    ['edge', 'a=[0,1,2,3,4,5]; a[1:6:2]=9; a -> [0,9,2,9,4,9]'],
  );
  filled.find(item => item.id === 'CHK-005')!.rows.push(
    ['edge', 's = "abcdef"; s[1:6:2] = "XY" -> exact error equals range assignment size mismatch: target=3 value=2'],
    ['edge', 's = "abc"; s[1:2] = 9 -> exact error equals range assignment expects STRING value, got NUMBER'],
    ['edge', 's = "abc"; s[1] = "xy" -> exact error equals index assignment expects single-character STRING value, got 2 characters'],
  );
  seed('B-d031', ABS_STEPPED_SLICES_REQUEST, filled);
  assert.deepEqual(keys(gapsOf('B-d031')).filter(key => /stringify|size mismatch|broadcast|exact text/.test(key)), [], 'run 30 + the demanded rows: no run-30 row left');

  // No false positives: requests without these patterns demand none of the new rows.
  seed('B-d032', STRS_REQUEST, [{ id: 'CHK-001', title: 'Upper and Reverse', rows: [['happy', 'Upper("ab") -> "AB"'], ['edge', 'Reverse("héllo") -> "olléh"'], ['adversarial', 'Reverse("") -> ""']] }]);
  assert.deepEqual(keys(gapsOf('B-d032')), [], 'a request without coverage patterns demands no row');
  seed('B-d033', PREFIX_ONLY_REQUEST, [{ id: 'CHK-001', title: 'clamp', rows: [['happy', 'clamp(5, 1, 3) -> 3'], ['edge', 'clamp({}, 1, 3) -> error starts with clamp expects NUMBER'], ['adversarial', 'clamp(1, 2, 3) stringifies to clamp(1, 2, 3)']] }]);
  assert.deepEqual(keys(gapsOf('B-d033')), [], `"starts with" strings and a stringify sentence without an omittable syntax demand nothing: ${keys(gapsOf('B-d033')).join(' | ')}`);
  seed('B-d034', EXACT_ONLY_REQUEST, [{ id: 'CHK-001', title: 'clamp', rows: [['happy', 'clamp(5, 1, 3) -> 3'], ['edge', 'clamp({}, 1, 3) -> clamp expects NUMBER, got HASH'], ['adversarial', 'clamp(1, 3, 2) -> exact error equals clamp bounds out of order: lo=3 hi=2']] }]);
  assert.deepEqual(keys(gapsOf('B-d034')), [exactKey('clamp expects NUMBER, got <TYPE>')], `exact strings: only the one without an exact-match intent is demanded: ${keys(gapsOf('B-d034')).join(' | ')}`);

  // Measurement: rows the run-30 rules add per run checklist.
  const added: string[] = [];
  for (const [run, items] of [['27', RUN27_ITEMS], ['28', RUN28_ITEMS], ['29', RUN29_ITEMS], ['30', RUN30_ITEMS]] as const) {
    seed(`B-d1${run}`, ABS_STEPPED_SLICES_REQUEST, items);
    const all = keys(gapsOf(`B-d1${run}`));
    added.push(`run ${run}: ${all.filter(key => /stringify|size mismatch|broadcast|exact text/.test(key)).length} new of ${all.length}`);
  }

  // The scope-plan prompt's judgment form names the new checks.
  const dispatch = createStoryDispatchHandlers({ root, scanRoot: root, store } as never);
  const scope = dispatch.dispatch({ storyId: 'B-d030', agentType: 'proof-or-stop-review-scope-plan' }).prompt;
  assert.match(scope, /Coverage matrix \(blocking\)[^\n]*stringif[^\n]*broadcast[^\n]*exact/i, 'the scope-plan coverage rule names stringify, per-form broadcast and exact text');

  // ---- A: probe matrix and the [probes] report.
  seed('B-d035', ABS_STEPPED_SLICES_REQUEST, RUN30_ITEMS, 'DEV');
  const implementer = dispatch.dispatch({ storyId: 'B-d035', itemId: 'CHK-002', agentType: 'proof-or-stop-implementer' }).prompt;
  assert.match(implementer, /explicit value equal to the default \(e\.g\. step 1, start 0/, 'the probe matrix names the explicit-default class (F-004)');
  assert.match(implementer, /needs a test, not only a probe/, 'a decided row needs a test');
  assert.match(implementer, /\[probes\][^\n]*tested: [^\n]*probed-only: /, 'the [probes] line separates tested from probed-only rows');
  // An item whose intent quotes an error string gets the exact-output section.
  seed('B-d036', ABS_STEPPED_SLICES_REQUEST, [{ id: 'CHK-001', title: 'Assign array range slices', rows: [['happy', 'a[1:4]=[9] fails with `range assignment size mismatch: target=3 value=1`']] }], 'DEV');
  const withExact = dispatch.dispatch({ storyId: 'B-d036', itemId: 'CHK-001', agentType: 'proof-or-stop-implementer' }).prompt;
  assert.match(withExact, /compares it exactly, not a prefix/i, 'the exact-output section asks for exact (not prefix) assertions');

  const parse = (requestAuthority as unknown as { parseProbeReport?: (text: string) => { present: boolean; probedOnly: string | null } }).parseProbeReport;
  assert.equal(typeof parse, 'function', 'request-authority exports parseProbeReport');
  assert.deepEqual(parse!('done\n[probes] 5 rows run on base and change; changed: a[1:6:2]=9 base error -> broadcast; tested: none; probed-only: a[1:6:2]=9 broadcast (three-part); crashes: none'),
    { present: true, probedOnly: 'a[1:6:2]=9 broadcast (three-part)' }, 'parseProbeReport reads the probed-only rows');
  assert.deepEqual(parse!('[probes] 5 rows run on base and change; changed: none; tested: none; probed-only: none; crashes: none'), { present: true, probedOnly: null }, 'probed-only none');
  assert.deepEqual(parse!('Completed CHK-001.'), { present: false, probedOnly: null }, 'no [probes] line');

  const gaps = (requestAuthority as unknown as { probeTestGaps?: (runs: Array<{ runId: string; itemId: string; createdAt: string; text: string }>, done: ReadonlySet<string>) => Array<{ itemId: string; runId: string; probedOnly: string }> }).probeTestGaps;
  assert.equal(typeof gaps, 'function', 'request-authority exports probeTestGaps');
  const untested = '[probes] 5 rows run on base and change; changed: x; tested: none; probed-only: a[1:6:2]=9 broadcast; crashes: none';
  const tested = '[probes] 5 rows run on base and change; changed: x; tested: a[1:6:2]=9 broadcast; probed-only: none; crashes: none';
  assert.deepEqual(gaps!([{ runId: 'r1', itemId: 'CHK-004', createdAt: '1', text: untested }], new Set(['CHK-004'])), [{ itemId: 'CHK-004', runId: 'r1', probedOnly: 'a[1:6:2]=9 broadcast' }], 'a done item whose latest run left decided rows untested is a gap');
  assert.deepEqual(gaps!([{ runId: 'r1', itemId: 'CHK-004', createdAt: '1', text: untested }], new Set()), [], 'an item not done yet is no gap (the run is not finished with it)');
  assert.deepEqual(gaps!([{ runId: 'r1', itemId: 'CHK-004', createdAt: '1', text: untested }, { runId: 'r2', itemId: 'CHK-004', createdAt: '2', text: tested }], new Set(['CHK-004'])), [], 'a later run that tested the rows closes the gap');
  assert.deepEqual(gaps!([{ runId: 'r1', itemId: 'CHK-004', createdAt: '1', text: untested }, { runId: 'r2', itemId: 'CHK-004', createdAt: '2', text: untested }], new Set(['CHK-004'])), [],
    'a relaunch that reports the same probed-only rows made no progress: no second reopen (REVIEW judges them)');

  // Test-coverage lane rubric: prefix / contains assertions of request-quoted exact strings are a finding (only when the request quotes them).
  const lane = requestAuthority.renderReviewRequestAuthority(store, 'B-d030', { lane: 'proof-or-stop-review-test-coverage' } as never).join('\n');
  assert.match(lane, /Exact-text rubric[^\n]*range assignment size mismatch: target=<X> value=<Y>[^\n]*prefix[^\n]*finding/, 'the test-coverage lane gets the exact-text rubric with the request strings');
  assert.doesNotMatch(lane, /slice step cannot be 0`[^\n]*prefix/, 'a "starts with" string is not in the exact-text rubric');
  assert.doesNotMatch(requestAuthority.renderReviewRequestAuthority(store, 'B-d030', { lane: 'proof-or-stop-review-quality' } as never).join('\n'), /Exact-text rubric/, 'other lanes do not get it');
  assert.doesNotMatch(requestAuthority.renderReviewRequestAuthority(store, 'B-d032', { lane: 'proof-or-stop-review-test-coverage' } as never).join('\n'), /Exact-text rubric/, 'a request without exact strings adds nothing');

  console.log(`catch-earlier-run30-smoke: ${added.join('; ')}`);
  console.log('catch-earlier-run30-smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
