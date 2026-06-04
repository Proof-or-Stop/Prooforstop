/**
 * Compatibility adapter for the older prewrite-guard smoke-test interface.
 *
 * The product implementation lives in core/prewrite-guard.ts plus
 * handlers/prewrite-guard.ts. Keep this file thin so tests can express
 * Edit/Write/MultiEdit fixtures without carrying a second policy engine.
 */

import type { GuardSessionData, ScopeContractData } from './types.js';
import {
  runPrewriteGuardCheck,
  type PrewriteGuardResult as CanonicalPrewriteGuardResult,
} from './prewrite-guard.js';

/** Tool names that produce file writes in Claude Code. */
export type PrewriteToolName = 'Edit' | 'Write' | 'MultiEdit';

export interface PrewriteToolInput {
  tool: PrewriteToolName;
  file_path?: string;
  edits?: Array<{ file_path: string }>;
}

export interface PrewriteGuardResult {
  deny: boolean;
  reason?: string;
  rule?: 'protected' | 'out_of_scope' | 'no_session' | 'no_contract' | 'watcher_fallback';
  path?: string;
}

export function extractPrewritePaths(input: PrewriteToolInput): string[] {
  if (input.tool === 'MultiEdit') {
    return (input.edits ?? [])
      .map(e => e.file_path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  }
  return input.file_path ? [input.file_path] : [];
}

function canBlockBeforeWrite(session: GuardSessionData): boolean {
  return session.guardMode === 'native-pretool'
    || session.guardMode === 'wrapped-preapply'
    || session.guardMode === 'active';
}

function adapt(result: CanonicalPrewriteGuardResult): PrewriteGuardResult {
  if (result.verdict !== 'deny') return { deny: false };
  const first = result.violations?.[0];
  const isProtected = first?.rule === 'protected';
  return {
    deny: true,
    reason: first
      ? `${isProtected ? 'Protected file' : 'Out-of-scope file'}: ${first.path}`
      : result.reasons.join('\n'),
    rule: isProtected ? 'protected' : 'out_of_scope',
    path: first?.path,
  };
}

export function prewriteGuardCheck(
  contract: ScopeContractData | null,
  session: GuardSessionData | null,
  toolInput: PrewriteToolInput,
): PrewriteGuardResult {
  if (!session || session.status === 'stopped') return { deny: false, rule: 'no_session' };
  if (!contract) return { deny: false, rule: 'no_contract' };
  if (!canBlockBeforeWrite(session)) return { deny: false, rule: 'watcher_fallback' };

  const enforceContract: ScopeContractData = contract.mode === 'enforce'
    ? contract
    : { ...contract, mode: 'enforce' };
  return adapt(runPrewriteGuardCheck({
    normalizedPaths: extractPrewritePaths(toolInput),
    contract: enforceContract,
    storyId: session.storyId,
  }));
}
