import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { defaultHostRunRunner } from '../dist/core/host-run.js';

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
  command: 'fixture-codex',
  argv: [],
  env: {},
  cwd: tmpdir(),
  host: 'codex',
  stdinText: 'managed review prompt',
  reviewInvocationPayload: () => 'one-shot callback capability',
  onChunk: () => {},
}, {
  spawnChild: () => child,
  readProcessStartFingerprint: () => null,
});

await new Promise(resolve => setImmediate(resolve));
child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: envelope } })}\n`);
child.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`);

// Reproduce the benchmark ordering: the provider has authored its one complete
// terminal proposal before the optional callback descriptor reports that its
// peer has already closed the channel.
const reset = new Error('socket hang up');
reset.code = 'ECONNRESET';
descriptor.emit('error', reset);
child.stdout.end();
child.stderr.end();
child.emit('close', 0, null);

const result = await pending;
assert.equal(result.exitCode, 0, 'a complete provider-authored final proposal survives a late descriptor reset');
assert.equal(result.terminalReason, 'completed');
assert.equal(result.finalAssistantResult, envelope);
assert.equal(result.finalAssistantResultCount, 1);
assert.equal(result.finalAssistantResultTruncated, false);
assert.equal(killCount, 0, 'late optional descriptor reset must not kill an already-complete provider turn');

const earlyChild = new EventEmitter();
earlyChild.pid = 424243;
earlyChild.stdin = new PassThrough();
earlyChild.stdout = new PassThrough();
earlyChild.stderr = new PassThrough();
const earlyDescriptor = new PassThrough();
earlyChild.stdio = [earlyChild.stdin, earlyChild.stdout, earlyChild.stderr, earlyDescriptor];
let earlyKillCount = 0;
earlyChild.kill = () => { earlyKillCount += 1; return true; };
const earlyPending = defaultHostRunRunner({
  command: 'fixture-codex', argv: [], env: {}, cwd: tmpdir(), host: 'codex',
  stdinText: 'managed review prompt',
  reviewInvocationPayload: () => 'one-shot callback capability',
  onChunk: () => {},
}, {
  spawnChild: () => earlyChild,
  readProcessStartFingerprint: () => null,
});
await new Promise(resolve => setImmediate(resolve));
const earlyReset = new Error('socket hang up');
earlyReset.code = 'ECONNRESET';
earlyDescriptor.emit('error', earlyReset);
earlyChild.stdout.end();
earlyChild.stderr.end();
earlyChild.emit('close', 0, null);
const earlyResult = await earlyPending;
assert.equal(earlyResult.exitCode, 1, 'descriptor reset before any final proposal remains fail closed');
assert.equal(earlyResult.terminalReason, 'child_error');
assert.equal(earlyKillCount, 1, 'early descriptor failure still terminates the provider');

console.log('MANAGED_REVIEW_LATE_DESCRIPTOR_RESET_GREEN');
