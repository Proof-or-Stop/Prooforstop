#!/usr/bin/env node
/**
 * Old-PoS run 40 (bench-staging/oldpos/run40-analysis.md §2 N1-N4, §4, §5;
 * run38-a3-analysis.md §3): unit level, with real git repositories where Git is
 * involved. Generic examples only (no benchmark-task material).
 *
 *   E. Exact-text gate, operand / row level (N2, run 38 §3):
 *      E1 a test function whose table compares one literal's row exactly (a
 *         wrapper-typed row, its own switch branch) and other rows through a
 *         prefix helper: the exactly compared literal is clear, the prefix row
 *         is a gap that names its own row line;
 *      E2 a helper that compares the expected text with equality and checks a
 *         position line with a prefix API compares it exactly (clear);
 *      E3 true positives stay: HasPrefix(got, want) directly, through a helper,
 *         on the literal itself, and an equality on a slice of the text;
 *      E4 two tables in one function: each literal is judged by its own table's
 *         loop; a keyed field decides which comparison applies to its row;
 *      E5 full equality, TrimSuffix + equality, Contains on another value beside
 *         an exact equality: clear; JS / Python forms.
 *   G. PLAN guard after a current story_review round (N3): the step lists the
 *      round's blockers and names `next --run` (which reruns story_review and the
 *      scope-plan reviewer itself), never a hand-run story_review; the scope_gap
 *      remedy names `next --run`, not a hand-launched host_run.
 *   I. INIT (N4): a schema-enum refusal of story_create (row `type`) stages the
 *      payload and names ONE `story_create @<file>` Next with the allowed values;
 *      the story_create template step lists the row type values.
 *   D. Delivery (sink 5): the delivery_check_set skeleton for the Story and the
 *      canonical report commands are rendered for the delivery prompt.
 *   B. Bundle hygiene (§4): no run-history marker in shipped code outside
 *      comments, the comment strip of the benchmark bundle removes the rest and
 *      keeps every identity boundary valid, and the coverage matrix code carries
 *      no task-family vocabulary.
 *
 * Usage: node packages/main/dist/tasks/run40-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as exactText from '../core/exact-text-assertions.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ChecklistItem, StoryInfo } from '../core/types.js';
import { writeStoryRequest } from '../core/story-request.js';
import { createMainRegistry } from '../registry.js';
import { createNextDriver, type NextStep, storyCreateTemplateStep } from '../handlers/next-driver.js';
import { createReferenceNextDriver } from './helpers/next-driver-reference.js';
import { createScopeCheckHandlers } from '../handlers/scope-check.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';
import * as deliveryPack from '../handlers/delivery-context-pack.js';

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

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(DIST, 'cli.js');
const PACKAGE_ROOT = join(DIST, '..');
const PROJECT_ROOT = join(PACKAGE_ROOT, '..', '..');
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// ---------------------------------------------------------------------------
// E. exact-text gate

const LIT_EXACT = 'empty input not allowed';
const LIT_PREFIX = 'unknown option name';
const LIT_THIRD = 'config file missing';
const REQUEST = [
  '## Errors',
  '- Error strings must match exactly:',
  `  - \`${LIT_EXACT}: <field>\``,
  `  - \`${LIT_PREFIX}: <name>\``,
  `  - \`${LIT_THIRD}: <path>\``,
].join('\n');

function exactRepo(): { root: string; base: string; commit: (files: Record<string, string>) => void; gaps: () => Array<{ literal: string; file: string; test: string; via: string; line?: number }> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run40-exact-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Smoke']);
  git(root, ['config', 'user.email', 'smoke@example.invalid']);
  write(root, 'cfg/cfg.go', 'package cfg\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  return {
    root, base,
    commit: files => { for (const [rel, text] of Object.entries(files)) write(root, rel, text); git(root, ['add', '-A']); git(root, ['commit', '-qm', 'tests']); },
    gaps: () => exactText.exactTextPrefixAssertions({ gitCwd: root, base, requestText: REQUEST }) as Array<{ literal: string; file: string; test: string; via: string; line?: number }>,
  };
}

const GO_HELPERS = [
  'package cfg', '', 'import (', '\t"strings"', '\t"testing"', ')', '',
  'type exactMessage string', '',
  'func assertErrorPrefix(t *testing.T, got string, want string) {', '\tif !strings.HasPrefix(got, want) {', '\t\tt.Errorf("got %q want prefix %q", got, want)', '\t}', '}', '',
  'func assertValue(t *testing.T, got string, want string) {', '\tif got != want {', '\t\tt.Errorf("got %q want %q", got, want)', '\t}', '}', '',
  // Run 38 shape: exact first line, a prefix check on the position line only.
  'func assertExactWithPosition(t *testing.T, got string, want string) {', '\tlines := strings.SplitN(got, "\\n", 2)',
  '\tif lines[0] != want {', '\t\tt.Errorf("got %q want %q", lines[0], want)', '\t}',
  '\tif len(lines) < 2 || !strings.HasPrefix(lines[1], "\\tat line ") {', '\t\tt.Errorf("no position line in %q", got)', '\t}', '}', '',
].join('\n');

await check('E1 row level: a wrapper-typed row compared exactly in its own branch is clear; the prefix-helper row is a gap naming its row', () => {
  const repo = exactRepo();
  try {
    repo.commit({
      'cfg/helpers_test.go': GO_HELPERS,
      'cfg/load_test.go': [
        'package cfg', '', 'import "testing"', '',
        'func TestLoadErrors(t *testing.T) {',
        '\ttests := []struct {', '\t\tinput    string', '\t\texpected interface{}', '\t}{',
        '\t\t{"a=1", "1"},',
        `\t\t{"", exactMessage("${LIT_EXACT}: input")},`,
        `\t\t{"--x", "${LIT_PREFIX}: x"},`,
        '\t}',
        '\tfor _, tt := range tests {',
        '\t\tresult, err := load(tt.input)',
        '\t\tswitch expected := tt.expected.(type) {',
        '\t\tcase exactMessage:',
        '\t\t\tif err == nil || err.Error() != string(expected) {',
        '\t\t\t\tt.Errorf("got %v want %q", err, expected)',
        '\t\t\t}',
        '\t\tcase string:',
        '\t\t\tif err != nil {',
        '\t\t\t\tassertErrorPrefix(t, err.Error(), expected)',
        '\t\t\t} else {',
        '\t\t\t\tassertValue(t, result, expected)',
        '\t\t\t}',
        '\t\t}',
        '\t}',
        '}', '',
      ].join('\n'),
    });
    const gaps = repo.gaps();
    assert.ok(!gaps.some(gap => gap.literal.startsWith(LIT_EXACT)), `the exactly compared row is not a gap (run 40 N2 false positive): ${JSON.stringify(gaps)}`);
    const prefix = gaps.find(gap => gap.literal.startsWith(LIT_PREFIX));
    assert.ok(prefix, `the prefix-helper row is still a gap: ${JSON.stringify(gaps)}`);
    assert.equal(prefix!.via, 'assertErrorPrefix');
    assert.equal(prefix!.line, 12, `the gap names the literal's own row line: ${JSON.stringify(prefix)}`);
    assert.match(exactText.describeExactTextGap(prefix as never), /cfg\/load_test\.go:12/, 'the Why names the row');
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

await check('E2 a helper with exact equality of the expected text plus a prefix check on the position line compares it exactly', () => {
  const repo = exactRepo();
  try {
    repo.commit({
      'cfg/helpers_test.go': GO_HELPERS,
      'cfg/pos_test.go': [
        'package cfg', '', 'import "testing"', '',
        'func TestPositionErrors(t *testing.T) {',
        '\ttests := []struct{ input, want string }{',
        `\t\t{"", "${LIT_EXACT}: input"},`,
        '\t}',
        '\tfor _, tt := range tests {',
        '\t\t_, err := load(tt.input)',
        '\t\tassertExactWithPosition(t, err.Error(), tt.want)',
        '\t}',
        '}', '',
      ].join('\n'),
    });
    assert.deepEqual(repo.gaps(), [], 'exact first line + HasPrefix on the position line is an exact comparison of the request text');
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

await check('E3 true positives stay flagged: HasPrefix(got, want) directly and via a helper, on the literal itself, and an equality on a slice of the text', () => {
  const repo = exactRepo();
  try {
    repo.commit({
      'cfg/helpers_test.go': GO_HELPERS,
      'cfg/prefix_test.go': [
        'package cfg', '', 'import (', '\t"strings"', '\t"testing"', ')', '',
        'func TestDirectPrefix(t *testing.T) {',
        '\ttests := []struct{ input, want string }{',
        `\t\t{"", "${LIT_EXACT}: input"},`,
        '\t}',
        '\tfor _, tt := range tests {',
        '\t\t_, err := load(tt.input)',
        '\t\tif !strings.HasPrefix(err.Error(), tt.want) {',
        '\t\t\tt.Fatal(err)',
        '\t\t}',
        '\t}',
        '}', '',
        'func TestHelperPrefix(t *testing.T) {',
        '\t_, err := load("--x")',
        `\tassertErrorPrefix(t, err.Error(), "${LIT_PREFIX}: x")`,
        '}', '',
        'func TestSlicedEquality(t *testing.T) {',
        `\twant := "${LIT_THIRD}: /x"`,
        '\t_, err := load("/x")',
        '\tif got := err.Error(); got[:len(want)] != want {',
        '\t\tt.Fatal(got)',
        '\t}',
        '}', '',
      ].join('\n'),
    });
    const gaps = repo.gaps();
    const byLiteral = (literal: string) => gaps.find(gap => gap.literal.startsWith(literal));
    assert.equal(byLiteral(LIT_EXACT)?.via, 'HasPrefix', `direct HasPrefix(got, tt.want): ${JSON.stringify(gaps)}`);
    assert.equal(byLiteral(LIT_PREFIX)?.via, 'assertErrorPrefix', `helper prefix on the literal: ${JSON.stringify(gaps)}`);
    assert.ok(byLiteral(LIT_THIRD), `an equality on got[:len(want)] compares a prefix: ${JSON.stringify(gaps)}`);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

await check('E4 two tables in one function and keyed fields: each literal is judged by its own row', () => {
  const repo = exactRepo();
  try {
    repo.commit({
      'cfg/helpers_test.go': GO_HELPERS,
      'cfg/tables_test.go': [
        'package cfg', '', 'import "testing"', '',
        'func TestTables(t *testing.T) {',
        '\texactTests := []struct{ input, want string }{',
        `\t\t{"", "${LIT_EXACT}: input"},`,
        '\t}',
        '\tfor _, tt := range exactTests {',
        '\t\t_, err := load(tt.input)',
        '\t\tif err.Error() != tt.want {',
        '\t\t\tt.Fatal(err)',
        '\t\t}',
        '\t}',
        '\tprefixTests := []struct{ input, want string }{',
        `\t\t{"--x", "${LIT_PREFIX}: x"},`,
        '\t}',
        '\tfor _, tt := range prefixTests {',
        '\t\t_, err := load(tt.input)',
        '\t\tassertErrorPrefix(t, err.Error(), tt.want)',
        '\t}',
        '}', '',
        'func TestKeyed(t *testing.T) {',
        '\ttests := []struct{ input, exact, prefix string }{',
        `\t\t{input: "/x", exact: "${LIT_THIRD}: /x"},`,
        `\t\t{input: "--y", prefix: "${LIT_PREFIX}: y"},`,
        '\t}',
        '\tfor _, tt := range tests {',
        '\t\t_, err := load(tt.input)',
        '\t\tif tt.exact != "" && err.Error() != tt.exact {',
        '\t\t\tt.Fatal(err)',
        '\t\t}',
        '\t\tif tt.prefix != "" {',
        '\t\t\tassertErrorPrefix(t, err.Error(), tt.prefix)',
        '\t\t}',
        '\t}',
        '}', '',
      ].join('\n'),
    });
    const gaps = repo.gaps();
    assert.deepEqual(gaps.map(gap => gap.literal.split(':')[0]).sort(), [LIT_PREFIX], `only the prefix-table / prefix-field literal is a gap: ${JSON.stringify(gaps)}`);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

await check('E5 full equality, TrimSuffix + equality, a Contains on another value beside an exact equality, JS and Python forms', () => {
  const repo = exactRepo();
  try {
    repo.commit({
      'cfg/helpers_test.go': GO_HELPERS,
      'cfg/exact_test.go': [
        'package cfg', '', 'import (', '\t"strings"', '\t"testing"', ')', '',
        'func TestFull(t *testing.T) {',
        `\twant := "${LIT_EXACT}: input"`,
        '\t_, err := load("")',
        '\tif got := err.Error(); got != want+"\\n\\tat line 1" {',
        '\t\tt.Fatal(got)',
        '\t}',
        '}', '',
        'func TestTrimmed(t *testing.T) {',
        '\t_, err := load("--x")',
        `\tif strings.TrimSuffix(err.Error(), "\\n") != "${LIT_PREFIX}: x" {`,
        '\t\tt.Fatal(err)',
        '\t}',
        '\tif !strings.Contains(err.Error(), "line") {',
        '\t\tt.Fatal(err)',
        '\t}',
        '}', '',
      ].join('\n'),
      'web/load.test.js': [
        "test('missing config', () => {",
        `  expect(() => load('/x')).toThrow();`,
        `  expect(errorOf('/x').message).toBe('${LIT_THIRD}: /x');`,
        '});', '',
      ].join('\n'),
    });
    assert.deepEqual(repo.gaps(), [], 'every literal has an exact comparison');
    repo.commit({
      'tools/test_load.py': [
        'def test_prefix():',
        `    assert "${LIT_THIRD}: /y" in str(load_error("/y"))`, '',
      ].join('\n'),
    });
    assert.deepEqual(repo.gaps(), [], 'one exact comparison of a literal anywhere still clears it');
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
  const py = exactRepo();
  try {
    py.commit({ 'tools/test_load.py': ['def test_prefix():', `    assert "${LIT_THIRD}: /y" in str(load_error("/y"))`, '', 'def test_value():', '    assert load("a") == 1', ''].join('\n') });
    assert.equal(py.gaps().find(gap => gap.literal.startsWith(LIT_THIRD))?.via, 'in', 'Python `assert <literal> in <text>` is a contains comparison');
  } finally { rmSync(py.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// G. PLAN guard after a current story_review round; scope_gap remedy

const G_REQUEST = [
  '## Text helpers',
  '- `Upper(s)` returns the upper-case form of `s`, for example `Upper("ab")` is `"AB"`.',
  '- `Reverse(s)` returns `s` reversed, for example `Reverse("ab")` is `"ba"`.',
].join('\n');
const gRow = (desc: string, test: string) => ({ desc, type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const, expectation: 'absolute_pass' as const,
  requirementSource: 'story' as const, verification: { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` } });
function gItems(): ChecklistItem[] {
  return [{
    id: 'CHK-001', title: 'Upper helper', context: 'strs/strs.go', userSees: 'Upper("ab") is "AB"',
    files: { modify: ['strs/strs.go'], create: [], test: ['strs/strs_test.go'] },
    verificationIntent: { happy: [gRow('Upper("ab") -> "AB"', 'TestUpper')], edge: [gRow('Upper("") -> ""', 'TestUpperEmpty')], adversarial: [gRow('Upper("aB") -> "AB"', 'TestUpperMixed')] },
    status: 'pending', startTime: null, endTime: null,
  }, {
    id: 'CHK-002', title: 'Reverse helper', context: 'strs/strs.go', userSees: 'Reverse("ab") is "ba"',
    files: { modify: ['strs/strs.go'], create: [], test: ['strs/strs_test.go'] },
    verificationIntent: { happy: [gRow('Reverse("ab") -> "ba"', 'TestReverse')], edge: [gRow('Reverse("") -> ""', 'TestReverseEmpty')], adversarial: [gRow('Reverse("a") -> "a"', 'TestReverseOne')] },
    status: 'pending', startTime: null, endTime: null,
  }] as unknown as ChecklistItem[];
}

await check('G the DEV guard after a current story_review round lists its blockers and names next --run; the scope_gap remedy names next --run', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run40-guard-')));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Bench Owner']);
    git(root, ['config', 'user.email', 'owner@bench.invalid']);
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' } }, null, 2));
    write(root, 'README.md', 'fixture\n');
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'baseline']);
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-40a1';
    const now = '2026-10-10T03:00:00.000Z';
    store.writeStory(storyId, { storyId, name: 'text-helpers', title: 'Text helpers', description: 'Add Upper and Reverse.', type: 'feature', phase: 'PLAN', priority: 'high',
      createdAt: now, startedAt: now, endedAt: null, events: [{ phase: 'PLAN', action: 'advance', timestamp: now }] } as StoryInfo);
    store.writeChecklist(storyId, { items: gItems() } as ChecklistData);
    writeStoryRequest(store, { storyId, phase: 'INIT', request: G_REQUEST, source: 'smoke', now });
    store.writeDevMemoryPreflightAck(storyId, { schemaVersion: 'proof-or-stop.dev_memory_preflight_ack.v1', storyId, topHitIds: [], acknowledgedAt: now, acknowledgedBy: 'smoke' } as never);
    const ctx = { store, root, scanRoot: root };
    const registry = createMainRegistry(ctx);
    const GAP = 'Upper keeps non-letters unchanged';
    createScopeCheckHandlers(ctx).scope_check_save({ storyId,
      features: [{ feature: 'Upper helper', status: 'covered', covered_by: 'CHK-001', excluded_by: null, source: 'request.md' },
        { feature: GAP, status: 'gap', covered_by: null, excluded_by: null, source: 'request.md' }],
      summary: { total: 2, covered: 1, excluded: 0, gaps: 1 }, readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null }, openQuestions: [] } as never);
    const review = createStoryReviewHandlers(ctx).story_review({ storyId }) as { issues: Array<{ type: string; severity: string; message: string }> };
    const gap = review.issues.find(issue => issue.type === 'scope_gap');
    assert.ok(gap, `story_review reports the scope gap: ${JSON.stringify(review.issues.map(issue => issue.type))}`);
    assert.match(gap!.message, new RegExp(`proof-or-stop next --storyId=${storyId} --run`), `the scope_gap remedy names next --run: ${gap!.message}`);
    assert.doesNotMatch(gap!.message, /proof-or-stop host_run\b/, `the scope_gap remedy does not hand the scope-plan launch to the owner: ${gap!.message}`);
    assert.match(gap!.message, /proof-or-stop-review-scope-plan|scope-plan reviewer/, 'the remedy still says the scope-plan reviewer reruns');
    const live = createNextDriver(ctx, (name: string) => registry.get(name)).decide(storyId) as NextStep;
    const reference = createReferenceNextDriver(ctx as never, (name: string) => registry.get(name)).decide(storyId);
    assert.deepEqual(live, reference, 'the frozen reference driver mirrors the live step');
    assert.notEqual(live.cli?.command, 'story_review', `the step does not send the owner to rerun story_review by hand: ${live.reason} ${live.command}`);
    assert.match(live.why, new RegExp(GAP), `the step lists the blocker: ${live.why}`);
    assert.match(live.why, new RegExp(`proof-or-stop next --storyId=${storyId} --run`), `the step names next --run as the one action after the fix: ${live.why}`);
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// I. INIT schema-enum refusal

await check('I story_create refused on a row type enum stages the payload and names ONE @file Next with the allowed values', () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'run40-init-')));
  try {
    git(work, ['init', '-q', '-b', 'main']);
    git(work, ['config', 'user.name', 'Owner']);
    git(work, ['config', 'user.email', 'owner@example.invalid']);
    write(work, 'README.md', 'x\n');
    git(work, ['add', '-A']); git(work, ['commit', '-qm', 'base']);
    const payload = { name: 'text-helpers', title: 'Text helpers', description: 'Add Upper.', type: 'feature', priority: 'medium',
      checklist: [{ title: 'Upper', context: 'strs', userSees: 'Upper("ab") is "AB"', verificationIntent: { happy: [{ desc: 'Upper("ab") -> "AB"', type: 'compatibility', priority: 'must' }], edge: [{ desc: 'Upper("") -> ""', type: 'error', priority: 'must' }], adversarial: [] } }] };
    const run = spawnSync(process.execPath, [CLI, 'story_create', JSON.stringify(payload)], { cwd: work, encoding: 'utf8', env: { ...process.env, PROOF_OR_STOP_NO_HOOKS: '1' } });
    const out = `${run.stdout}${run.stderr}`;
    assert.notEqual(run.status, 0, 'refused');
    assert.match(out, /compatibility/, `the refused value is named: ${out.slice(-1500)}`);
    assert.match(out, /logic[^\n]*cli[^\n]*browser[^\n]*manual[^\n]*docs/, 'the allowed values are listed');
    const staged = out.match(/proof-or-stop story_create @(\S+\.json)/)?.[1];
    assert.ok(staged, `ONE Next names story_create @<staged payload>, not a full resend: ${out.slice(-1500)}`);
    assert.equal(new Set(out.match(/^Next:.*$/gm) ?? []).size, 1, `exactly one distinct Next line: ${out.slice(-1500)}`);
    assert.deepEqual(JSON.parse(readFileSync(staged!, 'utf8')).checklist, payload.checklist, 'the staged file holds the submitted payload');
  } finally { rmSync(work, { recursive: true, force: true }); }
  const template = storyCreateTemplateStep(PROJECT_ROOT);
  assert.match(template.why, /logic\|cli\|browser\|manual\|docs/, `the story_create template step lists the row type values: ${template.why}`);
});

// ---------------------------------------------------------------------------
// D. delivery skeleton

await check('D the delivery prompt material carries the delivery_check_set skeleton and the canonical report commands', () => {
  const render = api(deliveryPack, 'renderDeliveryCheckSkeleton');
  const text = String(render({ storyId: 'B-40d1', docsPromises: [{ docPath: 'docs/strs.md', promise: 'Upper upper-cases' }], featureIds: ['CHK-001', 'CHK-002'] }));
  assert.match(text, /proof-or-stop delivery_check_set '\{"storyId":"B-40d1"/, `a ready delivery_check_set call: ${text}`);
  assert.match(text, /"featureId":"CHK-001"[\s\S]*"featureId":"CHK-002"/, 'one realMachineTests row per item');
  assert.match(text, /"closingSelfCheck"/, 'closingSelfCheck skeleton');
  for (const command of ['acceptance_topology_check', 'pre_review_check_read', 'acceptance_rollout_report_read', 'acceptance_rollout_check']) {
    assert.match(text, new RegExp(`proof-or-stop ${command} --storyId=B-40d1`), `${command} is named as a read-only command, not a file to find`);
  }
});

// ---------------------------------------------------------------------------
// B. bundle hygiene

const RUN_HISTORY = /\bold-PoS\b|\bOld-PoS\b|\b[Rr]uns? \d{1,2}\b(?![-.]\d)/;
const require = createRequire(import.meta.url);

/** Shipped JS outside comments (string literals, regexes, code) that names a benchmark run. */
function codeRunHistory(file: string): string[] {
  const ts = require('typescript') as typeof import('typescript');
  const text = readFileSync(file, 'utf8');
  if (!RUN_HISTORY.test(text)) return [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const hits: string[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node: import('typescript').Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)) {
      const raw = node.getText(source);
      if (RUN_HISTORY.test(raw)) hits.push(raw.slice(0, 120));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  void scanner;
  return hits;
}

function shippedModules(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'tasks') walk(full); continue; }
      if (/\.(?:js|mjs|cjs)$/.test(name) && !/\.bundle\.mjs$/.test(name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

await check('B1 shipped code names no benchmark run outside comments (step sources, reasons, help, refusals)', () => {
  const hits = shippedModules(DIST).flatMap(file => codeRunHistory(file).map(hit => `${relative(DIST, file)}: ${hit}`));
  assert.deepEqual(hits, [], `run-history in shipped strings:\n${hits.slice(0, 30).join('\n')}${hits.length > 30 ? `\n+${hits.length - 30} more` : ''}`);
});

await check('B2 the benchmark bundle comment strip removes every comment and keeps the identity boundaries valid', () => {
  const script = join(PROJECT_ROOT, 'scripts', 'strip-shipped-comments.mjs');
  assert.ok(existsSync(script), 'scripts/strip-shipped-comments.mjs exists');
  const staged = realpathSync(mkdtempSync(join(tmpdir(), 'run40-strip-')));
  try {
    const pkg = join(staged, 'packages', 'main');
    mkdirSync(pkg, { recursive: true });
    // The shipped shape: no source maps, no CLI bundle (rebuilt after the strip), dist/tasks pruned to non-test modules.
    cpSync(DIST, join(pkg, 'dist'), { recursive: true, filter: source => !/\.map$|cli-direct\.bundle\./.test(source)
      && !(/[/\\]dist[/\\]tasks[/\\]/.test(source) && /(?:-smoke|-fixture|fixture-|\.test|-e2e|e2e-|-harness)[^/\\]*$/.test(source)) });
    cpSync(join(PACKAGE_ROOT, 'package.json'), join(pkg, 'package.json'));
    cpSync(join(PACKAGE_ROOT, 'templates'), join(pkg, 'templates'), { recursive: true });
    symlinkSync(join(PROJECT_ROOT, 'node_modules'), join(pkg, 'node_modules'));
    const run = spawnSync(process.execPath, [script, '--package-root', pkg], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, `strip ran: ${run.stdout.slice(-800)}${run.stderr.slice(-1500)}`);
    const left = shippedModules(join(pkg, 'dist')).filter(file => RUN_HISTORY.test(readFileSync(file, 'utf8')));
    assert.deepEqual(left.map(file => relative(pkg, file)), [], 'no run-history marker remains in the stripped modules');
    const help = spawnSync(process.execPath, [join(pkg, 'dist', 'cli.js'), '--version'], { cwd: staged, encoding: 'utf8', env: { ...process.env, PROOF_OR_STOP_BUNDLE: '0', PROOF_OR_STOP_NO_HOOKS: '1' } });
    assert.match(`${help.stdout}${help.stderr}`, /Proof-or-Stop /, `the stripped CLI still runs: ${help.stderr.slice(-800)}`);
  } finally { rmSync(staged, { recursive: true, force: true }); }
});

await check('B3 the coverage matrix code carries no task-family vocabulary', () => {
  const file = join(DIST, 'core', 'plan-coverage-matrix.js');
  const ts = require('typescript') as typeof import('typescript');
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code: string[] = [];
  const visit = (node: import('typescript').Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node) || ts.isIdentifier(node)) code.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  const joined = code.join('\n');
  const vocabulary = [/stepped/i, /three-part/i, /two-part/i, /receiver-(?:member|nested|call)/, /broadcast/i, /size[- ]mismatch/i, /\brunes?\b/i, /\bstart\b.*\bend\b.*\bstep\b/,
    /assignment uses read selection/i, /\bARRAY\b/, /\bSTRING\b/, /index-of-index/i, /é/];
  const hits = vocabulary.filter(word => word.test(joined)).map(String);
  assert.deepEqual(hits, [], `task-family vocabulary in the shipped coverage matrix: ${hits.join(', ')}`);
});

if (failures.length) {
  console.error(`run40-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('run40-fixes-smoke: PASS');
