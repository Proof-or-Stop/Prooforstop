#!/usr/bin/env node
/**
 * Local REVIEW -> TEST -> DONE regression harness for the benchmark owner flow.
 *
 * Benchmark runs take ~2 hours to reach a REVIEW/TEST/DONE gate conflict. This
 * harness reproduces the same owner command sequence in minutes against a temp
 * git repository shaped like the DeepSWE task: a small Go project (no
 * packages/main, no packages/*\/dist), a benchmark-prepared
 * proof-or-stop.config.json (validate.commands = go test, validate.env
 * CONTEXT=abs, artifactContract=none), the managed runtime .gitignore, a Story
 * worktree under .worktrees/<id> on story/<id>, and a docs file that describes
 * the behavior but is outside the scope contract.
 *
 * Every lifecycle command goes through the real CLI (dist/cli.js) from the
 * Story worktree, exactly as the owner runs it. The only simulated part is the
 * model: a fake `codex` executable on PATH replaces the provider. host_run
 * --managedReview / --managedDispatch still build the prompt, spawn the
 * detached worker, seal the terminal receipt and import the evidence; the fake
 * provider only prints the scripted final envelope (reviewer lanes, inventory
 * critic) or runs the scripted CLI command a delivery reviewer would run
 * (delivery_check_set) with the env the worker gave it.
 *
 * Scenarios:
 *   A  happy path must reach DONE and merge story/<id> into main (hard PASS).
 *   B  run-10 dead end: the delivery reviewer requires an update to a docs file
 *      outside the scope contract. Fixed by fix 28 (docs admitted by default);
 *      must now go TEST -> DEV -> REVIEW without PLAN rollback and reach DONE.
 *   C  single host: what the owner must run for the review assurance floor /
 *      review escalation before DONE (observed inside scenario A).
 *   D  run-11 dead end: REVIEW round 1 finds a verified finding -> critic ->
 *      finalize --remediation -> DEV repair by a managed finding-repair
 *      dispatch -> round 2 all pass -> direct finalize (zero-wave
 *      completeness-only receipt, refused by certification) -> cancel ->
 *      fresh saturated epoch + critic -> certification_window_begin ->
 *      validate -> story_advance TEST must not refuse the managed passes with
 *      managed_review_live_head_lineage_invalid; then TEST -> DONE.
 *
 * Machine registries (provider slots, locks) use a disposable fixture machine
 * so the harness never touches the developer's ~/.proof-or-stop admission state.
 *
 * Usage: node packages/main/dist/tasks/e2e-review-to-done-smoke.js [A|B|C|D]...
 *        E2E_R2D_VERBOSE=1 prints every command's output.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import { mergeRuntimeGitignore } from '../core/managed-assets.js';
import { QUALIFIED_MANAGED_REVIEWER_DEFAULTS } from '../core/managed-reviewer-qualification.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { classifierOptionsForCheck, classifyGitStatusRows, isBlockingDirty, readGitStatusLines } from '../core/dirty-worktree-gate.js';
import { MANAGED_INVENTORY_CRITIC_LANE } from '../core/managed-inventory-critic.js';
import { sanitizedFixtureChildEnvironment } from './fixture-environment.js';
import { createFixtureMachineEnvironment } from './helpers/fixture-machine-environment.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const MODEL = QUALIFIED_MANAGED_REVIEWER_DEFAULTS.codex;
const FINAL_SCHEMA = 'lattice.managed_review_final_proposal.v1';
const DELIVERY = 'proof-or-stop-review-delivery';
const FULL_SCAN_REASON = 'Go task repository has no requirements corpus; review the whole changed Go package and its docs.';
/** Files whose uncommitted change makes validate / done_prepare refuse (VALIDATION_PUBLICATION_NOT_READY). */
const PUBLICATION_SET = ['test-evidence.json', 'process-events.jsonl', 'closeout-write-receipts.jsonl'];
/** Steps that refuse when the publication set is dirty. */
const PUBLICATION_SENSITIVE = /^(validate \(routine\)|done_prepare|story_advance (TEST|DONE))/;

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

interface Step { scenario: string; label: string; ms: number; exit: number; result: string; dirty: string }
interface CliResult { status: number; stdout: string; stderr: string; out: string }

const DOC_V1 = '# String type\n\n`Upper` returns the upper-case form of a string.\n`Reverse` returns the string reversed by rune.\n';
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
const TESTS = [
  'package strs', '', 'import "testing"', '',
  'func TestBaseline(t *testing.T) {}', '',
  'func TestUpper(t *testing.T) {', '\tif Upper("ab") != "AB" {', '\t\tt.Fatal("upper")', '\t}', '}', '',
  'func TestReverse(t *testing.T) {', '\tif Reverse("héllo") != "olléh" {', '\t\tt.Fatal("reverse")', '\t}', '}', '',
].join('\n');

class Owner {
  readonly root: string;
  readonly worktree: string;
  readonly store: StoryStore;
  private readonly providerBin: string;
  private get installedCliBin(): string { return `${this.root}-installed-cli`; }
  private readonly scripts: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(readonly scenario: string, readonly storyId: string, machineEnv: NodeJS.ProcessEnv, readonly steps: Step[]) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), `e2e-r2d-${scenario}-`)));
    this.worktree = join(this.root, '.worktrees', storyId);
    this.store = new StoryStore(this.root);
    this.providerBin = `${this.root}-provider`;
    this.scripts = join(this.providerBin, 'scripts');
    mkdirSync(this.scripts, { recursive: true });
    writeFakeCodex(this.providerBin, this.scripts);
    // The benchmark host has the installed `proof-or-stop` on PATH for the whole
    // run; a shim for this checkout's dist CLI stands in. It must be on PATH from
    // the first call: PATH is part of the verification environment digest, so
    // adding it later would make earlier verification receipts stale.
    mkdirSync(this.installedCliBin, { recursive: true });
    // The shim re-applies the owner env exactly: /bin/sh adds SHLVL, _ and
    // OLDPWD, and the verification environment digest covers the ambient env,
    // so a pasted hint would otherwise see every earlier receipt as stale.
    // (A real owner runs every command through the same shell, so its env is
    // stable across calls.)
    writeFileSync(join(this.installedCliBin, 'proof-or-stop'), [
      `#!${process.execPath}`,
      `const { spawnSync } = require('child_process'); const env = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(this.installedCliBin, 'env.json'))}, 'utf8'));`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { stdio: 'inherit', env });`,
      'process.exit(r.status ?? 1);', '',
    ].join('\n'), { mode: 0o755 });
    this.env = {
      ...sanitizedFixtureChildEnvironment(machineEnv),
      PATH: `${this.providerBin}:${this.installedCliBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      PROOF_OR_STOP_AGENT: 'main',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: `e2e-review-to-done-owner-${scenario}`,
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: 'main',
      PROOF_OR_STOP_USAGE_LEDGER: '0',
    };
    writeFileSync(join(this.installedCliBin, 'env.json'), JSON.stringify(this.env));
    this.buildFixture();
  }

  cleanup(): void {
    rmSync(this.providerBin, { recursive: true, force: true });
    rmSync(this.installedCliBin, { recursive: true, force: true });
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Benchmark-shaped Go repo; Story in DEV with the implementation committed on story/<id>. */
  private buildFixture(): void {
    const { root, worktree, storyId } = this;
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Bench Owner']);
    git(root, ['config', 'user.email', 'owner@bench.invalid']);
    write(root, 'go.mod', 'module example.com/strs\n\ngo 1.21\n');
    write(root, 'strs/strs.go', 'package strs\n\n// Upper returns s unchanged (baseline bug).\nfunc Upper(s string) string { return s }\n');
    write(root, 'strs/strs_test.go', 'package strs\n\nimport "testing"\n\nfunc TestBaseline(t *testing.T) {}\n');
    write(root, 'docs/types/string.md', DOC_V1);
    write(root, '.gitignore', `.worktrees/\n${mergeRuntimeGitignore('')}`);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'task baseline']);
    // Same shape as the bench adapter's prepare_workflow.py.
    write(root, 'proof-or-stop.config.json', `${JSON.stringify({
      artifactContract: 'none',
      validate: {
        commands: [{ id: 'benchmark-go-strs', command: 'go', args: ['test', '-v', './strs'], env: { CONTEXT: 'abs' }, focus: ['fast'], timeoutMs: 270000 }],
        env: { CONTEXT: 'abs' },
      },
    }, null, 2)}\n`);
    git(root, ['add', 'proof-or-stop.config.json']);
    git(root, ['commit', '-qm', 'benchmark: configure PoS Go validation before Story']);

    const now = new Date().toISOString();
    const intent = (id: string, desc: string) => ({
      happy: [{ id, desc, type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const, expectation: 'absolute_pass' as const, requirementSource: 'story' as const }],
      edge: [], adversarial: [],
    });
    // docs/types/string.md is deliberately in no item's files, so it is outside the scope contract.
    const files = { modify: ['strs/strs.go'], create: [], test: ['strs/strs_test.go'] };
    // Metadata as the INIT_CHECK commit leaves it on main; the phase is DEV.
    this.store.writeStory(storyId, {
      storyId, name: 'strs-upper-reverse', title: 'Implement Upper and Reverse string helpers',
      description: 'Implement strs.Upper and strs.Reverse as documented in docs/types/string.md.',
      type: 'bug', phase: 'DEV', priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      worktree: { path: worktree, branch: `story/${storyId}`, createdAt: now },
      events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
    });
    this.store.writeChecklist(storyId, { items: [
      { id: 'CHK-001', title: 'Upper returns the upper-case form', context: 'strs.Upper returns its input unchanged; docs/types/string.md promises upper-casing.',
        userSees: 'go test -v ./strs -run TestUpper prints --- PASS: TestUpper', status: 'in_progress', startTime: now, endTime: null,
        files, verificationIntent: intent('CHK-001:happy:0', 'TestUpper passes') },
      { id: 'CHK-002', title: 'Reverse returns the rune-reversed string', context: 'strs.Reverse does not exist; docs/types/string.md promises rune reversal.',
        userSees: 'go test -v ./strs -run TestReverse prints --- PASS: TestReverse', status: 'in_progress', startTime: now, endTime: null,
        files, verificationIntent: intent('CHK-002:happy:0', 'TestReverse passes') },
    ] });
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', `proof-or-stop: INIT_CHECK metadata ${storyId}`]);
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', '-q', worktree, `story/${storyId}`]);
    write(worktree, 'strs/strs.go', IMPL);
    write(worktree, 'strs/strs_test.go', TESTS);
    git(worktree, ['add', '-A']);
    git(worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'implement Upper and Reverse']);
  }

  /** One real CLI call from the Story worktree (the owner's cwd), timed and dirty-checked. */
  cli(command: string, payload: Record<string, unknown>, opts: { label?: string } = {}): CliResult {
    const label = opts.label ?? command;
    const cwd = existsSync(this.worktree) ? this.worktree : this.root;
    const before = this.publicationDirt();
    const started = Date.now();
    const run = spawnSync(process.execPath, [CLI, command, JSON.stringify(payload)], {
      cwd, encoding: 'utf8', env: this.env, maxBuffer: 64 * 1024 * 1024,
    });
    const ms = Date.now() - started;
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const exit = run.status ?? -1;
    const result = exit === 0 ? summarize(command, run.stdout ?? '') : firstError({ status: exit, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out });
    const dirty = this.dirtyNote(label, before);
    this.steps.push({ scenario: this.scenario, label, ms, exit, result, dirty });
    if (process.env.E2E_R2D_VERBOSE) console.log(`--- ${label} exit=${exit} ${ms}ms\n${out.slice(0, 4000)}`);
    return { status: exit, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out };
  }

  /**
   * Run a hinted command line literally through /bin/sh, as an owner pasting it
   * would, with the same env (including the installed-CLI shim on PATH).
   */
  shell(label: string, commandLine: string): CliResult {
    const before = this.publicationDirt();
    const started = Date.now();
    const run = spawnSync('/bin/sh', ['-c', commandLine], {
      cwd: this.worktree, encoding: 'utf8', env: this.env, maxBuffer: 64 * 1024 * 1024,
    });
    const ms = Date.now() - started;
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const exit = run.status ?? -1;
    const result = exit === 0 ? summarize(label, run.stdout ?? '') : firstError({ status: exit, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out });
    this.steps.push({ scenario: this.scenario, label, ms, exit, result, dirty: this.dirtyNote(label, before) });
    if (process.env.E2E_R2D_VERBOSE) console.log(`--- ${label} exit=${exit} ${ms}ms\n${out.slice(0, 4000)}`);
    return { status: exit, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out };
  }

  mustCli(command: string, payload: Record<string, unknown>, opts: { label?: string } = {}): CliResult {
    const run = this.cli(command, payload, opts);
    assert.equal(run.status, 0, `[${this.scenario}] ${opts.label ?? command} failed:\n${run.out.slice(-3000)}`);
    return run;
  }

  /** Publication-set files of this Story that are dirty now (they make validate/done_prepare refuse). */
  private publicationDirt(): string[] {
    if (!existsSync(this.worktree)) return [];
    const storyRel = `.proof-or-stop/story/actives/${this.storyId}/`;
    // Untrimmed: git()'s trim() would eat the first row's leading status space
    // (" M path"), so slice(3) mangled exactly the first dirty path.
    return execFileSync('git', ['status', '--porcelain'], { cwd: this.worktree, encoding: 'utf8' }).split('\n')
      .filter(Boolean).map(line => line.slice(3))
      .filter(path => path.startsWith(storyRel) && PUBLICATION_SET.includes(path.slice(storyRel.length)));
  }

  /**
   * After every command: material (non-metadata) dirt blocks review_run_start,
   * PRE_CERT and DONE, so it must never appear (hard assert, real classifier).
   * Dirty publication-set metadata is recorded, and flagged WOULD-BLOCK when
   * it was already dirty before a step that refuses it.
   */
  private dirtyNote(label: string, dirtyBefore: string[]): string {
    if (!existsSync(this.worktree)) return 'worktree removed';
    resetConfigCache();
    const status = readGitStatusLines(this.worktree);
    assert.ok(status.ok, 'git status readable');
    const classification = classifyGitStatusRows(status.ok ? status.lines : [],
      classifierOptionsForCheck(loadConfig(this.worktree), this.storyId, new StoryStore(this.worktree), this.worktree));
    const blocking = isBlockingDirty(classification);
    assert.equal(blocking.blocked, false, `[${this.scenario}] ${label} left blocking dirt: ${blocking.blockingPaths.join(', ')}`);
    const pub = this.publicationDirt();
    const notes: string[] = [];
    if (PUBLICATION_SENSITIVE.test(label) && dirtyBefore.length) notes.push(`WOULD-BLOCK(dirty before): ${dirtyBefore.map(base).join(',')}`);
    if (pub.length) notes.push(`dirty after: ${pub.map(base).join(',')}`);
    return notes.join('; ') || 'clean';
  }

  script(key: string, script: { final: string; commands?: string[][] }): void {
    writeFileSync(join(this.scripts, `${key}.json`), JSON.stringify(script));
  }

  unscript(key: string): void {
    const path = join(this.scripts, `${key}.json`);
    if (existsSync(path)) unlinkSync(path);
  }

  providerCommandLog(): string {
    const path = join(this.scripts, 'commands.log');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  readEvidence(): Record<string, unknown> {
    const candidate = new StoryStore(this.worktree).readCandidateSpecSet(this.storyId);
    assert.ok(candidate, 'review_round_prepare persisted the candidate route');
    const filesReadFully = [...new Set(['strs/strs.go', 'strs/strs_test.go', 'docs/types/string.md', ...candidate.candidateSpecSet])].sort();
    return {
      readManifest: { filesReadFully, filesTriagedByName: [], scanEscalationReason: candidate.scanEscalationReason ?? null,
        candidateSpecSetDigest: candidate.artifactDigest, corpusDigest: candidate.corpusDigest },
      readLog: { filesReadFully, filesTriagedByName: [], summary: { readCount: filesReadFully.length, tokenCount: null }, digest: 'a'.repeat(64) },
    };
  }

  phase(): string {
    return new StoryStore(existsSync(this.worktree) ? this.worktree : this.root).readStory(this.storyId).phase;
  }
}

function base(path: string): string { return path.split('/').pop() ?? path; }

function summarize(command: string, stdout: string): string {
  const json = parseJson(stdout);
  if (json) {
    const run = json.run as Record<string, unknown> | undefined;
    const terminal = run?.terminal as Record<string, unknown> | null | undefined;
    if (run?.state) return `run ${String(run.state)}${terminal?.reason ? ` (${String(terminal.reason)})` : ''}`;
    if (json.status) return `status=${String(json.status)}${json.blockedAt ? ` blockedAt=${String(json.blockedAt)}` : ''}`;
    if (json.canAttemptDone !== undefined) return `canAttemptDone=${String(json.canAttemptDone)}`;
    if (json.reviewRuns) return `lanes=${Object.keys(json.reviewRuns as object).length}`;
  }
  const line = stdout.split('\n').find(l => /State: |advanced to|imported|saved|recorded|Critic receipt|^Checklist|Scope contract|Delivery check|Blockers: /.test(l));
  return line ?? `${command} ok`;
}

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)) as Record<string, unknown>; } catch { return null; }
}

function firstError(run: CliResult): string {
  const line = run.out.split('\n').find(l => /^Error: |Cannot |refused|not allowed|\[[a-z_]+\]/.test(l)) ?? run.out.trim().split('\n').at(-1) ?? '';
  return line.replace(/^Error: /, '').slice(0, 260);
}

/**
 * The provider seam. host_run starts the `codex` CLI in JSON mode with the
 * prompt on stdin and `-C <cwd>`. This stand-in finds the script whose key (a
 * reviewRunId, or the delivery role name) occurs in the prompt, runs the
 * script's commands with the environment the managed worker gave it (a real
 * reviewer runs them as tool calls), and prints the final message as the Codex
 * JSON event stream.
 */
function writeFakeCodex(bin: string, scripts: string): void {
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const dir = ${JSON.stringify(scripts)};
let input = ''; process.stdin.on('data', d => { input += d; }); process.stdin.on('end', () => {
  const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'thread.started', thread_id: 'fake-codex-' + process.pid });
  emit({ type: 'turn.started' });
  const key = fs.readdirSync(dir).filter(f => f.endsWith('.json')).find(f => input.includes(f.slice(0, -5)));
  if (!key) { fs.writeFileSync(path.join(dir, 'unmatched-' + process.pid + '.txt'), input); process.exit(3); }
  const script = JSON.parse(fs.readFileSync(path.join(dir, key), 'utf8'));
  const c = process.argv.indexOf('-C'); const cwd = c > 0 ? process.argv[c + 1] : process.cwd();
  for (const argv of script.commands || []) {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: process.env });
    const out = (r.stdout || '') + (r.stderr || '');
    fs.appendFileSync(path.join(dir, 'commands.log'), JSON.stringify({ argv: argv.slice(2, 3), status: r.status, out: out.slice(-1500) }) + '\\n');
    emit({ type: 'item.completed', item: { type: 'command_execution', command: argv.slice(2, 3).join(' '), aggregated_output: out.slice(-2000), exit_code: r.status } });
  }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: script.final } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } });
});
`, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Owner flow segments, in the order the benchmark owner follows them

function devToReview(o: Owner): void {
  const id = o.storyId;
  o.mustCli('dev_memory_preflight_ack', { storyId: id });
  o.mustCli('scope_contract_init_from_plan', { storyId: id });
  o.mustCli('verification_evidence_add', { storyId: id, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'logic_test',
    command: 'go test -v ./strs -run TestUpper', selector: '--- PASS: TestUpper', note: 'Pinned focused go test proves Upper upper-cases its input.' }, { label: 'verification_evidence_add CHK-001' });
  o.mustCli('verification_evidence_add', { storyId: id, itemId: 'CHK-002', intentRef: 'CHK-002:happy:0', kind: 'logic_test',
    command: 'go test -v ./strs -run TestReverse', selector: '--- PASS: TestReverse', note: 'Pinned focused go test proves Reverse reverses by rune.' }, { label: 'verification_evidence_add CHK-002' });
  o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-001', status: 'done' }, { label: 'checklist_update CHK-001 done' });
  o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-002', status: 'done' }, { label: 'checklist_update CHK-002 done' });
  o.mustCli('story_advance', { storyId: id, phase: 'REVIEW' }, { label: 'story_advance REVIEW' });
  assert.equal(o.phase(), 'REVIEW');
}

function short(lane: string): string { return lane.replace('proof-or-stop-review-', ''); }

function launchManagedReview(o: Owner, lane: string, reviewRunId: string, envelope: Record<string, unknown>): string {
  o.script(reviewRunId, { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId: o.storyId, providerAgent: lane, lane, reviewRunId, ...envelope, ...o.readEvidence() }) });
  const launched = o.mustCli('host_run', { host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort, storyId: o.storyId,
    agentType: lane, reviewRunId, lane, managedReview: true, detach: true, json: true }, { label: `host_run --managedReview ${short(lane)}` });
  return String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
}

function waitTerminal(o: Owner, label: string, runId: string): { state: string; reason: string; receiptId: string } {
  const status = o.mustCli('host_run_status', { runId, untilTerminal: true, json: true }, { label: `host_run_status ${label}` });
  const json = parseJson(status.stdout)!;
  const run = json.run as Record<string, unknown>;
  const terminal = run.terminal as Record<string, unknown> | null;
  return { state: String(run.state), reason: String(terminal?.reason ?? ''), receiptId: String((json.receipt as Record<string, unknown> | undefined)?.receiptId ?? '') };
}

type LaneEnvelope = (lane: string) => Record<string, unknown>;
const PASS_ENVELOPE: LaneEnvelope = lane => ({ conclusion: 'pass', note: `Scripted ${lane} pass: reviewed strs.go Upper/Reverse and their focused tests; no blocking issue.` });

function reviewRound(o: Owner, envelopeFor: LaneEnvelope = PASS_ENVELOPE): void {
  const id = o.storyId;
  let prepared = o.cli('review_round_prepare', { storyId: id, json: true });
  if (prepared.status !== 0) {
    // The CLI asks for a justified broad scan when the task repo has no requirements corpus.
    assert.match(prepared.out, /fullScanReason/, `review_round_prepare failed:\n${prepared.out.slice(-2000)}`);
    prepared = o.mustCli('review_round_prepare', { storyId: id, json: true, fullScanReason: FULL_SCAN_REASON }, { label: 'review_round_prepare --fullScanReason' });
  }
  const reviewRuns = parseJson(prepared.stdout)!.reviewRuns as Record<string, string>;
  assert.ok(Object.keys(reviewRuns).length >= 1, 'at least one launchable lane');
  // Controller order: launch every lane, then wait for all, then import.
  const launched = Object.entries(reviewRuns).map(([lane, reviewRunId]) => ({ lane, reviewRunId, receiptId: '',
    runId: launchManagedReview(o, lane, reviewRunId, envelopeFor(lane)) }));
  for (const run of launched) {
    const terminal = waitTerminal(o, short(run.lane), run.runId);
    assert.equal(terminal.state, 'completed', `${run.lane} managed review terminal ${terminal.state} (${terminal.reason})`);
    run.receiptId = terminal.receiptId;
  }
  for (const run of launched) {
    o.mustCli('managed_review_evidence_import', { runId: run.runId, receiptId: run.receiptId }, { label: `managed_review_evidence_import ${short(run.lane)}` });
    o.unscript(run.reviewRunId);
  }
}

interface InventoryOpts {
  /** Critic dispositions (default: none, i.e. a zero-finding wave). */
  dispositions?: Record<string, unknown>[];
  /** Label suffix for the timeline. */
  tag?: string;
}

/** begin -> critic (managed) -> returns the epoch id; finalize is the caller's. */
function inventoryCritic(o: Owner, opts: InventoryOpts = {}): string {
  const id = o.storyId;
  const tag = opts.tag ? ` ${opts.tag}` : '';
  const begun = o.mustCli('review_inventory_begin', { storyId: id }, { label: `review_inventory_begin${tag}` });
  const epochId = begun.stdout.match(/Review inventory epoch: (\S+)/)?.[1];
  assert.ok(epochId, `inventory epoch id printed:\n${begun.out.slice(-1500)}`);
  const status = o.mustCli('review_inventory_status', { storyId: id }, { label: `review_inventory_status${tag}` });
  assert.match(status.stdout, /REVIEW_INVENTORY_CRITIC_INCOMPLETE/, 'lanes complete, critic pending');
  const critic = MANAGED_INVENTORY_CRITIC_LANE;
  o.mustCli('dispatch', { storyId: id, agentType: critic, reviewPurpose: 'inventory-completeness', inventoryEpochId: epochId, summary: true }, { label: `dispatch critic${tag}` });
  o.mustCli('review_run_start', { storyId: id, agent: critic, lane: critic, reviewPurpose: 'inventory-completeness', inventoryEpochId: epochId, summary: true }, { label: `review_run_start critic${tag}` });
  const criticRun = new StoryStore(o.worktree).readReviewRuns(id).runs.at(-1)!.reviewRunId;
  const dispositions = opts.dispositions ?? [];
  const runId = launchManagedReview(o, critic, criticRun, { conclusion: 'pass',
    note: dispositions.length ? 'Scripted inventory critic: dispositioned every verified finding of this wave.' : 'Scripted inventory critic: every required lane passed with zero findings; nothing to disposition.',
    inventoryCritic: { epochId, wave: 1, findingDispositions: dispositions } });
  const terminal = waitTerminal(o, `critic${tag}`, runId);
  assert.equal(terminal.state, 'completed', `critic terminal ${terminal.state} (${terminal.reason})`);
  o.mustCli('managed_review_evidence_import', { runId, receiptId: terminal.receiptId }, { label: `managed_review_evidence_import critic${tag}` });
  o.unscript(criticRun);
  return epochId!;
}

function inventory(o: Owner): void {
  inventoryCritic(o);
  const finalized = o.mustCli('review_inventory_finalize', { storyId: o.storyId });
  assert.match(finalized.stdout, /State: FINALIZED/);
}

function precertToTest(o: Owner): void {
  const id = o.storyId;
  o.mustCli('validate', { story: id, focus: 'fast', json: true }, { label: 'validate --focus=fast' });
  const begin = o.mustCli('certification_window_begin', { storyId: id });
  assert.match(begin.stdout, /State: ADMITTED/, begin.out);
  o.mustCli('validate', { story: id, json: true }, { label: 'validate (routine)' });
  const status = o.mustCli('certification_window_status', { storyId: id });
  assert.match(status.stdout, /Next: proof-or-stop story_advance --storyId=\S+ --phase=TEST/, status.out);
  o.mustCli('story_advance', { storyId: id, phase: 'TEST' }, { label: 'story_advance TEST' });
  assert.equal(o.phase(), 'TEST');
}

function liveSmoke(o: Owner): void {
  const run = o.mustCli('live_smoke_transcript', { storyId: o.storyId, capture: 'go test -v ./strs', write: true });
  assert.match(run.stdout, /\[PASS\] done\.live-smoke-transcript/, `live smoke did not pass:\n${run.out.slice(0, 1500)}`);
}

function deliveryReview(o: Owner, docsPromises: Record<string, unknown>[]): { state: string; reason: string; commandLog: string } {
  const payload = {
    storyId: o.storyId, docsPromises,
    realMachineTests: [
      { featureId: 'CHK-001', transcript: 'go test -v ./strs -run TestUpper -> --- PASS: TestUpper' },
      { featureId: 'CHK-002', transcript: 'go test -v ./strs -run TestReverse -> --- PASS: TestReverse' },
    ],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'Both string helpers are implemented and verified by focused go tests.' },
    agentId: DELIVERY,
  };
  o.script(DELIVERY, { commands: [[process.execPath, CLI, 'delivery_check_set', JSON.stringify(payload)]], final: 'Delivery review complete; delivery_check_set recorded.' });
  const launched = o.mustCli('host_run', { host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort, storyId: o.storyId,
    agentType: DELIVERY, managedDispatch: true, detach: true, json: true }, { label: 'host_run --managedDispatch delivery' });
  const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
  const terminal = waitTerminal(o, 'delivery', runId);
  o.unscript(DELIVERY);
  return { state: terminal.state, reason: terminal.reason, commandLog: o.providerCommandLog() };
}

function authoredCloseout(o: Owner): void {
  const id = o.storyId;
  o.mustCli('dev_memory_finish_decision', { storyId: id, decision: 'no-reusable-lesson', reason: 'Harness fixture: trivial string helpers, no reusable lesson.' });
  o.mustCli('summary_set', { storyId: id, changes: 'strs/strs.go: Upper now upper-cases; new Reverse reverses by rune.', usage: 'strs.Upper("ab") == "AB"; strs.Reverse("héllo") == "olléh"',
    expectedOutcome: 'go test -v ./strs prints --- PASS: TestUpper and --- PASS: TestReverse', actualTranscript: 'go test -v ./strs: --- PASS: TestUpper, --- PASS: TestReverse, ok',
    outcomeDiff: 'no difference', acceptanceVerdict: 'accepted', outcomeKind: 'success', limitations: 'none — fully covered',
    pitfalls: 'Harness fixture; the only retry was the documented fullScanReason step of review_round_prepare.' });
}

function closureRow(o: Owner, label: string, rowId: string): Record<string, unknown> | undefined {
  const closure = o.mustCli('done_closure', { storyId: o.storyId, json: true }, { label });
  const rows = (parseJson(closure.stdout)?.blockers ?? []) as Record<string, unknown>[];
  return rows.find(row => row.id === rowId);
}

// ---------------------------------------------------------------------------
// Scenarios

interface Outcome { name: string; status: 'PASS' | 'FAIL' | 'OBSERVED'; lines: string[] }

function scenarioA(machineEnv: NodeJS.ProcessEnv, steps: Step[]): { a: Outcome; c: Outcome } {
  const aName = 'A happy path REVIEW -> TEST -> DONE';
  const o = new Owner('A', 'B-e2e0', machineEnv, steps);
  const c: Outcome = { name: 'C single host: review assurance floor / escalation before DONE', status: 'OBSERVED', lines: [] };
  try {
    devToReview(o);
    reviewRound(o);
    inventory(o);
    precertToTest(o);
    liveSmoke(o);
    const delivery = deliveryReview(o, [
      { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
      { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
    ]);
    assert.equal(delivery.state, 'completed', `delivery reviewer terminal ${delivery.state} (${delivery.reason})\n${delivery.commandLog}`);
    authoredCloseout(o);

    // --- Scenario C: what a single-host owner must still produce before DONE.
    const floor = closureRow(o, 'done_closure (before host verdict)', 'review-assurance-floor');
    const escalation = closureRow(o, 'done_closure (escalation row)', 'review-escalation');
    const floorReason = String(floor?.reason ?? '');
    const hinted = floorReason.match(/(proof-or-stop autopilot_review_submit [^#\n]*?--storyFilesHash=\S+)/)?.[1] ?? '';
    assert.ok(hinted, `C: the floor names no runnable proof-or-stop autopilot_review_submit writer:\n${floorReason.slice(0, 2000)}`);
    assert.doesNotMatch(floorReason, /bin\/proof-or-stop\.js/, 'C: floor hints must not point at a checkout-relative bin/ wrapper');
    c.lines.push(`done_closure review-assurance-floor: status=${String(floor?.status)} blocking=${String(floor?.blocking)} code=${floorReason.match(/\[(review_assurance_floor_[a-z_]+)\]/)?.[1] ?? 'n/a'}`);
    c.lines.push(`  "${floorReason.match(/local rounds: [0-9/]+ with [0-9]+ PASS host/)?.[0] ?? '?'}" although 3 managed lanes + critic passed: only autopilot_review_submit host verdicts count (core/review-assurance-floor.ts:912-917)`);
    c.lines.push(`done_closure review-escalation: status=${String(escalation?.status)} "${String(escalation?.reason ?? '').slice(0, 80)}"`);
    c.lines.push(`  hinted writer: ${hinted.slice(0, 110)}...`);
    assert.ok(hinted.includes(`--materialDigest=${currentMaterialHash(o.worktree, 'HEAD', o.worktree)}`), 'C: hint carries the current materialDigest');
    assert.ok(hinted.includes(`--storyFilesHash=${currentStoryFilesHash(o.worktree, 'HEAD', o.worktree)}`), 'C: hint carries the current storyFilesHash');
    o.mustCli('review_escalation_status', { storyId: o.storyId });
    // The owner pastes the hinted writer as printed; the installed CLI is on PATH.
    const submit = o.shell('autopilot_review_submit (literal floor hint)', hinted);
    assert.equal(submit.status, 0, `C: the literal floor hint failed in the task worktree:\n${submit.out.slice(-2000)}`);
    c.lines.push(`owner pasted the floor hint (proof-or-stop autopilot_review_submit --provider=local --deriveBindings --decision=pass --materialDigest=<current> ...) -> exit ${submit.status} (accepted from the owner session: reviewerWrite, core/command-policy.ts:597)`);
    const floorAfter = closureRow(o, 'done_closure (after host verdict)', 'review-assurance-floor');
    c.lines.push(`done_closure review-assurance-floor after one local host verdict: status=${String(floorAfter?.status)}`);
    assert.notEqual(floorAfter?.blocking, true, 'one local host verdict satisfies the one-local-round floor');
    const eventsDirty = git(o.worktree, ['status', '--porcelain', '--', `.proof-or-stop/story/actives/${o.storyId}/process-events.jsonl`]) !== '';
    c.lines.push(`autopilot_review_submit leaves process-events.jsonl uncommitted: ${eventsDirty ? 'yes' : 'no'}`);
    assert.equal(eventsDirty, false, 'C: autopilot_review_submit must commit its host_verdict event (else done_prepare refuses VALIDATION_PUBLICATION_NOT_READY)');

    // done_prepare, as the floor guidance says to rerun it after the writer ran.
    const prepare = o.cli('done_prepare', { storyId: o.storyId, json: true });
    const prepared = parseJson(prepare.stdout);
    c.lines.push(`done_prepare after the host verdict: exit ${prepare.status} status=${String(prepared?.status)} blockedAt=${String(prepared?.blockedAt ?? '-')}`);
    if (prepared?.blockedAt) c.lines.push(`  ${String(prepared.reason).slice(0, 230)} (handlers/verifier.ts:2214-2239)`);
    assert.doesNotMatch(prepare.out, /VALIDATION_PUBLICATION_NOT_READY/, 'C: done_prepare after the host verdict must not refuse on unpublished metadata');

    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    assert.equal(done.status, 0, `A: story_advance DONE refused:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE', 'main store records DONE');
    assert.match(git(o.root, ['log', '--format=%s', '-3', 'main']), new RegExp(`merge: ${o.storyId} `), 'story branch merged into main');
    assert.match(readFileSync(join(o.root, 'strs/strs.go'), 'utf8'), /func Reverse/, 'story code is on main');
    assert.equal(existsSync(o.worktree), false, 'story worktree removed');
    assert.equal(git(o.root, ['branch', '--list', `story/${o.storyId}`]), '', 'story branch deleted');
    const a: Outcome = { name: aName, status: 'PASS', lines: [
      `DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`,
      ...(prepared?.blockedAt ? [`note: done_prepare BLOCKED at ${String(prepared.blockedAt)}, story_advance DONE still passed (see C)`] : []),
    ] };
    o.cleanup();
    return { a, c };
  } catch (error) {
    console.log(`A fixture retained for diagnosis: ${o.root}`);
    return { a: { name: aName, status: 'FAIL', lines: [error instanceof Error ? error.message : String(error)] }, c };
  }
}

function scenarioB(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  // Run 10 dead end, fixed on bench/speed-int by fix 28 (classifyScopePath
  // admits .md/.mdx/.rst/.adoc docs by default unless protected/excluded).
  // Expected now: the reviewer-required docs update goes TEST -> DEV -> REVIEW
  // with no PLAN rollback, and the Story reaches DONE.
  const name = 'B delivery reviewer requires a docs update outside the scope contract (run 10)';
  const o = new Owner('B', 'B-e2e1', machineEnv, steps);
  const lines: string[] = [];
  const verifiedPromises = [
    { docPath: 'docs/types/string.md', promise: 'Upper returns the Unicode upper-case form of a string (strings.ToUpper).', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
    { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
  ];
  try {
    devToReview(o);
    reviewRound(o);
    inventory(o);
    precertToTest(o);
    liveSmoke(o);
    // The reviewer finds the docs promise stale: the code maps Unicode letters, the doc must say so.
    const delivery = deliveryReview(o, [
      // status=unverified may carry no evidence/verifiedBy (core/delivery-promise-outcome.ts:103-126).
      { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string; the doc must state that strings.ToUpper also maps Unicode letters.', status: 'unverified' },
      verifiedPromises[1]!,
    ]);
    assert.equal(delivery.state, 'completed', `delivery reviewer terminal ${delivery.state} (${delivery.reason})\n${delivery.commandLog}`);
    authoredCloseout(o);
    const refused = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE (unverified promise)' });
    assert.notEqual(refused.status, 0, 'an unverified docs promise must block DONE');
    assert.match(refused.out, /\[unverified_promise\]/);
    lines.push(`story_advance DONE with the unverified docs promise: refused [unverified_promise] (core/machine.ts:1077), as expected`);
    const waiver = o.cli('delivery_waiver_add', { storyId: o.storyId, promiseId: 'docs/types/string.md',
      waiverReason: 'Attempting the hinted waiver path on a managed, terminal-sealed delivery check.' });
    lines.push(`delivery_waiver_add (hinted by the refusal): exit ${waiver.status}: ${waiver.status === 0 ? 'accepted' : firstError(waiver)} (handlers/delivery-check.ts:69)`);

    // Recovery: rework in DEV, update the doc, re-earn evidence, return to REVIEW.
    o.mustCli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (TEST->DEV)' });
    write(o.worktree, 'docs/types/string.md', DOC_V1.replace('upper-case form of a string.', 'Unicode upper-case form of a string (strings.ToUpper).'));
    git(o.worktree, ['add', 'docs/types/string.md']);
    git(o.worktree, ['-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'docs: Upper maps Unicode letters']);
    // The docs commit moves material, so the pinned evidence must be re-earned first.
    for (const [itemId, test] of [['CHK-001', 'TestUpper'], ['CHK-002', 'TestReverse']] as const) {
      o.mustCli('verification_evidence_add', { storyId: o.storyId, itemId, intentRef: `${itemId}:happy:0`, kind: 'logic_test',
        command: `go test -v ./strs -run ${test}`, selector: `--- PASS: ${test}`, note: `Re-earned pinned evidence for ${test} after the docs commit.` }, { label: `verification_evidence_add ${itemId} (re-earn)` });
    }
    const check = o.cli('scope_contract_check', { storyId: o.storyId, json: true });
    lines.push(`scope_contract_check after the docs commit: status=${String(parseJson(check.stdout)?.status ?? firstError(check))}`);
    const review = o.cli('story_advance', { storyId: o.storyId, phase: 'REVIEW' }, { label: 'story_advance REVIEW (docs change)' });
    assert.equal(review.status, 0, `B: docs update cannot re-enter REVIEW without a PLAN rollback (run-10 dead end is back):\n${firstError(review)}`);
    lines.push('story_advance REVIEW with the docs change: ok (no PLAN rollback)');

    // Second review round over the new material, then PRE_CERT and TEST again.
    reviewRound(o);
    inventory(o);
    precertToTest(o);
    liveSmoke(o);
    const second = deliveryReview(o, verifiedPromises);
    assert.equal(second.state, 'completed', `second delivery review terminal ${second.state} (${second.reason})`);
    authoredCloseout(o);
    // Single host: after a rework the floor asks for more degraded host rounds; submit until it passes.
    const floor = closureRow(o, 'done_closure (floor after rework)', 'review-assurance-floor');
    const floorReason = String(floor?.reason ?? '');
    lines.push(`review-assurance-floor after the rework: ${floorReason.match(/required assurance: [a-z-]+/)?.[0] ?? '?'}; ${floorReason.match(/failure signals: (.*?) - (?:high-risk|review assurance)/)?.[1] ?? '?'}`);
    let rounds = 0;
    for (let round = 1; round <= 3; round += 1) {
      o.mustCli('autopilot_review_submit', { storyId: o.storyId, runId: `${o.storyId}-degraded-r${round}`, hostId: 'e2e-single-host', provider: 'local',
        sessionId: `local-reviewer-r${round}`, decision: 'pass', deriveBindings: true,
        materialDigest: currentMaterialHash(o.worktree, 'HEAD', o.worktree), storyFilesHash: currentStoryFilesHash(o.worktree, 'HEAD', o.worktree) }, { label: `autopilot_review_submit r${round}` });
      rounds = round;
      if (closureRow(o, `done_closure (after host verdict r${round})`, 'review-assurance-floor')?.blocking !== true) break;
    }
    lines.push(`owner had to submit ${rounds} single-host autopilot_review_submit round(s) before DONE (REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS=3, core/review-assurance-floor.ts:33,899-903)`);
    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    assert.equal(done.status, 0, `B: story_advance DONE refused after the docs rework:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE');
    assert.match(readFileSync(join(o.root, 'docs/types/string.md'), 'utf8'), /Unicode upper-case/, 'docs update merged into main');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}; docs update merged`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`B fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

const D_FINDING = {
  desc: 'Reverse has no focused test for an empty string: Reverse("") must return "" without indexing r[-1].',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};

/** A material commit makes the pinned focused evidence stale; the owner re-earns it. */
function reEarnEvidence(o: Owner, why: string): void {
  for (const [itemId, test] of [['CHK-001', 'TestUpper'], ['CHK-002', 'TestReverse']] as const) {
    o.mustCli('verification_evidence_add', { storyId: o.storyId, itemId, intentRef: `${itemId}:happy:0`, kind: 'logic_test',
      command: `go test -v ./strs -run ${test}`, selector: `--- PASS: ${test}`, note: `Re-earned pinned evidence for ${test} ${why}.` }, { label: `verification_evidence_add ${itemId} (re-earn)` });
  }
}

const FINDING_REPAIR = 'proof-or-stop-finding-repair';
const REPAIR_TEST = '\nfunc TestReverseEmpty(t *testing.T) {\n\tif Reverse("") != "" {\n\t\tt.Fatal("empty")\n\t}\n}\n';

/** The owner dispatches the implementer (managed, fake codex); it edits the test and commits, as a real implementer does. */
function devRepairViaManagedDispatch(o: Owner, findingId: string): string {
  const commands = [
    ['/bin/sh', '-c', `printf '%s' '${REPAIR_TEST.replace(/'/g, "'\\''")}' >> strs/strs_test.go && git add strs/strs_test.go && git -c user.name=${FINDING_REPAIR} commit -qm 'test: Reverse of the empty string' && git log --format=%h -1`],
  ];
  o.script(FINDING_REPAIR, { commands, final: 'Added TestReverseEmpty covering Reverse(""); committed.' });
  const launched = o.mustCli('host_run', { host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort, storyId: o.storyId,
    agentType: FINDING_REPAIR, findingId, managedDispatch: true, detach: true, json: true }, { label: 'host_run --managedDispatch finding-repair' });
  const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
  const terminal = waitTerminal(o, 'finding-repair', runId);
  o.unscript(FINDING_REPAIR);
  assert.equal(terminal.state, 'completed', `finding-repair terminal ${terminal.state} (${terminal.reason})\n${o.providerCommandLog()}`);
  return `${terminal.state}; story HEAD ${git(o.worktree, ['log', '--format=%h %s', '-1'])}`;
}

function nextOf(out: string): string {
  return out.split('\n').find(line => line.startsWith('Next: ')) ?? '(no Next)';
}

/** Head bound by the current round's managed review passes. */
function reviewedHead(o: Owner): string {
  const store = new StoryStore(o.worktree);
  const round = store.readStory(o.storyId).currentReviewRound;
  const pass = store.readReviewPasses(o.storyId).passes.filter(row => row.reviewRound === round && row.managedEvidenceBinding
    && row.agent !== MANAGED_INVENTORY_CRITIC_LANE).at(-1) as unknown as { managedEvidenceBinding?: { headHash?: string } } | undefined;
  return pass?.managedEvidenceBinding?.headHash ?? 'HEAD';
}

function scenarioD(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const name = 'D run 11: review finding -> DEV repair -> all-pass round -> PRE_CERT -> TEST -> DONE';
  const o = new Owner('D', 'B-e2e3', machineEnv, steps);
  const lines: string[] = [];
  try {
    devToReview(o);
    reviewRound(o, lane => lane === 'proof-or-stop-review-test-coverage'
      ? { conclusion: 'findings', note: 'Scripted behavior finding: empty-string edge case is untested.', findings: [D_FINDING] }
      : PASS_ENVELOPE(lane));
    const findingId = `${o.storyId}:F-001`;
    inventoryCritic(o, { tag: 'r1', dispositions: [{ finding: { findingId }, disposition: 'verified_family', familyKey: 'reverse-empty-string', reason: 'The empty-string edge of Reverse is untested; one verified family.' }] });
    const refusedFinalize = o.cli('review_inventory_finalize', { storyId: o.storyId }, { label: 'review_inventory_finalize r1' });
    assert.match(refusedFinalize.out, /REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE/);
    const st = o.mustCli('review_inventory_status', { storyId: o.storyId }, { label: 'review_inventory_status r1 (after critic)' });
    assert.match(st.stdout, /Next: proof-or-stop review_inventory_finalize --storyId=\S+ --remediation/);
    const rem = o.mustCli('review_inventory_finalize', { storyId: o.storyId, remediation: true }, { label: 'review_inventory_finalize --remediation r1' });
    assert.match(rem.stdout, /Next: proof-or-stop story_advance --storyId=\S+ --phase=DEV/);
    o.mustCli('story_advance', { storyId: o.storyId, phase: 'DEV' }, { label: 'story_advance DEV (REVIEW->DEV)' });
    const repair = devRepairViaManagedDispatch(o, findingId);
    lines.push(`DEV repair via managed dispatch: ${repair}`);
    reEarnEvidence(o, 'after repair');
    o.mustCli('story_advance', { storyId: o.storyId, phase: 'REVIEW' }, { label: 'story_advance REVIEW (after repair)' });
    reviewRound(o);
    // Round 2 is all-pass with no OPEN epoch, so every import committed. The
    // run-11 owner then finalized directly (commit 5 "review epoch": the
    // prompt bodies/envelopes/runs of this round + a zero-wave receipt).
    const direct = o.mustCli('review_inventory_finalize', { storyId: o.storyId }, { label: 'review_inventory_finalize (direct, no OPEN epoch)' });
    assert.match(direct.stdout, /Authority: inventory-completeness-only/);
    lines.push(`round 2 all-pass; direct review_inventory_finalize -> zero-wave inventory-completeness-only receipt; ${nextOf(direct.out)}`);
    o.mustCli('validate', { story: o.storyId, focus: 'fast', json: true }, { label: 'validate --focus=fast' });
    let begin = o.cli('certification_window_begin', { storyId: o.storyId }, { label: 'certification_window_begin (completeness-only)' });
    lines.push(`certification_window_begin: exit ${begin.status} ${begin.status ? firstError(begin) : 'ADMITTED'}; ${nextOf(begin.out)}`);
    let recovered = false;
    if (begin.status !== 0) {
      // Run 11 retried once (commit 7), then took the printed recovery: cancel
      // the completeness-only receipt (commit 8) and open a fresh saturated
      // zero-new epoch with its critic (commit 9 at finalize).
      begin = o.cli('certification_window_begin', { storyId: o.storyId }, { label: 'certification_window_begin (retry)' });
      lines.push(`certification_window_begin retry: exit ${begin.status} ${begin.status ? firstError(begin) : 'ADMITTED'}`);
    }
    if (begin.status !== 0) {
      const status = o.mustCli('review_inventory_status', { storyId: o.storyId }, { label: 'review_inventory_status (recovery)' });
      assert.match(status.stdout, /Recovery for genuine late evidence: proof-or-stop review_inventory_cancel/, status.out);
      o.mustCli('review_inventory_cancel', { storyId: o.storyId, reason: 'completeness-only receipt refused by certification; open a saturated epoch' }, { label: 'review_inventory_cancel (completeness-only)' });
      inventoryCritic(o, { tag: 'r2' });
      const fin = o.mustCli('review_inventory_finalize', { storyId: o.storyId }, { label: 'review_inventory_finalize r2 (saturated)' });
      assert.match(fin.stdout, /State: FINALIZED/);
      o.mustCli('validate', { story: o.storyId, focus: 'fast', json: true }, { label: 'validate --focus=fast' });
      begin = o.cli('certification_window_begin', { storyId: o.storyId }, { label: 'certification_window_begin (saturated)' });
      lines.push(`fresh saturated epoch + critic, then certification_window_begin: exit ${begin.status} ${begin.status ? firstError(begin) : 'ADMITTED'}`);
      recovered = true;
    }
    assert.equal(begin.status, 0, `D: certification never admitted:\n${begin.out.slice(-2000)}`);
    lines.push(`fresh saturated epoch needed: ${recovered ? 'yes' : 'no'}`);
    o.mustCli('validate', { story: o.storyId, json: true }, { label: 'validate (routine)' });
    const cws = o.mustCli('certification_window_status', { storyId: o.storyId });
    lines.push(`certification_window_status: ${nextOf(cws.out)}`);
    const lineage = git(o.worktree, ['log', '--format=%h %s', `${reviewedHead(o)}..HEAD`]).split('\n').reverse();
    lines.push(`commits since the reviewed head ${reviewedHead(o).slice(0, 7)}:`, ...lineage.map(row => `  ${row}`));
    const test = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'story_advance TEST' });
    lines.push(`story_advance TEST: exit ${test.status} ${test.status ? firstError(test) : 'ok'}`);
    assert.equal(test.status, 0, `D: story_advance TEST refused:\n${test.out.slice(-3000)}`);
    liveSmoke(o);
    const delivery = deliveryReview(o, [
      { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
      { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
    ]);
    assert.equal(delivery.state, 'completed', `delivery reviewer terminal ${delivery.state} (${delivery.reason})\n${delivery.commandLog}`);
    authoredCloseout(o);
    // Single host: submit the hinted local host verdicts until the floor passes.
    let rounds = 0;
    for (let round = 1; round <= 3; round += 1) {
      if (closureRow(o, `done_closure (floor r${round})`, 'review-assurance-floor')?.blocking !== true) break;
      o.mustCli('autopilot_review_submit', { storyId: o.storyId, runId: `${o.storyId}-degraded-r${round}`, hostId: 'e2e-single-host', provider: 'local',
        sessionId: `local-reviewer-r${round}`, decision: 'pass', deriveBindings: true,
        materialDigest: currentMaterialHash(o.worktree, 'HEAD', o.worktree), storyFilesHash: currentStoryFilesHash(o.worktree, 'HEAD', o.worktree) }, { label: `autopilot_review_submit r${round}` });
      rounds = round;
    }
    lines.push(`single-host autopilot_review_submit rounds before DONE: ${rounds}`);
    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    assert.equal(done.status, 0, `D: story_advance DONE refused:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE');
    assert.match(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8'), /TestReverseEmpty/, 'repair merged into main');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`D fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

function printTimeline(steps: Step[], scenario: string): void {
  const rows = steps.filter(s => s.scenario === scenario);
  const total = rows.reduce((sum, s) => sum + s.ms, 0);
  console.log(`\nTimeline ${scenario} (${rows.length} CLI calls, ${(total / 1000).toFixed(1)} s inside the PoS CLI):`);
  console.log(`  ${'command'.padEnd(44)} ${'ms'.padStart(6)} exit  result | story metadata after`);
  for (const s of rows) {
    console.log(`  ${s.label.padEnd(44).slice(0, 44)} ${String(s.ms).padStart(6)} ${String(s.exit).padStart(4)}  ${s.result.replace(/\s+/g, ' ').slice(0, 88)} | ${s.dirty}`);
  }
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter(arg => /^[ABCD]$/.test(arg));
  const machine = createFixtureMachineEnvironment();
  const steps: Step[] = [];
  const outcomes: Outcome[] = [];
  const started = Date.now();
  try {
    if (!only.length || only.includes('A') || only.includes('C')) {
      const { a, c } = scenarioA(machine.env, steps);
      outcomes.push(a, c);
    }
    if (!only.length || only.includes('B')) outcomes.push(scenarioB(machine.env, steps));
    if (!only.length || only.includes('D')) outcomes.push(scenarioD(machine.env, steps));
  } finally {
    try { machine.cleanup(); } catch (error) { console.log(String(error)); }
  }
  for (const scenario of ['A', 'B', 'D']) if (steps.some(s => s.scenario === scenario)) printTimeline(steps, scenario);
  console.log('\nScenarios:');
  for (const outcome of outcomes) {
    console.log(`  [${outcome.status}] ${outcome.name}`);
    for (const line of outcome.lines) console.log(`      ${line}`);
  }
  console.log(`\ne2e-review-to-done: ${((Date.now() - started) / 1000).toFixed(0)} s wall`);
  const failed = outcomes.filter(outcome => outcome.status === 'FAIL');
  if (failed.length) {
    console.log(`e2e-review-to-done-smoke: FAIL (${failed.map(outcome => outcome.name.split(' ')[0]).join(', ')})`);
    process.exit(1);
  }
  console.log(`e2e-review-to-done-smoke: PASS (${outcomes.filter(outcome => outcome.status === 'PASS').map(outcome => outcome.name.split(' ')[0]).join(', ')} reached DONE; C observed)`);
}

await main();
