#!/usr/bin/env node
/**
 * Evidence-chain problems are framework actions, never review findings.
 *
 * Run 11 (abs Go task) had 6 findings; two (F-002, F-006) were "coverage
 * binding gaps": an existing test that covered the behavior was bound to no
 * verification intent. Each cost inventory + critic + DEV return + a review
 * round. Separately the owner replayed stale receipts with 72
 * verification_evidence_add calls.
 *
 * This smoke drives the real CLI (dist/cli.js) against a benchmark-shaped Go
 * repository with a fake `codex` provider, as e2e-review-to-done-smoke does:
 *
 *   S1  F-006 shape: the Story adds TestEmptyInput, which no intent's pinned
 *       `go test -run` selects. Before REVIEW, pre_review_check must name it
 *       with one next action (bind it to the unpinned CHK-002 edge intent),
 *       and that exact command must bind it.
 *   S2  a code commit after the receipts stales them. story_advance REVIEW must
 *       refuse with exactly one Next: verification_evidence_refresh_stale, and
 *       after that one command REVIEW is admitted.
 *   S3  the test-coverage lane still reports an evidence-chain item
 *       (category=evidence_chain). The importer must reclassify it as a logged
 *       framework action (process event), import no finding, admit the lane as
 *       a pass, and the Story must still reach TEST on that evidence.
 *
 * Usage: node packages/main/dist/tasks/evidence-chain-not-findings-smoke.js
 *        ECNF_VERBOSE=1 prints every command's output.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import { mergeRuntimeGitignore } from '../core/managed-assets.js';
import { QUALIFIED_MANAGED_REVIEWER_DEFAULTS } from '../core/managed-reviewer-qualification.js';
import { MANAGED_INVENTORY_CRITIC_LANE } from '../core/managed-inventory-critic.js';
import { sanitizedFixtureChildEnvironment } from './fixture-environment.js';
import { createFixtureMachineEnvironment } from './helpers/fixture-machine-environment.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const MODEL = QUALIFIED_MANAGED_REVIEWER_DEFAULTS.codex;
const FINAL_SCHEMA = 'lattice.managed_review_final_proposal.v1';
const TEST_COVERAGE = 'proof-or-stop-review-test-coverage';
const STORY = 'B-ec01';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const IMPL = [
  'package strs', '', 'import "strings"', '',
  '// Upper returns the upper-case form of s.',
  'func Upper(s string) string { return strings.ToUpper(s) }', '',
  '// Reverse returns s reversed by rune.',
  'func Reverse(s string) string {',
  '\tr := []rune(s)',
  '\tfor i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {',
  '\t\tr[i], r[j] = r[j], r[i]',
  '\t}',
  '\treturn string(r)',
  '}', '',
].join('\n');
// TestEmptyInput is the F-006 shape: it covers the empty-string behavior, but
// the PLAN-pinned commands select only ^TestUpper$ and ^TestReverse$.
const TESTS = [
  'package strs', '', 'import "testing"', '',
  'func TestBaseline(t *testing.T) {}', '',
  'func TestUpper(t *testing.T) {', '\tif Upper("ab") != "AB" {', '\t\tt.Fatal("upper")', '\t}', '}', '',
  'func TestReverse(t *testing.T) {', '\tif Reverse("héllo") != "olléh" {', '\t\tt.Fatal("reverse")', '\t}', '}', '',
  'func TestEmptyInput(t *testing.T) {', '\tif Reverse("") != "" || Upper("") != "" {', '\t\tt.Fatal("empty")', '\t}', '}', '',
].join('\n');

interface CliResult { status: number; stdout: string; stderr: string; out: string }

class Fixture {
  readonly root: string;
  readonly worktree: string;
  private readonly providerBin: string;
  private readonly scripts: string;
  private readonly cliBin: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(machineEnv: NodeJS.ProcessEnv) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), 'ecnf-')));
    this.worktree = join(this.root, '.worktrees', STORY);
    this.providerBin = `${this.root}-provider`;
    this.scripts = join(this.providerBin, 'scripts');
    this.cliBin = `${this.root}-cli`;
    mkdirSync(this.scripts, { recursive: true });
    mkdirSync(this.cliBin, { recursive: true });
    writeFakeCodex(this.providerBin, this.scripts);
    this.env = {
      ...sanitizedFixtureChildEnvironment(machineEnv),
      PATH: `${this.providerBin}:${this.cliBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      PROOF_OR_STOP_AGENT: 'main',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'evidence-chain-not-findings-owner',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: 'main',
      PROOF_OR_STOP_USAGE_LEDGER: '0',
    };
    // `proof-or-stop` on PATH, so a printed Next line can be run literally.
    writeFileSync(join(this.cliBin, 'env.json'), JSON.stringify(this.env));
    writeFileSync(join(this.cliBin, 'proof-or-stop'), [
      `#!${process.execPath}`,
      `const { spawnSync } = require('child_process'); const env = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(this.cliBin, 'env.json'))}, 'utf8'));`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { stdio: 'inherit', env });`,
      'process.exit(r.status ?? 1);', '',
    ].join('\n'), { mode: 0o755 });
    this.build();
  }

  cleanup(): void {
    for (const dir of [this.providerBin, this.cliBin, this.root]) rmSync(dir, { recursive: true, force: true });
  }

  private build(): void {
    const { root, worktree } = this;
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Bench Owner']);
    git(root, ['config', 'user.email', 'owner@bench.invalid']);
    write(root, 'go.mod', 'module example.com/strs\n\ngo 1.21\n');
    write(root, 'strs/strs.go', 'package strs\n\n// Upper returns s unchanged (baseline bug).\nfunc Upper(s string) string { return s }\n');
    write(root, 'strs/strs_test.go', 'package strs\n\nimport "testing"\n\nfunc TestBaseline(t *testing.T) {}\n');
    write(root, '.gitignore', `.worktrees/\n${mergeRuntimeGitignore('')}`);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'task baseline']);
    write(root, 'proof-or-stop.config.json', `${JSON.stringify({
      artifactContract: 'none',
      validate: { commands: [{ id: 'benchmark-go-strs', command: 'go', args: ['test', '-v', './strs'], focus: ['fast'], timeoutMs: 270000 }] },
    }, null, 2)}\n`);
    git(root, ['add', 'proof-or-stop.config.json']);
    git(root, ['commit', '-qm', 'benchmark: configure PoS Go validation before Story']);
    const now = new Date().toISOString();
    const files = { modify: ['strs/strs.go'], create: [], test: ['strs/strs_test.go'] };
    const must = (id: string, desc: string) => ({ id, desc, type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const, expectation: 'absolute_pass' as const, requirementSource: 'story' as const });
    const store = new StoryStore(root);
    store.writeStory(STORY, {
      storyId: STORY, name: 'strs-upper-reverse', title: 'Implement Upper and Reverse string helpers',
      description: 'Implement strs.Upper and strs.Reverse.', type: 'bug', phase: 'DEV', priority: 'medium',
      createdAt: now, startedAt: now, endedAt: null,
      worktree: { path: worktree, branch: `story/${STORY}`, createdAt: now },
      events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
    });
    store.writeChecklist(STORY, { items: [
      { id: 'CHK-001', title: 'Upper returns the upper-case form', context: 'strs.Upper returns its input unchanged.',
        userSees: 'go test -v ./strs -run TestUpper prints --- PASS: TestUpper', status: 'in_progress', startTime: now, endTime: null,
        files, verificationIntent: { happy: [must('CHK-001:happy:0', 'TestUpper passes')], edge: [], adversarial: [] } },
      { id: 'CHK-002', title: 'Reverse returns the rune-reversed string', context: 'strs.Reverse does not exist.',
        userSees: 'go test -v ./strs -run TestReverse prints --- PASS: TestReverse; the empty string reverses to itself', status: 'in_progress', startTime: now, endTime: null,
        files, verificationIntent: {
          happy: [must('CHK-002:happy:0', 'TestReverse passes')],
          edge: [{ id: 'CHK-002:edge:0', desc: 'Reverse and Upper of the empty string are empty', type: 'logic', priority: 'should', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
          adversarial: [],
        } },
    ] });
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', `proof-or-stop: INIT_CHECK metadata ${STORY}`]);
    git(root, ['branch', `story/${STORY}`]);
    git(root, ['worktree', 'add', '-q', worktree, `story/${STORY}`]);
    write(worktree, 'strs/strs.go', IMPL);
    write(worktree, 'strs/strs_test.go', TESTS);
    git(worktree, ['add', '-A']);
    git(worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'implement Upper and Reverse']);
  }

  cli(command: string, payload: Record<string, unknown>): CliResult {
    const run = spawnSync(process.execPath, [CLI, command, JSON.stringify(payload)], {
      cwd: this.worktree, encoding: 'utf8', env: this.env, maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    if (process.env.ECNF_VERBOSE) console.log(`--- ${command} exit=${run.status}\n${out.slice(0, 4000)}`);
    return { status: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out };
  }

  must(command: string, payload: Record<string, unknown>): CliResult {
    const run = this.cli(command, payload);
    assert.equal(run.status, 0, `${command} failed:\n${run.out.slice(-3000)}`);
    return run;
  }

  /** Run a printed command line literally, as an owner pasting it would. */
  shell(commandLine: string): CliResult {
    const run = spawnSync('/bin/sh', ['-c', commandLine], { cwd: this.worktree, encoding: 'utf8', env: this.env, maxBuffer: 64 * 1024 * 1024 });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    if (process.env.ECNF_VERBOSE) console.log(`--- sh ${commandLine.slice(0, 200)} exit=${run.status}\n${out.slice(0, 4000)}`);
    return { status: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out };
  }

  store(): StoryStore { return new StoryStore(this.worktree); }

  script(key: string, final: string): void { writeFileSync(join(this.scripts, `${key}.json`), JSON.stringify({ final })); }
  unscript(key: string): void { const path = join(this.scripts, `${key}.json`); if (existsSync(path)) unlinkSync(path); }

  readEvidence(): Record<string, unknown> {
    const candidate = this.store().readCandidateSpecSet(STORY);
    assert.ok(candidate, 'review_round_prepare persisted the candidate route');
    const filesReadFully = [...new Set(['strs/strs.go', 'strs/strs_test.go', ...candidate.candidateSpecSet])].sort();
    return {
      readManifest: { filesReadFully, filesTriagedByName: [], scanEscalationReason: candidate.scanEscalationReason ?? null,
        candidateSpecSetDigest: candidate.artifactDigest, corpusDigest: candidate.corpusDigest },
      readLog: { filesReadFully, filesTriagedByName: [], summary: { readCount: filesReadFully.length, tokenCount: null }, digest: 'a'.repeat(64) },
    };
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)) as Record<string, unknown>; } catch { return null; }
}

function writeFakeCodex(bin: string, scripts: string): void {
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const dir = ${JSON.stringify(scripts)};
let input = ''; process.stdin.on('data', d => { input += d; }); process.stdin.on('end', () => {
  const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'thread.started', thread_id: 'fake-codex-' + process.pid });
  emit({ type: 'turn.started' });
  const key = fs.readdirSync(dir).filter(f => f.endsWith('.json')).find(f => input.includes(f.slice(0, -5)));
  if (!key) process.exit(3);
  const script = JSON.parse(fs.readFileSync(path.join(dir, key), 'utf8'));
  emit({ type: 'item.completed', item: { type: 'agent_message', text: script.final } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } });
});
`, { mode: 0o755 });
}

function launch(f: Fixture, lane: string, reviewRunId: string, envelope: Record<string, unknown>): string {
  f.script(reviewRunId, JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId: STORY, providerAgent: lane, lane, reviewRunId, ...envelope, ...f.readEvidence() }));
  const launched = f.must('host_run', { host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort, storyId: STORY,
    agentType: lane, reviewRunId, lane, managedReview: true, detach: true, json: true });
  return String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
}

function waitTerminal(f: Fixture, runId: string): { state: string; reason: string; receiptId: string } {
  const status = f.must('host_run_status', { runId, untilTerminal: true, json: true });
  const json = parseJson(status.stdout)!;
  const run = json.run as Record<string, unknown>;
  const terminal = run.terminal as Record<string, unknown> | null;
  return { state: String(run.state), reason: String(terminal?.reason ?? ''), receiptId: String((json.receipt as Record<string, unknown> | undefined)?.receiptId ?? '') };
}

const failures: string[] = [];
function check(ok: boolean, message: string): boolean {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${message}`);
  if (!ok) failures.push(message);
  return ok;
}

function nextLine(text: string): string | null {
  return text.split('\n').map(line => line.trim()).find(line => line.startsWith('Next: proof-or-stop '))?.slice('Next: '.length) ?? null;
}

async function main(): Promise<void> {
  const machine = createFixtureMachineEnvironment();
  const f = new Fixture(machine.env);
  let keep = false;
  const scenarios = (): void => {
    f.must('dev_memory_preflight_ack', { storyId: STORY });
    f.must('scope_contract_init_from_plan', { storyId: STORY });
    f.must('verification_evidence_add', { storyId: STORY, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'logic_test',
      command: 'go test -v ./strs -run ^TestUpper$', selector: '--- PASS: TestUpper', note: 'Pinned focused go test proves Upper upper-cases its input.' });
    f.must('verification_evidence_add', { storyId: STORY, itemId: 'CHK-002', intentRef: 'CHK-002:happy:0', kind: 'logic_test',
      command: 'go test -v ./strs -run ^TestReverse$', selector: '--- PASS: TestReverse', note: 'Pinned focused go test proves Reverse reverses by rune.' });
    f.must('checklist_update', { storyId: STORY, itemId: 'CHK-001', status: 'done' });
    f.must('checklist_update', { storyId: STORY, itemId: 'CHK-002', status: 'done' });

    console.log('S1 F-006 shape: an existing test bound to no intent surfaces before REVIEW');
    const pre = f.cli('pre_review_check', { storyId: STORY });
    const named = check(/TestEmptyInput \(strs\/strs_test\.go\)[^\n]*selected by no intent's pinned command/.test(pre.out),
      'S1 pre_review_check names unbound test TestEmptyInput before REVIEW');
    const bind = nextLine(pre.out);
    check(named && !!bind && bind.includes('verification_evidence_add') && bind.includes('"intentRef":"CHK-002:edge:0"') && bind.includes('^TestEmptyInput$'),
      'S1 its one next action binds TestEmptyInput to the unpinned intent CHK-002:edge:0');
    if (bind && bind.includes('verification_evidence_add')) {
      const bound = f.shell(bind);
      check(bound.status === 0, `S1 the printed bind command succeeds${bound.status === 0 ? '' : `: ${bound.out.slice(-600)}`}`);
      const after = f.cli('pre_review_check', { storyId: STORY });
      check(!/TestEmptyInput/.test(after.out) && /unboundTests=checked/.test(after.out), 'S1 after binding, the check reports no unbound test');
    }

    console.log('S2 stale receipts: one Next, verification_evidence_refresh_stale');
    write(f.worktree, 'strs/strs.go', `${IMPL}// Documented: Reverse keeps combining marks attached to runes only.\n`);
    git(f.worktree, ['add', '-A']);
    git(f.worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'document Reverse']);
    const refused = f.cli('story_advance', { storyId: STORY, phase: 'REVIEW' });
    check(refused.status !== 0 && nextLine(refused.out) === `proof-or-stop verification_evidence_refresh_stale --storyId=${STORY}`,
      `S2 story_advance REVIEW refuses stale receipts with exactly Next: proof-or-stop verification_evidence_refresh_stale --storyId=${STORY}${refused.status !== 0 ? '' : ' (it was admitted)'}`);
    f.must('verification_evidence_refresh_stale', { storyId: STORY });
    const advanced = f.cli('story_advance', { storyId: STORY, phase: 'REVIEW' });
    if (!check(advanced.status === 0, `S2 after the one refresh command REVIEW is admitted${advanced.status === 0 ? '' : `: ${advanced.out.slice(-800)}`}`)) {
      keep = true;
      return;
    }

    console.log('S3 a reviewer evidence-chain item is reclassified as a framework action, not a finding');
    const prepared = f.must('review_round_prepare', { storyId: STORY, json: true });
    const reviewRuns = parseJson(prepared.stdout)!.reviewRuns as Record<string, string>;
    check(TEST_COVERAGE in reviewRuns, 'S3 the test-coverage lane is launched');
    const evidenceChainDesc = 'TestEmptyInput covers the empty-string behavior of CHK-002 but no intent pinned command selects it (binding gap)';
    const launched = Object.entries(reviewRuns).map(([lane, reviewRunId]) => ({ lane, reviewRunId,
      runId: launch(f, lane, reviewRunId, lane === TEST_COVERAGE
        ? { conclusion: 'findings', findings: [{ desc: evidenceChainDesc, severity: 'medium', category: 'evidence_chain', files: ['strs/strs_test.go'] }] }
        : { conclusion: 'pass', note: `Scripted ${lane} pass: reviewed strs.go and its tests; no blocking issue.` }) }));
    let coverageImport: CliResult | null = null;
    for (const run of launched) {
      const terminal = waitTerminal(f, run.runId);
      if (!check(terminal.state === 'completed', `S3 ${run.lane.replace('proof-or-stop-review-', '')} managed review completed (${terminal.state}${terminal.reason ? `: ${terminal.reason}` : ''})`)) {
        keep = true;
        return;
      }
      const imported = f.must('managed_review_evidence_import', { runId: run.runId, receiptId: terminal.receiptId });
      if (run.lane === TEST_COVERAGE) coverageImport = imported;
      f.unscript(run.reviewRunId);
    }
    check(/Reclassified 1 evidence-chain item\(s\)/.test(coverageImport?.out ?? '') && /Framework next action: /.test(coverageImport?.out ?? ''),
      'S3 the import prints the reclassification and the framework next action');
    const findings = f.store().readFindings(STORY).findings;
    check(findings.length === 0, `S3 no finding was imported (found ${findings.length})`);
    const coveragePass = f.store().readReviewPasses(STORY).passes.find(pass => pass.agent === TEST_COVERAGE);
    check(!!coveragePass && coveragePass.note.startsWith('No product finding') && coveragePass.note.includes('TestEmptyInput'),
      'S3 the test-coverage lane is admitted as a pass whose note records the reclassified item');
    const event = f.store().readProcessEvents(STORY).find(row => (row.type as string) === 'review_evidence_chain_reclassified');
    check(!!event && JSON.stringify(event).includes('TestEmptyInput'), 'S3 the reclassification is logged as a review_evidence_chain_reclassified process event');
    const refusedNative = f.cli('finding_add', { storyId: STORY, desc: evidenceChainDesc, severity: 'medium', category: 'evidence_chain' });
    check(refusedNative.status !== 0 && /evidence_chain_not_a_finding/.test(refusedNative.out), 'S3 native finding_add refuses category=evidence_chain with the framework action');

    // The reclassified pass must be admissible review evidence all the way to TEST.
    const begun = f.must('review_inventory_begin', { storyId: STORY });
    const epochId = begun.stdout.match(/Review inventory epoch: (\S+)/)?.[1];
    assert.ok(epochId, `inventory epoch id printed:\n${begun.out.slice(-1500)}`);
    f.must('review_inventory_status', { storyId: STORY });
    const critic = MANAGED_INVENTORY_CRITIC_LANE;
    f.must('dispatch', { storyId: STORY, agentType: critic, reviewPurpose: 'inventory-completeness', inventoryEpochId: epochId, summary: true });
    f.must('review_run_start', { storyId: STORY, agent: critic, lane: critic, reviewPurpose: 'inventory-completeness', inventoryEpochId: epochId, summary: true });
    const criticRun = f.store().readReviewRuns(STORY).runs.at(-1)!.reviewRunId;
    const criticRunId = launch(f, critic, criticRun, { conclusion: 'pass', note: 'Scripted inventory critic: every required lane passed with zero findings; nothing to disposition.',
      inventoryCritic: { epochId, wave: 1, findingDispositions: [] } });
    const criticTerminal = waitTerminal(f, criticRunId);
    assert.equal(criticTerminal.state, 'completed', `critic terminal ${criticTerminal.state} (${criticTerminal.reason})`);
    f.must('managed_review_evidence_import', { runId: criticRunId, receiptId: criticTerminal.receiptId });
    f.unscript(criticRun);
    f.must('review_inventory_finalize', { storyId: STORY });
    f.must('validate', { story: STORY, focus: 'fast', json: true });
    const begin = f.must('certification_window_begin', { storyId: STORY });
    assert.match(begin.stdout, /State: ADMITTED/, begin.out);
    f.must('validate', { story: STORY, json: true });
    const test = f.cli('story_advance', { storyId: STORY, phase: 'TEST' });
    check(test.status === 0 && f.store().readStory(STORY).phase === 'TEST',
      `S3 the Story reaches TEST on the reclassified pass${test.status === 0 ? '' : `: ${test.out.slice(-800)}`}`);
  };
  try {
    scenarios();
  } catch (error) {
    keep = true;
    failures.push(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  [FAIL] unexpected error: ${error instanceof Error ? error.message.slice(0, 3000) : String(error)}`);
  } finally {
    if (keep || failures.length) console.log(`fixture retained for diagnosis: ${f.root}`);
    else f.cleanup();
    try { machine.cleanup(); } catch (error) { console.log(String(error)); }
  }
  if (failures.length) {
    console.log(`evidence-chain-not-findings-smoke: FAIL (${failures.length})`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log('evidence-chain-not-findings-smoke: PASS');
}

await main();
