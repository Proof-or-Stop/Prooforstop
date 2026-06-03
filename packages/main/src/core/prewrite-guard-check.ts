/**
 * Pre-write guard check: evaluate a pending tool call (Edit/Write/MultiEdit)
 * against the story scope contract and decide whether to deny the write
 * before it happens.
 *
 * This is the pre-tool-use blocking half of the guard session projection:
 *   active mode   → deny forbidden writes before they land (pre-tool hook)
 *   watcher-fallback → cannot block pre-write; violations are detected
 *                      post-write by guard_session_check instead
 *
 * See core/guard-session.ts for the guard session projection data model and
 * guard_session_check for post-write violation detection.
 */

import type { ScopeContractData, GuardSessionData } from './types.js';
import { checkScopeContract } from './scope-contract.js';

/** Tool names that produce file writes in Claude Code. */
export type PrewriteToolName = 'Edit' | 'Write' | 'MultiEdit';

/**
 * Normalized tool input for a write operation.
 * - Edit and Write each target a single file_path.
 * - MultiEdit carries an edits array where each entry may target a distinct file.
 */
export interface PrewriteToolInput {
  tool: PrewriteToolName;
  /** Target path for Edit and Write calls. */
  file_path?: string;
  /** Per-edit path list for MultiEdit calls (each edit may touch a different file). */
  edits?: Array<{ file_path: string }>;
}

export interface PrewriteGuardResult {
  deny: boolean;
  /** Human-readable denial reason (only set when deny: true). */
  reason?: string;
  /** Scope rule that triggered the denial. */
  rule?: 'protected' | 'out_of_scope' | 'no_session' | 'no_contract' | 'watcher_fallback';
  /** First violating path (only set when deny: true). */
  path?: string;
}

/** Extract target file paths from a pre-write tool input. */
export function extractPrewritePaths(input: PrewriteToolInput): string[] {
  if (input.tool === 'MultiEdit') {
    return (input.edits ?? [])
      .map(e => e.file_path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  }
  return input.file_path ? [input.file_path] : [];
}

/**
 * Pre-write guard check.
 *
 * Returns deny: true only when ALL of these hold:
 *   1. A guard session is running (not stopped)
 *   2. A scope contract is configured
 *   3. The provider supports pre-tool blocking (guardMode === 'active')
 *   4. At least one target path violates the contract (protected or out_of_scope)
 *
 * Deny is always based on an enforce-equivalent contract view: the guard session
 * escalates protection so even shadow/local contracts surface violations here.
 *
 * Protected files (contract.protectedFiles) are always denied regardless of any
 * acknowledgement; out-of-scope files that have been explicitly acknowledged are
 * not denied (the acknowledgement was a deliberate, reviewed scope expansion).
 */
export function prewriteGuardCheck(
  contract: ScopeContractData | null,
  session: GuardSessionData | null,
  toolInput: PrewriteToolInput,
): PrewriteGuardResult {
  if (!session || session.status === 'stopped') {
    return { deny: false, rule: 'no_session' };
  }
  if (!contract) {
    return { deny: false, rule: 'no_contract' };
  }
  if (session.guardMode === 'watcher-fallback') {
    // Watcher-fallback providers cannot intercept writes pre-tool; violations
    // are recorded post-write by guard_session_check. Do not deny.
    return { deny: false, rule: 'watcher_fallback' };
  }

  const paths = extractPrewritePaths(toolInput);
  if (paths.length === 0) return { deny: false };

  // Always evaluate against an enforce-equivalent view: the guard session
  // escalates protection so shadow/local contracts still surface violations.
  const enforceContract: ScopeContractData =
    contract.mode === 'enforce' ? contract : { ...contract, mode: 'enforce' };

  const result = checkScopeContract(enforceContract, paths);

  // Only unacknowledged violations block. Protected files are always
  // unacknowledged (checkScopeContract never sets acknowledged=true for them).
  const blocker = result.violations.find(v => !v.acknowledged);

  if (blocker) {
    const isProtected = blocker.rule === 'protected';
    return {
      deny: true,
      reason: `${isProtected ? 'Protected file' : 'Out-of-scope file'}: ${blocker.path}`,
      rule: isProtected ? 'protected' : 'out_of_scope',
      path: blocker.path,
    };
  }

  return { deny: false };
}
