#!/usr/bin/env node

// Regression (benchmark run 11, abs Go task, B-d1e8:RR-009): a managed docs
// reviewer worked for 5.4 minutes, concluded "pass", and emitted its final
// managed-review envelope with unescaped double quotes inside `note`
// (`"012345"[1:5:2]`). The strict final-envelope parser rejected it
// (`managed_review_final_result_invalid:managed_review_final_result_malformed`)
// and the owner had to re-prepare the round and rerun the whole lane.
//
// A final result that fails to parse or fails the final-proposal schema must
// instead resume the SAME provider session with a short format-repair prompt
// (exact error + "re-emit only the final JSON object"). The re-emitted output
// passes through the identical strict validation; attempts are bounded, every
// attempt is recorded in the run's event journal, and an exhausted repair
// seals today's replacement-safe `managed_review_final_result_invalid` terminal.
//
// The provider is a fake `codex` on PATH driven through the real default
// runner, so the envelope is parsed from a Codex JSON event stream exactly as
// in production. The malformed envelope is the byte-exact saved RR-009 output.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  managedHostRunDirectory,
  managedHostRunReceipt,
  readManagedHostRunResult,
  readManagedReviewEvidenceProposal,
  runManagedHostRunWorker,
  submitManagedHostRun,
} from '../core/managed-host-run.js';
import type { ManagedHostRunTerminal } from '../core/managed-host-run.js';

const MARKER = 'managed-final-json-repair: malformed final envelope was not repaired by resuming the provider session';
const STORY = 'B-d1e8';
const LANE = 'proof-or-stop-review-docs';
const REVIEW_RUN = 'B-d1e8:RR-009';
const THREAD = '019a1f18-c8d8-7000-8000-00000000d0c5';

// Saved finalAssistantResult of the rejected RR-009 run (byte-exact).
const RR009_MALFORMED: string = "{\"schemaVersion\": \"lattice.managed_review_final_proposal.v1\", \"storyId\": \"B-d1e8\", \"providerAgent\": \"proof-or-stop-review-docs\", \"lane\": \"proof-or-stop-review-docs\", \"reviewRunId\": \"B-d1e8:RR-009\", \"conclusion\": \"pass\", \"note\": \"Re-review of story B-d1e8 stepped index ranges at candidate 1f18c8d8700071ce67da2d7746f307c203f3952e (docs consistency lane). Prior finding B-d1e8:F-005 is FIXED: docs/src/docs/types/array.md:43 now reads `array[0:2] # [0, 1]` and :52 `array[:2] # [0, 1]`, and the surrounding prose now states start is inclusive and end is exclusive, matching the evaluator. Earlier non-docs findings confirmed resolved against the new material: B-d1e8:F-001 (backing-array sharing) is fixed by the new unit-step view path in evaluator/evaluator.go:1508-1531 - verified by running the built binary that `a=[1,2,3,4]; b=a[0:2]; b[0]=99` yields a[0]=99, and likewise for `a[0:2:1]`; B-d1e8:F-002/F-003/F-004 (under-bound parser/evaluator test coverage) are addressed by new cases and pass. Re-verified every documentation example touched by the diff by running a locally built binary from this checkout: array.md (`array[0:2]`->[0,1], `array[:2]`->[0,1], `array[7:]`->[7,8,9], `array[:-3]`->[0..6], `array[1:5:2]`->[1,3], `array[::2]`->[0,2,4], `array[4::-1]`->[4,3,2,1,0], `array[::0]`->slice step cannot be 0), string.md (`\"012345\"[1:5:2]`->13, `[::2]`->024, `[4::-1]`->43210, `[::0]` error), assignments.md (`a[1:4]=[10,20,30]`, `a[::2]=9`, `a[0:2]=[1]` size mismatch, `s[0]=A`, `s[1:3]=XY`, `s[3:]=-` broadcast), examples/index_ranges.abs and examples/unicode.abs. All match the implementation; parser/evaluator test suites pass (`go test ./parser ./evaluator`). Variant analysis on the changed docs: the analogous two-part range examples in string.md were already exclusive and remain consistent; no other in-scope doc paragraph describes the changed range behavior incorrectly. Non-blocking, out-of-scope observation (unchanged by this story and not about index ranges): examples/index_ranges.abs:4 comment `str.split(\"\")[:5]` shows `[\"H\", \"e\", \"l\", \"l\", \"o\"]` but the binary prints `[\"Hello world!\"]`; identical behavior exists on the base revision, so it is pre-existing and not a Story regression. Controller-fetched canonical reports: acceptance_topology_check pass, pre_review_check_read pass, acceptance_rollout_report_read missing (AR_REPORT_MISSING, blocking=false), acceptance_rollout_check missing (AR_REPORT_MISSING, blocking=false).\", \"readManifest\": {\"filesReadFully\": [\"docs/src/docs/types/array.md\", \"docs/src/docs/types/string.md\", \"docs/src/docs/syntax/assignments.md\", \"examples/index_ranges.abs\", \"examples/unicode.abs\"], \"filesTriagedByName\": [\"tests/test-assign-index.abs\", \"ast/ast_test.go\", \"ast/ast.go\", \"evaluator/evaluator_test.go\", \"evaluator/evaluator.go\", \"parser/parser_test.go\", \"parser/parser.go\"], \"scanEscalationReason\": \"The repository requirements corpus is still unavailable and the prior candidate binding is stale after remediation, so the full repaired parser/AST/evaluator/docs material must be re-scanned for the fresh review round.\", \"candidateSpecSetDigest\": \"6cdc41a9d6483eb4e07d9e041d14cbfe35f86408ff3ab5b4519a764c91f62422\", \"corpusDigest\": \"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945\"}, \"readLog\": {\"filesReadFully\": [\"docs/src/docs/types/array.md\", \"docs/src/docs/types/string.md\", \"docs/src/docs/syntax/assignments.md\", \"examples/index_ranges.abs\", \"examples/unicode.abs\"], \"filesTriagedByName\": [\"tests/test-assign-index.abs\", \"ast/ast_test.go\", \"ast/ast.go\", \"evaluator/evaluator_test.go\", \"evaluator/evaluator.go\", \"parser/parser_test.go\", \"parser/parser.go\"], \"summary\": {\"readCount\": 5, \"tokenCount\": null}, \"digest\": \"98f172c84b33306ee58f6de26ac39de529f4369c5e61d938632f2cb5e9eca222\"}}";

function repairedEnvelope(): string {
  // Test-only: what a compliant re-emission looks like (same verdict/content, quotes escaped).
  const text = RR009_MALFORMED
    .replace('(`"012345"[1:5:2]`', '(`\\"012345\\"[1:5:2]`')
    .replace('`str.split("")[:5]`', '`str.split(\\"\\")[:5]`')
    .replace('`["H", "e", "l", "l", "o"]`', '`[\\"H\\", \\"e\\", \\"l\\", \\"l\\", \\"o\\"]`')
    .replace('`["Hello world!"]`', '`[\\"Hello world!\\"]`');
  JSON.parse(text);
  return text;
}

function writeFakeCodex(bin: string, state: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const state = ${JSON.stringify(state)};
let input = ''; process.stdin.on('data', d => { input += d; }); process.stdin.on('end', () => {
  const mode = fs.readFileSync(path.join(state, 'mode'), 'utf8').trim();
  const resumed = process.argv[2] === 'exec' && process.argv[3] === 'resume';
  fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify({ argv: process.argv.slice(2), stdin: input }) + '\\n');
  const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'thread.started', thread_id: ${JSON.stringify(THREAD)} });
  if (!resumed && mode !== 'nosession') {
    const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '30');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-09-30T06-58-17-${THREAD}.jsonl'), '{}\\n');
  }
  emit({ type: 'turn.started' });
  let text = fs.readFileSync(path.join(state, resumed && mode === 'repair' ? 'valid.txt' : 'malformed.txt'), 'utf8');
  // A failing repair that still changes its output (an unchanged one stops early).
  if (resumed && mode === 'fail') text = text.replace('Re-review of story', 'Re-review (attempt ' + fs.readFileSync(path.join(state, 'invocations.jsonl'), 'utf8').trim().split('\\n').length + ') of story');
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } });
});
`, { mode: 0o755 });
}

interface Outcome {
  terminal: ManagedHostRunTerminal;
  invocations: Array<{ argv: string[]; stdin: string }>;
  events: Array<{ type: string; detail?: Record<string, unknown> }>;
  root: string;
  runId: string;
}

async function runCase(base: string, name: string, mode: 'repair' | 'fail' | 'nosession'): Promise<Outcome> {
  const root = join(base, name);
  const state = join(root, '.fake-codex');
  const bin = join(root, '.fake-bin');
  const codexHome = join(root, '.codex-home');
  mkdirSync(state, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFakeCodex(bin, state);
  writeFileSync(join(state, 'mode'), mode);
  writeFileSync(join(state, 'malformed.txt'), RR009_MALFORMED);
  writeFileSync(join(state, 'valid.txt'), repairedEnvelope());
  let worker: Promise<ManagedHostRunTerminal> | null = null;
  const submitted = await submitManagedHostRun(
    {
      root, cwd: root, host: 'codex', storyId: STORY, phase: 'REVIEW', agentType: LANE,
      reviewRunId: REVIEW_RUN, lane: LANE, promptText: 'review the docs lane',
      deadlineMs: 60_000, projectRootHash: `sha256:${name}`, profile: 'managed_reviewer',
      reviewBinding: {
        headHash: '1f18c8d8700071ce67da2d7746f307c203f3952e', materialHash: 'material-rr009',
        storyFilesHash: 'story-rr009', promptHash: 'prompt-rr009', envelopeId: null,
      },
    },
    {
      launchWorker: async request => {
        worker = runManagedHostRunWorker(request, {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            CODEX_HOME: codexHome,
            PROOF_OR_STOP_USAGE_LEDGER: '0',
          },
          cancelPollMs: 5,
        });
        return { pid: process.pid };
      },
      claimTimeoutMs: 5_000,
      claimPollMs: 5,
    },
  );
  assert.ok(worker, 'the worker was launched');
  const terminal = await (worker as unknown as Promise<ManagedHostRunTerminal>);
  const log = join(state, 'invocations.jsonl');
  const invocations = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; stdin: string })
    : [];
  const events = readFileSync(join(managedHostRunDirectory(root, submitted.runId), 'events.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; detail?: Record<string, unknown> });
  return { terminal, invocations, events, root, runId: submitted.runId };
}

const repairEvents = (outcome: Outcome) => outcome.events.filter(event => event.type === 'final_result_format_repair');

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'managed-final-json-repair-'));
  try {
    assert.throws(() => JSON.parse(RR009_MALFORMED), SyntaxError, 'the fixture is the saved invalid JSON');

    // (A) Malformed, then a valid re-emission on the resumed session.
    const a = await runCase(base, 'repair', 'repair');
    assert.equal(a.terminal.state, 'completed', `${MARKER} (terminal ${a.terminal.state}: ${a.terminal.reason})`);
    assert.equal(a.terminal.reason, 'provider_completed');
    assert.equal(a.invocations.length, 2, 'exactly one format-repair turn after the review turn');
    assert.deepEqual(a.invocations[0]!.argv.slice(0, 2), ['exec', '--json'], 'the review turn is a fresh launch');
    const resumed = a.invocations[1]!;
    assert.deepEqual(resumed.argv.slice(0, 2), ['exec', 'resume'], `the repair turn resumes the session: ${resumed.argv.join(' ')}`);
    assert.equal(resumed.argv.at(-2), THREAD, 'the repair turn resumes the SAME provider session');
    assert.equal(resumed.argv.at(-1), '-');
    assert.match(resumed.stdin, /JSON/, 'the repair prompt names the parse failure');
    assert.match(resumed.stdin, /position \d+|column \d+|Expected|Unexpected/, 'the repair prompt carries the exact parse error');
    assert.match(resumed.stdin, /re-emit only the final JSON object/i);
    assert.match(resumed.stdin, /same verdict/i);
    assert.ok(resumed.stdin.length < 2_000, 'the repair prompt is short');
    const proposal = readManagedReviewEvidenceProposal(a.root, a.runId);
    assert.ok(proposal, 'the repaired final result becomes the immutable proposal');
    assert.equal(proposal!.conclusion, 'pass', 'same verdict');
    assert.equal(proposal!.note, (JSON.parse(repairedEnvelope()) as { note: string }).note, 'same content');
    const aRepairs = repairEvents(a);
    assert.equal(aRepairs.length, 1, 'one format-repair attempt is journaled');
    assert.equal(aRepairs[0]!.detail?.attempt, 1);
    assert.equal(aRepairs[0]!.detail?.resumeSessionId, THREAD);
    assert.match(String(aRepairs[0]!.detail?.error), /^managed_review_final_result_malformed/);
    const outcomes = a.events.filter(event => event.type === 'final_result_format_repair_outcome');
    assert.deepEqual(outcomes.map(event => event.detail?.outcome), ['valid'], 'the repair outcome is journaled');
    const aResult = readManagedHostRunResult(a.root, a.runId);
    assert.equal(aResult?.finalAssistantResult, repairedEnvelope(), 'the sealed result binds the final valid output exactly');
    const receipt = managedHostRunReceipt(a.root, a.runId);
    assert.equal(receipt.state, 'completed');
    assert.ok(a.terminal.evidenceProposalDigest, 'the terminal binds the proposal digest');
    assert.equal(a.terminal.replacementSafe, true);

    // (B) Each repair re-emission is malformed too (and differs from the last):
    // bounded attempts, then today's terminal failure.
    const b = await runCase(base, 'repair-fails', 'fail');
    assert.equal(b.terminal.state, 'failed');
    assert.match(b.terminal.reason, /^managed_review_final_result_invalid:managed_review_final_result_malformed/);
    assert.equal(b.terminal.replacementSafe, true, 'an exhausted repair stays replacement-safe');
    assert.equal(b.invocations.length, 3, 'one review turn plus two bounded repair turns');
    assert.ok(b.invocations.slice(1).every(call => call.argv[1] === 'resume' && call.argv.at(-2) === THREAD));
    assert.equal(repairEvents(b).length, 2, 'every repair attempt is journaled');
    assert.equal(readManagedReviewEvidenceProposal(b.root, b.runId), null, 'no proposal is written from an invalid envelope');
    assert.equal(managedHostRunReceipt(b.root, b.runId).state, 'failed');

    // (C) No resumable session in the provider home: no repair, today's behavior.
    const c = await runCase(base, 'no-session', 'nosession');
    assert.equal(c.terminal.state, 'failed');
    assert.match(c.terminal.reason, /^managed_review_final_result_invalid:managed_review_final_result_malformed/);
    assert.equal(c.invocations.length, 1, 'no repair launch without a resumable session');
    assert.equal(repairEvents(c).length, 0);

    console.log('managed-final-json-repair-smoke: PASS');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
