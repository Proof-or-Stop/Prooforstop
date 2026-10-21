#!/usr/bin/env node
/**
 * Lab run132 (old-PoS run 135 items H and I; bench-staging/oldpos/run135-analysis.md): made-up rows only.
 *
 *   H. Delta confirmation (review.deltaSelectorRepair, default on, `off` = rollback). Run 135 R2: the confirm lane
 *      wrote `[reverified] F-001 :: go test -v ./evaluator -run <Test>/<sub> -count=1 :: PASS`; the generic selector was
 *      refused and the round went straight to a full round (~10 min, ~12M tokens). Now the prompt states the selector
 *      rule; a generic selector is filled from the test the command names; else it is asked for ONCE in the lane's
 *      own resumed session before the run seals; a selector still generic at import is taken from the framework's OWN
 *      re-run output (exactly one test-named pass line). No runtime file (the lane's live output) decides it.
 *   I. Duplicates (run 135 F-005, ~6.3 min): every open duplicate-family member's repro (any round) rides on the
 *      canonical's repair prompt, verbatim; after ONE `duplicate_coverage_lacks_repro` refusal `next` offers a ready
 *      owner step (append the repro to the covering test, rerun the same coverage, close) instead of a managed repair.
 *
 * Usage: node packages/main/dist/tasks/run135-hi-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Fn = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
/** A module export that may not exist yet (RED: the check fails, the smoke still runs). */
async function load(path: string, name: string): Promise<Fn> {
  let module: Record<string, unknown> = {};
  try { module = await import(path) as Record<string, unknown>; } catch { module = {}; }
  const fn = module[name];
  assert.ok(fn !== undefined, `${path} exports ${name}`);
  return fn as Fn;
}
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const noPlaceholder = (value: unknown): void => assert.doesNotMatch(JSON.stringify(value), /"<[a-z][^"]*>"/i, `no placeholder: ${JSON.stringify(value).slice(0, 400)}`);

const STORY = 'B-1350';
const binding = { checkItems: [] as string[], reverifyFindingIds: [`${STORY}:F-001`] };

// ---------------------------------------------------------------------------
// H. Delta confirmation selector

await check('H1 the confirmation prompt states the selector rule: a test-named line (`--- PASS: <TestName>`), a bare PASS / ok is refused', async () => {
  const render = await load('../core/review-delta-round.js', 'renderDeltaConfirmationBlock');
  const text = render({ mode: 'confirm', reviewRound: 'r2', previousRound: 'r1', fromHead: 'a'.repeat(40), headHash: 'b'.repeat(40), fullLanes: [], replacedLanes: ['proof-or-stop-review-concept'],
    scope: [], openFindings: [], resolvedFindings: [{ id: `${STORY}:F-001`, severity: 'medium', desc: 'x' }], repair: { files: [], changedLines: 0, storyChangedLines: 0 } }, STORY).join('\n');
  assert.match(text, /--- PASS: <TestName>/);
  assert.match(text, /bare (?:`?PASS`?|"PASS")[^\n]*refused/i);
});

await check('H2 a generic selector is filled from the test the command names (Go -run, a subtest path); off = refused as before', async () => {
  const checkNote = await load('../core/review-delta-round.js', 'checkDeltaConfirmationNote');
  const note = `[reverified] F-001 :: go test -v ./evaluator -run TestRangeNullEnd/array_explicit_null_end -count=1 :: PASS`;
  const on = checkNote({ binding, storyId: STORY, note, fillGeneric: true });
  assert.deepEqual(on.problems, [], JSON.stringify(on.problems));
  assert.equal(on.reverify[0]?.selector, '--- PASS: TestRangeNullEnd/array_explicit_null_end');
  assert.equal(on.reverify[0]?.selectorSource, 'command');
  const quoted = checkNote({ binding, storyId: STORY, note: `[reverified] F-001 :: go test -v ./evaluator -run '^TestSteppedSliceErrors$' :: ok`, fillGeneric: true });
  assert.equal(quoted.reverify[0]?.selector, '--- PASS: TestSteppedSliceErrors', 'anchors and quotes stripped');
  const off = checkNote({ binding, storyId: STORY, note });
  assert.match(off.problems.join(' '), /generic/, 'without the fill: refused as today');
  const alternation = checkNote({ binding, storyId: STORY, note: `[reverified] F-001 :: go test -v ./evaluator -run '^(TestA|TestB)$' :: PASS`, fillGeneric: true });
  assert.equal(alternation.reverify[0]?.selectorSource, 'rerun_output', 'a pattern naming several tests is not filled from the command (the re-run decides, H3)');
  assert.equal(alternation.reverify[0]?.selector, 'PASS');
});

await check('H3 no named test: filled from the framework\'s OWN re-run output only when it prints exactly one test-named pass line', async () => {
  const evaluate = await load('../core/review-delta-confirmation.js', 'evaluateDeltaConfirmation');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run135-h3-')));
  try {
    write(root, 'go.mod', 'module example.invalid/m\n\ngo 1.21\n');
    write(root, 'pkg/p.go', 'package pkg\n');
    write(root, 'pkg/p_test.go', 'package pkg\n\nimport "testing"\n\nfunc TestOnly(t *testing.T) { t.Run("sub", func(t *testing.T) {}) }\n');
    write(root, 'two/p_test.go', 'package two\n\nimport "testing"\n\nfunc TestA(t *testing.T) {}\n\nfunc TestB(t *testing.T) {}\n');
    const run = (dir: string, fillGeneric: boolean) => evaluate({ binding, storyId: STORY, conclusion: 'pass', note: `[reverified] F-001 :: go test -v ./${dir} -count=1 :: PASS`,
      readManifest: null, projectRoot: root, cwd: root, headHash: null, fillGeneric });
    const one = run('pkg', true);
    assert.equal(one.ok, true, one.reason);
    assert.equal(one.reverified[0]?.selector, '--- PASS: TestOnly');
    assert.equal(one.reverified[0]?.selectorSource, 'rerun_output');
    assert.equal(one.reverified[0]?.laneSelector, 'PASS');
    const two = run('two', true);
    assert.equal(two.ok, false, 'two tests: ambiguous');
    assert.match(two.reason, /generic/);
    const off = run('pkg', false);
    assert.equal(off.ok, false, 'off: refused as today');
    assert.match(off.reason, /generic/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('H3b no runtime file decides a selector: recorded/forged lane output is ignored, the import reads no live-output', async () => {
  const checkNote = await load('../core/review-delta-round.js', 'checkDeltaConfirmationNote');
  const forged = [{ command: 'go test -v ./pkg -count=1', output: '--- PASS: TestForged (0.00s)\n', exitCode: 0 }];
  const out = checkNote({ binding, storyId: STORY, note: '[reverified] F-001 :: go test -v ./pkg -count=1 :: PASS', fillGeneric: true, recorded: forged });
  assert.equal(out.reverify[0]?.selectorSource, 'rerun_output', 'left to the framework re-run');
  assert.notEqual(out.reverify[0]?.selector, '--- PASS: TestForged');
  const dist = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  assert.doesNotMatch(dist('../handlers/managed-review-evidence.js'), /live-output/, 'import handler');
  assert.doesNotMatch(dist('../core/delta-reverify-selector.js'), /live-output|readFileSync/, 'selector module');
});

await check('H4 the switch: review.deltaSelectorRepair default on, `off` recorded as the rollback arm', async () => {
  const flags = await import('../core/ab-variants.js') as { AB_VARIANT_FLAGS: Record<string, readonly string[]>; deltaSelectorRepairOn?: Fn };
  assert.deepEqual([...(flags.AB_VARIANT_FLAGS['review.deltaSelectorRepair'] ?? [])], ['on', 'off']);
  assert.equal(flags.deltaSelectorRepairOn?.({}), true);
  assert.equal(flags.deltaSelectorRepairOn?.({ review: { deltaSelectorRepair: 'off' } }), false);
});

// Worker path: a fake codex confirmation lane whose note names a generic selector the command does not decide.
const THREAD = '019a1f18-c8d8-7000-8000-0000000013d5';
const LANE = 'proof-or-stop-review-concept';
const REVIEW_RUN = `${STORY}:RR-006`;
const READ = {
  readManifest: { filesReadFully: ['docs/src/docs/types/array.md', 'docs/src/docs/types/string.md', 'docs/src/docs/syntax/assignments.md', 'examples/index_ranges.abs', 'examples/unicode.abs'],
    filesTriagedByName: ['tests/test-assign-index.abs', 'ast/ast_test.go', 'ast/ast.go', 'evaluator/evaluator_test.go', 'evaluator/evaluator.go', 'parser/parser_test.go', 'parser/parser.go'],
    scanEscalationReason: 'The repository requirements corpus is still unavailable and the prior candidate binding is stale after remediation, so the full repaired parser/AST/evaluator/docs material must be re-scanned for the fresh review round.',
    candidateSpecSetDigest: '6cdc41a9d6483eb4e07d9e041d14cbfe35f86408ff3ab5b4519a764c91f62422', corpusDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945' },
  readLog: { filesReadFully: ['docs/src/docs/types/array.md', 'docs/src/docs/types/string.md', 'docs/src/docs/syntax/assignments.md', 'examples/index_ranges.abs', 'examples/unicode.abs'],
    filesTriagedByName: ['tests/test-assign-index.abs', 'ast/ast_test.go', 'ast/ast.go', 'evaluator/evaluator_test.go', 'evaluator/evaluator.go', 'parser/parser_test.go', 'parser/parser.go'],
    summary: { readCount: 5, tokenCount: null }, digest: '98f172c84b33306ee58f6de26ac39de529f4369c5e61d938632f2cb5e9eca222' },
};
const envelope = (selector: string): string => JSON.stringify({ schemaVersion: 'lattice.managed_review_final_proposal.v1', storyId: STORY, providerAgent: LANE, lane: LANE, reviewRunId: REVIEW_RUN,
  conclusion: 'pass', note: `[checked] concern:concept :: read the repair\n[reverified] F-001 :: go test -v ./pkg -count=1 :: ${selector}`, ...READ });

function writeFakeCodex(bin: string, state: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const state = ${JSON.stringify(state)};
let input = ''; process.stdin.on('data', d => { input += d; }); process.stdin.on('end', () => {
  const resumed = process.argv[2] === 'exec' && process.argv[3] === 'resume';
  fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify({ argv: process.argv.slice(2), stdin: input }) + '\\n');
  const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'thread.started', thread_id: ${JSON.stringify(THREAD)} });
  if (!resumed) {
    const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '22');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-10-22T06-58-17-${THREAD}.jsonl'), '{}\\n');
  }
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: fs.readFileSync(path.join(state, resumed ? 'second.txt' : 'first.txt'), 'utf8') } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } });
});
`, { mode: 0o755 });
}

async function workerCase(base: string, name: string, opts: { first: string; second: string; off?: boolean }) {
  const mod = await import('../core/managed-host-run.js');
  const { resetConfigCache } = await import('../core/config.js');
  const root = join(base, name);
  const state = join(root, '.fake-codex'); const bin = join(root, '.fake-bin'); const codexHome = join(root, '.codex-home');
  mkdirSync(state, { recursive: true }); mkdirSync(codexHome, { recursive: true });
  writeFakeCodex(bin, state);
  writeFileSync(join(state, 'first.txt'), opts.first); writeFileSync(join(state, 'second.txt'), opts.second); writeFileSync(join(state, 'invocations.jsonl'), '');
  if (opts.off) write(root, 'proof-or-stop.config.json', JSON.stringify({ review: { deltaSelectorRepair: 'off' } }));
  resetConfigCache();
  const deltaRound = { schema: 'proof-or-stop.review-delta-round.v1', abVariant: { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.deltaRounds': 'confirm' } }, role: 'confirmation',
    reviewRound: 'r2', previousRound: 'r1', fromHead: 'a'.repeat(40), planDigest: 'd', confirmationLane: LANE, replacedLanes: [LANE], fullLanes: [],
    checkItems: ['concern:concept'], reverifyFindingIds: [`${STORY}:F-001`], mode: 'confirm', scope: [] };
  let worker: Promise<unknown> | null = null;
  const submitted = await mod.submitManagedHostRun({
    root, cwd: root, host: 'codex', storyId: STORY, phase: 'REVIEW', agentType: LANE, reviewRunId: REVIEW_RUN, lane: LANE, promptText: 'confirm the delta',
    deadlineMs: 60_000, projectRootHash: `sha256:${name}`, profile: 'managed_reviewer',
    reviewBinding: { headHash: 'h', materialHash: 'm', storyFilesHash: 's', promptHash: 'p', envelopeId: null, deltaRound },
  } as never, {
    launchWorker: async (request: unknown) => {
      worker = mod.runManagedHostRunWorker(request as never, { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CODEX_HOME: codexHome, PROOF_OR_STOP_USAGE_LEDGER: '0' }, cancelPollMs: 5 });
      return { pid: process.pid };
    },
    claimTimeoutMs: 5_000, claimPollMs: 5,
  } as never);
  const terminal = await (worker as unknown as Promise<{ state: string; reason: string }>);
  const invocations = readFileSync(join(state, 'invocations.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; stdin: string });
  const events = readFileSync(join(mod.managedHostRunDirectory(root, submitted.runId), 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; detail?: Record<string, unknown> });
  const proposal = mod.readManagedReviewEvidenceProposal(root, submitted.runId) as { note?: string } | null;
  resetConfigCache();
  return { terminal, invocations, events, proposal };
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'run135-hi-')));
try {
  await check('H5 worker: a generic selector the command does not decide is corrected ONCE in the lane\'s own resumed session (answer only), then sealed', async () => {
    const out = await workerCase(base, 'corrected', { first: envelope('PASS'), second: envelope('--- PASS: TestOnly') });
    assert.equal(out.terminal.state, 'completed', `${out.terminal.state}: ${out.terminal.reason}`);
    assert.equal(out.invocations.length, 2, 'one correction turn');
    assert.deepEqual(out.invocations[1]!.argv.slice(0, 2), ['exec', 'resume']);
    assert.equal(out.invocations[1]!.argv.at(-2), THREAD, 'the SAME session');
    assert.match(out.invocations[1]!.stdin, /F-001/);
    assert.match(out.invocations[1]!.stdin, /--- PASS: <TestName>/);
    assert.match(out.invocations[1]!.stdin, /Do not run/i);
    assert.match(String(out.proposal?.note), /--- PASS: TestOnly/, 'the corrected note is the proposal');
    assert.ok(out.events.some(event => event.type === 'delta_reverify_selector_correction'), out.events.map(event => event.type).join(','));
  });
  await check('H6 worker: a failed correction (invalid re-emission) keeps the original valid proposal, so the import gaps and escalates as today', async () => {
    const out = await workerCase(base, 'kept', { first: envelope('PASS'), second: 'not json at all' });
    assert.equal(out.terminal.state, 'completed', `${out.terminal.state}: ${out.terminal.reason}`);
    assert.equal(out.invocations.length, 2);
    assert.match(String(out.proposal?.note), /:: PASS$/m, 'the original note');
  });
  await check('H7 worker: review.deltaSelectorRepair=off: no correction turn (today)', async () => {
    const out = await workerCase(base, 'off', { first: envelope('PASS'), second: envelope('--- PASS: TestOnly'), off: true });
    assert.equal(out.terminal.state, 'completed', `${out.terminal.state}: ${out.terminal.reason}`);
    assert.equal(out.invocations.length, 1);
  });
} finally {
  rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// I. Duplicate family repros and the lacks-repro step

await check('I1 the canonical repair prompt carries every open duplicate-family member\'s repro (any round), to be stated verbatim in the regression test', async () => {
  const lines = await load('../core/regression-family-brief.js', 'sameRoundDuplicateLines');
  const findings = [
    { id: `${STORY}:F-001`, desc: 'explicit null end errors', status: 'open', reviewRound: 'r1' },
    { id: `${STORY}:F-005`, desc: 'Consequently `s = "abc"; s[0:null]` raises.', status: 'open', reviewRound: 'r1' },
    { id: `${STORY}:F-007`, desc: 'Repro: `t = [1]; t[0:null]`', status: 'open', reviewRound: 'r2' },
    { id: `${STORY}:F-008`, desc: 'Repro: `u[0:null]`', status: 'resolved', reviewRound: 'r1' },
  ];
  const text = lines({ storyId: STORY, finding: findings[0], findings, duplicateOf: (id: string) => (id.endsWith('F-001') ? null : `${STORY}:F-001`) }).join('\n');
  assert.match(text, /F-005[^\n]*s = "abc"; s\[0:null\]/);
  assert.match(text, /F-007[^\n]*t = \[1\]; t\[0:null\]/, 'a later-round duplicate of the same canonical');
  assert.doesNotMatch(text, /F-008/, 'a closed member is not repaired again');
  assert.match(text, /verbatim/i);
});

await check('I2 after ONE lacks-repro refusal the duplicate is not grouped into a managed repair; after a second one it is', async () => {
  const joins = await load('../core/duplicate-finding-coverage.js', 'duplicateJoinsRepairGroup');
  const pending = await load('../core/duplicate-finding-coverage.js', 'reproAppendReceipt');
  const lacks = { findingId: `${STORY}:F-005`, canonicalFindingId: `${STORY}:F-001`, command: 'go test -v ./evaluator -run ^TestNullEnd$', selector: '--- PASS: TestNullEnd', passed: false, refusal: 'duplicate_coverage_lacks_repro' };
  const storeOf = (receipts: unknown[]) => ({ readDuplicateFindingCoverage: () => ({ receipts }) });
  const finding = { id: `${STORY}:F-005`, desc: 'Consequently `s = "abc"; s[0:null]` raises.' };
  assert.ok(pending([lacks]), 'one lacks-repro refusal: the append step is due');
  assert.equal(joins(storeOf([lacks]), STORY, finding, []), false, 'not grouped into a managed repair');
  assert.equal(pending([lacks, lacks]), null, 'a second refusal: its own repair');
  assert.equal(joins(storeOf([lacks, lacks]), STORY, finding, []), true);
  assert.equal(joins(storeOf([{ ...lacks, refusal: 'duplicate_coverage_failed' }]), STORY, finding, []), true, 'a failing coverage run is a repair as before');
});

await check('I3 the lacks-repro step is ready: the covering test (file + function from the canonical repair commit), the missing repro, the same coverage call', async () => {
  const stepOf = await load('../handlers/next-driver.js', 'duplicateReproAppendStep');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run135-i3-')));
  try {
    git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.name', 'T']); git(root, ['config', 'user.email', 't@t.invalid']);
    write(root, 'evaluator/evaluator.go', 'package evaluator\n'); git(root, ['add', '-A']); git(root, ['commit', '-qm', 'base']);
    write(root, 'evaluator/evaluator_test.go', 'package evaluator\n\nimport "testing"\n\nfunc TestNullEnd(t *testing.T) {\n\tcases := []string{"\\"abc\\"[0:null]"}\n\t_ = cases\n}\n');
    git(root, ['add', '-A']); git(root, ['commit', '-qm', `${STORY} F-001: resolve finding`]);
    const commit = git(root, ['rev-parse', 'HEAD']);
    const canonical = { id: `${STORY}:F-001`, status: 'resolved', resolvedReason: `Framework-verified repair of ${STORY}:F-001: material commit ${commit.slice(0, 12)} of managed finding-repair run r1` };
    const finding = { id: `${STORY}:F-005`, severity: 'medium', desc: 'Consequently `s = "abc"; s[0:null]` raises.' };
    const receipt = { findingId: finding.id, canonicalFindingId: canonical.id, command: 'go test -v ./evaluator -run ^TestNullEnd$', selector: '--- PASS: TestNullEnd', passed: false, refusal: 'duplicate_coverage_lacks_repro' };
    const out = stepOf({ storyId: STORY, phase: 'REVIEW' }, finding, canonical, null, receipt, { gitCwd: root, findings: [finding, canonical], findingsPath: 'findings.json' });
    assert.equal(out.reason, 'duplicate_repro_append');
    assert.equal(out.cli.command, 'finding_resolve');
    assert.deepEqual(out.cli.payload.coverage, { command: receipt.command, selector: receipt.selector }, 'the same coverage, rerun after the append');
    assert.equal(out.cli.payload.duplicateOf, canonical.id);
    noPlaceholder(out.cli.payload);
    assert.match(out.why, /evaluator\/evaluator_test\.go/);
    assert.match(out.why, /TestNullEnd/);
    assert.match(out.why, /s = "abc"; s\[0:null\]/);
    assert.match(out.why, /verbatim/i);
    assert.match(out.why, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the absolute test path');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

if (failures.length) {
  console.log(`run135-hi-smoke: ${failures.length} check(s) FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('run135-hi-smoke: all checks passed');
void existsSync;
