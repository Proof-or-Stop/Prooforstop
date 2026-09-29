import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';


import { readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';


import { defaultHostRunRunner, runHostRun, hostRunSlotsDir, FinalAssistantResultScanner, classifyManagedReviewFinalEnvelope, hasRequiredManagedReviewReadEvidence, type HostRunRunner } from '../../core/host-run.js';











import { extensionCheck, extensionCheckAsync, freshRoot, deterministicHostRuntime, baseArgs } from "./support.js";

export async function case00(): Promise<void> {

  extensionCheck('B-137a bounded final-result adapters: Codex JSONL/raw and Claude terminal lanes only; tool logs ignored and ambiguity/oversize explicit', () => {
    const envelope = JSON.stringify({
      schemaVersion: 'lattice.managed_review_final_proposal.v1',
      storyId: 'B-final-scanner',
      providerAgent: 'lattice-review-quality',
      lane: 'lattice-review-quality',
      reviewRunId: 'B-final-scanner:RR-001',
      conclusion: 'pass',
      note: 'The exact managed review material has no blocking issue.',
      readManifest: {
        filesReadFully: ['packages/main/src/example.ts'],
        filesTriagedByName: [],
        scanEscalationReason: null,
        candidateSpecSetDigest: 'a'.repeat(64),
        corpusDigest: 'b'.repeat(64),
      },
      readLog: {
        filesReadFully: ['packages/main/src/example.ts'],
        filesTriagedByName: [],
        summary: { readCount: 1, tokenCount: null },
        digest: 'c'.repeat(64),
      },
    });
    const coherentReadEvidence = {
      readManifest: {
        filesReadFully: ['docs/requirements/decisions/review.md'],
        filesTriagedByName: [],
        scanEscalationReason: null,
        candidateSpecSetDigest: 'a'.repeat(64),
        corpusDigest: 'b'.repeat(64),
      },
      readLog: {
        filesReadFully: ['docs/requirements/decisions/review.md'],
        filesTriagedByName: [],
        summary: { readCount: 1, tokenCount: null },
        digest: 'c'.repeat(64),
      },
    };
    assert.equal(hasRequiredManagedReviewReadEvidence(coherentReadEvidence.readManifest, coherentReadEvidence.readLog), true,
      'coherent managed manifest/log/summary remains admissible');
    assert.equal(hasRequiredManagedReviewReadEvidence(coherentReadEvidence.readManifest, {
      ...coherentReadEvidence.readLog,
      filesReadFully: ['packages/main/src/unrelated.ts'],
    }), false,
    'managed receipt rejects a manifest paired with an unrelated read log');
    assert.equal(hasRequiredManagedReviewReadEvidence(coherentReadEvidence.readManifest, {
      ...coherentReadEvidence.readLog,
      summary: { readCount: 999, tokenCount: null },
    }), false,
    'managed receipt rejects a contradictory readLog summary count');
    const codex = new FinalAssistantResultScanner('codex', 2_048);
    codex.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'DISPATCH_START' } })}\n`);
    codex.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: envelope } })}\n`);
    codex.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'tool_output', text: envelope } })}\n`);
    codex.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Reviewed the first evidence group; continuing.' } })}\n`);
    codex.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: envelope } })}\n`);
    assert.deepEqual(codex.snapshot(), { result: envelope, count: 1, truncated: false },
      'Codex adapter ignores ordinary progress/tool/reasoning messages and selects the one strict proposal envelope');

    const rawCodex = new FinalAssistantResultScanner('codex', 2_048);
    rawCodex.push(envelope.slice(0, 83));
    rawCodex.push(envelope.slice(83, 211));
    rawCodex.push(envelope.slice(211));
    rawCodex.flush();
    assert.deepEqual(rawCodex.snapshot(), { result: envelope, count: 1, truncated: false },
      'Codex non-JSON stdout accepts one exact raw standalone proposal across arbitrary chunks');

    const rawOrdinary = new FinalAssistantResultScanner('codex', 2_048);
    rawOrdinary.push('Reviewed the implementation; preparing the final response.');
    rawOrdinary.flush();
    assert.deepEqual(rawOrdinary.snapshot(), { result: null, count: 0, truncated: false },
      'ordinary raw Codex stdout never becomes formal evidence');

    const rawMalformedText = '{"schemaVersion":"lattice.managed_review_final_proposal.v1","storyId":';
    const rawMalformed = new FinalAssistantResultScanner('codex', 2_048);
    rawMalformed.push(rawMalformedText.slice(0, 35));
    rawMalformed.push(rawMalformedText.slice(35));
    rawMalformed.flush();
    assert.deepEqual(rawMalformed.snapshot(), { result: rawMalformedText, count: 1, truncated: false },
      'schema-naming malformed raw stdout remains an explicit fail-closed candidate');

    const rawMultiple = new FinalAssistantResultScanner('codex', 2_048);
    rawMultiple.push(`${envelope}\n${envelope}`);
    rawMultiple.flush();
    assert.equal(rawMultiple.snapshot().count, 1,
      'two raw objects are retained only as one malformed standalone candidate, never selected as a valid verdict');
    assert.equal(classifyManagedReviewFinalEnvelope(rawMultiple.snapshot().result ?? '').kind, 'malformed',
      'multiple raw proposal objects remain fail-closed rather than creating a fallback candidate');

    const wrappedThenRawOrdinary = new FinalAssistantResultScanner('codex', 2_048);
    wrappedThenRawOrdinary.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: envelope } })}\n`);
    wrappedThenRawOrdinary.push('ordinary raw stdout after the wrapped result');
    wrappedThenRawOrdinary.flush();
    assert.deepEqual(wrappedThenRawOrdinary.snapshot(), { result: null, count: 0, truncated: false },
      'ordinary raw stdout after a wrapped candidate invalidates that non-terminal candidate');

    const claudeEnvelope = '{"schemaVersion":"lattice.managed_review_final_proposal.v1"}';
    const fencedClaudeResult = `Review complete.\n\`\`\`json\n${claudeEnvelope}\n\`\`\``;
    const claudeProse = new FinalAssistantResultScanner('claude', 512);
    claudeProse.push(`${JSON.stringify({ type: 'assistant', message: { content: claudeEnvelope } })}\n`);
    claudeProse.push(`${JSON.stringify({ type: 'result', subtype: 'success', result: fencedClaudeResult })}\n`);
    assert.deepEqual(claudeProse.snapshot(), { result: null, count: 0, truncated: false },
      'Claude success result without structured_output is ignored rather than falling back to event.result');

    assert.equal(classifyManagedReviewFinalEnvelope(envelope).kind, 'valid',
      'the rejected error-event payload is a well-formed managed-review envelope');
    const claudeErrorEnvelope = new FinalAssistantResultScanner('claude', 2_048);
    claudeErrorEnvelope.push(`${JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: envelope,
    })}\n`);
    assert.deepEqual(claudeErrorEnvelope.snapshot(), { result: null, count: 0, truncated: false },
      'a non-success Claude result containing a well-formed managed-review envelope is not accepted');

    const claudeSuccessResultOnly = new FinalAssistantResultScanner('claude', 2_048);
    claudeSuccessResultOnly.push(`${JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: envelope,
    })}\n`);
    assert.deepEqual(claudeSuccessResultOnly.snapshot(), { result: null, count: 0, truncated: false },
      'a success Claude result without structured_output is ignored even when event.result is a well-formed envelope');

    const claudeStructured = new FinalAssistantResultScanner('claude', 512);
    claudeStructured.push(`${JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: fencedClaudeResult,
      structured_output: JSON.parse(claudeEnvelope),
    })}\n`);
    assert.deepEqual(claudeStructured.snapshot(), { result: claudeEnvelope, count: 1, truncated: false },
      'a success Claude result with provider-validated structured_output is accepted');

    codex.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: envelope } })}\n`);
    assert.equal(codex.snapshot().count, 2, 'two valid proposal envelopes remain explicit for fail-closed multiple policy');
    const nonTerminalProposal = new FinalAssistantResultScanner('codex', 2_048);
    nonTerminalProposal.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: envelope } })}\n`);
    nonTerminalProposal.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Final reviewer response omitted the canonical proposal envelope.' } })}\n`);
    assert.deepEqual(nonTerminalProposal.snapshot(), { result: null, count: 0, truncated: false },
      'a valid-looking earlier assistant message cannot survive a later ordinary terminal assistant result');
    const malformedText = `{"schemaVersion":"lattice.managed_review_final_proposal.v1","storyId":`;
    const malformed = new FinalAssistantResultScanner('codex', 2_048);
    malformed.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: malformedText } })}\n`);
    assert.deepEqual(malformed.snapshot(), { result: malformedText, count: 1, truncated: false },
      'an envelope-looking malformed Codex message remains an explicit fail-closed candidate');
    const ordinaryOversize = new FinalAssistantResultScanner('codex', 128);
    ordinaryOversize.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'progress '.repeat(256) } })}\n`);
    assert.deepEqual(ordinaryOversize.snapshot(), { result: null, count: 0, truncated: false },
      'an oversized ordinary Codex progress message is ignored rather than poisoning formal evidence');
    const proposalOversize = new FinalAssistantResultScanner('codex', 512);
    proposalOversize.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ ...JSON.parse(envelope), note: 'x'.repeat(2_048) }) } })}\n`);
    assert.deepEqual(proposalOversize.snapshot(), { result: null, count: 1, truncated: true },
      'an oversized envelope-looking Codex proposal remains an explicit fail-closed candidate');
    const invalidNestedFinding = JSON.stringify({
      ...JSON.parse(envelope),
      conclusion: 'findings',
      note: undefined,
      findings: [{
        desc: 'Unknown nested values must not cross the adapter boundary.',
        severity: 'urgent',
        category: 'invented',
        evidenceState: 'trusted',
        controllerOverride: true,
      }],
    });
    assert.equal(
      classifyManagedReviewFinalEnvelope(invalidNestedFinding).kind,
      'malformed',
      'the final-result adapter rejects unknown nested finding values and fields before persistence',
    );
    const providerFinding = {
      desc: 'The provider found a concrete managed-review defect.',
      severity: 'high',
      category: 'adversarial',
      files: ['packages/main/src/example.ts'],
      evidenceState: 'verified',
    };
    const findingsWithExplanation = JSON.stringify({
      ...JSON.parse(envelope),
      conclusion: 'findings',
      note: 'Optional provider explanation is descriptive only and never becomes formal finding evidence.',
      findings: [providerFinding],
    });
    assert.equal(classifyManagedReviewFinalEnvelope(findingsWithExplanation).kind, 'valid',
      'structured findings may carry a non-empty explanatory note without weakening strict finding validation');
    assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
      ...JSON.parse(findingsWithExplanation),
      note: '   ',
    })).kind, 'malformed', 'a supplied findings explanation must be a non-blank diagnostic note');
    assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
      ...JSON.parse(findingsWithExplanation),
      note: 'short one',
    })).kind, 'malformed', 'a supplied findings explanation must meet the 10-character persistence minimum');
    assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
      ...JSON.parse(envelope),
      note: '   ',
    })).kind, 'malformed', 'pass still requires a trimmed 10-character note');
    assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
      ...JSON.parse(envelope),
      note: 'short one',
    })).kind, 'malformed', 'pass cannot reach persistence with a too-short diagnostic note');
    assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
      ...JSON.parse(envelope),
      findings: [],
    })).kind, 'valid', 'pass may carry the flat provider schema empty findings array but never a real finding');
    assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
      ...JSON.parse(envelope),
      findings: [providerFinding],
    })).kind, 'malformed', 'pass rejects every non-empty findings payload');
    const oversize = new FinalAssistantResultScanner('claude', 32);
    oversize.push(`${JSON.stringify({ type: 'result', result: 'x'.repeat(128) })}\n`);
    assert.deepEqual(oversize.snapshot(), { result: null, count: 1, truncated: true },
      'an oversize trusted final result is not retained as evidence');
  });
}

export async function case01(): Promise<void> {


  await extensionCheckAsync('B-137a admission transfer failure kills/reaps the spawned provider and cannot report runner success', async () => {
    const sub = freshRoot();
    const harness = deterministicHostRuntime();
    (harness.child as typeof harness.child & { pid: number }).pid = 987_654;
    const runner: HostRunRunner = plan => defaultHostRunRunner(plan, {
      ...harness.runtime,
      spawnChild: () => {
        const slotPath = join(hostRunSlotsDir(sub), 'slot-0.json');
        const slot = JSON.parse(readFileSync(slotPath, 'utf8')) as Record<string, unknown>;
        writeFileSync(slotPath, `${JSON.stringify({ ...slot, token: 'foreign-reclaimed-token' })}\n`);
        return harness.child as unknown as ReturnType<typeof spawn>;
      },
    });
    const pending = runHostRun(baseArgs({
      root: sub,
      host: 'codex',
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0', LATTICE_PROVIDER_MAX_CONCURRENT: '1' },
    }), { runner });
    assert.equal(harness.killCount(), 1, 'failed slot transfer immediately kills the exact spawned child');
    harness.child.emit('close', 0, null);
    const result = await pending;
    assert.notEqual(result.exitCode, 0, 'a provider that escaped admission tracking cannot report success');
    assert.equal(result.terminalReason, 'child_error');
    assert.equal(result.processCleanup?.reaped, true, 'settlement waits for the child close/reap boundary');
  });
}
