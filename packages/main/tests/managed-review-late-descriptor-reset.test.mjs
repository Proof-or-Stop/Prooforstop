import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { defaultHostRunRunner, HOST_RUN_FINAL_ASSISTANT_RESULT_CAP } from '../dist/core/host-run.js';

const envelope = JSON.stringify({
  schemaVersion: 'lattice.managed_review_final_proposal.v1',
  storyId: 'B-late-reset',
  providerAgent: 'proof-or-stop-review-quality',
  lane: 'proof-or-stop-review-quality',
  reviewRunId: 'B-late-reset:RR-001',
  conclusion: 'pass',
  note: 'The bounded candidate has no blocking quality finding.',
  readManifest: {
    filesReadFully: ['packages/main/src/core/host-run.ts'],
    filesTriagedByName: [],
    scanEscalationReason: null,
    candidateSpecSetDigest: 'a'.repeat(64),
    corpusDigest: 'b'.repeat(64),
  },
  readLog: {
    filesReadFully: ['packages/main/src/core/host-run.ts'],
    filesTriagedByName: [],
    summary: { readCount: 1, tokenCount: null },
    digest: 'c'.repeat(64),
  },
});

const codexEvent = text => `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`;

async function runCase({ descriptorCode, stdout = [], exitCode = 0 }) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const descriptor = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, descriptor];
  let killCount = 0;
  child.kill = () => { killCount += 1; return true; };

  const pending = defaultHostRunRunner({
    command: 'fixture-codex', argv: [], env: {}, cwd: tmpdir(), host: 'codex',
    stdinText: 'managed review prompt',
    reviewInvocationPayload: () => 'one-shot callback capability',
    onChunk: () => {},
  }, {
    spawnChild: () => child,
    readProcessStartFingerprint: () => null,
  });
  await new Promise(resolve => setImmediate(resolve));
  for (const chunk of stdout) child.stdout.write(chunk);
  const descriptorError = new Error('descriptor peer closed');
  descriptorError.code = descriptorCode;
  descriptor.emit('error', descriptorError);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', exitCode, null);
  return { result: await pending, killCount };
}

for (const descriptorCode of ['EPIPE', 'ECONNRESET']) {
  const { result, killCount } = await runCase({
    descriptorCode,
    stdout: [codexEvent(envelope), `${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`],
  });
  assert.equal(result.exitCode, 0, `one complete final proposal survives late ${descriptorCode}`);
  assert.equal(result.terminalReason, 'completed');
  assert.equal(result.finalAssistantResult, envelope);
  assert.equal(result.finalAssistantResultCount, 1);
  assert.equal(result.finalAssistantResultTruncated, false);
  assert.equal(killCount, 0, `late ${descriptorCode} must not kill an already-complete provider turn`);
}

const early = await runCase({ descriptorCode: 'ECONNRESET' });
assert.equal(early.result.exitCode, 1, 'descriptor reset before any final proposal remains fail closed');
assert.equal(early.result.terminalReason, 'child_error');
assert.equal(early.killCount, 1, 'early descriptor failure still terminates the provider');

const nonzero = await runCase({ descriptorCode: 'EPIPE', stdout: [codexEvent(envelope)], exitCode: 7 });
assert.equal(nonzero.result.exitCode, 7, 'a late descriptor close cannot convert a provider failure into success');
assert.equal(nonzero.killCount, 0, 'provider exit status remains authoritative after a complete candidate');

const multiple = await runCase({ descriptorCode: 'EPIPE', stdout: [codexEvent(envelope), codexEvent(envelope)] });
assert.equal(multiple.result.exitCode, 1, 'multiple final proposals remain fail closed');
assert.equal(multiple.result.terminalReason, 'child_error');
assert.equal(multiple.killCount, 1);

const oversizedEnvelope = JSON.stringify({
  schemaVersion: 'lattice.managed_review_final_proposal.v1',
  note: 'x'.repeat(HOST_RUN_FINAL_ASSISTANT_RESULT_CAP),
});
const oversized = await runCase({ descriptorCode: 'ECONNRESET', stdout: [codexEvent(oversizedEnvelope)] });
assert.equal(oversized.result.exitCode, 1, 'an oversized final proposal remains fail closed');
assert.equal(oversized.result.finalAssistantResultTruncated, true);
assert.equal(oversized.killCount, 1);

console.log('MANAGED_REVIEW_LATE_DESCRIPTOR_RESET_GREEN');
