#!/usr/bin/env node
/**
 * Regression (run 14 cost analysis, abs-stepped-slices): the Story owner spent
 * 59.1M input tokens on 161 empty 30 s polls of a blocking
 * `host_run_status --untilTerminal` (the long-yield hint was printed only by
 * `host_run`), and 30.2M more re-reading `host_run_status --json` records of
 * 25k-75k tokens, because the text status lacked the binding, exit and verdict
 * the owner had to check, and `next`'s own wait step printed `--json=true`.
 *
 * Contract checked here:
 *   1. a blocking status/wait prints the exact wait instruction as its FIRST
 *      line: the CLI on stderr before any work, the text result while the run
 *      is still non-terminal, and `next`'s rendering of a wait step;
 *   2. the owner-facing text status of a terminal run is a compact summary
 *      (<= 1400 bytes, ~300 tokens) that still carries everything a gate or
 *      the owner acts on: binding, state, exit, verdict and finding count,
 *      receiptId, replacementSafe, the next action and the full-record path;
 *      full JSON stays available with --json / --full;
 *   3. `next`'s wait step uses that compact text form, not --json.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import type { HostRunRunner } from '../core/host-run.js';
import { getManagedHostRunStatus, managedHostRunDirectory } from '../core/managed-host-run.js';
import { createHostRunHandlers, type HostRunDetachResult } from '../handlers/host-run.js';
import * as nextDriver from '../handlers/next-driver.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const WAIT_LINE = /^Wait: .*yield_time_ms=300000.*write_stdin yield_time_ms=300000.*Do not poll more often/;
const SUMMARY_MAX_BYTES = 1_400;

function finalProposal(): string {
  return JSON.stringify({
    schemaVersion: 'lattice.managed_review_final_proposal.v1',
    storyId: 'B-wait',
    providerAgent: 'lattice-review-quality',
    lane: 'lattice-review-quality',
    reviewRunId: 'B-wait:RR-001',
    conclusion: 'findings',
    note: 'two issues',
    findings: [
      { desc: 'negative step loops forever', severity: 'medium', category: 'edge', files: ['evaluator/slice.go'] },
      { desc: 'docs omit step syntax', severity: 'low', category: 'missing', files: ['README.md'] },
    ],
  });
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'owner-wait-output-smoke-'));
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runner: HostRunRunner = async plan => {
      // A realistic Codex JSONL stream: ~120 KB of retained live output.
      for (let i = 0; i < 400; i += 1) {
        plan.onChunk?.({ stream: 'stdout', text: `${JSON.stringify({ type: 'item.completed', item: { id: `item_${i}`, type: 'command_execution', aggregated_output: 'x'.repeat(240) } })}\n` });
      }
      await gate;
      return {
        stdout: '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":1,"output_tokens":2}}\n',
        stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
        finalAssistantResult: finalProposal(), finalAssistantResultCount: 1, finalAssistantResultTruncated: false,
      };
    };
    const ctx = { root, scanRoot: join(root, 'packages/main'), store: new StoryStore(root) };
    const handlers = createHostRunHandlers(ctx, { runner });
    const detached = await handlers.host_run({
      host: 'codex', agentType: 'lattice-review-quality', phase: 'REVIEW',
      model: 'gpt-5.6-sol', reasoningEffort: 'high',
      prompt: 'owner wait output smoke', detach: true, deadlineMs: 60_000, json: true,
    }) as HostRunDetachResult;
    const runId = detached.run.runId;

    // 1a. Non-terminal text status (the owner's default form) leads with the wait instruction.
    const capped = createHostRunHandlers(ctx, { runner, statusWaitCapMs: 50 });
    const running = await capped.host_run_status({ runId }) as string;
    assert.match(running.split('\n')[0]!, WAIT_LINE,
      `non-terminal text status must lead with the wait instruction; got: ${running.split('\n')[0]}`);

    release();
    for (let i = 0; i < 400; i += 1) {
      if ((await getManagedHostRunStatus({ root, runId })).run.terminal) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    // 2. Terminal: compact summary vs the full JSON record.
    const full = JSON.stringify(await handlers.host_run_status({ runId, json: true }));
    const text = await handlers.host_run_status({ runId, untilTerminal: true }) as string;
    const textBytes = Buffer.byteLength(text);
    console.log(`owner-wait-output-smoke: status bytes json=${Buffer.byteLength(full)} text=${textBytes}`);
    console.log(text);
    assert.ok(textBytes <= SUMMARY_MAX_BYTES, `terminal text status must be <= ${SUMMARY_MAX_BYTES} bytes, got ${textBytes}`);
    assert.doesNotMatch(text.split('\n')[0]!, /^Wait:/, 'a terminal status is not a wait');
    for (const field of [
      `run ${runId}`, 'state=completed', 'exit=0', 'agentType=lattice-review-quality', 'phase=REVIEW',
      'host=codex', 'model=gpt-5.6-sol', 'effort=high', 'verdict=findings', 'findings=2', 'receiptId=',
      'replacementSafe=', 'Next:', managedHostRunDirectory(root, runId),
    ]) assert.ok(text.includes(field), `terminal text status must carry ${field}`);
    assert.ok(text.includes('--json=true') && text.includes('--full=true'), 'the summary names the full-record flags');
    const fullFlag = await handlers.host_run_status({ runId, full: true } as never) as Record<string, unknown>;
    assert.equal(typeof fullFlag, 'object', '--full=true returns the full structured record');
    assert.ok('output' in fullFlag && 'receipt' in fullFlag, '--full=true keeps output frames and receipt');

    // 3. next's wait step: compact text form, wait instruction first.
    const build = (nextDriver as Record<string, unknown>).managedRunWaitStep as
      ((base: { storyId: string; phase: string }, runId: string, state: string, what: string) => nextDriver.NextStep) | undefined;
    assert.equal(typeof build, 'function', 'next-driver exports the wait-step builder it uses');
    const step = build!({ storyId: 'B-wait', phase: 'DEV' }, runId, 'running', 'Implementer run');
    assert.equal(step.wait, true);
    assert.equal(step.cli?.payload.json, undefined, 'the wait step must not request the full --json record');
    assert.match(nextDriver.renderNextStep(step).split('\n')[0]!, WAIT_LINE, 'next renders a wait step with the wait instruction first');
    const stepText = await handlers.host_run_status(step.cli!.payload as never) as string;
    assert.ok(typeof stepText === 'string' && Buffer.byteLength(stepText) <= SUMMARY_MAX_BYTES,
      'executing the wait step prints the compact summary');

    // 1b. The real CLI prints the instruction as its first stderr line, before any work.
    const cli = spawnSync(process.execPath, [CLI, '--root', root, 'host_run_status', `--runId=${runId}`, '--untilTerminal=true'], {
      cwd: root, env: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0' }, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(cli.status, 0, `CLI status exits 0: ${cli.stderr}`);
    assert.match(cli.stderr.split('\n')[0]!, WAIT_LINE, `CLI wait must print the instruction first; stderr: ${cli.stderr.slice(0, 300)}`);
    assert.ok(Buffer.byteLength(cli.stdout) <= SUMMARY_MAX_BYTES, `CLI text status stays compact (${Buffer.byteLength(cli.stdout)} bytes)`);
    const snapshot = spawnSync(process.execPath, [CLI, '--root', root, 'host_run_status', `--runId=${runId}`, '--waitMs=0'], {
      cwd: root, env: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0' }, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.doesNotMatch(snapshot.stderr, /^Wait:/m, 'a waitMs=0 snapshot is not a wait');

    console.log(`owner-wait-output-smoke: PASS (json=${Buffer.byteLength(full)} bytes -> text=${textBytes} bytes)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
