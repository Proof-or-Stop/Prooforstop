/**
 * prewrite-guard handler — koala prewrite_guard_check
 *
 * Pre-write scope enforcement command for agent tool hooks.
 *
 * Wires I/O (store reads, path resolution) and delegates verdict computation
 * to the pure logic in core/prewrite-guard.ts.
 *
 * Resolution order:
 *   1. storyId provided  → load that story's scope contract + guard session.
 *   2. storyId absent    → scan all active guard sessions; if exactly one is
 *                          active, use it; fail-closed otherwise.
 *   3. No session found  → allow (no-decision, backward compatible).
 */

import { resolve } from 'node:path';
import type { HandlerContext } from './context.js';
import type { ScopeContractData, GuardSessionData } from '../core/types.js';
import {
  isWriteLikeTool,
  extractPathsFromToolInput,
  normalizeToProjectRoot,
  runPrewriteGuardCheck,
  type PrewriteGuardResult,
} from '../core/prewrite-guard.js';

// ── Active guard session discovery ──

interface ActiveSession {
  storyId: string;
  session: GuardSessionData;
}

function findActiveGuardSessions(
  store: HandlerContext['store'],
): ActiveSession[] {
  const storyIds = store.listStoryIds();
  const active: ActiveSession[] = [];
  for (const storyId of storyIds) {
    // Skip terminal phases — don't even try to read guard session
    let phase: string;
    try {
      const story = store.readStory(storyId);
      phase = story.phase;
    } catch {
      continue;
    }
    if (phase === 'DONE' || phase === 'DISCARDED') continue;

    let session: GuardSessionData | null = null;
    try {
      session = store.readGuardSession(storyId);
    } catch {
      continue;
    }
    if (!session || session.status === 'stopped') continue;
    active.push({ storyId, session });
  }
  return active;
}

// ── Path extraction ──

function resolveTargetPaths(args: {
  toolName: string;
  toolInputJson?: string;
  targetPaths?: string | string[];
  cwd: string;
  projectRoot: string;
}): string[] {
  const { toolName, toolInputJson, targetPaths, cwd, projectRoot } = args;

  const raw: string[] = [];

  // Explicit targetPaths override tool-input extraction
  if (targetPaths !== undefined && targetPaths !== null) {
    const arr = Array.isArray(targetPaths) ? targetPaths : [targetPaths];
    for (const p of arr) {
      if (typeof p === 'string' && p.trim().length > 0) raw.push(p.trim());
    }
  } else if (isWriteLikeTool(toolName) && toolInputJson) {
    raw.push(...extractPathsFromToolInput(toolName, toolInputJson));
  }

  const normalized: string[] = [];
  for (const p of raw) {
    const rel = normalizeToProjectRoot(p, projectRoot, cwd);
    if (rel !== null) normalized.push(rel);
    // Paths that escape the root are silently dropped (not a concern for this tool).
  }
  return normalized;
}

// ── Handler factory ──

export function createPrewriteGuardHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;

  return {
    prewrite_guard_check(args: {
      storyId?: string;
      provider?: string;
      toolName: string;
      toolInputJson?: string;
      targetPaths?: string | string[];
      cwd?: string;
      json?: boolean;
    }): string {
      if (!args.toolName || args.toolName.trim().length === 0) {
        throw new Error('toolName is required');
      }

      const cwd = args.cwd ? resolve(args.cwd) : root;
      const normalizedPaths = resolveTargetPaths({
        toolName: args.toolName,
        toolInputJson: args.toolInputJson,
        targetPaths: args.targetPaths,
        cwd,
        projectRoot: root,
      });

      // ── Resolve story context ──
      let storyId: string | undefined = args.storyId?.trim() || undefined;
      let contract: ScopeContractData | null = null;
      let contractError: string | undefined;
      let resolutionError: string | undefined;

      if (storyId) {
        // Explicit storyId: validate exists, load contract.
        // readScopeContract fails closed on corrupt contracts.
        try {
          store.readStory(storyId); // ensure story exists
        } catch (e) {
          throw new Error(`Story ${storyId} not found: ${(e as Error).message}`);
        }
        try {
          contract = store.readScopeContract(storyId);
        } catch (e) {
          contractError = (e as Error).message;
        }
      } else {
        // Auto-discover from active guard sessions.
        let activeSessions: ActiveSession[];
        try {
          activeSessions = findActiveGuardSessions(store);
        } catch (e) {
          resolutionError = `Failed to scan guard sessions: ${(e as Error).message}`;
          activeSessions = [];
        }

        if (!resolutionError) {
          if (activeSessions.length === 0) {
            // No active guard session → no-decision allow
            // (contract stays null, storyId stays undefined)
          } else if (activeSessions.length === 1) {
            storyId = activeSessions[0].storyId;
            try {
              contract = store.readScopeContract(storyId);
            } catch (e) {
              contractError = (e as Error).message;
            }
          } else {
            // Multiple active guard sessions → fail-closed
            const ids = activeSessions.map(s => s.storyId).join(', ');
            resolutionError = `Ambiguous: ${activeSessions.length} active guard sessions found (${ids}). Provide an explicit storyId.`;
          }
        }
      }

      const result: PrewriteGuardResult = runPrewriteGuardCheck({
        normalizedPaths,
        contract,
        storyId,
        contractError,
        resolutionError,
      });

      if (args.json) return JSON.stringify(result, null, 2);
      return renderPrewriteGuardResult(result);
    },
  };
}

function renderPrewriteGuardResult(result: PrewriteGuardResult): string {
  const lines: string[] = [];
  lines.push(`prewrite_guard_check: ${result.verdict.toUpperCase()}`);
  if (result.storyId) lines.push(`story: ${result.storyId}`);
  if (result.targetPaths.length > 0) {
    lines.push(`paths (${result.targetPaths.length}):`);
    for (const p of result.targetPaths) lines.push(`  ${p}`);
  }
  lines.push('reasons:');
  for (const r of result.reasons) lines.push(`  ${r}`);
  if (result.noDecision) {
    lines.push('note: no guard session — backward-compatible allow (no-decision)');
  }
  return lines.join('\n');
}
