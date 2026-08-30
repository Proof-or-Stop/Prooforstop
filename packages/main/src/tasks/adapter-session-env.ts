/**
 * Shared helper for smokes that need a signing-eligible session identity.
 *
 * Roles that sign a topology receipt (`proof-or-stop-review-topology-critic`) or an exclusion approval
 * (`proof-or-stop-review-scope-plan`) must hold a `host-adapter` or `generated-token` session — see the
 * guard in `core/topology-critic-receipt.ts#deriveRoleProvenance`. A fixture that establishes
 * identity by writing the session id env var directly resolves to `explicit-env` and is refused,
 * because that value is mintable by whoever runs the command.
 *
 * So instead of naming a session, a fixture names the *task label* it wants and lets the adapter
 * derive the id the way a real host does. Two consequences a caller must respect:
 *
 *  1. The session id env var has to be ABSENT, not merely overridden. `resolveAdapterOwnerSession`
 *     short-circuits on it before the adapter branch is ever reached, so leaving a stale value in
 *     the inherited environment silently downgrades the session back to `explicit-env`.
 *  2. The derived id depends on `projectRoot`, so it cannot be compared against a hardcoded
 *     literal. Use `adapterSessionId(root, task, agent)` to recompute the value a fixture expects.
 */

import { realpathSync } from 'node:fs';
import { deriveAdapterOwnerSessionId } from '../core/owner-session-adapters.js';

export const ADAPTER_SESSION_PROVIDER = 'claude-code' as const;

/**
 * Environment fragment that makes the adapter derive a `host-adapter` session.
 *
 * Both brand spellings of the session id key are explicitly set to `undefined` so that spreading
 * this over an inherited `process.env` REMOVES them rather than leaving the caller's value in
 * place. `execFileSync` drops `undefined` entries, and the in-process helper deletes them.
 */
export function adapterSessionEnv(task: string, agent: string): Record<string, string | undefined> {
  return {
    PROOF_OR_STOP_SESSION_ID: undefined,
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: ADAPTER_SESSION_PROVIDER,
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: task,
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: agent,
  };
}

/**
 * The session id the adapter will derive for `task` + `agent` under `root`.
 *
 * `root` is realpath-resolved because session resolution derives from `git rev-parse
 * --show-toplevel`, which reports the real path; on macOS a `mkdtemp` fixture root under
 * `/var/folders/...` is a symlink to `/private/var/folders/...` and the two would not agree.
 */
export function adapterSessionId(root: string, task: string, agent: string): string {
  let resolved = root;
  try { resolved = realpathSync(root); } catch { /* keep the caller path */ }
  return deriveAdapterOwnerSessionId(resolved, ADAPTER_SESSION_PROVIDER, task, agent);
}

/**
 * Apply `adapterSessionEnv` to `process.env` for the duration of `fn`, then restore.
 *
 * Used by fixtures that drive handlers in-process rather than through a spawned CLI. The caller
 * is responsible for resetting any cached session identity around the call.
 */
export function withAdapterSessionEnv<T>(task: string, agent: string, fn: () => T): T {
  const fragment = adapterSessionEnv(task, agent);
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(fragment)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); }
  finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
