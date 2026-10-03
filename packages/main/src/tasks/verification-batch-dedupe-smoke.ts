#!/usr/bin/env node
/**
 * Verification batch dedupe smoke (run 14 cost #1).
 *
 * A DEV Story with N pinned executable intents over K < N unique pinned
 * commands. The owner drives only `proof-or-stop next --json` and executes the
 * returned `evidence_chain` steps until the evidence chain is clean, as
 * `next --run` does. Run 14 spent 16.8 min here: next emitted one
 * `verification_run` per intent (49 steps for 10 unique go test commands), each
 * re-executing its command and writing its own metadata commit.
 *
 * Required now:
 *   - one evidence_chain step (a batch), K real executions, 1 metadata commit;
 *   - all N receipts recorded, fresh and admissible (each row's own signed
 *     assertion receipt validated with its own selector against the shared
 *     execution output: the coverage gate reports every intent `covered`);
 *   - a selector that does not match the shared output still fails that one
 *     intent (the step is refused and names it, no row is minted for it), the
 *     other intents are recorded, and still only K executions happen.
 *
 * Executions are counted twice: distinct signed execution receipts on the
 * recorded rows, and signed causal receipts in the Story's CAS (one per real
 * launch, including a launch whose selector then fails).
 *
 * Usage: node packages/main/dist/tasks/verification-batch-dedupe-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { createVerificationEvidenceGateEvaluator } from '../core/proof-admissibility.js';
import { isSplitVerificationReceipt } from '../core/verification-execution-evidence.js';
import { withValidationSigningRoot } from '../core/validation-signing-context.js';
import { CAUSAL_RECEIPT_DIRECTORY } from '../core/causal-evidence.js';
import type { ChecklistData } from '../core/types.js';

const SELF = fileURLToPath(import.meta.url);
const UPPER = 'go test -v ./strs -run TestUpper';
const REVERSE = 'go test -v ./strs -run TestReverse';

type Pin = { command: string; selector: string };

function intent(id: string, desc: string, pin: Pin) {
  return { id, desc, type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const,
    expectation: 'absolute_pass' as const, requirementSource: 'story' as const, verification: pin };
}

/** N=6 intents over K=2 unique pinned commands; CHK-002:edge:0 shares CHK-001's command. */
/** badRef: the one intent whose selector is absent from its shared output (first or last of its execution key). */
function pinnedIntents(badRef: string | null) {
  const sel = (ref: string, selector: string) => ref === badRef ? '--- PASS: TestUpperNotInOutput' : selector;
  return {
    'CHK-001': {
      happy: [
        intent('CHK-001:happy:0', 'TestUpper passes', { command: UPPER, selector: sel('CHK-001:happy:0', '--- PASS: TestUpper') }),
        intent('CHK-001:happy:1', 'TestUpper runs', { command: UPPER, selector: '=== RUN   TestUpper' }),
      ],
      edge: [intent('CHK-001:edge:0', 'the strs package passes under the Upper selection', { command: UPPER, selector: 'ok  \texample.com/strs' })],
      adversarial: [],
    },
    'CHK-002': {
      happy: [
        intent('CHK-002:happy:0', 'TestReverse passes', { command: REVERSE, selector: '--- PASS: TestReverse' }),
        intent('CHK-002:happy:1', 'TestReverse runs', { command: REVERSE, selector: '=== RUN   TestReverse' }),
      ],
      edge: [intent('CHK-002:edge:0', 'Upper still passes next to Reverse',
        { command: UPPER, selector: sel('CHK-002:edge:0', '--- PASS: TestUpper') })],
      adversarial: [],
    },
  } as const;
}

const N = 6;
const K = 2;

interface Measure { steps: string[]; refusedStep?: string; executions: number; launches: number; commits: number; ms: number }

async function scenario(name: string, badRef: string | null): Promise<Measure> {
  const { Owner } = await import('./e2e-review-to-done-smoke.js');
  const { createFixtureMachineEnvironment } = await import('./helpers/fixture-machine-environment.js');
  const machine = createFixtureMachineEnvironment();
  const o = new Owner(name, 'B-bd01', machine.env, [], false);
  let passed = false;
  try {
    const id = o.storyId;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: o.worktree, encoding: 'utf8' }).trim();
    // Author the pinned intents on the Story branch (as PLAN leaves them).
    const store = new StoryStore(o.worktree);
    const cl = store.readChecklist(id) as ChecklistData;
    const intents = pinnedIntents(badRef);
    for (const item of cl.items) item.verificationIntent = JSON.parse(JSON.stringify(intents[item.id as keyof typeof intents]));
    store.writeChecklist(id, cl);
    resetConfigCache();
    git('add', '-A');
    git('-c', 'user.name=Bench Owner', '-c', 'user.email=owner@bench.invalid', 'commit', '-qm', `proof-or-stop: PLAN pins ${id}`);
    o.mustCli('dev_memory_preflight_ack', { storyId: id });
    o.mustCli('scope_contract_init_from_plan', { storyId: id });
    o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-001', status: 'done' });
    o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-002', status: 'done' });

    const commitsBefore = Number(git('rev-list', '--count', 'HEAD'));
    const steps: string[] = [];
    let refusedStep: string | undefined;
    const started = Date.now();
    for (let i = 0; i < 3 * N; i += 1) {
      const asked = o.mustCli('next', { storyId: id, json: true });
      const next = JSON.parse(asked.stdout) as { reason: string; command: string | null; cli: { command: string; payload: Record<string, unknown> } | null };
      if (next.reason !== 'evidence_chain' || !next.cli) break;
      if (refusedStep && next.command === refusedStep) break; // the same refused step again: nothing more to run
      steps.push(next.command!);
      const ran = o.cli(next.cli.command, next.cli.payload, { label: `evidence_chain ${next.cli.command}` });
      if (ran.status !== 0) {
        refusedStep = next.command!;
        assert.ok(badRef, `[${name}] evidence step refused unexpectedly:\n${ran.out.slice(-3000)}`);
        assert.ok(ran.out.includes(badRef), `[${name}] the refusal must name the mismatching intent:\n${ran.out.slice(-3000)}`);
        assert.match(ran.out, /receipt_selector_absent/, `[${name}] the refusal must be the selector diagnosis:\n${ran.out.slice(-3000)}`);
      }
    }
    const ms = Date.now() - started;
    const commits = Number(git('rev-list', '--count', 'HEAD')) - commitsBefore;

    // Every recorded row: its own signed receipt, judged by the real gate
    // evaluator in a probe process from the Story worktree (the owner's cwd).
    const probed = o.node([SELF, '--probe', id]);
    assert.equal(probed.status, 0, `[${name}] coverage probe failed:\n${probed.out.slice(-3000)}`);
    const { status, executionReceipts, rows } = JSON.parse(probed.stdout.trim().split('\n').at(-1)!) as
      { status: Record<string, string>; executionReceipts: number; rows: Record<string, boolean> };
    const expectedCovered = Object.values(intents).flatMap(lanes => [...lanes.happy, ...lanes.edge]).map(row => row.id)
      .filter(ref => ref !== badRef);
    for (const ref of expectedCovered) assert.equal(status[ref], 'covered', `[${name}] ${ref} must be covered by its own fresh receipt; got ${status[ref]}`);
    if (badRef) {
      assert.notEqual(status[badRef], 'covered', `[${name}] a selector absent from the shared output must not be covered`);
      assert.equal(rows[badRef], undefined, `[${name}] no row may be minted for the refused intent`);
    }
    // One signed causal receipt per real launch (each carries a fresh observation id).
    const receiptDir = join(new StoryStore(o.worktree).storyDirPath(id), CAUSAL_RECEIPT_DIRECTORY);
    const launches = existsSync(receiptDir) ? readdirSync(receiptDir).filter(file => /^[0-9a-f]{64}\.json$/.test(file)).length : 0;
    passed = true;
    return { steps, ...(refusedStep ? { refusedStep } : {}), executions: executionReceipts, launches, commits, ms };
  } finally {
    if (passed) o.cleanup(); else console.log(`fixture retained for diagnosis: ${o.root}`);
    try { machine.cleanup(); } catch (error) { console.log(String(error)); }
  }
}

/** Probe (cwd = Story worktree): coverage status per intent through the real gate evaluator. */
function probe(storyId: string): void {
  // Receipts bind the execution implementation (its runtime part digests the
  // entrypoint); judge them as the real CLI entry would.
  process.argv[1] = realpathSync(fileURLToPath(new URL('../cli.js', import.meta.url)));
  const root = realpathSync(process.cwd());
  withValidationSigningRoot(root, () => probeIn(root, storyId));
}

function probeIn(root: string, storyId: string): void {
  const checklist = new StoryStore(root).readChecklist(storyId);
  const coverage = buildVerificationCoverage(checklist, undefined, undefined, {
    receiptAdmissibility: createVerificationEvidenceGateEvaluator(root, storyId),
  });
  const executions = new Set<string>();
  const rows: Record<string, boolean> = {};
  for (const item of checklist.items) {
    for (const evidence of item.verificationEvidence ?? []) {
      const receipt = evidence.receipt;
      rows[evidence.intentRef] = Boolean(receipt && isSplitVerificationReceipt(receipt));
      if (receipt && isSplitVerificationReceipt(receipt)) executions.add(JSON.stringify(receipt.executionReceipt));
    }
  }
  process.stdout.write(`${JSON.stringify({ status: Object.fromEntries(coverage.entries.map(entry => [entry.intentRef, entry.status])), executionReceipts: executions.size, rows })}\n`);
}

if (process.argv[2] === '--probe') { probe(process.argv[3]!); process.exit(0); }

const good = await scenario('VBD', null);
console.log(`all-pass: N=${N} intents over K=${K} commands -> ${good.steps.length} evidence step(s), ${good.launches} launch(es) / ${good.executions} distinct execution receipt(s), ${good.commits} metadata commit(s), ${good.ms} ms`);
for (const step of good.steps) console.log(`  step: ${step}`);
const bad = await scenario('VBDX', 'CHK-002:edge:0');
// The refused intent is the FIRST of its execution key: its completed execution
// must still be shared with the intents after it, not relaunched.
const badHead = await scenario('VBDH', 'CHK-001:happy:0');
console.log(`selector-mismatch (first of its key): ${badHead.steps.length} evidence step(s), ${badHead.launches} launch(es) / ${badHead.executions} distinct execution receipt(s), ${badHead.commits} metadata commit(s), ${badHead.ms} ms; refused: ${badHead.refusedStep ?? 'none'}`);
console.log(`selector-mismatch (last of its key): ${bad.steps.length} evidence step(s), ${bad.launches} launch(es) / ${bad.executions} distinct execution receipt(s), ${bad.commits} metadata commit(s), ${bad.ms} ms; refused: ${bad.refusedStep ?? 'none'}`);
assert.equal(good.steps.length, 1, `all N pinned intents must be one batch step (got ${good.steps.length})`);
assert.equal(good.launches, K, `K unique pinned commands must launch K times (got ${good.launches})`);
assert.equal(good.executions, K, `N receipts must share K execution receipts (got ${good.executions})`);
assert.equal(good.commits, 1, `one metadata commit per batch (got ${good.commits})`);
assert.equal(bad.launches, K, `the mismatching selector must not cause an extra launch (got ${bad.launches})`);
assert.ok(bad.refusedStep, 'the mismatching intent must refuse the batch step');
assert.equal(badHead.launches, K, `a refused first intent must still share its execution (got ${badHead.launches} launches)`);
assert.ok(badHead.refusedStep, 'the mismatching first intent must refuse the batch step');
console.log('verification-batch-dedupe-smoke: PASS');
