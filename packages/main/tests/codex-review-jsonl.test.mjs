import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractCodexReviewVerdict, runCodexReviewLeaf } from '../dist/core/codex-review-leaf.js';

// Synthetic transport controls, not provider review credentials.
const materialHash = 'a'.repeat(64);
const verdict = { schemaVersion: 'proof-or-stop.codex_review_verdict.v1', decision: 'pass', materialHash, findings: [], summary: 'Synthetic review transport control.' };
const start = [{ type: 'thread.started', thread_id: 'fixture-thread' }, { type: 'turn.started' }];
const message = text => ({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text } });
const done = { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } };
const encode = events => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const validEvents = [...start, message('Inspecting the candidate.'), { type: 'item.completed', item: { id: 'tool', type: 'command_execution', aggregated_output: 'checked', exit_code: 0 } }, message(JSON.stringify(verdict)), done];
const stream = encode(validEvents);
assert.deepEqual(extractCodexReviewVerdict(stream), verdict, 'CROSSHOST_JSONL_VERDICT: canonical assistant verdict followed by turn usage must be consumed');
assert.deepEqual(extractCodexReviewVerdict(JSON.stringify(verdict)), verdict, 'legacy plain verdict remains supported');

const bad = new Map([
  ['duplicate verdict', encode([...start, message(JSON.stringify(verdict)), message(JSON.stringify(verdict)), done])],
  ['conflicting verdict', encode([...start, message(JSON.stringify({ ...verdict, decision: 'fail' })), message(JSON.stringify(verdict)), done])],
  ['duplicate separated by progress', encode([...start, message(JSON.stringify(verdict)), message('More work.'), message(JSON.stringify(verdict)), done])],
  ['tool-only verdict', encode([...start, { type: 'item.completed', item: { id: 'tool', type: 'command_execution', aggregated_output: JSON.stringify(verdict) } }, done])],
  ['trailing assistant', encode([...validEvents.slice(0, -1), message('Actually fail.'), done])],
  ['trailing tool', encode([...validEvents.slice(0, -1), { type: 'item.completed', item: { id: 'later', type: 'command_execution', aggregated_output: 'later' } }, done])],
  ['trailing prose', stream + 'disregard verdict\n'],
  ['trailing raw object', stream + JSON.stringify(verdict)],
  ['missing completion', encode(validEvents.slice(0, -1))],
  ['failed turn', encode([...validEvents.slice(0, -1), { type: 'turn.failed', error: { message: 'failed' } }])],
  ['error event', encode([...start, { type: 'error', message: 'transport error' }, ...validEvents.slice(2)])],
  ['second turn', stream + encode([{ type: 'turn.started' }, message(JSON.stringify(verdict)), done])],
  ['unknown event', encode([...start, { type: 'unknown.future' }, ...validEvents.slice(2)])],
  ['malformed line', encode(start) + '{bad json}\n' + encode(validEvents.slice(2))],
  ['wrong assistant shape', encode([...start, message({ ...verdict }), done])],
  ['malformed earlier verdict', encode([...start, message('{"schemaVersion":"proof-or-stop.codex_review_verdict.v1"'), message(JSON.stringify(verdict)), done])],
  ['extra verdict key', encode([...start, message(JSON.stringify({ ...verdict, authorityDone: true })), done])],
  ['trailing text in message', encode([...start, message(JSON.stringify(verdict) + '\nactually fail'), done])],
]);
for (const [name, raw] of bad) assert.equal(extractCodexReviewVerdict(raw), undefined, name);

const options = { storyId: 'B-jsonl-fixture', storyWorktree: process.cwd(), materialHash, timeoutMs: 1000, managedExecution: true };
const run = async (stdout, overrides = {}) => runCodexReviewLeaf(options, async () => ({ stdout, exitCode: 0, timedOut: false, ...overrides }));
const positive = await run(stream);
assert.equal(positive.hostBVerdict.decision, 'pass');
assert.equal(positive.stdoutDigest, createHash('sha256').update(stream).digest('hex'), 'digest binds original transport, not extracted text');
assert.equal(Object.hasOwn(positive, 'stdout'), false, 'raw transcript is not verdict output');
for (const [name, raw] of bad) assert.equal((await run(raw)).hostBVerdict.decision, 'blocked', `leaf refuses ${name}`);
for (const override of [{ exitCode: 1 }, { timedOut: true }, { truncated: true }]) assert.equal((await run(stream, override)).hostBVerdict.decision, 'blocked');
assert.equal((await run(encode([...start, message(JSON.stringify({ ...verdict, materialHash: 'b'.repeat(64) })), done]))).hostBVerdict.reason, 'codex_review_material_mismatch');
console.log(`CROSSHOST_JSONL_VERDICT_GREEN ${bad.size} negative transport controls; actual leaf exit/timeout/truncation/material guards preserved`);
