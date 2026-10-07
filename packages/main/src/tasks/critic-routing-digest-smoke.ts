#!/usr/bin/env node
/**
 * Detection A/B V3 R2A-r2 (de80753, abs-stepped-slices replay, B-ba92, REVIEW
 * round 2): the inventory critic (RR-010) read candidate-spec-set.json (its
 * artifactDigest was ba5faa35...) and then wrote a DIFFERENT 64-hex value
 * (8577ba20...) into readManifest.candidateSpecSetDigest. The artifact did not
 * change between launch and import (no candidate_spec_route commit after the
 * round-2 route); the digest was mistyped by the model. The import was refused
 * "candidate routing evidence rejected: candidateSpecSetDigest does not match
 * current artifact" BEFORE any evidence was persisted, so the refused-critic
 * rule of 9471bb7 (which keys on persisted evidence) did not apply and `next`
 * proposed the same import forever.
 *
 * Contract (lab adopt-fresh-r2-and-critic-routing):
 *  - the candidate route a managed reviewer is launched against is sealed in
 *    its spec (reviewBinding.candidateRouting); the digests are controller-owned
 *    values, so the worker seals the proposal with them instead of the
 *    provider's transcription (as it already does for scanEscalationReason) and
 *    journals the replacement. A route that changed after launch still refuses
 *    at import (sealed launch digest != current artifact).
 *  - any deterministic import refusal of a sealed receipt is recorded once
 *    (process event managed_review_import_refused), and `next` never proposes
 *    that import again: it relaunches the critic / lane (e2e scenario NC5).
 *
 * Fixture: the byte-exact V3 R2A-r2 critic finalAssistantResult
 * (sha256:244bbd843a048594baee71c4ad3ca828cd5a194b704a7038a97f89c25c25ca18),
 * through the real default runner with a fake `codex` on PATH.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { managedHostRunDirectory, runManagedHostRunWorker, submitManagedHostRun } from '../core/managed-host-run.js';
import type { ManagedHostRunTerminal } from '../core/managed-host-run.js';

const STORY = 'B-ba92';
const LANE = 'proof-or-stop-review-topology-critic';
const REVIEW_RUN = 'B-ba92:RR-010';
const THREAD = '0d1e2f30-4152-7364-8596-a7b8c9d0e1f2';
const SCAN_REASON = 'automatic: no requirements corpus in project (docs/requirements has no documents); framework-selected full scan of the changed code and docs (escalation: requirements_corpus_missing)';
/** candidate-spec-set.json of the replay at critic launch (and at import). */
const ARTIFACT_DIGEST = 'ba5faa35753e01ae7804346572bf25b3c60507bed92bee5fc5e12445a2571a7b';
const CORPUS_DIGEST = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const MISTYPED_DIGEST = '8577ba20d1ad8034c589b5029a816ba50a510dbd56fd83f7d4d40589f582f78a';
// Byte-exact V3 R2A-r2 critic finalAssistantResult.
const V3_R2A_R2_CRITIC: string = "{\"schemaVersion\":\"lattice.managed_review_final_proposal.v1\",\"storyId\":\"B-ba92\",\"providerAgent\":\"proof-or-stop-review-topology-critic\",\"lane\":\"proof-or-stop-review-topology-critic\",\"reviewRunId\":\"B-ba92:RR-010\",\"conclusion\":\"pass\",\"note\":\"Inventory-completeness pass: no product defect beyond the four verified aggregate findings was found, and no coverage gap independent of those findings was missed. Independently reproduced the single shared root cause at this sealed HEAD (2156074218da75a8ea27df882b564f24445435b1): parser/parser.go:1043 still guards the omitted-start marker with `if startOmitted && exp.End == nil`, so a three-part slice with an omitted start and an explicit end (`value[:end:step]`) loses StartOmitted. Built the binary from this checkout and confirmed `echo([1,2,3,4,5,6,7,8,9][:5:-1])` prints `[]` (must be `[9,8,7,6,5]`), while the explicit-start form `echo([1,2,3,4,5,6,7,8,9][8:5:-1])` correctly prints `[9,8,7]`, isolating the marker as the cause. The defect also flows through the array/string range-assignment selection in evaluator/evaluator.go (rangeIndexes/steppedSliceIndexes) and through IndexExpression.String() dropping the start, matching the four aggregate findings B-ba92:F-006..F-009. All four required lanes (concept RR-006, quality RR-007, test-coverage RR-008, docs RR-009) carry signatureValid=true terminal records on the same material/storyFiles hashes. Framework limitation only: `proof-or-stop review_run_start` was refused by the controller ('refused unsigned or unregistered linked worktree for B-ba92') from this isolated scratch checkout, so this review-run registration could not be opened locally; the audit proceeded from the sealed evidence pack and direct source inspection, and the findings are independently confirmed rather than merely restated. General limitations: existing parser/ast tests pass, and the unrelated evaluator failures (TestEnv/TestCommand on env(\\\"CONTEXT\\\")) are pre-existing environment issues, not defects of this change.\",\"findings\":[],\"inventoryCritic\":{\"epochId\":\"B-ba92:RI-002\",\"wave\":1,\"findingDispositions\":[{\"finding\":{\"findingId\":\"B-ba92:F-006\"},\"disposition\":\"verified_family\",\"familyKey\":\"parser-omitted-start-marker-requires-omitted-end\",\"reason\":\"Confirmed verified at this HEAD: parser/parser.go:1043 still conditions the omitted-start marker on exp.End == nil, so value[:end:step] loses StartOmitted; reproduced [:5:-1] returning [] against the documented n-1 default. This is the most complete statement of the shared root cause, so it is the family canonical.\"},{\"finding\":{\"findingId\":\"B-ba92:F-007\"},\"disposition\":\"duplicate\",\"familyKey\":\"parser-omitted-start-marker-requires-omitted-end\",\"canonicalFinding\":{\"findingId\":\"B-ba92:F-006\"},\"reason\":\"Same-root-cause duplicate of B-ba92:F-006: the same parser/parser.go:1043 guard drops StartOmitted for omitted-start-with-explicit-end slices, producing the same wrong negative-step default and read/assignment result.\"},{\"finding\":{\"findingId\":\"B-ba92:F-008\"},\"disposition\":\"duplicate\",\"familyKey\":\"parser-omitted-start-marker-requires-omitted-end\",\"canonicalFinding\":{\"findingId\":\"B-ba92:F-006\"},\"reason\":\"Same-root-cause duplicate of B-ba92:F-006: identical parser/parser.go:1043 omitted-start marker defect; its String() and read/assignment manifestations are the same defect seen from the test-coverage lane.\"},{\"finding\":{\"findingId\":\"B-ba92:F-009\"},\"disposition\":\"duplicate\",\"familyKey\":\"parser-omitted-start-marker-requires-omitted-end\",\"canonicalFinding\":{\"findingId\":\"B-ba92:F-006\"},\"reason\":\"Same-root-cause duplicate of B-ba92:F-006: identical parser/parser.go:1043 omitted-start marker defect introduced by repair commit 2f6d38b; the cited evaluator/assignment/stringification effects share the one parser root cause.\"}]},\"readManifest\":{\"filesReadFully\":[\"ast/ast.go\",\"evaluator/evaluator.go\",\"parser/parser.go\"],\"filesTriagedByName\":[\".proof-or-stop/story/actives/B-ba92/background.md\",\".proof-or-stop/story/actives/B-ba92/candidate-spec-set.json\",\".proof-or-stop/story/actives/B-ba92/checklist.json\",\"ast/ast_test.go\",\"docs/src/docs/syntax/operators.md\",\"evaluator/evaluator_test.go\",\"parser/parser_test.go\"],\"scanEscalationReason\":\"automatic: no requirements corpus in project (docs/requirements has no documents); framework-selected full scan of the changed code and docs (escalation: requirements_corpus_missing)\",\"candidateSpecSetDigest\":\"8577ba20d1ad8034c589b5029a816ba50a510dbd56fd83f7d4d40589f582f78a\",\"corpusDigest\":\"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945\"},\"readLog\":{\"filesReadFully\":[\"ast/ast.go\",\"evaluator/evaluator.go\",\"parser/parser.go\"],\"filesTriagedByName\":[\".proof-or-stop/story/actives/B-ba92/background.md\",\".proof-or-stop/story/actives/B-ba92/candidate-spec-set.json\",\".proof-or-stop/story/actives/B-ba92/checklist.json\",\"ast/ast_test.go\",\"docs/src/docs/syntax/operators.md\",\"evaluator/evaluator_test.go\",\"parser/parser_test.go\"],\"summary\":{\"readCount\":3,\"tokenCount\":null},\"digest\":\"14e970cdf391b56c4efe03f1f7e287b0d3480f8ec5126ae3b9bd33a76b98c79d\"}}";

function writeFakeCodex(bin: string, state: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const state = ${JSON.stringify(state)};
let input = ''; process.stdin.on('data', d => { input += d; }); process.stdin.on('end', () => {
  fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify({ argv: process.argv.slice(2), stdin: input }) + '\\n');
  const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'thread.started', thread_id: ${JSON.stringify(THREAD)} });
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '07');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-2026-10-07T13-40-00-${THREAD}.jsonl'), '{}\\n');
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: fs.readFileSync(path.join(state, 'final.txt'), 'utf8') } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } });
});
`, { mode: 0o755 });
}

async function main(): Promise<void> {
  assert.equal(createHash('sha256').update(V3_R2A_R2_CRITIC).digest('hex'), '244bbd843a048594baee71c4ad3ca828cd5a194b704a7038a97f89c25c25ca18', 'fixture is byte-exact');
  assert.equal(JSON.parse(V3_R2A_R2_CRITIC).readManifest.candidateSpecSetDigest, MISTYPED_DIGEST, 'fixture carries the mistyped digest');
  const root = mkdtempSync(join(tmpdir(), 'critic-routing-digest-'));
  try {
    const state = join(root, '.fake-codex');
    const bin = join(root, '.fake-bin');
    const codexHome = join(root, '.codex-home');
    mkdirSync(state, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFakeCodex(bin, state);
    writeFileSync(join(state, 'final.txt'), V3_R2A_R2_CRITIC);
    let worker: Promise<ManagedHostRunTerminal> | null = null;
    const submitted = await submitManagedHostRun({
      root, cwd: root, host: 'codex', storyId: STORY, phase: 'REVIEW', agentType: LANE, reviewRunId: REVIEW_RUN, lane: LANE,
      promptText: 'inventory completeness critic', deadlineMs: 60_000, projectRootHash: 'sha256:v3-r2a-r2', profile: 'managed_reviewer',
      reviewBinding: { headHash: '2156074218da75a8ea27df882b564f24445435b1', materialHash: 'material-rr010', storyFilesHash: 'story-rr010',
        promptHash: 'prompt-rr010', envelopeId: null, fullScanEscalationReason: SCAN_REASON,
        candidateRouting: { candidateSpecSetDigest: ARTIFACT_DIGEST, corpusDigest: CORPUS_DIGEST } } as any,
    }, {
      launchWorker: async request => {
        worker = runManagedHostRunWorker(request, { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CODEX_HOME: codexHome, PROOF_OR_STOP_USAGE_LEDGER: '0' }, cancelPollMs: 5 });
        return { pid: process.pid };
      },
      claimTimeoutMs: 5_000, claimPollMs: 5,
    });
    assert.ok(worker, 'the worker was launched');
    const terminal = await (worker as unknown as Promise<ManagedHostRunTerminal>);
    assert.equal(terminal.state, 'completed', `critic run completes: ${terminal.reason}`);
    const dir = managedHostRunDirectory(root, submitted.runId);
    const invocations = readFileSync(join(state, 'invocations.jsonl'), 'utf8').trim().split('\n');
    assert.equal(invocations.length, 1, 'no repair turn is spent on a controller-owned value');
    const proposal = JSON.parse(readFileSync(join(dir, 'evidence-proposal.json'), 'utf8')) as { readManifest: Record<string, unknown>; inventoryCritic?: unknown };
    assert.equal(proposal.readManifest.candidateSpecSetDigest, ARTIFACT_DIGEST,
      `the sealed proposal binds the candidate route sealed at launch, not the provider's mistyped ${String(proposal.readManifest.candidateSpecSetDigest)}`);
    assert.equal(proposal.readManifest.corpusDigest, CORPUS_DIGEST);
    assert.ok(proposal.inventoryCritic, 'the critic block is sealed unchanged');
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string; detail?: Record<string, unknown> });
    const replaced = events.find(e => e.type === 'read_manifest_routing_sealed');
    assert.ok(replaced, `the replacement is journaled: ${events.map(e => e.type).join(', ')}`);
    assert.equal(replaced!.detail?.providerCandidateSpecSetDigest, MISTYPED_DIGEST, 'the journal keeps the provider value');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('critic-routing-digest-smoke: PASS');
}

await main();
