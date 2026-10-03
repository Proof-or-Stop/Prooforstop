#!/usr/bin/env node
/**
 * Regression (old-PoS bench run 15, abs-stepped-slices, CHK-005): the owner
 * stopped a healthy Story because of three framework faults.
 *
 *   1. The auth classifier matched the bare `401` inside the Codex usage line
 *      `{"type":"turn.completed","usage":{"cached_input_tokens":7401088,...}}`,
 *      so a successful implementer (exit 0, provider_completed, output sealed)
 *      carried failureKind=auth. Run 14 had 7 such false `auth` and 6 false
 *      `interactive` kinds on completed runs.
 *   2. The compact host_run_status text printed that failureKind and
 *      "result: no provider final result" for the completed implementer, so
 *      the owner relaunched it.
 *   3. The replacement found CHK-005 already done; done->done is not a
 *      completion transition, so no run-bound result existed and the run
 *      ended managed_dispatch_output_missing, which the owner rule treats as
 *      "relaunch once, then stop".
 *
 * Contract checked here:
 *   A. provider stdout JSON other than an error event (item.*, turn.completed
 *      usage, tool output) never classifies auth/interactive; patterns are
 *      word-bounded; exit 0 + completed => failureKind none; a real provider
 *      error event / stderr diagnostic still classifies.
 *   B. the compact status of a completed implementer leads with OK:, shows no
 *      failureKind and no "no provider final result", and names the sealed
 *      item and its commit.
 *   C. dispatch (and host_run --managedDispatch) of an implementer item that
 *      already has a sealed managed completion is refused with one next
 *      action naming the earlier run, its commit and `next`.
 *   D. a run that nevertheless finds its target already done ends with the
 *      non-fatal managed_dispatch_target_already_done, whose status points to
 *      the earlier run and `next`, never to relaunch/stop.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyHostExecutionDiagnosticText, classifyHostExecutionFailure } from '../core/host-execution-readiness.js';
import { defaultHostRunRunner } from '../core/host-run.js';
import * as managedHostRun from '../core/managed-host-run.js';
import { StoryStore } from '../core/store.js';
import * as summary from '../handlers/host-run-status-summary.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { createHostRunHandlers } from '../handlers/host-run.js';
import { deterministicHostRuntime } from './host-run-usage/support.js';

const MARKER = 'false provider failure / redundant implementer redispatch';
const USAGE_LINE = '{"type":"turn.completed","usage":{"input_tokens":7483160,"cached_input_tokens":7401088,"output_tokens":24011}}\n';
const TOOL_LINE = `${JSON.stringify({ type: 'item.completed', item: { id: 'item_7', type: 'command_execution',
  aggregated_output: 'GET /api -> HTTP 401 Unauthorized: authentication required; run in non-interactive mode; press enter to continue',
  exit_code: 0 } })}\n`;

async function runFake(chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }>, code: number) {
  const fake = deterministicHostRuntime();
  const pending = defaultHostRunRunner({ command: 'fake-codex', argv: [], env: process.env, cwd: process.cwd() }, fake.runtime);
  for (const chunk of chunks) fake.child[chunk.stream].emit('data', chunk.text);
  fake.child.emit('close', code, null);
  return pending;
}

async function partA(): Promise<void> {
  // Word-bounded diagnostic patterns.
  for (const text of [USAGE_LINE, 'cached_input_tokens 7401088', 'Run the non-interactive installer', 'add authentication middleware', 'interactive']) {
    assert.equal(classifyHostExecutionDiagnosticText(text), null, `${MARKER}: "${text.trim().slice(0, 60)}" is not a provider diagnostic`);
  }
  for (const [text, kind] of [
    ['unexpected status 401 Unauthorized', 'auth'], ['HTTP status 401', 'auth'], ['authentication required: please login', 'auth'],
    ['refresh_token_invalidated: please login again', 'auth'], ['Invalid API key', 'auth'], ['not logged in', 'auth'],
    ['interactive terminal required; cannot prompt without a TTY', 'interactive'],
  ] as const) assert.equal(classifyHostExecutionDiagnosticText(text), kind, `"${text}" stays ${kind}`);

  // Provider stdout JSON that is not an error event is never classified.
  const ok = await runFake([{ stream: 'stdout', text: TOOL_LINE }, { stream: 'stdout', text: USAGE_LINE }], 0);
  assert.equal(ok.terminalReason, 'completed');
  assert.equal(ok.failureKind, 'none', `${MARKER}: a completed run whose usage line contains 401 must be failureKind none (got ${ok.failureKind})`);
  const split = await runFake([{ stream: 'stdout', text: USAGE_LINE.slice(0, 70) }, { stream: 'stdout', text: USAGE_LINE.slice(70) }], 1);
  assert.notEqual(split.failureKind, 'auth', `${MARKER}: a usage line split across chunks is still not an auth diagnostic`);
  const toolOnFailure = await runFake([{ stream: 'stdout', text: TOOL_LINE }], 1);
  assert.equal(toolOnFailure.failureKind, 'unknown', `${MARKER}: tool output inside item JSON never classifies a failed run (got ${toolOnFailure.failureKind})`);
  // Exit 0 + completed is authoritative even over a stderr diagnostic.
  const exitZero = await runFake([{ stream: 'stderr', text: 'authentication required: please login\n' }], 0);
  assert.equal(exitZero.failureKind, 'none', `${MARKER}: exit 0 + completed must be failureKind none`);
  // Real provider error events still classify.
  const errorEvent = await runFake([
    { stream: 'stdout', text: '{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer"}\n' },
    { stream: 'stdout', text: '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}\n' },
  ], 1);
  assert.equal(errorEvent.failureKind, 'auth', 'a Codex error/turn.failed event naming 401 Unauthorized stays auth');
  const claudeError = await runFake([{ stream: 'stdout', text: '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}\n' }], 1);
  assert.equal(claudeError.failureKind, 'auth', 'a Claude is_error result naming an invalid API key stays auth');
  // Close-time classification of retained stdout uses the same filter.
  assert.equal(classifyHostExecutionFailure({ status: 1, signal: null, stdout: USAGE_LINE + TOOL_LINE, stderr: '' }), 'unknown',
    `${MARKER}: close-time classification ignores retained usage/tool JSON`);
}

function partB(): void {
  const compose = (summary as Record<string, unknown>).composeHostRunStatusSummary as
    ((status: unknown, facts: Record<string, unknown>) => string) | undefined;
  assert.equal(typeof compose, 'function', `${MARKER}: no pure compact-status composer`);
  const run = {
    runId: 'run-ok', state: 'completed', terminal: { state: 'completed', reason: 'provider_completed' },
    stage: { number: 5, total: 5, name: 'terminal' }, generation: 4, storyId: 'B-060b', phase: 'DEV',
    agentType: 'proof-or-stop-implementer', host: 'codex', model: 'deepseek-v4-flash', reasoningEffort: 'low',
    profile: 'managed_dispatch', replacementSafe: true, supervisionDiagnostic: null,
  };
  const result = { exitCode: 0, timedOut: false, failureKind: 'auth', finalAssistantResult: null, finalAssistantResultCount: 0, finalAssistantResultTruncated: false };
  const text = compose!({ run, receipt: { receiptId: 'rcpt-1' } }, {
    dir: '/x/run-ok', target: { itemId: 'CHK-005' }, result, proposal: null,
    codeOutput: { commit: '39c8303' }, priorCompletion: null,
  });
  const lines = text.split('\n');
  assert.match(lines[0]!, /^OK: /, `${MARKER}: completed status must lead with OK: (got ${lines[0]})`);
  assert.doesNotMatch(text, /failureKind/, `${MARKER}: a completed run shows no failureKind`);
  assert.doesNotMatch(text, /no provider final result/, `${MARKER}: an implementer never sends a final result`);
  assert.match(text, /CHK-005/);
  assert.match(text, /commit 39c8303/);
  assert.match(text, /Next: proof-or-stop next --storyId=B-060b/);

  const failed = compose!({ run: { ...run, runId: 'run-bad', state: 'failed', terminal: { state: 'failed', reason: 'provider_exit_1' } }, receipt: null }, {
    dir: '/x/run-bad', target: { itemId: 'CHK-005' }, result: { ...result, exitCode: 1, failureKind: 'unknown' }, proposal: null,
    codeOutput: null, priorCompletion: null,
  });
  assert.match(failed.split('\n')[0]!, /^FAILED: /, 'a failed run leads with FAILED:');
  assert.match(failed, /failureKind=unknown/, 'a failed run keeps its failureKind');

  const already = compose!({ run: { ...run, runId: 'run-again', state: 'failed', terminal: { state: 'failed', reason: 'managed_dispatch_target_already_done' } }, receipt: null }, {
    dir: '/x/run-again', target: { itemId: 'CHK-005' }, result: { ...result, exitCode: 1, failureKind: 'unknown' }, proposal: null,
    codeOutput: null, priorCompletion: { runId: 'run-ok', commit: '39c8303' },
  });
  assert.match(already.split('\n')[0]!, /^OK: /, `${MARKER}: an already-done target is not a failure (got ${already.split('\n')[0]})`);
  assert.match(already, /run-ok/);
  assert.match(already, /39c8303/);
  assert.match(already, /Next: proof-or-stop next --storyId=B-060b/);
  assert.doesNotMatch(already, /relaunch|stop and report|failureKind/i, `${MARKER}: already-done never routes to relaunch/stop`);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeSealedRun(root: string, runId: string, fields: { storyId: string; itemId: string; cwd: string; createdAt: string; terminalAt: string }): void {
  const dir = managedHostRun.managedHostRunDirectory(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({
    runId, host: 'codex', profile: 'managed_dispatch', storyId: fields.storyId, phase: 'DEV',
    agentType: 'proof-or-stop-implementer', cwd: fields.cwd, root, model: 'deepseek-v4-flash',
    managedDispatchTarget: { itemId: fields.itemId }, createdAt: fields.createdAt, deadlineAt: fields.terminalAt,
  }));
  writeFileSync(join(dir, 'terminal.json'), JSON.stringify({
    runId, state: 'completed', reason: 'provider_completed', terminalAt: fields.terminalAt,
    managedDispatchOutputDigest: 'a'.repeat(64),
  }));
}

async function partCD(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'false-failure-redispatch-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: '.', testsDir: 'tests', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    }));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'redispatch@example.invalid');
    git(root, 'config', 'user.name', 'Redispatch Smoke');
    const store = new StoryStore(root);
    const storyId = 'B-060b';
    store.writeStory(storyId, { storyId, title: 'Stepped slices', description: 'slices', phase: 'DEV', priority: 'high' } as never);
    const item = (id: string, status: string) => ({ id, title: `${id} work`, context: 'evaluator', status, relatedDocs: [], userSees: 'works',
      verificationIntent: { happy: [{ id: `${id}:happy:0`, desc: 'works', type: 'logic' }], edge: [], adversarial: [] } });
    store.writeChecklist(storyId, { items: [item('CHK-004', 'done'), item('CHK-005', 'done'), item('CHK-006', 'pending')] } as never);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(root, 'slice.go'), 'package main\n');
    git(root, 'add', 'slice.go');
    git(root, 'commit', '-qm', 'CHK-005: stepped slices');
    const commit = git(root, 'rev-parse', 'HEAD');
    const terminalAt = new Date(Date.now() + 2_000).toISOString();
    writeSealedRun(root, 'run-first', { storyId, itemId: 'CHK-005', cwd: root, createdAt, terminalAt });
    store.appendProcessEvent(storyId, { type: 'subagent_result', checklistId: 'CHK-005', success: true, managedDispatchRunId: 'run-first' } as never);
    // CHK-004 was done by the owner without a managed run: not refused.
    store.appendProcessEvent(storyId, { type: 'subagent_result', checklistId: 'CHK-004', success: true } as never);

    // C. dispatch refusal with one next action.
    const handlers = createStoryDispatchHandlers({ root, scanRoot: root, store });
    let refusal = '';
    try {
      handlers.dispatch({ storyId, itemId: 'CHK-005', agentType: 'proof-or-stop-implementer' });
    } catch (error) { refusal = error instanceof Error ? error.message : String(error); }
    assert.ok(refusal, `${MARKER}: dispatch of an implementer item with a sealed managed completion must be refused`);
    assert.match(refusal, /managed_dispatch_target_already_done/);
    assert.match(refusal, /run-first/);
    assert.ok(refusal.includes(commit.slice(0, 7)), `refusal names the earlier commit: ${refusal}`);
    assert.match(refusal, /proof-or-stop next --storyId=B-060b/);
    handlers.dispatch({ storyId, itemId: 'CHK-006', agentType: 'proof-or-stop-implementer' });
    handlers.dispatch({ storyId, itemId: 'CHK-004', agentType: 'proof-or-stop-implementer' });

    let hostRunRefusal = '';
    try {
      await createHostRunHandlers({ root, scanRoot: root, store }).host_run({
        host: 'codex', model: 'deepseek-v4-flash', reasoningEffort: 'low', storyId, agentType: 'proof-or-stop-implementer',
        itemId: 'CHK-005', managedDispatch: true, detach: true, json: true,
      } as never);
    } catch (error) { hostRunRefusal = error instanceof Error ? error.message : String(error); }
    assert.match(hostRunRefusal, /managed_dispatch_target_already_done[\s\S]*run-first[\s\S]*proof-or-stop next --storyId=B-060b/,
      `${MARKER}: host_run --managedDispatch must be refused the same way (got: ${hostRunRefusal.slice(0, 300)})`);

    // D. a late run that finds the target already done gets the non-fatal terminal.
    const validation = managedHostRun.managedDispatchOutputValidation({
      root, storyId, agentType: 'proof-or-stop-implementer', runId: 'run-again', managedDispatchTarget: { itemId: 'CHK-005' },
    });
    assert.equal(validation.failureReason, 'managed_dispatch_target_already_done',
      `${MARKER}: an implementer whose item was already sealed by another run must not end managed_dispatch_output_missing`);
    const find = (managedHostRun as Record<string, unknown>).findSealedManagedImplementerCompletion as
      ((args: { root: string; storyId: string; itemId: string; excludeRunId?: string }) => { runId: string; commit: string | null } | null) | undefined;
    assert.equal(typeof find, 'function');
    assert.deepEqual(find!({ root, storyId, itemId: 'CHK-005', excludeRunId: 'run-again' }), { runId: 'run-first', commit: commit.slice(0, 7) });
    assert.equal(find!({ root, storyId, itemId: 'CHK-005', excludeRunId: 'run-first' }), null);
    assert.equal(find!({ root, storyId, itemId: 'CHK-004' }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await partA();
partB();
await partCD();
console.log('false-failure-and-redispatch-smoke: PASS');
