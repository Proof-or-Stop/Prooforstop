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
 *      fresh saturated epoch + critic -> certification_window_begin refuses
 *      the still-open verified MEDIUM F-001 from round 1 (closure required, no
 *      round decay); DONE's review verdict and story_advance TEST refuse too ->
 *      the owner runs the hinted finding_resolve with the repair evidence ->
 *      certification_window_begin -> validate -> story_advance TEST must not
 *      refuse the managed passes with managed_review_live_head_lineage_invalid;
 *      then TEST -> DONE.
 *   D2 run-11 workaround: an unauthenticated commit breaks the live binding;
 *      TEST names the commit/rule with one Next (review_round_prepare); the
 *      owner reruns the round; the superseded older passes of the same round
 *      block neither TEST nor DONE.
 *   D3 run 13: the review assurance floor is satisfied with quorum_submit
 *      (two Codex sessions); its `quorum-submit` commit must keep the managed
 *      passes live through done_prepare and DONE.
 *   E  run-11 bare .gitignore: scenario A on a task repo whose tracked
 *      .gitignore has NO Proof-or-Stop runtime block (and no .worktrees/),
 *      with `proof-or-stop init --profile codex --asset-mode global-thin`
 *      run in the main checkout before the Story worktree exists, exactly as
 *      the bench adapter does. PoS runtime files must stay out of git status
 *      without any owner-written excludes; must reach DONE (hard PASS).
 *      Also selected by E2E_R2D_BARE_GITIGNORE=1 (runs E instead of A).
 *   N  A's and D's flows (NA, ND) from REVIEW entry driven ONLY by
 *      `proof-or-stop next --storyId=<id> --json`: the harness executes the
 *      returned command (agent kinds through the same fake-provider seams and
 *      authored values as A/D) and asserts DONE, that next is read-only, and
 *      that no proposed command is refused by its gate. Prints CLI calls and
 *      seconds against A/D when they run in the same invocation.
 *   NR the same flows (NA-run, ND-run) with `next --run`, which executes the
 *      consecutive framework steps itself through the real CLI.
 *   NF run 14: D's next-driven flow with TWO verified medium findings in round
 *      1 (Reverse("") and Upper("") untested). After the managed repair of the
 *      first one, the material changes for both; next must still return the
 *      managed finding-repair dispatch for the second one and propose
 *      finding_resolve for a finding only after a managed finding-repair run
 *      bound to that finding id completed (hard assert at every step).
 *   NL run 16: D's next-driven flow plus two LOW round-1 findings; the owner
 *      repairs one anyway (managed finding-repair): next must propose its
 *      finding_resolve before REVIEW; the cosmetic one stays open; a
 *      finding_resolve after DONE refuses without dirtying the main checkout;
 *      the live-smoke capture passes only with validate.env (CONTEXT=abs).
 *
 * Machine registries (provider slots, locks) use a disposable fixture machine
 * so the harness never touches the developer's ~/.proof-or-stop admission state.
 *
 * Usage: node packages/main/dist/tasks/e2e-review-to-done-smoke.js [A|B|C|D|D2|E|N|NR|NF|NL]...
 *        E2E_R2D_VERBOSE=1 prints every command's output.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { FINDING_RESOLUTION_PLACEHOLDER } from '../core/finding-closure-hint.js';
import { sanitizedFixtureChildEnvironment } from './fixture-environment.js';
import { createFixtureMachineEnvironment } from './helpers/fixture-machine-environment.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const MODEL = QUALIFIED_MANAGED_REVIEWER_DEFAULTS.codex;
const FINAL_SCHEMA = 'lattice.managed_review_final_proposal.v1';
const DELIVERY = 'proof-or-stop-review-delivery';
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

export class Owner {
  readonly root: string;
  readonly worktree: string;
  readonly store: StoryStore;
  private readonly providerBin: string;
  private get installedCliBin(): string { return `${this.root}-installed-cli`; }
  private readonly scripts: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(readonly scenario: string, readonly storyId: string, machineEnv: NodeJS.ProcessEnv, readonly steps: Step[], readonly bareGitignore = false,
    private readonly fixtureOpts: { trackedGateFailureCounts?: boolean } = {}) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), `e2e-r2d-${scenario}-`)));
    this.worktree = join(this.root, '.worktrees', storyId);
    this.store = new StoryStore(this.root);
    this.providerBin = `${this.root}-provider`;
    this.scripts = join(this.providerBin, 'scripts');
    mkdirSync(this.scripts, { recursive: true });
    writeFakeCodex(this.providerBin, this.scripts);
    // The benchmark host has the installed `proof-or-stop` on PATH for the whole
    // run; a shim for this checkout's dist CLI stands in, on PATH from the first
    // call as on the host. Since the v2 environment identity (0ea79fb) receipts
    // bind only declared validate.env, variables named in the command, resolved
    // toolchain binaries (by realpath) and behavior-affecting families (locale,
    // TZ, GO*, NODE_*, ...); unrelated PATH entries and shell bookkeeping
    // (SHLVL, _, OLDPWD) no longer stale receipts. The shim still replays the
    // owner env exactly so a pasted hint runs with the same env the owner's
    // direct CLI calls use.
    mkdirSync(this.installedCliBin, { recursive: true });
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
    // Scenario E: the task's own .gitignore, without PoS's runtime block or .worktrees/.
    // Run 11's task repo tracked the convergence-breaker gate counter (commit 6
    // of that run committed gate-failure-counts.json); D2 reproduces that.
    write(root, '.gitignore', this.bareGitignore ? 'bin/\n' : `.worktrees/\n${mergeRuntimeGitignore('')}${this.fixtureOpts.trackedGateFailureCounts ? '!**/gate-failure-counts.json\n' : ''}`);
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
    if (this.bareGitignore) {
      // Bench adapter: `proof-or-stop init --profile codex --asset-mode global-thin .`
      // in the main checkout. Its .gitignore merge stays an uncommitted main-checkout
      // edit (a frozen control file), so the Story branch never carries the block.
      const init = spawnSync(process.execPath, [CLI, 'init', '--profile', 'codex', '--asset-mode', 'global-thin', '.'], {
        cwd: root, encoding: 'utf8', env: this.env,
      });
      assert.equal(init.status, 0, `[${this.scenario}] init failed:\n${init.stdout}${init.stderr}`);
    }
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

  /** A node script from the Story worktree with the owner env (untimed; not an owner step). */
  node(args: string[]): CliResult {
    const run = spawnSync(process.execPath, args, { cwd: existsSync(this.worktree) ? this.worktree : this.root, encoding: 'utf8', env: this.env, maxBuffer: 64 * 1024 * 1024 });
    return { status: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '', out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
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
    return readEvidenceFor(this.worktree, this.storyId);
  }

  /** Scripts directory of the fake provider (run mode: per-run scripts and the resolver live here). */
  get scriptsDir(): string { return this.scripts; }

  phase(): string {
    return new StoryStore(existsSync(this.worktree) ? this.worktree : this.root).readStory(this.storyId).phase;
  }
}

/** The reviewer read manifest/log a managed review final proposal carries (bound to the persisted candidate route). */
function readEvidenceFor(worktree: string, storyId: string): Record<string, unknown> {
  const candidate = new StoryStore(worktree).readCandidateSpecSet(storyId);
  assert.ok(candidate, 'review_round_prepare persisted the candidate route');
  const filesReadFully = [...new Set(['strs/strs.go', 'strs/strs_test.go', 'docs/types/string.md', ...candidate.candidateSpecSet])].sort();
  return {
    readManifest: { filesReadFully, filesTriagedByName: [], scanEscalationReason: candidate.scanEscalationReason ?? null,
      candidateSpecSetDigest: candidate.artifactDigest, corpusDigest: candidate.corpusDigest },
    readLog: { filesReadFully, filesTriagedByName: [], summary: { readCount: filesReadFully.length, tokenCount: null }, digest: 'a'.repeat(64) },
  };
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
  // Run mode (next --run launches managed runs itself): a script for this exact
  // run id (byrun/<runId>.json), else a static key, else the harness resolver
  // writes byrun/<runId>.json from the run's spec and the Story state.
  const runId = process.env.LATTICE_MANAGED_HOST_RUN_ID || '';
  const byRun = runId ? path.join(dir, 'byrun', runId + '.json') : '';
  const key = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'resolver.json').find(f => input.includes(f.slice(0, -5)));
  let file = byRun && fs.existsSync(byRun) ? byRun : key ? path.join(dir, key) : '';
  if (!file && byRun && fs.existsSync(path.join(dir, 'resolver.json'))) {
    const resolver = JSON.parse(fs.readFileSync(path.join(dir, 'resolver.json'), 'utf8'));
    const r = spawnSync(resolver.argv[0], [...resolver.argv.slice(1), runId], { encoding: 'utf8', env: process.env });
    if (r.status === 0 && fs.existsSync(byRun)) file = byRun;
    else fs.writeFileSync(path.join(dir, 'resolver-failed-' + process.pid + '.txt'), (r.stdout || '') + (r.stderr || ''));
  }
  if (!file) { fs.writeFileSync(path.join(dir, 'unmatched-' + process.pid + '.txt'), input); process.exit(3); }
  const script = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  // The Go task repo has no requirements corpus: the framework routes with an
  // automatic full-scan reason, so one call suffices (round-prepare-no-corpus).
  const prepared = o.mustCli('review_round_prepare', { storyId: id, json: true });
  assert.match(new StoryStore(o.worktree).readCandidateSpecSet(id)?.scanEscalationReason ?? '', /^automatic: no requirements corpus in project /,
    'no-corpus route records the automatic full-scan reason');
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

function deliveryReview(o: Owner, docsPromises: Record<string, unknown>[], opts: { probeFirst?: boolean } = {}): { state: string; reason: string; commandLog: string } {
  // Run 14: the delivery reviewer first sent waiverReason:null (refused), then
  // "probed" with a junk minimal payload that consumed its one-shot invocation
  // and moved HEAD by a metadata commit, so the real seal was refused. With
  // probeFirst the scripted reviewer repeats that sequence; the real write
  // must re-seal (same live run) and become the delivery-check.
  const probe = {
    storyId: o.storyId,
    docsPromises: [{ docPath: 'a#b', promise: 'p', verifiedBy: 'diff', evidence: 'e', waiverReason: null }],
    realMachineTests: [{ featureId: 'CHK-001', transcript: 't', waiverReason: null }],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'minimal smoke test of payload shape' },
  };
  const payload = {
    storyId: o.storyId, docsPromises,
    realMachineTests: [
      { featureId: 'CHK-001', transcript: 'go test -v ./strs -run TestUpper -> --- PASS: TestUpper' },
      { featureId: 'CHK-002', transcript: 'go test -v ./strs -run TestReverse -> --- PASS: TestReverse' },
    ],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'Both string helpers are implemented and verified by focused go tests.' },
    agentId: DELIVERY,
  };
  o.script(DELIVERY, { commands: [
    ...(opts.probeFirst ? [[process.execPath, CLI, 'delivery_check_set', JSON.stringify(probe)]] : []),
    [process.execPath, CLI, 'delivery_check_set', JSON.stringify(payload)],
  ], final: 'Delivery review complete; delivery_check_set recorded.' });
  const launched = o.mustCli('host_run', { host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort, storyId: o.storyId,
    agentType: DELIVERY, managedDispatch: true, detach: true, json: true }, { label: 'host_run --managedDispatch delivery' });
  const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
  const terminal = waitTerminal(o, 'delivery', runId);
  o.unscript(DELIVERY);
  if (opts.probeFirst) {
    const statuses = o.providerCommandLog().trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { status: number | null }).status).slice(-2);
    assert.deepEqual(statuses, [0, 0], `delivery probe-then-seal: both delivery_check_set calls of the same run must succeed (re-seal):\n${o.providerCommandLog().slice(-3000)}`);
    const sealed = new StoryStore(o.worktree).readDeliveryCheck(o.storyId);
    assert.equal(sealed?.docsPromises.length, docsPromises.length, 'the real (second) delivery_check_set re-sealed the delivery-check');
  }
  return { state: terminal.state, reason: terminal.reason, commandLog: o.providerCommandLog() };
}

function authoredCloseout(o: Owner): void {
  const id = o.storyId;
  o.mustCli('dev_memory_finish_decision', { storyId: id, decision: 'no-reusable-lesson', reason: 'Harness fixture: trivial string helpers, no reusable lesson.' });
  o.mustCli('summary_set', { storyId: id, changes: 'strs/strs.go: Upper now upper-cases; new Reverse reverses by rune.', usage: 'strs.Upper("ab") == "AB"; strs.Reverse("héllo") == "olléh"',
    expectedOutcome: 'go test -v ./strs prints --- PASS: TestUpper and --- PASS: TestReverse', actualTranscript: 'go test -v ./strs: --- PASS: TestUpper, --- PASS: TestReverse, ok',
    outcomeDiff: 'no difference', acceptanceVerdict: 'accepted', outcomeKind: 'success', limitations: 'none — fully covered',
    pitfalls: 'Harness fixture; no retries were needed.' });
}

function closureRow(o: Owner, label: string, rowId: string): Record<string, unknown> | undefined {
  const closure = o.mustCli('done_closure', { storyId: o.storyId, json: true }, { label });
  const rows = (parseJson(closure.stdout)?.blockers ?? []) as Record<string, unknown>[];
  return rows.find(row => row.id === rowId);
}

// ---------------------------------------------------------------------------
// Scenarios

interface Outcome { name: string; status: 'PASS' | 'FAIL' | 'OBSERVED'; lines: string[] }

function scenarioA(machineEnv: NodeJS.ProcessEnv, steps: Step[], bare = false): { a: Outcome; c: Outcome } {
  const aName = bare ? 'E bare task .gitignore (no runtime block): REVIEW -> TEST -> DONE' : 'A happy path REVIEW -> TEST -> DONE';
  const o = new Owner(bare ? 'E' : 'A', bare ? 'B-e2e4' : 'B-e2e0', machineEnv, steps, bare);
  const c: Outcome = { name: 'C single host: one framework step (next -> quorum_submit singleHost) satisfies the review assurance floor before DONE', status: 'OBSERVED', lines: [] };
  try {
    devToReview(o);
    reviewRound(o);
    inventory(o);
    precertToTest(o);
    liveSmoke(o);
    const delivery = deliveryReview(o, [
      { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
      { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
    ], { probeFirst: !bare });
    assert.equal(delivery.state, 'completed', `delivery reviewer terminal ${delivery.state} (${delivery.reason})\n${delivery.commandLog}`);
    if (!bare) c.lines.push('delivery reviewer probe-then-seal (run 14): junk probe write, then the real write re-sealed by the same live run -> completed');
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
    // Run 14: no discovery dance. The guidance leads with the one-step single-host
    // writer and next names it as a framework step, filled in.
    assert.match(floorReason, /proof-or-stop quorum_submit '\{"storyId":"[^"]+","singleHost":true\}'/, 'C: the floor guidance names the one-step single-host writer');
    const asked = o.cli('next', { storyId: o.storyId, json: true }, { label: 'next (single host)' });
    const named = parseJson(asked.stdout) as { kind?: string; reason?: string; cli?: { command: string; payload: Record<string, unknown> } } | null;
    assert.equal(named?.kind, 'framework', `C: next names the single-host step as a framework step:\n${asked.out.slice(-1500)}`);
    assert.equal(named?.cli?.command, 'quorum_submit', `C: next names quorum_submit singleHost: ${String(named?.reason)}`);
    assert.equal(named?.cli?.payload.singleHost, true, 'C: next fills singleHost:true');
    const submit = o.cli('quorum_submit', { ...named!.cli!.payload, json: true }, { label: 'quorum_submit singleHost (next)' });
    assert.equal(submit.status, 0, `C: quorum_submit singleHost failed:\n${submit.out.slice(-2000)}`);
    const single = parseJson(submit.stdout) as { roundsRecorded?: number; satisfied?: boolean; probeId?: string | null; fallbackId?: string | null } | null;
    c.lines.push(`next -> framework quorum_submit {singleHost:true}: rounds=${String(single?.roundsRecorded)} probe=${String(single?.probeId)} fallback=${String(single?.fallbackId)} satisfied=${String(single?.satisfied)}`);
    assert.equal(single?.satisfied, true, 'C: one step satisfies the single-host review assurance');
    assert.equal(single?.roundsRecorded, 1, 'C: the one-local-round floor records exactly one round (the rule is not weakened or inflated)');
    assert.equal(single?.fallbackId ?? null, null, 'C: no degraded fallback is recorded when no rule needs it');
    const floorAfter = closureRow(o, 'done_closure (after host verdict)', 'review-assurance-floor');
    c.lines.push(`done_closure review-assurance-floor after the single-host step: status=${String(floorAfter?.status)}`);
    assert.notEqual(floorAfter?.blocking, true, 'one local host verdict satisfies the one-local-round floor');
    const again = o.cli('quorum_submit', { storyId: o.storyId, singleHost: true, json: true }, { label: 'quorum_submit singleHost (again)' });
    assert.equal(again.status, 0, `C: a repeated single-host step is a no-op:\n${again.out.slice(-1500)}`);
    assert.equal((parseJson(again.stdout) as { roundsRecorded?: number } | null)?.roundsRecorded, 0, 'C: nothing missing -> nothing recorded');
    if (!bare) c.status = 'PASS';
    const eventsDirty = git(o.worktree, ['status', '--porcelain', '--', `.proof-or-stop/story/actives/${o.storyId}/process-events.jsonl`]) !== '';
    c.lines.push(`single-host step leaves process-events.jsonl uncommitted: ${eventsDirty ? 'yes' : 'no'}`);
    assert.equal(eventsDirty, false, 'C: the single-host step must commit its host_verdict events (else done_prepare refuses VALIDATION_PUBLICATION_NOT_READY)');

    // done_prepare, as the floor guidance says to rerun it after the writer ran.
    const prepare = o.cli('done_prepare', { storyId: o.storyId, json: true });
    const prepared = parseJson(prepare.stdout);
    c.lines.push(`done_prepare after the host verdict: exit ${prepare.status} status=${String(prepared?.status)} blockedAt=${String(prepared?.blockedAt ?? '-')}`);
    if (prepared?.blockedAt) c.lines.push(`  ${String(prepared.reason).slice(0, 230)} (handlers/verifier.ts:2214-2239)`);
    assert.doesNotMatch(prepare.out, /VALIDATION_PUBLICATION_NOT_READY/, 'C: done_prepare after the host verdict must not refuse on unpublished metadata');
    // E: projected controller hooks and PoS runtime files are framework-owned, never dirt for done_prepare.
    if (bare) assert.notEqual(prepared?.blockedAt, 'cleanTree', `E: done_prepare refused cleanTree on framework-owned files:\n${prepare.out.slice(-2000)}`);

    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    assert.equal(done.status, 0, `A: story_advance DONE refused:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE', 'main store records DONE');
    assert.match(git(o.root, ['log', '--format=%s', '-3', 'main']), new RegExp(`merge: ${o.storyId} `), 'story branch merged into main');
    assert.match(readFileSync(join(o.root, 'strs/strs.go'), 'utf8'), /func Reverse/, 'story code is on main');
    assert.equal(existsSync(o.worktree), false, 'story worktree removed');
    assert.equal(git(o.root, ['branch', '--list', `story/${o.storyId}`]), '', 'story branch deleted');
    const a: Outcome = { name: aName, status: 'PASS', lines: [
      `DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`,
      ...(bare ? [`main checkout status after DONE: ${JSON.stringify(git(o.root, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean))}`] : []),
      ...(prepared?.blockedAt ? [`note: done_prepare BLOCKED at ${String(prepared.blockedAt)}, story_advance DONE still passed (see C)`] : []),
      ...(prepared?.blockedAt ? [`  done_prepare reason: ${String(prepared.reason).slice(0, 200)} files=${JSON.stringify(prepared.files ?? [])}`] : []),
    ] };
    o.cleanup();
    return { a, c };
  } catch (error) {
    console.log(`${o.scenario} fixture retained for diagnosis: ${o.root}`);
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

// MEDIUM (its original severity) under the default balanced profile: the
// closure rule (core/finding-closure-severities.ts) requires verified
// critical/high/medium findings to be closed in every profile.
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

/** Scenario NF's second round-1 finding (a different defect than D_FINDING). */
const NF_FINDING = {
  desc: 'Upper has no focused test for an empty string: Upper("") must return "".',
  severity: 'medium', category: 'edge', files: ['strs/strs.go', 'strs/strs_test.go'], evidenceState: 'verified',
};

/**
 * Scenario NL (run 16): two LOW round-1 findings beside the medium D_FINDING.
 * The first is a real gap the owner repairs anyway through a managed
 * finding-repair (repairFor: Upper -> TestUpperEmpty); the second is cosmetic
 * and stays open (advisory) through DONE.
 */
const NL_LOW_REPAIRED = { ...NF_FINDING, severity: 'low' };
const NL_LOW_COSMETIC = {
  desc: 'Comment wording: the strs.go doc comment of Reverse could say "rune by rune" (cosmetic, no behavior change).',
  severity: 'low', category: 'edge', files: ['strs/strs.go'], evidenceState: 'verified',
};

const FINDING_REPAIR = 'proof-or-stop-finding-repair';
const REPAIR_TEST = '\nfunc TestReverseEmpty(t *testing.T) {\n\tif Reverse("") != "" {\n\t\tt.Fatal("empty")\n\t}\n}\n';
const NF_REPAIR_TEST = '\nfunc TestUpperEmpty(t *testing.T) {\n\tif Upper("") != "" {\n\t\tt.Fatal("empty")\n\t}\n}\n';

/** The scripted repair commit for one finding (by its description): test text, commit subject, test name. */
function repairFor(desc: string): { test: string; subject: string; name: string } {
  return desc.startsWith('Upper ')
    ? { test: NF_REPAIR_TEST, subject: 'test: Upper of the empty string', name: 'TestUpperEmpty' }
    : { test: REPAIR_TEST, subject: 'test: Reverse of the empty string', name: 'TestReverseEmpty' };
}

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

/**
 * Closure rule (core/finding-closure.ts): a verified blocking finding stays open
 * across rounds until the owner closes it. Before the resolve, the DONE oracle's
 * review-verdict row and REVIEW->TEST both refuse, naming the id; the owner then
 * runs exactly the hinted finding_resolve with the repair evidence.
 */
function resolveAsHinted(o: Owner, findingId: string, repairEvidence: string, lines: string[]): void {
  const verdict = closureRow(o, 'done_closure (before finding_resolve)', 'review-verdict');
  assert.equal(verdict?.blocking, true, `DONE must refuse the open verified finding ${findingId}:\n${JSON.stringify(verdict)}`);
  assert.ok(String(verdict?.reason ?? '').includes(findingId), `DONE refusal names ${findingId}: ${JSON.stringify(verdict)}`);
  const test = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'story_advance TEST (finding open)' });
  assert.notEqual(test.status, 0, 'REVIEW->TEST must refuse while the verified finding is open');
  const hint = nextOf(test.out);
  const expected = `Next: proof-or-stop finding_resolve --storyId=${o.storyId} --findingId=${findingId} --resolution="${FINDING_RESOLUTION_PLACEHOLDER}"`;
  assert.ok(hint.startsWith(expected), `TEST refusal must print the exact resolve command:\n${test.out.slice(-2000)}`);
  lines.push(`before finding_resolve: DONE review-verdict blocking=${String(verdict?.blocking)}; story_advance TEST refused; ${hint.slice(0, 160)}`);
  const command = expected.slice('Next: '.length).replace(FINDING_RESOLUTION_PLACEHOLDER, repairEvidence);
  const resolved = o.shell('finding_resolve (as hinted)', command);
  assert.equal(resolved.status, 0, `hinted finding_resolve failed:\n${resolved.out.slice(-2000)}`);
  lines.push(`owner ran the hinted finding_resolve: ${resolved.stdout.split('\n')[0]}`);
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
  const name = 'D run 11: review finding -> DEV repair -> all-pass round -> finding_resolve -> PRE_CERT -> TEST -> DONE';
  // Runs 11 and 12: the task repo tracked the convergence-breaker gate counter.
  const o = new Owner('D', 'B-e2e3', machineEnv, steps, false, { trackedGateFailureCounts: true });
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
      // Run 12: the owner probed TEST before PRE_CERT. The refused
      // story_advance bumps the (tracked) gate-failure-counts.json, and the
      // admitting certification_window_begin commit then sweeps it in next to
      // its certification-window/review-inventory-epochs publication.
      const premature = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'story_advance TEST (premature)' });
      assert.notEqual(premature.status, 0, 'TEST before certification must be refused');
      lines.push(`premature story_advance TEST: refused ${firstError(premature).slice(0, 90)}`);
      begin = o.cli('certification_window_begin', { storyId: o.storyId }, { label: 'certification_window_begin (saturated)' });
      lines.push(`fresh saturated epoch + critic, then certification_window_begin: exit ${begin.status} ${begin.status ? firstError(begin) : 'ADMITTED'}`);
      recovered = true;
    }
    // F-001 is verified MEDIUM from round 1 and still open after the all-pass
    // round 2: PRE_CERT refuses it (no round decay) and hints finding_resolve.
    assert.notEqual(begin.status, 0, `D: PRE_CERT must refuse while ${findingId} is open:\n${begin.out.slice(-2000)}`);
    assert.match(begin.out, /pre_cert_blocking_findings_open/, begin.out.slice(-2000));
    assert.ok(nextOf(begin.out).includes(`finding_resolve --storyId=${o.storyId} --findingId=${findingId}`), `PRE_CERT hint: ${nextOf(begin.out)}`);
    resolveAsHinted(o, findingId, `repair ${git(o.worktree, ['log', '--format=%h', '-1', '--grep=Reverse of the empty string'])} adds TestReverseEmpty; go test ./strs -run TestReverseEmpty passes`, lines);
    begin = o.cli('certification_window_begin', { storyId: o.storyId }, { label: 'certification_window_begin (after resolve)' });
    lines.push(`certification_window_begin after finding_resolve: exit ${begin.status} ${begin.status ? firstError(begin) : 'ADMITTED'}`);
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

function scenarioD2(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  // Run 11 continuation: the owner worked around the TEST refusal with a
  // further review round bound to the live head. The older passes of the same
  // round stayed in review-passes.json; TEST admitted the newer ones, but DONE
  // re-validated the superseded passes and sent the owner back to REVIEW.
  // An unauthenticated empty owner checkpoint commit stands in for the
  // lineage break the fixed framework no longer produces itself.
  const name = 'D2 run 11 workaround: rerun round after a lineage break; superseded passes must not block TEST/DONE';
  const o = new Owner('D2', 'B-e2e4', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  try {
    devToReview(o);
    reviewRound(o);
    // Run 11 order: the break lands after the lane imports and before the
    // inventory critic, so only the lane passes are bound to the older head.
    // (An empty owner checkpoint commit: no material, scope or metadata change.)
    git(o.worktree, ['commit', '-q', '--allow-empty', '-m', 'owner: checkpoint review status']);
    lines.push(`owner hand commit: ${git(o.worktree, ['log', '--format=%h %s', '-1'])}`);
    inventory(o);
    o.mustCli('validate', { story: o.storyId, focus: 'fast', json: true }, { label: 'validate --focus=fast' });
    o.mustCli('certification_window_begin', { storyId: o.storyId });
    o.mustCli('validate', { story: o.storyId, json: true }, { label: 'validate (routine)' });
    const refused = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'story_advance TEST (lineage break)' });
    assert.notEqual(refused.status, 0, 'an unauthenticated commit must break the managed live binding');
    assert.match(refused.out, /managed_review_live_head_lineage_invalid/);
    const detail = refused.out.match(/\(unauthenticated commit ([0-9a-f]{12}) "([^"]*)": (.*?); (Next: proof-or-stop [^)]*)\)/);
    assert.ok(detail, `TEST refusal names the unauthenticated commit, rule and one Next:\n${refused.out.slice(-1500)}`);
    lines.push(`story_advance TEST refused; diagnostic: commit ${detail[1]} "${detail[2]}": ${detail[3].slice(0, 90)}; ${detail[4]}`);
    assert.equal(detail[4], `Next: proof-or-stop review_round_prepare --storyId=${o.storyId}`);
    // Workaround as the owner ran it: a fresh round of every lane on the live head.
    reviewRound(o);
    const passes = new StoryStore(o.worktree).readReviewPasses(o.storyId).passes;
    lines.push(`review-passes.json now holds ${passes.length} passes (older same-round passes are superseded, not removed)`);
    let test = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: 'story_advance TEST (after rerun)' });
    lines.push(`story_advance TEST after the rerun: exit ${test.status} ${test.status ? firstError(test) : 'ok'}`);
    for (let attempt = 0; attempt < 4 && test.status !== 0; attempt += 1) {
      // Follow the printed Next, as the owner does.
      const next = nextOf(test.out).replace(/^Next: /, '') || nextOf(o.cli('certification_window_status', { storyId: o.storyId }).out).replace(/^Next: /, '');
      lines.push(`  owner follows: ${next}`);
      if (/review_inventory_begin|review_inventory_status|review_inventory_finalize/.test(next)) {
        inventory(o);
      } else if (/validate --story=\S+ --focus=fast/.test(next)) {
        o.mustCli('validate', { story: o.storyId, focus: 'fast', json: true }, { label: 'validate --focus=fast' });
      } else if (/certification_window_begin/.test(next)) {
        o.mustCli('certification_window_begin', { storyId: o.storyId });
      } else if (/validate --story=\S+ --json/.test(next)) {
        o.mustCli('validate', { story: o.storyId, json: true }, { label: 'validate (routine)' });
      } else {
        break;
      }
      test = o.cli('story_advance', { storyId: o.storyId, phase: 'TEST' }, { label: `story_advance TEST (attempt ${attempt + 3})` });
    }
    assert.equal(test.status, 0, `D2: story_advance TEST refused after the workaround round:\n${test.out.slice(-3000)}`);
    liveSmoke(o);
    const delivery = deliveryReview(o, [
      { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
      { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
    ]);
    assert.equal(delivery.state, 'completed', `delivery reviewer terminal ${delivery.state} (${delivery.reason})\n${delivery.commandLog}`);
    authoredCloseout(o);
    for (let round = 1; round <= 3; round += 1) {
      if (closureRow(o, `done_closure (floor r${round})`, 'review-assurance-floor')?.blocking !== true) break;
      o.mustCli('autopilot_review_submit', { storyId: o.storyId, runId: `${o.storyId}-degraded-r${round}`, hostId: 'e2e-single-host', provider: 'local',
        sessionId: `local-reviewer-r${round}`, decision: 'pass', deriveBindings: true,
        materialDigest: currentMaterialHash(o.worktree, 'HEAD', o.worktree), storyFilesHash: currentStoryFilesHash(o.worktree, 'HEAD', o.worktree) }, { label: `autopilot_review_submit r${round}` });
    }
    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    lines.push(`story_advance DONE: exit ${done.status} ${done.status ? firstError(done) : 'ok'}`);
    assert.equal(done.status, 0, `D2: story_advance DONE refused on superseded passes:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`D2 fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** DEV work the owner does before REVIEW entry (devToReview without story_advance REVIEW). */
const DEV_SETUP_CALLS = 6;

export function devSetup(o: Owner): void {
  const id = o.storyId;
  o.mustCli('dev_memory_preflight_ack', { storyId: id });
  o.mustCli('scope_contract_init_from_plan', { storyId: id });
  for (const [itemId, test, proves] of [['CHK-001', 'TestUpper', 'Upper upper-cases its input'], ['CHK-002', 'TestReverse', 'Reverse reverses by rune']] as const) {
    o.mustCli('verification_evidence_add', { storyId: id, itemId, intentRef: `${itemId}:happy:0`, kind: 'logic_test',
      command: `go test -v ./strs -run ${test}`, selector: `--- PASS: ${test}`, note: `Pinned focused go test proves ${proves}.` }, { label: `verification_evidence_add ${itemId}` });
  }
  o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-001', status: 'done' }, { label: 'checklist_update CHK-001 done' });
  o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-002', status: 'done' }, { label: 'checklist_update CHK-002 done' });
}

export interface NextStepCallJson {
  reason: string; command: string; cli: { command: string; payload: Record<string, unknown> };
  placeholders?: string[]; placeholderHints?: Record<string, string>;
}

export interface NextStepJson {
  phase: string; kind: 'agent' | 'framework' | 'human'; reason: string; command: string | null; why: string;
  cli: { command: string; payload: Record<string, unknown> } | null; placeholders?: string[]; done?: boolean; wait?: boolean;
  /** One-line description of each placeholder's expected content (Q6 (c)). */
  placeholderHints?: Record<string, string>;
  /** Several authoring commands the owner runs in one turn (Q6 (b), TEST). */
  batch?: NextStepCallJson[];
}

const VERIFIED_PROMISES = [
  { docPath: 'docs/types/string.md', promise: 'Upper returns the upper-case form of a string.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestUpper', evidence: '--- PASS: TestUpper' },
  { docPath: 'docs/types/string.md', promise: 'Reverse returns the string reversed by rune.', status: 'verified', verifiedBy: 'go test -v ./strs -run TestReverse', evidence: '--- PASS: TestReverse' },
];

/** Which scripted findings round 1 reports (shared by the inline harness and the run-mode resolver). */
interface ScriptMode { findingRound1: boolean; twoFindings?: boolean; lowFindings?: boolean }

type ProviderScript = { final: string; commands?: string[][] };

/** A REVIEW lane's scripted final proposal: round 1 test-coverage reports the mode's findings, every other lane passes. */
function laneScript(worktree: string, storyId: string, lane: string, reviewRunId: string, firstRound: boolean, mode: ScriptMode): ProviderScript {
  const envelope = mode.findingRound1 && firstRound && lane === 'proof-or-stop-review-test-coverage'
    ? { conclusion: 'findings', note: 'Scripted behavior finding: empty-string edge case is untested.',
      findings: mode.lowFindings ? [D_FINDING, NL_LOW_REPAIRED, NL_LOW_COSMETIC] : mode.twoFindings ? [D_FINDING, NF_FINDING] : [D_FINDING] }
    : PASS_ENVELOPE(lane);
  return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: lane, lane, reviewRunId, ...envelope, ...readEvidenceFor(worktree, storyId) }) };
}

/** The inventory critic: dispositions every finding of the current epoch's round as one verified family. */
function criticScript(worktree: string, storyId: string, reviewRunId: string): ProviderScript {
  const store = new StoryStore(worktree);
  const epoch = store.readReviewInventoryEpochs(storyId).epochs.at(-1)!;
  const raw = store.readFindings(storyId).findings.filter(f => f.reviewRound === epoch.reviewRound);
  const dispositions = raw.map(f => f.desc.startsWith('Upper ')
    ? { finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'upper-empty-string', reason: 'The empty-string edge of Upper is untested; one verified family.' }
    : f.desc.startsWith('Comment ')
      ? { finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'reverse-comment-wording', reason: 'Cosmetic doc-comment wording of Reverse; one verified family.' }
    : { finding: { findingId: f.id }, disposition: 'verified_family', familyKey: 'reverse-empty-string', reason: 'The empty-string edge of Reverse is untested; one verified family.' });
  return { final: JSON.stringify({ schemaVersion: FINAL_SCHEMA, storyId, providerAgent: MANAGED_INVENTORY_CRITIC_LANE, lane: MANAGED_INVENTORY_CRITIC_LANE,
    reviewRunId, conclusion: 'pass', note: dispositions.length ? 'Scripted inventory critic: dispositioned every verified finding of this wave.' : 'Scripted inventory critic: every required lane passed with zero findings; nothing to disposition.',
    inventoryCritic: { epochId: epoch.epochId, wave: epoch.waves.length + 1, findingDispositions: dispositions }, ...readEvidenceFor(worktree, storyId) }) };
}

function deliveryScript(storyId: string): ProviderScript {
  const deliveryPayload = { storyId, docsPromises: VERIFIED_PROMISES,
    realMachineTests: [
      { featureId: 'CHK-001', transcript: 'go test -v ./strs -run TestUpper -> --- PASS: TestUpper' },
      { featureId: 'CHK-002', transcript: 'go test -v ./strs -run TestReverse -> --- PASS: TestReverse' },
    ],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'Both string helpers are implemented and verified by focused go tests.' },
    agentId: DELIVERY };
  return { commands: [[process.execPath, CLI, 'delivery_check_set', JSON.stringify(deliveryPayload)]], final: 'Delivery review complete; delivery_check_set recorded.' };
}

function repairScript(desc: string): ProviderScript {
  const repair = repairFor(desc);
  return { commands: [['/bin/sh', '-c', `printf '%s' '${repair.test.replace(/'/g, "'\\''")}' >> strs/strs_test.go && git add strs/strs_test.go && git -c user.name=${FINDING_REPAIR} commit -qm '${repair.subject}' && git log --format=%h -1`]],
    final: `Added ${repair.name}; committed.` };
}

/**
 * Run mode: `next --run` launches fully bound managed runs itself, so the
 * harness cannot script the fake provider before the launch. The fake codex
 * calls this (through resolver.json) with the run id it serves; the script is
 * derived from the run's immutable spec and the Story state exactly as the
 * inline harness derives it from the step `next` returned.
 */
function provideScript(root: string, storyId: string, scriptsDir: string, modeJson: string, runId: string): void {
  const mode = JSON.parse(modeJson) as ScriptMode;
  const spec = JSON.parse(readFileSync(join(root, '.proof-or-stop', 'runtime', 'host-runs', runId, 'spec.json'), 'utf8')) as
    { agentType: string; reviewRunId?: string | null; managedDispatchTarget?: { findingId?: string } | null };
  const worktree = join(root, '.worktrees', storyId);
  const store = new StoryStore(worktree);
  let script: ProviderScript;
  if (spec.agentType === DELIVERY) script = deliveryScript(storyId);
  else if (spec.agentType === FINDING_REPAIR) {
    const findingId = spec.managedDispatchTarget?.findingId ?? '';
    script = repairScript(store.readFindings(storyId).findings.find(f => f.id === findingId)?.desc ?? '');
  } else if (spec.agentType === MANAGED_INVENTORY_CRITIC_LANE) script = criticScript(worktree, storyId, String(spec.reviewRunId));
  else {
    const runs = store.readReviewRuns(storyId).runs;
    const run = runs.find(row => row.reviewRunId === spec.reviewRunId);
    assert.ok(run, `resolver: ReviewRun ${String(spec.reviewRunId)} of run ${runId} not found`);
    const firstRound = runs.find(row => row.reviewPurpose !== 'inventory-completeness')?.reviewRound;
    script = laneScript(worktree, storyId, spec.agentType, run.reviewRunId, run.reviewRound === firstRound, mode);
  }
  mkdirSync(join(scriptsDir, 'byrun'), { recursive: true });
  writeFileSync(join(scriptsDir, 'byrun', `${runId}.json`), JSON.stringify(script));
}

/** Managed finding-repair runs per finding id, from the immutable run specs (covers runs `next --run` launched). */
function repairRunsOnDisk(runsRoot: string): Map<string, string[]> {
  const byFinding = new Map<string, string[]>();
  if (!existsSync(runsRoot)) return byFinding;
  for (const runId of readdirSync(runsRoot)) {
    try {
      const spec = JSON.parse(readFileSync(join(runsRoot, runId, 'spec.json'), 'utf8')) as { agentType?: string; managedDispatchTarget?: { findingId?: string } | null };
      const findingId = spec.agentType === FINDING_REPAIR ? spec.managedDispatchTarget?.findingId : undefined;
      if (findingId) byFinding.set(findingId, [...(byFinding.get(findingId) ?? []), runId]);
    } catch { /* not a managed run directory */ }
  }
  return byFinding;
}

/** Steps that launch or wait on a managed run (Q6: `next --run` executes these once the selection is bound). */
const MANAGED_LAUNCH_REASONS = new Set(['review_lane_launch', 'inventory_critic_launch', 'delivery_review_launch', 'finding_repair', 'implement_item', 'scope_plan_review_launch']);

/** The owner's authored values for the TEST/DEV authoring commands next proposes with placeholders. */
function authorPayload(o: Owner, reason: string, payload: Record<string, unknown>, findingDesc: (findingId: string) => string): void {
  switch (reason) {
    case 'finding_resolve': {
      const repair = repairFor(findingDesc(String(payload.findingId)));
      payload.resolution = `repair ${git(o.worktree, ['log', '--format=%h', '-1', `--grep=${repair.subject.slice('test: '.length)}`])} adds ${repair.name}; go test ./strs -run ${repair.name} passes`;
      break;
    }
    case 'dev_memory_finish_decision':
      Object.assign(payload, { decision: 'no-reusable-lesson', reason: 'Harness fixture: trivial string helpers, no reusable lesson.' });
      break;
    case 'summary_set':
      Object.assign(payload, { changes: 'strs/strs.go: Upper now upper-cases; new Reverse reverses by rune.', usage: 'strs.Upper("ab") == "AB"; strs.Reverse("héllo") == "olléh"',
        expectedOutcome: 'go test -v ./strs prints --- PASS: TestUpper and --- PASS: TestReverse', actualTranscript: 'go test -v ./strs: --- PASS: TestUpper, --- PASS: TestReverse, ok',
        outcomeDiff: 'no difference', limitations: 'none — fully covered', pitfalls: 'Harness fixture; no retries were needed.' });
      break;
    default:
      break;
  }
}

/** Q6 (c): every placeholder of a step (or of a batch command) carries a one-line description of its expected content. */
function placeholderHintViolations(call: { reason: string; placeholders?: string[]; placeholderHints?: Record<string, string> }): string[] {
  return (call.placeholders ?? []).filter(path => !(call.placeholderHints?.[path] ?? '').trim())
    .map(path => `${call.reason}: placeholder ${path} has no one-line description (placeholderHints)`);
}

/**
 * Scenario N: from REVIEW entry the owner runs ONLY `proof-or-stop next
 * --storyId=<id> --json` and executes the returned command. Agent-kind steps go
 * through the same fake-provider seams as A/D (the scripted reviewer envelope,
 * critic dispositions, delivery reviewer, finding repair) and the same authored
 * values (resolution, summary, finish decision). Every proposed command must
 * succeed: next must never propose a command its gate then refuses.
 *
 * Run mode (Q6, run 17): `next --run` also executes waits and every fully bound
 * managed launch (host/model/effort of the owner's own earlier run, no
 * placeholders), so after the first managed launch no launch or wait step may
 * reach the owner; the fake provider then scripts each run from its spec
 * (provideScript). TEST authoring (finish decision + summary) arrives as ONE
 * step whose batch lists each exact command (Q6 (b)).
 */
export function driveWithNext(o: Owner, mode: { findingRound1: boolean; run: boolean; twoFindings?: boolean;
  /** Run 16: round 1 also reports two LOW findings; the owner repairs the first itself (managed finding-repair) when next says enter_review. */
  lowFindings?: boolean;
  /** Run 16: the live-smoke capture needs the project validate.env (CONTEXT=abs) to pass. */
  contextSmoke?: boolean;
  /** Soft checks (NL): each violation is recorded and the flow continues, so one run reports every defect. */
  violations?: string[]; }, lines: string[],
  /** Called with each step `next` returned, before the harness executes it; quiet = no detached managed run in flight. */
  onStep?: (next: NextStepJson, quiet: boolean) => void): void {
  const id = o.storyId;
  const scriptKeyByRun = new Map<string, string>();
  let firstRound: string | undefined;
  const reasons: string[] = [];
  const statusOf = () => existsSync(o.worktree) ? execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: o.worktree, encoding: 'utf8' }) : '';
  let internalCalls = 0;
  let internalMs = 0;
  // Owner turns: one per `next` call plus one per step the owner executes itself.
  let ownerTurns = 0;
  // Q6 contract violations (hard-asserted at the end; every one is reported).
  const q6: string[] = [];
  // finding id -> managed finding-repair runs launched for it (as next proposed them).
  const repairRunsByFinding = new Map<string, string[]>();
  const findingDesc = (findingId: string): string => new StoryStore(o.worktree).readFindings(id).findings.find(f => f.id === findingId)?.desc ?? '';
  // A fake provider picks the first script whose key occurs in its prompt, and a
  // critic prompt names the lane ReviewRuns: retire each script once its run is terminal.
  const runsRoot = join(o.root, '.proof-or-stop', 'runtime', 'host-runs');
  const managedRunCount = (): number => existsSync(runsRoot) ? readdirSync(runsRoot).filter(runId => existsSync(join(runsRoot, runId, 'spec.json'))).length : 0;
  const retireTerminalScripts = (): void => {
    for (const [runId, key] of scriptKeyByRun) {
      if (existsSync(join(runsRoot, runId, 'terminal.json'))) { o.unscript(key); scriptKeyByRun.delete(runId); }
    }
  };
  if (mode.run) {
    writeFileSync(join(o.scriptsDir, 'resolver.json'), JSON.stringify({ argv: [process.execPath, SELF, '--provide-script', o.root, id, o.scriptsDir,
      JSON.stringify({ findingRound1: mode.findingRound1, twoFindings: mode.twoFindings ?? false, lowFindings: mode.lowFindings ?? false })] }));
  }
  let liveSmokeProposals = 0;
  for (let iteration = 0; iteration < 160; iteration += 1) {
    retireTerminalScripts();
    // A detached managed worker still running may commit its own metadata
    // meanwhile; the read-only check applies when nothing else is running.
    const quiet = scriptKeyByRun.size === 0;
    const before = statusOf();
    const asked = o.cli('next', { storyId: id, json: true, ...(mode.run ? { run: true } : {}) }, { label: mode.run ? 'next --run' : 'next' });
    ownerTurns += 1;
    const parsed = asked.status === 0 ? parseJson(asked.stdout) : null;
    const next = (mode.run ? parsed?.next : parsed) as NextStepJson | undefined;
    assert.ok(next && typeof next.kind === 'string', `[${o.scenario}] next --storyId=${id} --json did not return a step:\n${asked.out.slice(-2000)}`);
    if (mode.run) {
      const executed = (parsed!.executed ?? []) as Array<{ command: string; exit: number; ms: number; tail: string }>;
      for (const row of executed) {
        internalCalls += 1; internalMs += row.ms;
        reasons.push(`run:${row.command.split(' ')[1]}`);
        assert.equal(row.exit, 0, `[${o.scenario}] next --run executed a framework step its gate refused: ${row.command}\n${row.tail}`);
      }
      assert.equal(parsed!.stopped ?? null, null, `[${o.scenario}] next --run stopped: ${String(parsed!.stopped)}`);
      // Q6 (a): once the owner launched one managed run (its host/model/effort is
      // bound), every further launch and every wait is run by next --run itself.
      if (next.wait) q6.push(`next --run returned the wait ${next.reason} to the owner (${next.why.slice(0, 120)})`);
      if (MANAGED_LAUNCH_REASONS.has(next.reason) && managedRunCount() > 0) {
        q6.push(`next --run returned the fully bound managed launch ${next.reason} to the owner after a managed run already bound the selection`);
      }
    } else if (quiet) {
      assert.equal(statusOf(), before, `[${o.scenario}] next must be read-only; git status changed:\n${before}\n---\n${statusOf()}`);
    }
    q6.push(...placeholderHintViolations(next), ...(next.batch ?? []).flatMap(call => placeholderHintViolations(call)));
    if (next.reason === 'dev_memory_finish_decision' || next.reason === 'summary_set') {
      q6.push(`TEST authoring ${next.reason} surfaced as its own step; the finish decision and the summary must arrive as one step listing each command (Q6 (b))`);
    }
    onStep?.(next, quiet);
    if (next.done) break;
    assert.notEqual(next.kind, 'human', `[${o.scenario}] next asked for a human decision: ${next.reason}: ${next.why}`);
    assert.ok(next.cli, `[${o.scenario}] next returned no runnable command: ${next.reason}: ${next.why}`);
    const payload = { ...next.cli.payload };
    const round = new StoryStore(o.worktree).readStory(id).currentReviewRound;
    reasons.push(next.reason);
    // Fake-provider seams and authored values for agent-kind steps.
    switch (next.reason) {
      case 'review_lane_launch': {
        firstRound ??= round;
        const lane = String(payload.lane);
        const reviewRunId = String(payload.reviewRunId);
        o.script(reviewRunId, laneScript(o.worktree, id, lane, reviewRunId, round === firstRound, mode));
        break;
      }
      case 'inventory_critic_launch':
        o.script(String(payload.reviewRunId), criticScript(o.worktree, id, String(payload.reviewRunId)));
        break;
      case 'delivery_review_launch':
        o.script(DELIVERY, deliveryScript(id));
        break;
      case 'finding_repair':
        o.script(FINDING_REPAIR, repairScript(findingDesc(String(payload.findingId))));
        break;
      case 'enter_review': {
        // Run 16: next proposed enter_review with a verified LOW finding open
        // (advisory); the owner repaired it anyway with a managed finding-repair.
        const lowOpen = mode.lowFindings && next.phase === 'DEV'
          ? new StoryStore(o.worktree).readFindings(id).findings.find(f => f.status === 'open' && f.severity === 'low' && f.desc.startsWith('Upper '))
          : undefined;
        const repairedLowOpen = mode.lowFindings && next.phase === 'DEV'
          ? new StoryStore(o.worktree).readFindings(id).findings.find(f => f.status === 'open' && repairRunsByFinding.has(f.id))
          : undefined;
        if (repairedLowOpen && !mode.violations?.some(v => v.startsWith(`enter_review with repaired ${repairedLowOpen.id}`))) {
          mode.violations?.push(`enter_review with repaired ${repairedLowOpen.id} (${repairedLowOpen.severity}) still open: next must propose its finding_resolve first`);
        }
        if (lowOpen && !repairRunsByFinding.has(lowOpen.id)) {
          o.script(FINDING_REPAIR, repairScript(lowOpen.desc));
          const launched = o.mustCli('host_run', { host: 'codex', model: MODEL.model, reasoningEffort: MODEL.reasoningEffort, storyId: id,
            agentType: FINDING_REPAIR, findingId: lowOpen.id, managedDispatch: true, detach: true, json: true }, { label: 'host_run finding-repair (owner, low)' });
          const runId = String((parseJson(launched.stdout)?.run as Record<string, unknown>).runId);
          const terminal = waitTerminal(o, 'finding-repair (low)', runId);
          o.unscript(FINDING_REPAIR);
          assert.equal(terminal.state, 'completed', `[${o.scenario}] owner low finding-repair ${terminal.state} (${terminal.reason})`);
          repairRunsByFinding.set(lowOpen.id, [runId]);
          reasons.push(`owner_repair_low:${lowOpen.id}`);
          ownerTurns += 2;
          continue;
        }
        break;
      }
      case 'live_smoke':
        liveSmokeProposals += 1;
        if (mode.contextSmoke) {
          // Passes only with the project validate.env applied (CONTEXT=abs, run 16 §2e).
          payload.capture = 'test "$CONTEXT" = abs && go test -v ./strs';
          if (liveSmokeProposals > 1) {
            mode.violations?.push(`live_smoke proposed again: the capture without an exported CONTEXT did not pass (validate.env not applied); why: ${next.why.slice(0, 160)}`);
            // The owner's run-16 workaround: export it.
            payload.capture = 'export CONTEXT=abs; test "$CONTEXT" = abs && go test -v ./strs';
          }
        }
        break;
      case 'finding_resolve': {
        const findingId = String(payload.findingId);
        // Run 14: next must never propose closing a finding no repair bound to it produced.
        const runIds = [...new Set([...(repairRunsByFinding.get(findingId) ?? []), ...(repairRunsOnDisk(runsRoot).get(findingId) ?? [])])];
        const repaired = runIds.some(runId => {
          const terminal = join(runsRoot, runId, 'terminal.json');
          return existsSync(terminal) && (JSON.parse(readFileSync(terminal, 'utf8')) as { state?: string }).state === 'completed';
        });
        assert.ok(repaired, `[${o.scenario}] next proposed finding_resolve for ${findingId} although no managed finding-repair run bound to it completed (runs per finding: ${JSON.stringify([...repairRunsByFinding])}); why: ${next.why}`);
        authorPayload(o, next.reason, payload, findingDesc);
        break;
      }
      default:
        authorPayload(o, next.reason, payload, findingDesc);
        break;
    }
    // Q6 (b): a batch is the owner's one turn of authoring commands, run in order.
    const calls = next.batch?.length
      ? next.batch.map(call => { const filled = { ...call.cli.payload }; authorPayload(o, call.reason, filled, findingDesc); return { reason: call.reason, command: call.cli.command, payload: filled, line: call.command }; })
      : [{ reason: next.reason, command: next.cli.command, payload, line: next.command ?? '' }];
    ownerTurns += 1;
    for (const call of calls) {
      const unfilled = Object.entries(call.payload).filter(([, value]) => typeof value === 'string' && /^<.*>$/.test(value)).map(([key]) => key);
      assert.deepEqual(unfilled, [], `[${o.scenario}] ${call.reason}: harness has no value for placeholder(s) ${unfilled.join(', ')}`);
      const ran = o.cli(call.command, call.payload, { label: `  ${next.kind[0]}:${call.reason}`.slice(0, 44) });
      assert.equal(ran.status, 0, `[${o.scenario}] next proposed ${call.line} (${call.reason}) and its gate refused it:\n${ran.out.slice(-2500)}`);
      const launched = parseJson(ran.stdout)?.run as Record<string, unknown> | undefined;
      if (call.command === 'host_run' && launched?.runId) {
        scriptKeyByRun.set(String(launched.runId), call.reason === 'delivery_review_launch' ? DELIVERY : call.reason === 'finding_repair' ? FINDING_REPAIR : String(call.payload.reviewRunId));
        if (call.reason === 'finding_repair') {
          const findingId = String(call.payload.findingId);
          repairRunsByFinding.set(findingId, [...(repairRunsByFinding.get(findingId) ?? []), String(launched.runId)]);
        }
      }
    }
  }
  assert.equal(new StoryStore(o.root).readStory(id).phase, 'DONE', `[${o.scenario}] next never reached DONE; steps: ${reasons.join(' > ')}`);
  lines.push(`next-driven steps (${reasons.length}): ${reasons.join(' > ')}`);
  lines.push(`owner turns from REVIEW entry: ${ownerTurns} (${reasons.filter(row => !row.startsWith('run:')).length} owner-executed steps)`);
  if (mode.run) lines.push(`framework steps executed inside next --run: ${internalCalls} (${(internalMs / 1000).toFixed(1)} s, included in the next --run call times)`);
  const unique = [...new Set(q6)];
  if (mode.violations) mode.violations.push(...unique);
  else assert.deepEqual(unique, [], `[${o.scenario}] Q6 next-driver contract violations:\n- ${unique.join('\n- ')}`);
}

/**
 * Run 16 (§2c, §2e): round 1 reports a medium finding plus two LOW findings.
 * next repairs and resolves the medium one; at enter_review the owner repairs
 * the first LOW finding anyway (managed finding-repair bound to it). next must
 * then propose finding_resolve for it (same per-finding rule as medium) before
 * REVIEW, so DONE does not leave a repaired finding open. The cosmetic LOW
 * finding stays open (advisory) through DONE; finding_resolve after DONE must
 * refuse with a clear next action instead of leaving uncommitted metadata in the
 * integration checkout. The live-smoke capture needs validate.env (CONTEXT=abs).
 */
function scenarioNL(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const name = 'NL run 16: repaired LOW finding resolved before DONE; post-DONE resolve refused clean; live smoke uses validate.env';
  const o = new Owner('NL', 'B-e2eb', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const reasons: string[] = [];
  const violations: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, lowFindings: true, contextSmoke: true, violations }, lines, next => {
      if (next.reason === 'finding_repair' || next.reason === 'finding_resolve' || next.reason === 'enter_review') {
        reasons.push(`${next.reason}${next.cli?.payload.findingId ? `:${String(next.cli.payload.findingId)}` : ''}`);
      }
    });
    const order = reasons.filter((row, index) => row !== reasons[index - 1]);
    lines.push(`finding steps: ${order.join(' > ')}`);
    const findings = new StoryStore(o.root).readFindings(o.storyId).findings;
    const byDesc = (prefix: string) => findings.find(f => f.desc.startsWith(prefix));
    const repairedLow = byDesc('Upper ');
    const cosmetic = byDesc('Comment ');
    assert.ok(repairedLow && cosmetic, `NL: both low findings recorded: ${JSON.stringify(findings.map(f => [f.id, f.severity, f.status]))}`);
    if (repairedLow.status !== 'resolved') violations.push(`DONE left the repaired LOW finding ${repairedLow.id} ${repairedLow.status} (steps: ${order.join(' > ')})`);
    assert.equal(cosmetic.status, 'open', 'NL: the unrepaired cosmetic LOW finding stays open (advisory)');
    assert.match(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8'), /TestUpperEmpty/, 'low repair merged into main');
    // Post-DONE resolve from the integration checkout (run 16: owner in /app).
    const before = git(o.root, ['status', '--porcelain', '--untracked-files=all']);
    const late = o.cli('finding_resolve', { storyId: o.storyId, findingId: cosmetic.id, resolution: 'post-DONE: comment wording changed in a follow-up commit' }, { label: 'finding_resolve after DONE' });
    const after = git(o.root, ['status', '--porcelain', '--untracked-files=all']);
    lines.push(`finding_resolve after DONE: exit ${late.status}: ${late.out.split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 220)}`);
    if (after !== before) violations.push(`finding_resolve after DONE left uncommitted metadata in the integration checkout: ${after.replace(/\n/g, '; ')}`);
    if (late.status === 0) violations.push('finding_resolve after DONE was accepted (must refuse: the DONE record is merged)');
    else if (!/DONE/.test(late.out) || !/Next:/.test(late.out)) violations.push(`finding_resolve after DONE refusal must name DONE and one Next action: ${late.out.slice(-400)}`);
    assert.deepEqual(violations, [], `NL violations:\n- ${violations.join('\n- ')}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`NL fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

function scenarioN(machineEnv: NodeJS.ProcessEnv, steps: Step[], flow: 'A' | 'D', run: boolean): Outcome {
  const tag = `N${flow}${run ? '-run' : ''}`;
  const name = `${tag} ${flow}'s flow from REVIEW entry driven only by proof-or-stop next${run ? ' --run' : ''}`;
  const o = new Owner(tag, flow === 'A' ? (run ? 'B-e2e7' : 'B-e2e5') : (run ? 'B-e2e8' : 'B-e2e6'), machineEnv, steps, false, flow === 'D' ? { trackedGateFailureCounts: true } : {});
  const lines: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: flow === 'D', run }, lines);
    assert.match(git(o.root, ['log', '--format=%s', '-3', 'main']), new RegExp(`merge: ${o.storyId} `), 'story branch merged into main');
    if (flow === 'D') assert.match(readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8'), /TestReverseEmpty/, 'repair merged into main');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`${tag} fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Run 14: two verified findings in round 1. next drives the whole flow; the
 * finding_resolve assertion in driveWithNext fails the first time next proposes
 * closing a finding whose own managed repair has not completed.
 */
function scenarioNF(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  const name = 'NF run 14: two round-1 findings; next repairs each by its own managed finding-repair before resolving it';
  const o = new Owner('NF', 'B-e2ea', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
  const reasons: string[] = [];
  try {
    devSetup(o);
    driveWithNext(o, { findingRound1: true, run: false, twoFindings: true }, lines, next => {
      if (next.reason === 'finding_repair' || next.reason === 'finding_resolve') reasons.push(`${next.reason}:${String(next.cli?.payload.findingId ?? '').split(':').pop()}`);
    });
    const order = reasons.filter((row, index) => row !== reasons[index - 1]);
    lines.push(`finding steps: ${order.join(' > ')}`);
    assert.deepEqual(order, ['finding_repair:F-001', 'finding_resolve:F-001', 'finding_repair:F-002', 'finding_resolve:F-002'],
      `NF: each finding is repaired by its own run, then resolved: ${order.join(' > ')}`);
    const tests = readFileSync(join(o.root, 'strs/strs_test.go'), 'utf8');
    assert.match(tests, /TestReverseEmpty/, 'F-001 repair merged into main');
    assert.match(tests, /TestUpperEmpty/, 'F-002 repair merged into main');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`NF fixture retained for diagnosis: ${o.root}`);
    return { name, status: 'FAIL', lines: [...lines, error instanceof Error ? error.message : String(error)] };
  }
}

/** CLI calls and seconds from REVIEW entry (after the shared DEV setup), per scenario. */
function fromReviewEntry(steps: Step[], scenario: string): { calls: number; seconds: number; nextCalls: number } | null {
  const rows = steps.filter(s => s.scenario === scenario).slice(DEV_SETUP_CALLS);
  if (!rows.length) return null;
  return { calls: rows.length, seconds: rows.reduce((sum, s) => sum + s.ms, 0) / 1000, nextCalls: rows.filter(s => s.label.startsWith('next')).length };
}

function printNComparison(steps: Step[]): void {
  const pairs: Array<[string, string]> = [['A', 'NA'], ['A', 'NA-run'], ['D', 'ND'], ['D', 'ND-run']];
  const rows = pairs.map(([hand, driven]) => ({ hand, driven, h: fromReviewEntry(steps, hand), d: fromReviewEntry(steps, driven) })).filter(row => row.d);
  if (!rows.length) return;
  console.log('\nnext-driven vs hand-coded owner sequence, from REVIEW entry (after the 6 shared DEV setup calls):');
  for (const { hand, driven, h, d } of rows) {
    const handText = h ? `${hand}: ${h.calls} calls, ${h.seconds.toFixed(1)} s` : `${hand}: not run in this invocation`;
    console.log(`  ${driven}: ${d!.calls} calls (${d!.nextCalls} next), ${d!.seconds.toFixed(1)} s   |   ${handText}`);
  }
}

function scenarioD3(machineEnv: NodeJS.ProcessEnv, steps: Step[]): Outcome {
  // Run 13: the owner satisfied the review assurance floor with quorum_submit
  // (two distinct Codex sessions) instead of autopilot_review_submit. Its
  // lifecycle commit `quorum-submit` must keep the managed passes live at
  // done_prepare / DONE, and any lineage refusal in TEST must print a Next
  // that is valid in TEST.
  const name = 'D3 run 13: review assurance floor via quorum_submit, then done_prepare -> DONE';
  const o = new Owner('D3', 'B-e2e5', machineEnv, steps, false, { trackedGateFailureCounts: true });
  const lines: string[] = [];
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
    const quorum = o.cli('quorum_submit', { storyId: o.storyId, hostA: 'e2e-codex-host-a', hostB: 'e2e-codex-host-b',
      providerA: 'codex', providerB: 'codex', sessionA: 'codex-session-a', sessionB: 'codex-session-b', json: true }, { label: 'quorum_submit (2 codex sessions)' });
    assert.equal(quorum.status, 0, `D3: quorum_submit failed:\n${quorum.out.slice(-2000)}`);
    lines.push(`quorum_submit: ${git(o.worktree, ['log', '--format=%h %s', '-1'])}`);
    const floor = closureRow(o, 'done_closure (after quorum)', 'review-assurance-floor');
    lines.push(`review-assurance-floor after quorum_submit: status=${String(floor?.status)} blocking=${String(floor?.blocking)}`);
    const prepare = o.cli('done_prepare', { storyId: o.storyId, json: true });
    const prepared = parseJson(prepare.stdout);
    lines.push(`done_prepare: exit ${prepare.status} status=${String(prepared?.status)} blockedAt=${String(prepared?.blockedAt ?? '-')}`);
    const prepareText = prepare.out.replace(/\\"/g, '"');
    const refusal = prepareText.match(/\(unauthenticated commit ([0-9a-f]{12}) "([^"]*)": (.*?); (Next: proof-or-stop [^;)]*)/);
    if (refusal) {
      lines.push(`  lineage refusal: commit ${refusal[1]} "${refusal[2]}": ${refusal[3].slice(0, 100)}; ${refusal[4]}`);
      assert.doesNotMatch(refusal[4], /review_round_prepare/, 'D3: a REVIEW-only Next printed in TEST');
    }
    assert.doesNotMatch(prepare.out, /managed_review_live_head_lineage_invalid/, `D3: done_prepare refused the managed passes after quorum_submit: ${String(prepared?.reason ?? '').slice(0, 600)}`);
    const done = o.cli('story_advance', { storyId: o.storyId, phase: 'DONE' }, { label: 'story_advance DONE' });
    lines.push(`story_advance DONE: exit ${done.status} ${done.status ? firstError(done) : 'ok'}`);
    assert.equal(done.status, 0, `D3: story_advance DONE refused:\n${done.out.slice(-3000)}`);
    assert.equal(new StoryStore(o.root).readStory(o.storyId).phase, 'DONE');
    lines.push(`DONE reached; main HEAD: ${git(o.root, ['log', '--format=%h %s', '-1', 'main'])}`);
    o.cleanup();
    return { name, status: 'PASS', lines };
  } catch (error) {
    console.log(`D3 fixture retained for diagnosis: ${o.root}`);
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
  const only = process.argv.slice(2).filter(arg => /^(?:[ABCDEN]|D2|D3|NR|NF|NL|N[AD](?:-run)?)$/.test(arg));
  if (process.env.E2E_R2D_BARE_GITIGNORE === '1' && !only.includes('E')) {
    // Scenario A's flow on a bare task .gitignore replaces A.
    const index = only.indexOf('A');
    if (index >= 0) only.splice(index, 1);
    only.push('E');
  }
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
    if (!only.length || only.includes('D2')) outcomes.push(scenarioD2(machine.env, steps));
    if (!only.length || only.includes('D3')) outcomes.push(scenarioD3(machine.env, steps));
    if (only.includes('E')) outcomes.push(scenarioA(machine.env, steps, true).a);
    for (const [token, flow, run] of [['NA', 'A', false], ['ND', 'D', false], ['NA-run', 'A', true], ['ND-run', 'D', true]] as const) {
      const group = run ? 'NR' : 'N';
      if (only.includes(token) || only.includes(group)) outcomes.push(scenarioN(machine.env, steps, flow, run));
    }
    if (only.includes('NF')) outcomes.push(scenarioNF(machine.env, steps));
    if (only.includes('NL')) outcomes.push(scenarioNL(machine.env, steps));
  } finally {
    try { machine.cleanup(); } catch (error) { console.log(String(error)); }
  }
  for (const scenario of ['A', 'B', 'D', 'D2', 'D3', 'E', 'NA', 'ND', 'NA-run', 'ND-run', 'NF', 'NL']) if (steps.some(s => s.scenario === scenario)) printTimeline(steps, scenario);
  printNComparison(steps);
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
  console.log(`e2e-review-to-done-smoke: PASS (${outcomes.filter(outcome => outcome.status === 'PASS').map(outcome => outcome.name.split(' ')[0]).join(', ')} reached DONE)`);
}

// Importable by tasks/next-driver-cost-smoke.ts, which reuses the owner fixture and the next-driven flow.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // (internal) run-mode fake-provider resolver: --provide-script <root> <storyId> <scriptsDir> <modeJson> <runId>
  if (process.argv[2] === '--provide-script') provideScript(process.argv[3]!, process.argv[4]!, process.argv[5]!, process.argv[6]!, process.argv[7]!);
  else await main();
}
