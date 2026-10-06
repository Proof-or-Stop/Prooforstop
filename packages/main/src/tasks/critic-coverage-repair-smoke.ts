#!/usr/bin/env node
/**
 * Run 19 (efc375c, abs-stepped-slices, B-8166, REVIEW round 1): the only lane
 * finding F-001 was evidenceState=suspected (low). The inventory critic was
 * told to "classify every aggregate finding", gave F-001 a verified_family row,
 * and its import was refused REVIEW_INVENTORY_FINDING_DISPOSITION_INVALID:
 * B-8166:F-001 (a suspected finding is not in the wave's verified set). The
 * block was schema-valid, so no same-session repair ran; the owner read it as
 * "malformed" and relaunched the whole critic (RR-006).
 *
 * Contract (lab critic-import-loop):
 *  - F1: the critic is told up front exactly which existing ids take one row
 *    (the importer's own verified wave set) and which take none; the same
 *    lists are sealed as reviewBinding.inventoryCriticCoverage;
 *  - F2: a row for an id outside the verified set (run 19's row for suspected
 *    F-001) carries no authority: no repair turn is spent on it and the
 *    importer drops and logs it (partitionCriticRowsByWave), never an in-set row;
 *  - a MISSING row for a verified id is a same-session format repair naming
 *    the exact ids before sealing, never a sealed block the importer refuses
 *    and never a fresh critic.
 *  (F4, a critic promoting a suspected finding to verified, is deliberately
 *  not done: it changes detection and belongs to the A/B.)
 *
 * Fixture: the byte-exact run-19 critic finalAssistantResult
 * (sha256:ee54ff95c4a3cb068849cec851af975ef4186ac34f596c32a5c4bbf1ff174922),
 * through the real default runner with a fake `codex` on PATH.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { managedHostRunDirectory, runManagedHostRunWorker, submitManagedHostRun } from '../core/managed-host-run.js';
import type { ManagedHostRunTerminal } from '../core/managed-host-run.js';
import * as critic from '../core/managed-inventory-critic.js';

const STORY = 'B-8166';
const LANE = 'proof-or-stop-review-topology-critic';
const REVIEW_RUN = 'B-8166:RR-005';
const THREAD = '02b1fd14-f51d-7d83-9db5-e537e8714268';
const SCAN_REASON = 'automatic: no requirements corpus in project (docs/requirements has no documents); framework-selected full scan of the changed code and docs (escalation: requirements_corpus_missing)';
// Byte-exact run-19 critic finalAssistantResult (schema-valid; sha256 ee54ff95...).
const RUN19_REJECTED: string = "{\"schemaVersion\":\"lattice.managed_review_final_proposal.v1\",\"storyId\":\"B-8166\",\"providerAgent\":\"proof-or-stop-review-topology-critic\",\"lane\":\"proof-or-stop-review-topology-critic\",\"reviewRunId\":\"B-8166:RR-005\",\"conclusion\":\"pass\",\"note\":\"Inventory-completeness audit of OPEN epoch B-8166:RI-001, wave 1, cutoff c8a6925e47d80c8d7354ead0dfc817fb50318fbf. Independently inspected all four required-lane terminals: RR-001 concept (finding F-001), RR-002 quality (pass), RR-003 test-coverage (pass), RR-004 docs (pass). Every review run carries signatureValid=true, the epoch reports epochSignatureValid=true, and each lane readManifest carries the required full-scan scanEscalationReason. The quality lane fully read all three changed source files plus the five protected docs, so the framework-selected full scan of changed code and docs is covered. Independently reproduced the sole aggregate finding B-8166:F-001: evaluator/evaluator.go returns the hardcoded message index assignment expects single-character STRING value, got 0 characters when a string single-index assignment is given a non-string value (verified at line 587; the finding desc cites lines 659-661, a stale line-number reference only). I agree with low severity: the assignment still errors and this path is neither documented nor exercised by the story verification intent. Classified F-001 exactly once as verified_family. Focused in-scope re-runs: CONTEXT=abs go test ./ast ./parser passes and the eight named evaluator tests pass. Framework-owned observations, not product findings: F-001 desc line numbers do not match head; controller-projected canonical reports remain acceptance_topology_check inconclusive (AT_COVERAGE_BASIS_MISSING, AT_MISSING_TOPOLOGY), pre_review_check_read fail (PR_COVERAGE_BASIS_MISSING), and acceptance_rollout_report_read/acceptance_rollout_check missing (AR_REPORT_MISSING), all blocking=false; nothing here is upgraded to topology, TEST, or DONE authority. No additional missed product path found.\",\"readManifest\":{\"filesReadFully\":[\"ast/ast.go\"],\"filesTriagedByName\":[\".proof-or-stop/story/actives/B-8166/candidate-spec-set.json\",\".proof-or-stop/story/actives/B-8166/findings.json\",\".proof-or-stop/story/actives/B-8166/review-passes.json\",\".proof-or-stop/story/actives/B-8166/request.json\",\".proof-or-stop/story/actives/B-8166/scope-contract.json\",\"evaluator/evaluator.go\",\"evaluator/evaluator_test.go\",\"parser/parser.go\",\"parser/parser_test.go\",\"ast/ast_test.go\"],\"scanEscalationReason\":\"automatic: no requirements corpus in project (docs/requirements has no documents); framework-selected full scan of the changed code and docs (escalation: requirements_corpus_missing)\",\"candidateSpecSetDigest\":\"0de7044972271a26ddb2638c464e20f8e5720524f67e26057bf3146ff0b2ca73\",\"corpusDigest\":\"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945\"},\"readLog\":{\"filesReadFully\":[\"ast/ast.go\"],\"filesTriagedByName\":[\".proof-or-stop/story/actives/B-8166/candidate-spec-set.json\",\".proof-or-stop/story/actives/B-8166/findings.json\",\".proof-or-stop/story/actives/B-8166/review-passes.json\",\".proof-or-stop/story/actives/B-8166/request.json\",\".proof-or-stop/story/actives/B-8166/scope-contract.json\",\"evaluator/evaluator.go\",\"evaluator/evaluator_test.go\",\"parser/parser.go\",\"parser/parser_test.go\",\"ast/ast_test.go\"],\"summary\":{\"readCount\":1,\"tokenCount\":null},\"digest\":\"cdf11bf061b12fd4065d731d997554d4d6344636219426d9d123de18aad37828\"},\"inventoryCritic\":{\"epochId\":\"B-8166:RI-001\",\"wave\":1,\"findingDispositions\":[{\"finding\":{\"findingId\":\"B-8166:F-001\"},\"disposition\":\"verified_family\",\"familyKey\":\"evaluator.string-single-index-assignment-non-string-message\",\"reason\":\"Reproduced at head: evaluator/evaluator.go hardcodes got 0 characters for the non-string single-index string-assignment error, so the finding is a real, distinct low-severity family; severity low stands because the assignment still errors and the path is untested/undocumented.\"}]}}";
/** What the importer's wave evaluation gives for run 19 at critic launch: F-001 is suspected. */
const RUN19_COVERAGE = { requiredFindingIds: [] as string[], noRowFindingIds: ['B-8166:F-001'] };
/** A wave that also has a verified F-002 the run-19 block has no row for (missing-row repair case). */
const MISSING_COVERAGE = { requiredFindingIds: ['B-8166:F-002'], noRowFindingIds: ['B-8166:F-001'] };

function corrected(): string {
  const value = JSON.parse(RUN19_REJECTED) as Record<string, any>;
  value.inventoryCritic.findingDispositions.push({ finding: { findingId: 'B-8166:F-002' }, disposition: 'verified_family',
    familyKey: 'f-002-family', reason: 'Reproduced the verified F-002 on this head.' });
  return JSON.stringify(value);
}

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
    const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '07');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-10-07T06-00-00-${THREAD}.jsonl'), '{}\\n');
  }
  emit({ type: 'turn.started' });
  // Re-emit the fixed block only when the repair prompt names the row and why.
  const named = input.includes('B-8166:F-002') && /missing/.test(input);
  const file = resumed && named ? 'corrected.txt' : 'rejected.txt';
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: fs.readFileSync(path.join(state, file), 'utf8') } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } });
});
`, { mode: 0o755 });
}

async function main(): Promise<void> {
  // Unit (RED: no such rules). F2: run 19's row for suspected F-001 needs no repair turn and is dropped, never refused.
  assert.equal(typeof (critic as Record<string, unknown>).managedInventoryCriticCoverageViolations, 'function', 'a critic block is checked against its sealed coverage before sealing');
  assert.equal(typeof (critic as Record<string, unknown>).partitionCriticRowsByWave, 'function', 'the importer drops rows for findings outside the verified wave set');
  const block = JSON.parse(RUN19_REJECTED).inventoryCritic;
  assert.deepEqual((critic as any).managedInventoryCriticCoverageViolations(block, [], RUN19_COVERAGE), [], 'an extra row for a suspected finding is no repair turn');
  const rows = block.findingDispositions.map((row: any) => ({ findingId: row.finding.findingId, disposition: row.disposition, familyKey: row.familyKey, reason: row.reason }));
  const split = (critic as any).partitionCriticRowsByWave(rows, RUN19_COVERAGE.requiredFindingIds);
  assert.deepEqual(split.dropped.map((row: any) => row.findingId), ['B-8166:F-001'], 'the run-19 row is dropped (and logged by the importer)');
  assert.deepEqual(split.kept, [], 'leaving the only valid receipt for that wave: no rows');
  assert.deepEqual((critic as any).partitionCriticRowsByWave(rows, ['B-8166:F-001']).dropped, [], 'an in-set row is never dropped');
  // F1: the missing verified row is named.
  const missing = (critic as any).managedInventoryCriticCoverageViolations(block, [], MISSING_COVERAGE) as string[];
  assert.match(missing.join('\n'), /missing \["B-8166:F-002"\]/, JSON.stringify(missing));
  assert.deepEqual((critic as any).managedInventoryCriticCoverageViolations(JSON.parse(corrected()).inventoryCritic, [], MISSING_COVERAGE), []);
  // Missing rows the importer cannot complete stay a repair: an own finding about different code, and a lane finding with no row.
  const lane = { id: 'B-x:F-001', desc: 'Reverse has no focused test for an empty string: Reverse("") must return "" without indexing r[-1].', files: ['strs/strs.go'] };
  const upper = { desc: 'Upper has no focused test for an empty string: Upper("") must return "".', files: ['strs/strs.go'] };
  const only = { epochId: 'B-x:RI-001', wave: 1, findingDispositions: [{ finding: { proposalFindingIndex: 0 }, disposition: 'verified_family', familyKey: 'upper-empty', reason: 'reproduced on this head' }] };
  assert.match(((critic as any).managedInventoryCriticCoverageViolations(only, [upper], { requiredFindingIds: [lane.id], noRowFindingIds: [], requiredFindingClaims: [lane] }) as string[]).join('\n'),
    /missing \["B-x:F-001"\]/, 'a lane finding without a row is named');
  const laneRow = { epochId: 'B-x:RI-001', wave: 1, findingDispositions: [{ finding: { findingId: lane.id }, disposition: 'verified_family', familyKey: 'reverse-empty', reason: 'reproduced on this head' }] };
  assert.match(((critic as any).managedInventoryCriticCoverageViolations(laneRow, [upper], { requiredFindingIds: [lane.id], noRowFindingIds: [], requiredFindingClaims: [lane] }) as string[]).join('\n'),
    /missing proposalFindingIndex \[0\]/, 'a new own finding without a row is named, never reconciled away');
  // A verbatim restatement (D9-r1 shape) is completed by the importer: no repair turn.
  assert.deepEqual((critic as any).managedInventoryCriticCoverageViolations(laneRow, [{ desc: lane.desc, files: lane.files }], { requiredFindingIds: [lane.id], noRowFindingIds: [], requiredFindingClaims: [lane] }), []);

  // Worker, through the real runner with a fake codex.
  const base = mkdtempSync(join(tmpdir(), 'critic-coverage-repair-'));
  const runCase = async (name: string, coverage: typeof RUN19_COVERAGE) => {
    const root = join(base, name);
    const state = join(root, '.fake-codex');
    const bin = join(root, '.fake-bin');
    const codexHome = join(root, '.codex-home');
    mkdirSync(state, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFakeCodex(bin, state);
    writeFileSync(join(state, 'rejected.txt'), RUN19_REJECTED);
    writeFileSync(join(state, 'corrected.txt'), corrected());
    let worker: Promise<ManagedHostRunTerminal> | null = null;
    const submitted = await submitManagedHostRun({
      root, cwd: root, host: 'codex', storyId: STORY, phase: 'REVIEW', agentType: LANE, reviewRunId: REVIEW_RUN, lane: LANE,
      promptText: 'inventory completeness critic', deadlineMs: 60_000, projectRootHash: `sha256:${name}`, profile: 'managed_reviewer',
      reviewBinding: { headHash: '5b0cfb6a64d4c5e2c1a8d0e0f2e6b1c9d8a7f6e5', materialHash: 'material-rr005', storyFilesHash: 'story-rr005',
        promptHash: 'prompt-rr005', envelopeId: null, fullScanEscalationReason: SCAN_REASON, inventoryCriticCoverage: coverage } as any,
    }, {
      launchWorker: async request => {
        worker = runManagedHostRunWorker(request, { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CODEX_HOME: codexHome, PROOF_OR_STOP_USAGE_LEDGER: '0' }, cancelPollMs: 5 });
        return { pid: process.pid };
      },
      claimTimeoutMs: 5_000, claimPollMs: 5,
    });
    assert.ok(worker, 'the worker was launched');
    const terminal = await (worker as unknown as Promise<ManagedHostRunTerminal>);
    const invocations = readFileSync(join(state, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; stdin: string });
    const events = readFileSync(join(managedHostRunDirectory(root, submitted.runId), 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string; detail?: Record<string, unknown> });
    const proposal = JSON.parse(readFileSync(join(managedHostRunDirectory(root, submitted.runId), 'evidence-proposal.json'), 'utf8')) as { inventoryCritic?: { findingDispositions: Array<{ finding: { findingId?: string } }> } };
    return { terminal, invocations, events, proposal };
  };
  try {
    const exact = await runCase('run19', RUN19_COVERAGE);
    assert.equal(exact.terminal.state, 'completed', `run 19 exact: ${exact.terminal.reason}`);
    assert.equal(exact.invocations.length, 1, 'run 19 exact: no repair turn for a harmless extra row');
    const repaired = await runCase('missing', MISSING_COVERAGE);
    assert.equal(repaired.terminal.state, 'completed', `missing-row case is repaired, not failed: ${repaired.terminal.reason}`);
    assert.equal(repaired.invocations.length, 2, 'one original turn plus one same-session repair turn (no fresh critic)');
    assert.deepEqual(repaired.invocations[1]!.argv.slice(0, 2), ['exec', 'resume'], 'the repair resumes the same Codex session');
    assert.match(repaired.invocations[1]!.stdin, /missing \["B-8166:F-002"\]/, 'the repair prompt names the exact missing id');
    assert.ok(repaired.events.some(e => e.type === 'final_result_format_repair' && /inventory_critic_coverage/.test(String(e.detail?.error))), 'journaled as a format repair');
    assert.ok(repaired.proposal.inventoryCritic?.findingDispositions.some(row => row.finding.findingId === 'B-8166:F-002'), 'the sealed block has the missing row');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  console.log('critic-coverage-repair-smoke: PASS');
}

await main();
