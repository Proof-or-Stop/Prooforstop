/**
 * Validation command timeout policy: the default per-command wall-clock ceiling,
 * Node's timer bound, and the resolver every executor and identity path uses.
 * A leaf (types only), so validation-evidence-reuse and validation-command-identity
 * resolve timeouts without importing validation-executor (that edge was part of
 * the 55-module core import cycle). validation-executor re-exports all three.
 */
import type { ValidationCommand } from './validation-types.js';

/**
 * Default hard per-command ceiling applied when a validate command sets no explicit
 * `timeoutMs`. This is a TOTAL WALL-CLOCK ceiling per command — distinct from the
 * cli-engine global watchdog, which fires only after ~300s of NO OUTPUT (idle). Kept
 * strictly BELOW that global watchdog (300_000ms = 5*60*1000; overridable via the
 * PROOF_OR_STOP_IDLE_TIMEOUT_MS env var) so a hung/slow command is killed and ATTRIBUTED
 * (exit 124) here first, instead of the global watchdog silently force-exiting the whole
 * validate (which never re-stamps test-evidence.materialHash and silently blocks DONE for
 * every story). It is also kept ABOVE the observed full-validation incident envelope
 * (~171s) with margin; a command that genuinely needs longer can raise
 * `proof-or-stop.config.json` validate.commands[].timeoutMs (the build is pinned there to 290s
 * to keep near-watchdog headroom for a cold-cache compile). NOTE: lowering
 * PROOF_OR_STOP_IDLE_TIMEOUT_MS below this default would invert the invariant — an advanced,
 * non-default override the operator owns.
 */
export const DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS = 270_000;

/** Node clamps larger setTimeout delays to ~1ms and emits TimeoutOverflowWarning. */
export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The effective per-command timeout: an explicit positive `timeoutMs`, else `defaultMs`
 * (the module default unless a caller injects one — the seam tests use to exercise the
 * default-arming path with a tiny ceiling). A non-finite / zero / negative `timeoutMs`
 * falls back to the default BY DESIGN: there is intentionally no opt-out of the per-command
 * ceiling, since an unbounded command is exactly the hang this guards against.
 */
export function resolveCommandTimeoutMs(
  command: ValidationCommand,
  defaultMs: number = DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
): number {
  const effective = typeof command.timeoutMs === 'number' && Number.isFinite(command.timeoutMs) && command.timeoutMs > 0
    ? command.timeoutMs
    : defaultMs;
  return Math.max(1, Math.min(MAX_NODE_TIMER_DELAY_MS, Math.floor(effective)));
}
