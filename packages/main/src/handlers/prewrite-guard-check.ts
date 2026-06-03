/**
 * @task B-6bfd
 * @checklist CHK-005
 * @title prewrite_guard_check — pre-write scope gate for Claude Code PreToolUse hooks
 * @type feature
 * @priority high
 * @description
 *   Called by .claude/hooks/scope-pretool.cjs before Edit/Write/MultiEdit/NotebookEdit
 *   tools execute. Checks whether the target path(s) fall within scope for the current
 *   story's active guard session + scope contract. Silently passes when no guard session
 *   or contract is active (backward compatible with projects that haven't opted in).
 *
 *   Pass conditions (exit 0):
 *   - No active story on the current branch
 *   - No active guard session for the story (or session is stopped)
 *   - No scope contract configured
 *   - Target paths are in scope (or all acknowledged)
 *
 *   Block condition (throws → exit 1 from CLI → hook exits 2):
 *   - Guard session is active, scope contract exists, and one or more paths
 *     violate the enforce-equivalent contract view without acknowledgement.
 *
 *   Note: guard session escalates protection to enforce-equivalent regardless of
 *   the contract's stated mode (same coercion as detectGuardViolations).
 * @changes
 *   - [CHK-005] Add prewrite_guard_check handler for Claude Code PreToolUse blocking
 */

import { execSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import type { HandlerContext } from './context.js';
import { checkScopeContract } from '../core/scope-contract.js';
import type { ScopeContractData } from '../core/types.js';

function detectStoryIdFromBranch(root: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const m = branch.match(/^story\/([\w-]+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Extract target file paths from a Claude Code tool input JSON.
 * Only handles write-capable tools; returns empty array for others.
 */
export function extractPathsFromToolInput(toolName: string, toolInputJson: string): string[] {
  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(toolInputJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    input = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return typeof input.file_path === 'string' ? [input.file_path] : [];
    case 'NotebookEdit':
      return typeof input.notebook_path === 'string' ? [input.notebook_path] : [];
    default:
      return [];
  }
}

/**
 * Normalize raw paths (possibly absolute) to project-relative forward-slash paths.
 * Paths outside the project root are dropped.
 */
export function normalizeToRelativePaths(root: string, paths: readonly string[]): string[] {
  return paths
    .map(p => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      if (isAbsolute(p)) {
        const rel = relative(root, p).replace(/\\/g, '/');
        if (rel.startsWith('../')) return '';
        return rel;
      }
      return trimmed.replace(/\\/g, '/');
    })
    .filter((p): p is string => p.length > 0);
}

export function createPrewriteGuardCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;

  return {
    prewrite_guard_check(args: {
      provider: string;
      toolName: string;
      toolInputJson: string;
      storyId?: string;
      json?: boolean;
    }): string {
      const provider = (args.provider ?? '').trim();
      if (!provider) throw new Error('provider is required');
      const toolName = (args.toolName ?? '').trim();
      if (!toolName) throw new Error('toolName is required');
      if (args.toolInputJson === undefined || args.toolInputJson === null) {
        throw new Error('toolInputJson is required');
      }

      const pass = (reason: string): string => {
        if (args.json) return JSON.stringify({ status: 'pass', reason });
        return `prewrite_guard_check: pass (${reason})`;
      };

      // Detect story from git branch when not provided
      const storyId = (args.storyId ?? '').trim() || detectStoryIdFromBranch(root);
      if (!storyId) return pass('no active story on this branch');

      // Guard session must be active
      let session;
      try {
        session = store.readGuardSession(storyId);
      } catch {
        return pass('could not read guard session');
      }
      if (!session || session.status === 'stopped') {
        return pass('no active guard session');
      }

      // Scope contract must exist
      let contract: ScopeContractData | null;
      try {
        contract = store.readScopeContract(storyId);
      } catch {
        return pass('could not read scope contract');
      }
      if (!contract) return pass('no scope contract configured');

      // Extract target file paths from tool input
      const rawPaths = extractPathsFromToolInput(toolName, args.toolInputJson);
      if (rawPaths.length === 0) return pass('no file paths extracted from tool input');

      const relPaths = normalizeToRelativePaths(root, rawPaths);
      if (relPaths.length === 0) return pass('paths are outside project root');

      // Guard session escalates protection: always check as enforce mode
      const enforceContract: ScopeContractData = contract.mode === 'enforce'
        ? contract
        : { ...contract, mode: 'enforce' };
      const result = checkScopeContract(enforceContract, relPaths);
      const blockingViolations = result.violations.filter(v => !v.acknowledged);

      if (blockingViolations.length > 0) {
        const lines = [
          `prewrite_guard_check: BLOCKED — ${blockingViolations.length} out-of-scope write(s) for story ${storyId}`,
          '',
          ...blockingViolations.map(v => `  ${v.rule.toUpperCase()}: ${v.path}`),
          '',
          'Resolve: scope_contract_set / scope_contract_acknowledge, or restart the guard session.',
        ];
        throw new Error(lines.join('\n'));
      }

      if (args.json) {
        return JSON.stringify({ status: 'pass', storyId, paths: relPaths, provider, toolName });
      }
      return `prewrite_guard_check: pass (${relPaths.length} path(s) in scope for story ${storyId})`;
    },
  };
}
