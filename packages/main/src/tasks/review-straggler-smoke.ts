#!/usr/bin/env node
/**
 * Lab run132 (old-PoS run 133, bench-staging/oldpos/run133-analysis.md item 3 C; switch review.stragglerVerdict):
 * the managed review worker end to end with a fake `codex` on PATH driven through the real default runner (the
 * tasks/managed-final-json-repair-smoke.ts pattern). Run 133's R1 concept lane ran 13.1 min while its siblings took
 * 3.7-7.1 min. A lane still in its first turn once every sibling lane of its round finished, past max(floor,
 * 2 x the median completed sibling), is stopped and asked in its OWN resumed session for its verdict from what it has
 * read; its output passes the same validation as any final result.
 *
 *   S1 due: the first turn is stopped, the second invocation resumes the SAME session with the verdict-now prompt, the
 *      run completes with that verdict, and the decision / resume are journaled.
 *   S2 a sibling lane still runs: nothing is stopped (one invocation).
 *   S3 the floor is 0 (environment override; review.stragglerVerdict=off seals 0 too): nothing is stopped.
 *   S4 no resumable session: journaled as unavailable, the lane keeps running (one invocation).
 *
 * Usage: node packages/main/dist/tasks/review-straggler-smoke.js
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { managedHostRunDirectory, managedHostRunsRoot, runManagedHostRunWorker, submitManagedHostRun } from '../core/managed-host-run.js';
import type { ManagedHostRunTerminal } from '../core/managed-host-run.js';
import { StoryStore } from '../core/store.js';

const STORY = 'B-1331';
const LANE = 'proof-or-stop-review-concept';
const SIBLING_LANE = 'proof-or-stop-review-docs';
const REVIEW_RUN = `${STORY}:RR-002`;
const SIBLING_RUN = `${STORY}:RR-001`;
const THREAD = '019a1f18-c8d8-7000-8000-0000000013c1';

const envelope = JSON.stringify({
  schemaVersion: 'lattice.managed_review_final_proposal.v1', storyId: STORY, providerAgent: LANE, lane: LANE, reviewRunId: REVIEW_RUN,
  conclusion: 'pass', note: 'Concept lane: the reviewed range paths match the request; not checked: the docs examples (stopped early).',
  // The read manifest / log of the managed-final-json-repair fixture (a shape the final validation accepts).
  readManifest: { filesReadFully: ['docs/src/docs/types/array.md', 'docs/src/docs/types/string.md', 'docs/src/docs/syntax/assignments.md', 'examples/index_ranges.abs', 'examples/unicode.abs'],
    filesTriagedByName: ['tests/test-assign-index.abs', 'ast/ast_test.go', 'ast/ast.go', 'evaluator/evaluator_test.go', 'evaluator/evaluator.go', 'parser/parser_test.go', 'parser/parser.go'],
    scanEscalationReason: 'The repository requirements corpus is still unavailable and the prior candidate binding is stale after remediation, so the full repaired parser/AST/evaluator/docs material must be re-scanned for the fresh review round.',
    candidateSpecSetDigest: '6cdc41a9d6483eb4e07d9e041d14cbfe35f86408ff3ab5b4519a764c91f62422', corpusDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945' },
  readLog: { filesReadFully: ['docs/src/docs/types/array.md', 'docs/src/docs/types/string.md', 'docs/src/docs/syntax/assignments.md', 'examples/index_ranges.abs', 'examples/unicode.abs'],
    filesTriagedByName: ['tests/test-assign-index.abs', 'ast/ast_test.go', 'ast/ast.go', 'evaluator/evaluator_test.go', 'evaluator/evaluator.go', 'parser/parser_test.go', 'parser/parser.go'],
    summary: { readCount: 5, tokenCount: null }, digest: '98f172c84b33306ee58f6de26ac39de529f4369c5e61d938632f2cb5e9eca222' },
});

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
    const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '22');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-10-22T06-58-17-${THREAD}.jsonl'), '{}\\n');
  }
  emit({ type: 'turn.started' });
  const finish = () => {
    emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: fs.readFileSync(path.join(state, 'final.txt'), 'utf8') } });
    emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } });
  };
  if (resumed) return finish();
  // The first turn keeps working (reading files) for a while, emitting items so no stall timer fires.
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    emit({ type: 'item.completed', item: { id: 'read_' + ticks, type: 'command_execution', command: 'cat lang/slice.go', aggregated_output: '', exit_code: 0, status: 'completed' } });
    if (ticks >= 30) { clearInterval(timer); finish(); }
  }, 100);
});
`, { mode: 0o755 });
}

/** The round's other lane: completed in 100 ms (spec + events + terminal), or still running (no terminal). */
function writeSibling(root: string, state: 'completed' | 'running'): void {
  const store = new StoryStore(root);
  const startedAt = '2026-10-22T06:00:00.000Z';
  const run = (reviewRunId: string, lane: string) => ({ reviewRunId, storyId: STORY, agent: lane, lane, reviewRound: 'round-1', startedAt, headHash: 'h', materialHash: 'm', promptHash: 'p' });
  store.writeReviewRuns(STORY, { runs: [run(SIBLING_RUN, SIBLING_LANE), run(REVIEW_RUN, LANE)] } as never);
  const dir = join(managedHostRunsRoot(root), 'mhr_sibling_fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ storyId: STORY, reviewRunId: SIBLING_RUN, lane: SIBLING_LANE }));
  writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'provider_spawned', at: '2026-10-22T06:00:00.000Z' })}\n`);
  if (state === 'completed') writeFileSync(join(dir, 'terminal.json'), JSON.stringify({ state: 'completed', terminalAt: '2026-10-22T06:00:00.100Z' }));
}

interface Outcome { terminal: ManagedHostRunTerminal; invocations: Array<{ argv: string[]; stdin: string }>; events: Array<{ type: string; detail?: Record<string, unknown> }> }

async function runCase(base: string, name: string, opts: { sibling: 'completed' | 'running'; floorMs: string; mode?: 'normal' | 'nosession' }): Promise<Outcome> {
  const root = join(base, name);
  const state = join(root, '.fake-codex');
  const bin = join(root, '.fake-bin');
  const codexHome = join(root, '.codex-home');
  mkdirSync(state, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFakeCodex(bin, state);
  writeFileSync(join(state, 'mode'), opts.mode ?? 'normal');
  writeFileSync(join(state, 'final.txt'), envelope);
  writeFileSync(join(state, 'invocations.jsonl'), '');
  writeSibling(root, opts.sibling);
  const previous = process.env.PROOF_OR_STOP_MANAGED_REVIEW_STRAGGLER_MS;
  process.env.PROOF_OR_STOP_MANAGED_REVIEW_STRAGGLER_MS = opts.floorMs;
  let worker: Promise<ManagedHostRunTerminal> | null = null;
  try {
    const submitted = await submitManagedHostRun({
      root, cwd: root, host: 'codex', storyId: STORY, phase: 'REVIEW', agentType: LANE, reviewRunId: REVIEW_RUN, lane: LANE, promptText: 'review the concept lane',
      deadlineMs: 60_000, projectRootHash: `sha256:${name}`, profile: 'managed_reviewer',
      reviewBinding: { headHash: 'h', materialHash: 'm', storyFilesHash: 's', promptHash: 'p', envelopeId: null },
    }, {
      launchWorker: async request => {
        worker = runManagedHostRunWorker(request, {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CODEX_HOME: codexHome, PROOF_OR_STOP_USAGE_LEDGER: '0' },
          cancelPollMs: 5, stragglerPollMs: 25,
        });
        return { pid: process.pid };
      },
      claimTimeoutMs: 5_000, claimPollMs: 5,
    });
    assert.ok(worker, 'the worker was launched');
    const terminal = await (worker as unknown as Promise<ManagedHostRunTerminal>);
    const log = join(state, 'invocations.jsonl');
    const invocations = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; stdin: string }) : [];
    const events = readFileSync(join(managedHostRunDirectory(root, submitted.runId), 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { type: string; detail?: Record<string, unknown> });
    return { terminal, invocations, events };
  } finally {
    if (previous === undefined) delete process.env.PROOF_OR_STOP_MANAGED_REVIEW_STRAGGLER_MS; else process.env.PROOF_OR_STOP_MANAGED_REVIEW_STRAGGLER_MS = previous;
  }
}

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
const types = (outcome: Outcome): string[] => outcome.events.map(event => event.type);

const base = mkdtempSync(join(tmpdir(), 'review-straggler-'));
try {
  await check('S1 a lane past the budget once its sibling finished is stopped and gives its verdict in its own resumed session', async () => {
    const out = await runCase(base, 'due', { sibling: 'completed', floorMs: '1500' });
    assert.equal(out.terminal.state, 'completed', `terminal ${out.terminal.state}: ${out.terminal.reason}`);
    assert.equal(out.invocations.length, 2, `the first turn, then ONE verdict-now resume: ${out.invocations.length}; events ${JSON.stringify(out.events.filter(event => /straggler|provider|abort/.test(event.type)))}`);
    assert.deepEqual(out.invocations[0]!.argv.slice(0, 2), ['exec', '--json']);
    assert.deepEqual(out.invocations[1]!.argv.slice(0, 2), ['exec', 'resume'], 'the verdict turn resumes the session');
    assert.equal(out.invocations[1]!.argv.at(-2), THREAD, 'the SAME provider session');
    assert.match(out.invocations[1]!.stdin, /Do not run any more commands/);
    assert.match(out.invocations[1]!.stdin, /final JSON object/);
    assert.ok(types(out).includes('review_straggler_verdict_now'), `journaled: ${types(out).join(',')}`);
    assert.ok(types(out).includes('review_straggler_verdict_resume'));
    const decision = out.events.find(event => event.type === 'review_straggler_verdict_now')!.detail!;
    assert.equal(decision.thresholdMs, 1500, 'max(floor 1500, 2 x median 100)');
  });
  await check('S2 a sibling lane still runs: nothing is stopped', async () => {
    const out = await runCase(base, 'sibling-running', { sibling: 'running', floorMs: '1500' });
    assert.equal(out.terminal.state, 'completed', `terminal ${out.terminal.state}: ${out.terminal.reason}`);
    assert.equal(out.invocations.length, 1);
    assert.ok(!types(out).some(type => type.startsWith('review_straggler')));
  });
  await check('S3 floor 0 (off): nothing is stopped', async () => {
    const out = await runCase(base, 'off', { sibling: 'completed', floorMs: '0' });
    assert.equal(out.terminal.state, 'completed', `terminal ${out.terminal.state}: ${out.terminal.reason}`);
    assert.equal(out.invocations.length, 1);
    assert.ok(!types(out).some(type => type.startsWith('review_straggler')));
  });
  await check('S4 no resumable session: journaled unavailable, the lane keeps running to its own verdict', async () => {
    const out = await runCase(base, 'nosession', { sibling: 'completed', floorMs: '1500', mode: 'nosession' });
    assert.equal(out.invocations.length, 1, 'never stopped');
    assert.ok(types(out).includes('review_straggler_verdict_unavailable'), `journaled: ${types(out).join(',')}`);
    assert.ok(!types(out).includes('review_straggler_verdict_now'));
    assert.equal(types(out).filter(type => type === 'review_straggler_verdict_unavailable').length, 1, 'journaled once although the check repeats');
  });
} finally {
  if (!process.env.KEEP_STRAGGLER_FIXTURE) rmSync(base, { recursive: true, force: true }); else console.log(`fixture kept: ${base}`);
}
if (failures.length) {
  console.log(`review-straggler-smoke: ${failures.length} check(s) FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('review-straggler-smoke: all checks passed');
