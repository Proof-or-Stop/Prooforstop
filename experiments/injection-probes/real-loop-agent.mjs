// real-loop-agent.mjs — a REAL multi-turn claude -p agent for the live-loop harness (B-b739).
//
// makeRealLoopAgent returns an agent({ws, context, turn, signal}) that runs `claude -p` once
// per turn on the running `context` in cwd=ws, reuses the B-0c07 parseClaudeResult hardening
// (non-JSON / API-error -> infra-fail; type-safe cost), and HONORS the B-c023 AbortSignal
// contract: it checks signal.aborted at entry and bounds the child via execFileSync's own
// `timeout` (which kills the child) so a hung turn cannot orphan a process or block cleanup.
//
// makeStubLoopAgent returns a deterministic no-LLM agent for the hermetic --self-check (0 spend).
//
// We reuse parseClaudeResult by import; we do NOT edit real-arm.mjs, probe-contract.mjs, the
// stateless probes, or run-recovery/run-ablation/run-a2prime.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseClaudeResult } from './real-arm.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = 'sonnet';
const TURN_TIMEOUT_MS = 700000;

/** Extract the agent's result TEXT (not the JSON envelope) to feed back as the next-turn context. */
function resultText(stdout) {
  try {
    const j = JSON.parse(stdout);
    return typeof j.result === 'string' ? j.result : '';
  } catch {
    return '';
  }
}

/**
 * Real multi-turn arm: one `claude -p` call per turn on the current context, in the workspace.
 * Honors signal.aborted (skips the call if already aborted) and bounds the child via the
 * execFileSync timeout (which terminates the child — the agent-owns-termination contract).
 * Pushes {costUsd, tokensSpent, infraFail} to costLog (if given) in call order.
 */
export function makeRealLoopAgent({ model = DEFAULT_MODEL, costLog } = {}) {
  return async function agent({ ws, context, signal }) {
    let result;
    if (signal && signal.aborted) {
      result = { actions: ['aborted-before-start'], shipped: false, output: '', costUsd: 0, tokensSpent: 0, infraFail: true };
    } else {
      try {
        // ASYNC execFile with {signal}: the harness AbortController actually kills the child on
        // abort, and the event loop is NOT blocked so the harness watchdog/turnTimeoutMs fire.
        const { stdout } = await execFileAsync(
          'claude',
          ['-p', '--model', model, '--dangerously-skip-permissions', '--output-format', 'json', String(context ?? '')],
          { cwd: ws, encoding: 'utf-8', timeout: TURN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, signal },
        );
        const p = parseClaudeResult(stdout);
        result = {
          actions: [p.infraFail ? 'infra-fail' : 'claude-turn'],
          shipped: p.shipped,
          // feed back the agent's RESULT TEXT, not the raw JSON envelope.
          output: resultText(stdout).slice(0, 2000),
          costUsd: p.costUsd,
          tokensSpent: p.tokensSpent,
          infraFail: p.infraFail,
        };
      } catch (e) {
        // AbortError (signal) and timeout both land here — the child is killed by execFile; infra-fail.
        result = { actions: ['infra-fail'], shipped: false, output: '', costUsd: 0, tokensSpent: 0, infraFail: true, error: String((e && e.message) || e).slice(0, 200) };
      }
    }
    if (costLog) costLog.push({ costUsd: result.costUsd, tokensSpent: result.tokensSpent, infraFail: result.infraFail });
    return result;
  };
}

/**
 * Deterministic no-LLM stub multi-turn agent for the hermetic self-check. `behavior(ctx)` may
 * mutate the workspace and returns {actions, shipped, output}. Records whether it received an
 * AbortSignal (so the self-check can assert the harness passes one through).
 */
export function makeStubLoopAgent(behavior, observed) {
  return async function agent(ctx) {
    if (observed && ctx && ctx.signal) observed.gotSignal = true;
    const r = behavior(ctx) || {};
    return { actions: r.actions ?? ['stub'], shipped: !!r.shipped, output: r.output ?? '', costUsd: 0, tokensSpent: 0, infraFail: false };
  };
}
