#!/usr/bin/env node

// Regression (benchmark run 14, abs Go task, B-1165:RR-005): the managed
// inventory topology critic finished a 2.4-minute review and emitted a final
// envelope whose readManifest and readLog listed ast/ast_test.go in BOTH
// filesReadFully and filesTriagedByName. The reader normalizers require the two
// lists to be disjoint, but the provider contract (schema + protocol) never said
// so. The format-repair resume then told the model only "the JSON object does
// not satisfy the lattice.managed_review_final_proposal.v1 schema" and forbade
// changing readManifest/readLog, so it re-emitted byte-identical content twice
// and the run failed; the owner relaunched the whole critic.
//
// Contract: every final-result rejection names the failing path(s), expected
// and actual value (or the JSON.parse position) in the repair prompt, the event
// journal and the terminal reason (prefix managed_review_final_result_malformed
// kept); an unchanged re-emission stops repair early; and the provider schema
// states the disjointness the gate enforces.
//
// The provider is a fake `codex` on PATH driven through the real default runner.
// The rejected envelope is the byte-exact run-14 finalAssistantResult.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyManagedReviewFinalEnvelope, managedReviewFinalProposalJsonSchema } from '../core/host-run.js';
import {
  managedHostRunDirectory,
  readManagedReviewEvidenceProposal,
  runManagedHostRunWorker,
  submitManagedHostRun,
} from '../core/managed-host-run.js';
import type { ManagedHostRunTerminal } from '../core/managed-host-run.js';

const MARKER = 'managed-final-repair-specific-error: the format-repair prompt did not name the failing schema path';
const STORY = 'B-1165';
const LANE = 'proof-or-stop-review-topology-critic';
const REVIEW_RUN = 'B-1165:RR-005';
const THREAD = '01a0fd14-f51d-7d83-9db5-e537e8714268';
const SCAN_REASON = 'automatic: no requirements corpus in project (docs/requirements has no documents); framework-selected full scan of the changed code and docs (escalation: requirements_corpus_missing)';

// Saved finalAssistantResult of the rejected run-14 critic turn (byte-exact,
// sha256:ba99ade21bf14c34dd40e25d963de0cf8d406a7d1fa6d27cd8489c4e9ea67c37).
const RUN14_REJECTED: string = "{\n  \"schemaVersion\": \"lattice.managed_review_final_proposal.v1\",\n  \"storyId\": \"B-1165\",\n  \"providerAgent\": \"proof-or-stop-review-topology-critic\",\n  \"lane\": \"proof-or-stop-review-topology-critic\",\n  \"reviewRunId\": \"B-1165:RR-005\",\n  \"conclusion\": \"pass\",\n  \"note\": \"Inventory completeness pass. All four required lanes have signed terminal records on the bound cutoff, and all seven aggregate findings were independently resolved; F-003 is a duplicate of F-001. No required-lane read record was missing, and no additional current inventory family was found. Focused ast and parser tests plus the stepped evaluator tests pass; the full evaluator package has environment-dependent CONTEXT failures unrelated to this inventory. Existing open product findings remain blocking under their own status.\",\n  \"readManifest\": {\n    \"filesReadFully\": [\n      \"ast/ast_test.go\"\n    ],\n    \"filesTriagedByName\": [\n      \".proof-or-stop/story/actives/B-1165/candidate-spec-set.json\",\n      \"ast/ast.go\",\n      \"ast/ast_test.go\",\n      \"docs/src/docs/types/array.md\",\n      \"docs/src/docs/types/string.md\",\n      \"evaluator/evaluator.go\",\n      \"evaluator/evaluator_test.go\",\n      \"parser/parser.go\",\n      \"parser/parser_test.go\"\n    ],\n    \"scanEscalationReason\": \"automatic: no requirements corpus in project (docs/requirements has no documents); framework-selected full scan of the changed code and docs (escalation: requirements_corpus_missing)\",\n    \"candidateSpecSetDigest\": \"187179d2a032cdf0b54e8eca64bf76a040b49bc3a6b3c309dd59edd8d5a7369d\",\n    \"corpusDigest\": \"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945\"\n  },\n  \"readLog\": {\n    \"filesReadFully\": [\n      \"ast/ast_test.go\"\n    ],\n    \"filesTriagedByName\": [\n      \".proof-or-stop/story/actives/B-1165/candidate-spec-set.json\",\n      \"ast/ast.go\",\n      \"ast/ast_test.go\",\n      \"docs/src/docs/types/array.md\",\n      \"docs/src/docs/types/string.md\",\n      \"evaluator/evaluator.go\",\n      \"evaluator/evaluator_test.go\",\n      \"parser/parser.go\",\n      \"parser/parser_test.go\"\n    ],\n    \"summary\": {\n      \"readCount\": 1,\n      \"tokenCount\": null\n    },\n    \"digest\": \"f30843c4909de6e4524c5f9ae90b7a0721696afbbf40187d5717b4c0919b4399\"\n  },\n  \"inventoryCritic\": {\n    \"epochId\": \"B-1165:RI-001\",\n    \"wave\": 1,\n    \"findingDispositions\": [\n      {\n        \"finding\": {\n          \"findingId\": \"B-1165:F-001\"\n        },\n        \"disposition\": \"verified_family\",\n        \"familyKey\": \"trailing-colon-nil-step\",\n        \"reason\": \"Source inspection confirms the canonical family: omitted start with an explicitly empty step leaves Step nil, so non-stepped evaluation receives a nil Index.\"\n      },\n      {\n        \"finding\": {\n          \"findingId\": \"B-1165:F-002\"\n        },\n        \"disposition\": \"verified_family\",\n        \"familyKey\": \"hash-range-assignment-silent-null\",\n        \"reason\": \"Source inspection confirms range assignments route through evalRangeIndexAssignment, which has no HASH branch and returns NULL without writing.\"\n      },\n      {\n        \"finding\": {\n          \"findingId\": \"B-1165:F-003\"\n        },\n        \"disposition\": \"duplicate\",\n        \"familyKey\": \"trailing-colon-nil-step\",\n        \"canonicalFinding\": {\n          \"findingId\": \"B-1165:F-001\"\n        },\n        \"reason\": \"This has the same root cause and examples as B-1165:F-001, where stepPresent suppresses start normalization while Step remains nil.\"\n      },\n      {\n        \"finding\": {\n          \"findingId\": \"B-1165:F-004\"\n        },\n        \"disposition\": \"verified_family\",\n        \"familyKey\": \"array-nonnumeric-slice-errors-uncovered\",\n        \"reason\": \"Focused test inspection confirms array non-numeric start, end, and step error paths are uncovered while equivalent STRING cases are tested.\"\n      },\n      {\n        \"finding\": {\n          \"findingId\": \"B-1165:F-005\"\n        },\n        \"disposition\": \"verified_family\",\n        \"familyKey\": \"string-negative-step-assignment-uncovered\",\n        \"reason\": \"Assignment tests cover array negative-step ranges and string positive-step ranges, but no string negative-step range assignment is asserted.\"\n      },\n      {\n        \"finding\": {\n          \"findingId\": \"B-1165:F-006\"\n        },\n        \"disposition\": \"verified_family\",\n        \"familyKey\": \"omitted-two-part-stringification-uncovered\",\n        \"reason\": \"Parser and AST tests inspect omitted two-part fields but only assert String output for myArray[1:2], leaving omitted-component stringification uncovered.\"\n      },\n      {\n        \"finding\": {\n          \"findingId\": \"B-1165:F-007\"\n        },\n        \"disposition\": \"verified_family\",\n        \"familyKey\": \"array-docs-end-inclusive-drift\",\n        \"reason\": \"The array documentation shows end-inclusive two-part examples while runtime behavior and tests consistently select end-exclusive ranges.\"\n      }\n    ]\n  }\n}";

type Envelope = Record<string, any>;

function correctedEnvelope(): string {
  // Test-only: a compliant re-emission, the fully read path removed from the triage lists.
  const value = JSON.parse(RUN14_REJECTED) as Envelope;
  for (const key of ['readManifest', 'readLog']) {
    value[key].filesTriagedByName = value[key].filesTriagedByName.filter((path: string) => !value[key].filesReadFully.includes(path));
  }
  return JSON.stringify(value, null, 2);
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
  if (!resumed) {
    const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '02');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-10-02T14-46-44-${THREAD}.jsonl'), '{}\\n');
  }
  emit({ type: 'turn.started' });
  // A model can only fix what it is told: re-emit the corrected envelope only
  // when the repair prompt names the failing field and the offending path.
  const named = input.includes('filesTriagedByName') && input.includes('ast/ast_test.go');
  const file = resumed && mode === 'follow' && named ? 'corrected.txt' : 'rejected.txt';
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: fs.readFileSync(path.join(state, file), 'utf8') } });
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

async function runCase(base: string, name: string, mode: 'follow' | 'stubborn'): Promise<Outcome> {
  const root = join(base, name);
  const state = join(root, '.fake-codex');
  const bin = join(root, '.fake-bin');
  const codexHome = join(root, '.codex-home');
  mkdirSync(state, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFakeCodex(bin, state);
  writeFileSync(join(state, 'mode'), mode);
  writeFileSync(join(state, 'rejected.txt'), RUN14_REJECTED);
  writeFileSync(join(state, 'corrected.txt'), correctedEnvelope());
  let worker: Promise<ManagedHostRunTerminal> | null = null;
  const submitted = await submitManagedHostRun(
    {
      root, cwd: root, host: 'codex', storyId: STORY, phase: 'REVIEW', agentType: LANE,
      reviewRunId: REVIEW_RUN, lane: LANE, promptText: 'inventory completeness critic',
      deadlineMs: 60_000, projectRootHash: `sha256:${name}`, profile: 'managed_reviewer',
      reviewBinding: {
        headHash: '383e8ddeccfd7f2aadce7d340e6109004ddc8a82', materialHash: 'material-rr005',
        storyFilesHash: 'story-rr005', promptHash: 'prompt-rr005', envelopeId: null,
        fullScanEscalationReason: SCAN_REASON,
      },
    },
    {
      launchWorker: async request => {
        worker = runManagedHostRunWorker(request, {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CODEX_HOME: codexHome, PROOF_OR_STOP_USAGE_LEDGER: '0' },
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

const malformedViolations = (text: string): string[] => {
  const classification = classifyManagedReviewFinalEnvelope(text);
  assert.equal(classification.kind, 'malformed', `expected a malformed classification: ${JSON.stringify(classification).slice(0, 200)}`);
  return (classification as { violations?: string[] }).violations ?? [];
};

function unitCases(): void {
  // The exact run-14 constraint.
  const run14 = malformedViolations(RUN14_REJECTED);
  assert.ok(run14.some(line => /readManifest.*ast\/ast_test\.go.*filesReadFully and filesTriagedByName/.test(line)),
    `${MARKER}: run-14 violations name readManifest overlap: ${JSON.stringify(run14)}`);
  assert.ok(run14.some(line => /readLog.*ast\/ast_test\.go.*filesReadFully and filesTriagedByName/.test(line)), 'readLog overlap named');
  assert.equal(classifyManagedReviewFinalEnvelope(correctedEnvelope()).kind, 'valid', 'the corrected critic output validates');

  // Provider contract states the invariant the gate enforces.
  const schema = managedReviewFinalProposalJsonSchema({ storyId: STORY, reviewRunId: REVIEW_RUN, lane: LANE, agentType: LANE }) as Envelope;
  for (const key of ['readManifest', 'readLog']) {
    assert.match(String(schema.properties[key].properties.filesTriagedByName.description ?? ''), /disjoint/i, `${key}.filesTriagedByName schema states disjointness`);
  }

  // JSON parse error: position, line/column and a bounded excerpt.
  const broken = '{"schemaVersion":"lattice.managed_review_final_proposal.v1","note":"he said "hi" today"}';
  const parse = malformedViolations(broken);
  assert.equal(parse.length, 1);
  assert.match(parse[0]!, /^JSON\.parse: .* at position \d+ \(line 1 column \d+\); text around it: ".*hi.*"$/, `parse violation: ${parse[0]}`);
  const position = Number(/at position (\d+)/.exec(parse[0]!)![1]);
  assert.equal(broken[position - 1], '"', 'the reported position points just past the unescaped quote');
  const prosed = 'Final answer:\n' + broken;
  assert.match(malformedViolations(prosed)[0]!, new RegExp(`at position ${position + 'Final answer:\n'.length} \\(line 2`), 'positions are relative to the whole message');

  // Multiple violations: each names path, expected and actual (truncated), in order.
  const multi = JSON.parse(correctedEnvelope()) as Envelope;
  multi.conclusion = 'maybe';
  multi.extraField = true;
  multi.readLog.summary.readCount = 3;
  multi.inventoryCritic.findingDispositions[2].disposition = 'bogus';
  multi.inventoryCritic.findingDispositions[0].reason = 'x'.repeat(5);
  const lines = malformedViolations(JSON.stringify(multi));
  assert.ok(lines.includes('(top level): unexpected field(s) extraField; allowed schemaVersion, storyId, providerAgent, lane, reviewRunId, conclusion, readManifest, readLog, readDiagnostics, note, findings, inventoryCritic'), JSON.stringify(lines));
  assert.ok(lines.includes('conclusion: expected "pass" or "findings", got "maybe"'), JSON.stringify(lines));
  assert.ok(lines.some(line => /readCount \(3\) must equal unique filesReadFully count \(1\)/.test(line)), JSON.stringify(lines));
  assert.ok(lines.includes('inventoryCritic.findingDispositions[0].reason: expected a string of at least 10 trimmed characters, got "xxxxx"'), JSON.stringify(lines));
  assert.ok(lines.includes('inventoryCritic.findingDispositions[2].disposition: expected one of verified_family, duplicate, not_verified, got "bogus"'), JSON.stringify(lines));
  multi.note = 'n'.repeat(500);
  multi.conclusion = 'findings';
  multi.findings = [{ desc: 'd', severity: 'urgent', category: 'happy' }];
  const truncated = malformedViolations(JSON.stringify(multi));
  assert.ok(truncated.some(line => /^findings\[0\]\.severity: expected one of critical, high, medium, low, got "urgent"$/.test(line)), JSON.stringify(truncated));
  assert.ok(truncated.every(line => line.length < 400), 'each violation is bounded (actual values truncated)');
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'managed-final-repair-specific-error-'));
  try {
    // (A) The real rejected output; the model follows a repair prompt that names the failing path.
    const a = await runCase(base, 'follow', 'follow');
    assert.ok(a.invocations.length >= 2, 'a format-repair turn ran');
    const prompt = a.invocations[1]!.stdin;
    assert.ok(prompt.includes('filesTriagedByName') && prompt.includes('ast/ast_test.go'),
      `${MARKER}: ${prompt.split('\n').find(line => line.startsWith('Validation error')) ?? prompt.slice(0, 300)}`);
    assert.equal(a.terminal.state, 'completed', `terminal ${a.terminal.state}: ${a.terminal.reason}`);
    assert.equal(a.invocations.length, 2, 'exactly one repair turn');
    assert.deepEqual(a.invocations[1]!.argv.slice(0, 2), ['exec', 'resume']);
    assert.equal(a.invocations[1]!.argv.at(-2), THREAD, 'the SAME provider session is resumed');
    assert.ok(prompt.length < 2_500, `the repair prompt stays bounded (${prompt.length})`);
    const repair = a.events.find(event => event.type === 'final_result_format_repair');
    assert.match(String(repair?.detail?.error), /^managed_review_final_result_malformed: readManifest: duplicate path ast\/ast_test\.go appears in both filesReadFully and filesTriagedByName/,
      'the journal records the exact reason with the classification prefix');
    const proposal = readManagedReviewEvidenceProposal(a.root, a.runId);
    assert.ok(proposal, 'the corrected critic output becomes the proposal');
    assert.equal(proposal!.conclusion, 'pass');
    assert.deepEqual(proposal!.readManifest.filesTriagedByName.includes('ast/ast_test.go'), false);

    // (B) The model re-emits the identical bytes: stop after one repair turn, record why.
    const b = await runCase(base, 'stubborn', 'stubborn');
    assert.equal(b.terminal.state, 'failed');
    assert.equal(b.invocations.length, 2, 'no second repair turn after an unchanged re-emission');
    assert.match(b.terminal.reason, /^managed_review_final_result_invalid:managed_review_final_result_malformed: readManifest: duplicate path ast\/ast_test\.go/,
      `terminal names the failing path: ${b.terminal.reason}`);
    assert.match(b.terminal.reason, /unchanged/);
    const outcome = b.events.find(event => event.type === 'final_result_format_repair_outcome');
    assert.equal(outcome?.detail?.outcome, 'unchanged');
    assert.equal(outcome?.detail?.unchanged, 'bytes');
    assert.equal(b.terminal.replacementSafe, true);

    unitCases();
    console.log('managed-final-repair-specific-error-smoke: PASS');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
