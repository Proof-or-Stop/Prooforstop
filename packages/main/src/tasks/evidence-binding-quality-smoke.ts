#!/usr/bin/env node
/**
 * Run 16 (abs-stepped-slices, B-80ea) evidence-binding quality and receipt cost.
 *
 *   E1  An unpinned missing intent must never get a concrete bind. Run 16:
 *       `next` proposed, as a FRAMEWORK step, binding CHK-001:happy:0
 *       (`myArray[99 : 101 : 2]`) to TestParsingIndexRangeExpressions, which only
 *       parses a two-part range, with a fabricated note "X proves: <desc>"; and
 *       CHK-003's string case to an ARRAY test. `next --run` would have pinned the
 *       wrong test immutably with a passing receipt. A test<->intent match is a
 *       judgment: the report lists candidate tests with why (ranked by literals
 *       of the intent found in the test body, then name tokens), never writes a
 *       "proves" note, and every missing unpinned intent shares ONE
 *       verification_evidence_batch_add template the agent completes.
 *   E2  The advisory unbound-test action is a template too (the intent is the
 *       agent's choice), and the detection itself stays.
 *   N1  Through the real CLI: `next --json` returns that batch as an AGENT step
 *       with its placeholders, and `next --run` executes nothing (no receipt).
 *   P1  PLAN requires pins: story_review blocks an executable must/should intent
 *       without verification:{command,selector}, naming its refs; once pinned
 *       the blocker is gone and `verification_run --pending` covers them in DEV.
 *   C1  A JSON payload parse error is the LAST line of the CLI output (run 16:
 *       `tail -2` showed only the help footer "Owner lease meta options:
 *       --takeover", read as lease contention, 15 failures / 5.3 min), and the
 *       full argument help is not printed.
 *
 * Usage: node packages/main/dist/tasks/evidence-binding-quality-smoke.js
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { mergeRuntimeGitignore } from '../core/managed-assets.js';
import type { ChecklistData, StoryInfo, VerificationIntentItem } from '../core/types.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { collectChangedGoTests, evaluateEvidenceChain } from '../core/evidence-chain-check.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';
import { sanitizedFixtureChildEnvironment } from './fixture-environment.js';
import { createFixtureMachineEnvironment } from './helpers/fixture-machine-environment.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const failures: string[] = [];
function check(ok: boolean, message: string, detail = ''): boolean {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${message}${ok || !detail ? '' : `\n         ${detail.slice(0, 1500).replace(/\n/g, '\n         ')}`}`);
  if (!ok) failures.push(message);
  return ok;
}
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

interface Candidate { test: { name: string }; command: string; why: string }
/** Read loosely so this RED smoke compiles against the pre-fix report shape. */
const candidatesOf = (issue: unknown): Candidate[] => ((issue as { candidates?: Candidate[] } | undefined)?.candidates ?? []);

const must = (id: string, desc: string, extra: Partial<VerificationIntentItem> = {}): VerificationIntentItem => ({
  id, desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', ...extra,
});

const PARSER_TEST_BASE = [
  'package parser', '', 'import "testing"', '',
  'func TestParsingIndexRangeExpressions(t *testing.T) {',
  '\tinput := "myArray[99 : 101]"',
  '\tcheckRange(t, input)',
  '}', '',
].join('\n');
// The implementer added a two-part String() assertion to the old test (so it
// counts as changed) and a real stepped-slice test.
const PARSER_TEST_HEAD = [
  'package parser', '', 'import "testing"', '',
  'func TestParsingIndexRangeExpressions(t *testing.T) {',
  '\tinput := "myArray[99 : 101]"',
  '\tcheckRange(t, input)',
  '\tcheckString(t, input, "(myArray[99:101])")',
  '}', '',
  'func TestParsingIndexRangeWithStep(t *testing.T) {',
  '\tinput := "myArray[99 : 101 : 2]"',
  '\tcheckString(t, input, "(myArray[99:101:2])")',
  '}', '',
].join('\n');
const EVALUATOR_TEST_BASE = ['package evaluator', '', 'import "testing"', '', 'func TestBaseline(t *testing.T) {}', ''].join('\n');
const EVALUATOR_TEST_HEAD = [
  'package evaluator', '', 'import "testing"', '',
  'func TestBaseline(t *testing.T) {}', '',
  'func TestArrayIndexSteppedSliceExpressions(t *testing.T) {',
  '\tcheckArray(t, "[1, 2, 3, 4][::2]", "[1, 3]")',
  '}', '',
  'func TestStringIndexSteppedSlice(t *testing.T) {',
  '\tcheckString(t, "\\"12345\\"[::2]", "135")',
  '}', '',
].join('\n');

function run16Checklist(status: 'pending' | 'done'): ChecklistData {
  const now = '2026-10-03T02:59:00.000Z';
  return { items: [
    { id: 'CHK-001', title: 'Parser accepts stepped slices and AST string preserves them', context: 'parser',
      files: { modify: ['parser/parser.go'], create: [], test: ['parser/parser_test.go'] },
      status, startTime: now, endTime: null,
      verificationIntent: { happy: [must('CHK-001:happy:0', 'myArray[99 : 101 : 2] parses and AST String() == (myArray[99:101:2])')], edge: [], adversarial: [] } },
    { id: 'CHK-002', title: 'Array stepped read slicing', context: 'evaluator',
      files: { modify: ['evaluator/evaluator.go'], create: [], test: ['evaluator/evaluator_test.go'] },
      status, startTime: now, endTime: null,
      verificationIntent: { happy: [must('CHK-002:happy:0', '[1, 2, 3, 4][::2] returns [1, 3]')], edge: [], adversarial: [] } },
    { id: 'CHK-003', title: 'String stepped read slicing', context: 'evaluator',
      files: { modify: ['evaluator/evaluator.go'], create: [], test: ['evaluator/evaluator_test.go'] },
      status, startTime: now, endTime: null,
      verificationIntent: { happy: [must('CHK-003:happy:0', '"12345"[::2] returns "135"')], edge: [], adversarial: [] } },
  ] };
}

/** A run-16-shaped Go repo: base commit, then the implementer's test changes on HEAD. */
function goRepo(root: string): { base: string } {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'go.mod', 'module example.com/abs\n\ngo 1.21\n');
  write(root, 'parser/parser_test.go', PARSER_TEST_BASE);
  write(root, 'evaluator/evaluator_test.go', EVALUATOR_TEST_BASE);
  write(root, '.gitignore', `.worktrees/\n${mergeRuntimeGitignore('')}`);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'task baseline']);
  return { base: git(root, ['rev-parse', 'HEAD']) };
}

function e1e2(): void {
  console.log('E1/E2 run-16 shape: unpinned missing intents and changed tests');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ebq-unit-')));
  try {
    const { base } = goRepo(root);
    write(root, 'parser/parser_test.go', PARSER_TEST_HEAD);
    write(root, 'evaluator/evaluator_test.go', EVALUATOR_TEST_HEAD);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'implement stepped slices']);
    const changedGoTests = collectChangedGoTests(root, base, [
      { path: 'parser/parser_test.go', status: 'modified' }, { path: 'evaluator/evaluator_test.go', status: 'modified' }]);
    const checklist = run16Checklist('done');
    const coverage = buildVerificationCoverage(checklist).entries;
    const report = evaluateEvidenceChain({ storyId: 'B-80ea', checklist, coverage, changedGoTests, goModulePath: 'example.com/abs' });
    const all = JSON.stringify(report);
    check(!/ proves: /.test(all), 'E1 no report text fabricates "<test> proves: <intent desc>"', all.match(/.{0,80} proves: .{0,80}/)?.[0] ?? '');
    const missing = report.issues.filter(issue => issue.kind === 'missing_receipt');
    check(missing.length === 3 && missing.every(issue => issue.blocking), `E1 the three unpinned must intents are blocking missing receipts (got ${missing.length})`);
    const actions = new Set(missing.map(issue => issue.nextAction));
    const batch = [...actions][0] ?? '';
    check(actions.size === 1 && batch.startsWith('proof-or-stop verification_evidence_batch_add '),
      'E1 every missing unpinned intent shares ONE verification_evidence_batch_add action', [...actions].join('\n'));
    check(['CHK-001:happy:0', 'CHK-002:happy:0', 'CHK-003:happy:0'].every(ref => batch.includes(`"intentRef":"${ref}"`)),
      'E1 the batch names all three intents', batch);
    check(!/"command":"go test/.test(batch) && /"command":"</.test(batch) && /"note":"</.test(batch),
      'E1 the batch command and note are placeholders the agent authors, never a pre-chosen test', batch);
    check(report.nextAction === batch, 'E1 the report next action is that batch');
    const names = (ref: string): string[] => candidatesOf(missing.find(issue => issue.intentRef === ref)).map(candidate => candidate.test.name);
    const c1 = names('CHK-001:happy:0');
    check(c1[0] === 'TestParsingIndexRangeWithStep' && c1.includes('TestParsingIndexRangeExpressions'),
      `E1 CHK-001:happy:0 lists candidates, the test containing myArray[99 : 101 : 2] first (got ${c1.join(', ') || 'none'})`);
    const c3 = names('CHK-003:happy:0');
    check(c3[0] === 'TestStringIndexSteppedSlice' && c3.includes('TestArrayIndexSteppedSliceExpressions'),
      `E1 CHK-003:happy:0 (string case) ranks the string test before the array test (got ${c3.join(', ') || 'none'})`);
    const c2 = names('CHK-002:happy:0');
    check(c2[0] === 'TestArrayIndexSteppedSliceExpressions', `E1 CHK-002:happy:0 (array case) ranks the array test first (got ${c2.join(', ') || 'none'})`);
    const first = candidatesOf(missing.find(issue => issue.intentRef === 'CHK-001:happy:0'))[0];
    check(!!first && /myArray\[99 : 101 : 2\]/.test(first.why) && first.command === 'go test -v ./parser -run ^TestParsingIndexRangeWithStep$',
      'E1 each candidate carries its exact command and why (the intent literal found in its body)', JSON.stringify(first));
    const weak = candidatesOf(missing.find(issue => issue.intentRef === 'CHK-001:happy:0')).find(row => row.test.name === 'TestParsingIndexRangeExpressions');
    check(!!weak && /no literal of the intent/i.test(weak.why), 'E1 a candidate without any intent literal in its body says so', JSON.stringify(weak));
    check(missing.every(issue => /candidate/i.test(issue.detail)), 'E1 the rendered detail lists the candidates (the gate prints it)');

    const unbound = report.issues.filter(issue => issue.kind === 'unbound_test');
    check(unbound.length === 4 && unbound.every(issue => !issue.blocking), `E2 the advisory unbound-test detection stays (got ${unbound.length})`);
    check(unbound.every(issue => !issue.nextAction.includes('verification_evidence_add') || /"intentRef":"</.test(issue.nextAction)),
      'E2 an unbound-test bind leaves the intent choice to the agent (placeholder intentRef)', unbound.map(issue => issue.nextAction).join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function n1(machineEnv: NodeJS.ProcessEnv): void {
  console.log('N1 next through the real CLI: agent step, --run executes nothing');
  const storyId = 'B-80ea';
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ebq-next-')));
  const worktree = join(root, '.worktrees', storyId);
  const env: NodeJS.ProcessEnv = {
    ...sanitizedFixtureChildEnvironment(machineEnv),
    PROOF_OR_STOP_AGENT: 'main',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'evidence-binding-quality-owner',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: 'main',
    PROOF_OR_STOP_USAGE_LEDGER: '0',
  };
  try {
    goRepo(root);
    write(root, 'proof-or-stop.config.json', `${JSON.stringify({ artifactContract: 'none',
      validate: { commands: [{ id: 'go-all', command: 'go', args: ['test', './...'], focus: ['fast'], timeoutMs: 270000 }] } }, null, 2)}\n`);
    const now = new Date().toISOString();
    const store = new StoryStore(root);
    store.writeStory(storyId, {
      storyId, name: 'stepped-slices', title: 'Stepped slices', description: 'Add stepped slices.', type: 'feature', phase: 'DEV', priority: 'medium',
      createdAt: now, startedAt: now, endedAt: null, worktree: { path: worktree, branch: `story/${storyId}`, createdAt: now },
      events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
    } as StoryInfo);
    store.writeChecklist(storyId, run16Checklist('done'));
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', `proof-or-stop: INIT_CHECK metadata ${storyId}`]);
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', '-q', worktree, `story/${storyId}`]);
    write(worktree, 'parser/parser_test.go', PARSER_TEST_HEAD);
    write(worktree, 'evaluator/evaluator_test.go', EVALUATOR_TEST_HEAD);
    git(worktree, ['add', '-A']);
    git(worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'implement stepped slices']);
    const cli = (args: string[]) => {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: worktree, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return { status: r.status ?? -1, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const decided = cli(['next', JSON.stringify({ storyId, json: true })]);
    let step: Record<string, any> = {};
    try { step = JSON.parse(decided.stdout.slice(decided.stdout.indexOf('{'))); } catch { /* reported below */ }
    check(step.reason === 'evidence_chain' && step.kind === 'agent', `N1 next returns the evidence-chain step as kind=agent (got ${step.kind}/${step.reason})`, decided.out.slice(-1500));
    check(step.cli?.command === 'verification_evidence_batch_add' && Array.isArray(step.cli?.payload?.evidences) && step.cli.payload.evidences.length === 3,
      'N1 its command is one verification_evidence_batch_add for the three intents', JSON.stringify(step.cli ?? null).slice(0, 800));
    check(Array.isArray(step.placeholders) && step.placeholders.includes('evidences[0].command') && step.placeholders.includes('evidences[0].note'),
      `N1 the nested placeholders are listed (got ${JSON.stringify(step.placeholders ?? null)})`);
    check(/TestParsingIndexRangeWithStep/.test(String(step.why)) && !/ proves: /.test(decided.stdout),
      'N1 why lists the candidate tests; no fabricated "proves" note', String(step.why).slice(0, 800));
    const ran = cli(['next', JSON.stringify({ storyId, run: true, json: true })]);
    let runOut: Record<string, any> = {};
    try { runOut = JSON.parse(ran.stdout.slice(ran.stdout.indexOf('{'))); } catch { /* reported below */ }
    check(Array.isArray(runOut.executed) && runOut.executed.length === 0, `N1 next --run executes no step (executed ${JSON.stringify(runOut.executed ?? null).slice(0, 300)})`, ran.out.slice(-1200));
    const evidence = new StoryStore(worktree).readChecklist(storyId).items.flatMap(item => item.verificationEvidence ?? []);
    check(evidence.length === 0, `N1 no receipt or pin was recorded by next (found ${evidence.length})`);
  } finally {
    try { git(root, ['worktree', 'remove', '--force', worktree]); } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true });
  }
}

function p1(): void {
  console.log('P1 PLAN story_review requires a pin on every executable must/should intent');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ebq-plan-')));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' } }, null, 2));
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-80eb';
    const now = '2026-10-03T02:55:00.000Z';
    store.writeStory(storyId, { storyId, name: 'stepped-slices', title: 'Stepped slices', description: 'Add stepped slices.', type: 'feature',
      phase: 'PLAN', priority: 'medium', createdAt: now, startedAt: now, endedAt: null, events: [{ phase: 'PLAN', action: 'advance', timestamp: now }] } as StoryInfo);
    const checklist = run16Checklist('pending');
    // A manual intent needs no pin; a nice-priority one neither.
    checklist.items[2]!.verificationIntent!.edge = [{ ...must('CHK-003:edge:0', 'docs describe stepped slices'), type: 'manual' },
      { ...must('CHK-003:edge:1', 'very long strings slice fast'), priority: 'nice' }];
    store.writeChecklist(storyId, checklist);
    const review = () => createStoryReviewHandlers({ store, root, scanRoot: join(root, 'packages/main') }).story_review({ storyId }) as any;
    let result = review();
    const pins = (result.issues as any[]).filter(issue => issue.type === 'missing_verification_pin');
    check(pins.length === 3 && pins.every(issue => issue.severity === 'blocker'), `P1 each item with an unpinned executable must intent gets a blocker (got ${pins.length})`,
      JSON.stringify(result.issues.map((i: any) => `${i.type}:${i.severity}`)));
    const text = pins.map(issue => issue.message).join('\n');
    check(['CHK-001:happy:0', 'CHK-002:happy:0', 'CHK-003:happy:0'].every(ref => text.includes(ref)) && !text.includes('CHK-003:edge:'),
      'P1 the blockers name the unpinned executable refs only (manual and nice intents are exempt)', text);
    check(/checklist_update/.test(text) && /"verification":\{"command":/.test(text) && /verification_run/.test(text),
      'P1 the blocker names the PLAN action (checklist_update with verification:{command,selector}) and why (verification_run --pending)', text.slice(0, 900));
    for (const item of checklist.items) {
      const intent = item.verificationIntent!.happy[0]!;
      const test = { 'CHK-001': 'TestParsingIndexRangeWithStep', 'CHK-002': 'TestArrayIndexSteppedSliceExpressions', 'CHK-003': 'TestStringIndexSteppedSlice' }[item.id]!;
      intent.verification = { command: `go test -v ./${item.id === 'CHK-001' ? 'parser' : 'evaluator'} -run ^${test}$`, selector: `--- PASS: ${test}` };
    }
    store.writeChecklist(storyId, checklist);
    result = review();
    check(!(result.issues as any[]).some(issue => issue.type === 'missing_verification_pin'), 'P1 once every executable must/should intent is pinned the blocker is gone');
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

function c1(): void {
  console.log('C1 a JSON payload parse error is the last line, without the full help');
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ebq-cli-')));
  try {
    git(cwd, ['init', '-q', '-b', 'main']);
    for (const command of ['verification_evidence_add', 'verification_evidence_batch_add']) {
      const r = spawnSync(process.execPath, [CLI, command, '{"storyId":"B-1","note":"slice "12345"[::2] returns 135"}'], { cwd, encoding: 'utf8' });
      const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(line => line.trim());
      check(r.status !== 0 && /JSON parse failed/.test(lines.at(-1) ?? ''), `C1 ${command}: the last line is the parse error (got "${(lines.at(-1) ?? '').slice(0, 160)}")`);
      check(!lines.some(line => /Owner lease meta options|--takeover/.test(line)) && lines.length <= 3,
        `C1 ${command}: no argument help / lease footer is printed (${lines.length} lines)`, lines.join('\n').slice(0, 600));
      check(lines.some(line => line.includes(`${command} --help`)), `C1 ${command}: a one-line --help hint remains`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const machine = createFixtureMachineEnvironment();
  try {
    for (const scenario of [e1e2, () => n1(machine.env), p1, c1]) {
      try { scenario(); } catch (error) {
        check(false, `unexpected error: ${error instanceof Error ? error.message.slice(0, 2000) : String(error)}`);
      }
    }
  } finally {
    try { machine.cleanup(); } catch (error) { console.log(String(error)); }
  }
  if (failures.length) {
    console.log(`evidence-binding-quality-smoke: FAIL (${failures.length})`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log('evidence-binding-quality-smoke: PASS');
}

await main();
