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

import { execFileSync } from 'node:child_process';
import { parseClaudeResult } from './real-arm.mjs';

const DEFAULT_MODEL = 'sonnet';
const TURN_TIMEOUT_MS = 700000;

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
        const out = execFileSync(
          'claude',
          ['-p', '--model', model, '--dangerously-skip-permissions', '--output-format', 'json', String(context ?? '')],
          { cwd: ws, encoding: 'utf-8', timeout: TURN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const p = parseClaudeResult(out);
        result = {
          actions: [p.infraFail ? 'infra-fail' : 'claude-turn'],
          shipped: p.shipped,
          output: typeof out === 'string' ? out.slice(0, 400) : '',
          costUsd: p.costUsd,
          tokensSpent: p.tokensSpent,
          infraFail: p.infraFail,
        };
      } catch (e) {
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
