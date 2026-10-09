#!/usr/bin/env node
/**
 * Old-PoS run 34 (bench-staging/oldpos/run34-analysis.md §2.1, §4, §5): the
 * detection-neutral fixes that need no full lifecycle fixture. Unit level:
 *
 *   L. review lanes launch slowest-first (static order: docs, test-coverage,
 *      concept, quality; other lanes keep their order after them);
 *   P1. a PLAN exact-text coverage row that carries the request string but
 *      states no exact comparison is reported with that reason and the accepted
 *      wording (run 34 F1: the owner read framework source to find the rule);
 *      the done-time prefix-assertion gap names the accepted comparison too;
 *   P2. the pin-audit deterministic check handles one-character pinned values
 *      (run 34 F2: `includes('f')` / `split('f')` over a row holding "abcdef"
 *      fell back to a full scope-plan rerun);
 *   P3. a DEV-guard refusal whose first line is only "Cannot enter DEV:" is
 *      summarised with its first reason (run 34 F7: the Why was empty), and a
 *      story_review round older than the Story inputs it judged is stale (next
 *      reruns it as a framework step);
 *   H. scope_check_save --help states that features[].excluded_by /
 *      covered_by are required string-or-null values (run 34 F4: help said
 *      `any`, the validator refused a missing key 46 times);
 *   T. the implementer template carries no `[probes]` report contract (it is
 *      the implementation.probeMatrix=on prompt block's; run 34 F6);
 *   B. the shipped bundle (dist outside tasks/, agent templates) carries no
 *      benchmark-task-derived example, helper name or request string (run 34 §5).
 *
 * Usage: node packages/main/dist/tasks/run34-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as coverage from '../core/plan-coverage-matrix.js';
import * as exactText from '../core/exact-text-assertions.js';
import * as pinAudit from '../core/pin-audit-correction.js';
import * as nextDriver from '../handlers/next-driver.js';
import { scopeReviewChecklistDigest } from '../core/scope-check-integrity.js';
import type { ChecklistItem } from '../core/types.js';

type Fn = (...args: unknown[]) => unknown;
const api = (module: object, name: string): Fn => {
  const fn = (module as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `${name} is exported`);
  return fn as Fn;
};
/** A module this lab adds (resolved at run time so the RED build compiles). */
const optional = async (rel: string): Promise<Record<string, unknown>> => {
  try { return await import(String(new URL(rel, import.meta.url))) as Record<string, unknown>; } catch (error) { throw new Error(`${rel} is not available: ${error instanceof Error ? error.message : String(error)}`); }
};
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 3).join(' | ') : String(error)}`); }
}

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(DIST, 'cli.js');
const TEMPLATES = join(DIST, '..', 'templates', 'agents');
const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', ...extra });
const item = (id: string, happy: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): ChecklistItem => ({ id, title: `item ${id}`, status: 'pending',
  verificationIntent: { happy, edge: [], adversarial: [] }, ...extra } as unknown as ChecklistItem);

await check('L lanes launch slowest-first (docs, test-coverage, concept, quality), other lanes after them in their own order', async () => {
  const order = await optional('../core/review-lane-launch-order.js');
  const orderLanes = api(order, 'orderLanesForLaunch');
  const lanes = ['proof-or-stop-review-concept', 'proof-or-stop-review-behavior', 'proof-or-stop-review-quality', 'proof-or-stop-review-test-coverage', 'proof-or-stop-review-docs'];
  assert.deepEqual(orderLanes(lanes), ['proof-or-stop-review-docs', 'proof-or-stop-review-test-coverage', 'proof-or-stop-review-concept', 'proof-or-stop-review-quality', 'proof-or-stop-review-behavior']);
  assert.deepEqual(orderLanes(['proof-or-stop-review-quality', 'proof-or-stop-review-concept']), ['proof-or-stop-review-concept', 'proof-or-stop-review-quality'], 'a subset keeps the static order');
  assert.deepEqual(lanes, ['proof-or-stop-review-concept', 'proof-or-stop-review-behavior', 'proof-or-stop-review-quality', 'proof-or-stop-review-test-coverage', 'proof-or-stop-review-docs'], 'the input is not mutated');
});

const EXACT_REQUEST = [
  'Implement the file loader.',
  '',
  '- Error strings must match exactly:',
  '  - `file not found: path=<path>`',
].join('\n');

await check('P1 PLAN exact-text row: carrying the string without an exact comparison is reported with the reason and the accepted wording', () => {
  const items = [item('CHK-001', [row('load("x") -> file not found: path=x')])];
  const gaps = coverage.planCoverageGapsFor({}, items as never, EXACT_REQUEST) as Array<{ itemId: string; rule: string; key: string }>;
  assert.equal(gaps.length, 1, `one exact-text gap: ${JSON.stringify(gaps)}`);
  const text = coverage.describeCoverageGap(gaps[0] as never);
  assert.match(text, /CHK-001:happy:0 carries the string but states no exact comparison/, `the near-miss row and the reason: ${text}`);
  assert.match(text, /exact\b[^\n]*equals[^\n]*whole error[^\n]*==/, `the accepted wording is listed: ${text}`);
  const placeholder = coverage.coveragePlaceholders(gaps as never, 'CHK-001')[0]!;
  assert.match(placeholder.desc, /say exact|states? (?:an )?exact comparison/i, `the placeholder says how the row must be worded: ${placeholder.desc}`);
  const satisfied = coverage.planCoverageGapsFor({}, [item('CHK-001', [row('load("x") -> exact whole error equals file not found: path=x')])] as never, EXACT_REQUEST) as unknown[];
  assert.equal(satisfied.length, 0, 'the accepted wording clears the gap');
});

await check('P1 done-time exact-text gap names the accepted full-string comparison', () => {
  const text = exactText.describeExactTextGap({ literal: 'file not found: path=', file: 'loader_test.go', test: 'TestLoad', via: 'HasPrefix' });
  assert.match(text, /accepted: [^\n]*(?:==|Equal)/, `accepted comparison named: ${text}`);
});

await check('P2 pin audit: a one-character pinned value inside a longer literal still applies without a rerun', () => {
  const feature = 'pin-audit CHK-003:adversarial:1: pins "a"; request gives "f" (the last character of "abcdef")';
  const judged = [item('CHK-003', [row('first("abcdef") -> "a"')], { verificationIntent: { happy: [row('first("abcdef") -> "a"')], edge: [], adversarial: [row('first("abcdef") -> "f"'), row('last("abcdef") -> "a"')] } })];
  const corrected = structuredClone(judged);
  (corrected[0]!.verificationIntent!.adversarial![1] as { desc: string }).desc = 'last("abcdef") -> "f"';
  const scope = { checklistDigest: scopeReviewChecklistDigest({ items: judged }), features: [{ feature, status: 'gap', covered_by: null, excluded_by: null }] };
  const applied = pinAudit.appliedPinAuditGaps(scope as never, { items: corrected });
  assert.deepEqual([...applied], [feature], 'run 34 F2: the corrected row applies the requested value (no scope-plan rerun)');
  const unquoted = 'pin-audit CHK-003:adversarial:1: pins a; request gives f (the last character)';
  const scope2 = { checklistDigest: scope.checklistDigest, features: [{ feature: unquoted, status: 'gap', covered_by: null, excluded_by: null }] };
  assert.deepEqual([...pinAudit.appliedPinAuditGaps(scope2 as never, { items: corrected })], [unquoted], 'unquoted one-character values too');
  const other = structuredClone(corrected);
  (other[0]!.verificationIntent!.happy![0] as { desc: string }).desc = 'first("abcdef") -> "b"';
  assert.deepEqual([...pinAudit.appliedPinAuditGaps(scope as never, { items: other })], [], 'any other change still reruns the reviewer');
  assert.equal(pinAudit.openPinAuditGaps(scope as never, { items: corrected }).length, 0, 'the applied gap is no longer open');
  assert.equal(pinAudit.openPinAuditGaps(scope as never, { items: judged }).length, 1, 'the uncorrected gap stays open');
});

await check('P3 an empty "Cannot enter DEV:" first line is summarised with its first reason', () => {
  const summary = api(nextDriver, 'guardRefusalSummary');
  const failure = 'Cannot enter DEV:\n  - Latest story_review round has 1 unresolved blocker(s)\nNext: proof-or-stop story_review --storyId=B-1234';
  assert.equal(summary(failure), 'Cannot enter DEV: Latest story_review round has 1 unresolved blocker(s)');
  assert.equal(summary('Cannot enter DEV: the scope-plan reviewer verdict is missing [missing_scope_check]. Next: x'), 'Cannot enter DEV: the scope-plan reviewer verdict is missing [missing_scope_check]. Next: x');
});

await check('P3 a story_review round older than the inputs it judged is stale (next reruns it itself)', async () => {
  const staleness = await optional('../core/story-review-staleness.js');
  const stale = api(staleness, 'storyReviewRoundStale');
  const dir = mkdtempSync(join(tmpdir(), 'run34-review-'));
  try {
    writeFileSync(join(dir, 'checklist.json'), '{}');
    writeFileSync(join(dir, 'scope-check.json'), '{}');
    const older = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'checklist.json'), older, older);
    utimesSync(join(dir, 'scope-check.json'), older, older);
    const round = new Date(Date.now() - 30_000).toISOString();
    assert.equal(stale(dir, null), true, 'no round at all');
    assert.equal(stale(dir, round), false, 'a round newer than every input is current');
    writeFileSync(join(dir, 'scope-check.json'), '{"saved":"later"}');
    assert.equal(stale(dir, round), true, 'a scope verdict saved after the round stales it (run 34 F7)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check('H scope_check_save --help: excluded_by / covered_by are required string-or-null', () => {
  const work = mkdtempSync(join(tmpdir(), 'run34-help-'));
  try {
    const help = spawnSync(process.execPath, [CLI, 'scope_check_save', '--help'], { cwd: work, encoding: 'utf8' });
    const text = `${help.stdout}${help.stderr}`;
    assert.match(text, /features\[\]\.excluded_by: string\|null/, `excluded_by: ${text.split('\n').find(line => line.includes('excluded_by'))}`);
    assert.match(text, /features\[\]\.covered_by: string\|null/, 'covered_by too');
    assert.doesNotMatch(text, /features\[\]\.excluded_by\?/, 'not shown optional');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

await check('T the implementer template carries no [probes] report contract (probeMatrix off by default)', () => {
  const template = readFileSync(join(TEMPLATES, 'proof-or-stop-implementer.md'), 'utf8');
  assert.doesNotMatch(template, /\[probes\]/, 'run 34 F6: the implementer improvised a [probes] line 7 times');
  assert.match(template, /\[intent-conflict\]/, 'the intent-conflict contract stays');
});

/** Benchmark-task fragments (run 34 §5) that must not ship: examples, helper names, request strings. */
const TASK_FRAGMENTS = ['logErrorWithPosition', 'range assignment size mismatch', 'myArray', '[::-1]', '[::2]', '[1::2]', '[:4:2]', '[0:101:2]', '[:101:2]', '[a:b:c]',
  'h.s[', 'a[0][i]', 'f()[i]', 'read slicing', 'evaluator.go', 'hooo', 'aébcd', 'abs Go task', 'steppedIndexes', 'stepped slice', 'value[:end:step]', 'value[::step]'];

await check('B the shipped bundle carries no benchmark-task fragment', () => {
  const hits: string[] = [];
  const scan = (path: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) { if (name !== 'tasks') scan(full); continue; }
      if (!/\.(?:js|mjs|md|json)$/.test(name) || /\.map$/.test(name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const fragment of TASK_FRAGMENTS) if (text.includes(fragment)) hits.push(`${relative(join(DIST, '..'), full)}: ${fragment}`);
    }
  };
  scan(DIST);
  scan(TEMPLATES);
  assert.deepEqual(hits, [], `task-derived fragments ship in the bundle:\n${hits.slice(0, 40).join('\n')}${hits.length > 40 ? `\n+${hits.length - 40} more` : ''}`);
});

void mkdirSync;
if (failures.length) {
  console.log(`run34-fixes-smoke: FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('run34-fixes-smoke: PASS');
