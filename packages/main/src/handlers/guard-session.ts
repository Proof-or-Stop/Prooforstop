/**
 * Guard Session handlers — koala guard_session_start / status / check
 *
 * guard_session_start    — start (or restart) a story-scoped scope-guard session
 *                          projection bound to the current scope contract.
 * guard_session_status   — read the current guard session projection.
 * guard_session_check    — check the current diff (plus optional simulated writes)
 *                          against the guard session scope contract, record any
 *                          forbidden writes as violations, and surface status.
 * The guard session is a scope-protection projection. It does NOT replace the
 * story owner lease (which stays authoritative for writes) and is NOT a
 * competing session truth source.
 */

import type { HandlerContext } from './context.js';
import type { GuardSessionData } from '../core/types.js';
import {
  buildGuardSession,
  detectGuardViolations,
  applyGuardCheck,
  digestScopeContract,
  renderGuardSession,
  resolveGuardMode,
  type GuardModeContext,
} from '../core/guard-session.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';

export function createGuardSessionHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;

  return {
    guard_session_start(args: {
      storyId: string;
      provider: string;
      nativeHookVerified?: boolean;
      viaDispatch?: boolean;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const provider = (args.provider ?? '').trim();
      if (provider.length === 0) throw new Error('provider is required (e.g. claude-code, codex)');
      // ensure story exists (throws if not)
      store.readStory(args.storyId);

      const context: GuardModeContext = {
        nativeHookVerified: args.nativeHookVerified === true,
        viaDispatch: args.viaDispatch === true,
      };
      const contract = store.readScopeContract(args.storyId);
      const scopeContractHash = contract ? digestScopeContract(contract) : undefined;
      const guardMode = resolveGuardMode(provider, context);

      const session = buildGuardSession({
        storyId: args.storyId,
        provider,
        scopeContractHash,
        context,
      });
      store.writeGuardSession(args.storyId, session);

      try {
        store.appendProcessEvent(args.storyId, {
          type: 'guard_session_start',
          provider,
          guardMode,
          nativeHookVerified: context.nativeHookVerified ?? false,
          viaDispatch: context.viaDispatch ?? false,
          scopeContractHash: scopeContractHash ?? null,
        });
      } catch (e) {
        console.warn(`[process-events] guard_session_start append failed for ${args.storyId}:`, (e as Error).message);
      }

      if (args.json) return JSON.stringify(session, null, 2);
      const lines = [renderGuardSession(session)];
      if (!contract) {
        lines.push(
          'Warning: no scope contract configured — guard_session_check cannot detect violations until one exists (scope_contract_set / scope_contract_init_from_plan).',
        );
      }
      return lines.join('\n');
    },

    guard_session_status(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const session = store.readGuardSession(args.storyId);
      if (args.json) return JSON.stringify(session, null, 2);
      return renderGuardSession(session);
    },

    guard_session_check(args: {
      storyId: string;
      simulatedWrites?: string[];
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const session = store.readGuardSession(args.storyId);
      if (!session) {
        throw new Error(
          `Story ${args.storyId} has no guard session. Run guard_session_start first.`,
        );
      }

      const contract = store.readScopeContract(args.storyId);
      if (!contract) {
        // No contract → nothing to check against. Do not fabricate violations.
        const cleared = applyGuardCheck(session, [], new Date().toISOString());
        store.writeGuardSession(args.storyId, cleared);
        if (args.json) return JSON.stringify(cleared, null, 2);
        return [
          renderGuardSession(cleared),
          'No scope contract configured — nothing to check. Configure one with scope_contract_set / scope_contract_init_from_plan.',
        ].join('\n');
      }

      const simulatedWrites = Array.isArray(args.simulatedWrites) ? args.simulatedWrites : [];
      const diffPack = buildScopeDiffPack(root);
      const now = new Date().toISOString();
      const violations = detectGuardViolations(contract, diffPack, simulatedWrites, now);
      const scopeContractHash = digestScopeContract(contract);
      const updated = applyGuardCheck(session, violations, now, scopeContractHash);
      store.writeGuardSession(args.storyId, updated);

      try {
        store.appendProcessEvent(args.storyId, {
          type: 'guard_session_check',
          provider: session.provider,
          guardMode: session.guardMode,
          scopeContractHash,
          violationCount: violations.length,
          simulatedWriteCount: simulatedWrites.length,
          status: updated.status,
        });
      } catch (e) {
        console.warn(`[process-events] guard_session_check append failed for ${args.storyId}:`, (e as Error).message);
      }

      if (args.json) return JSON.stringify(updated, null, 2);
      const lines = [renderGuardSession(updated)];
      if (violations.length > 0) {
        lines.push(
          '',
          `Guard session blocks lifecycle progression until these ${violations.length} forbidden write(s) are removed`,
          'or recorded with scope_contract_acknowledge.',
        );
      }
      return lines.join('\n');
    },
  };
}

/**
 * Re-detect the current guard session state for a story and block lifecycle
 * progression when forbidden writes exist. Returns a status line on pass (or
 * empty string when the story has no guard session — backward compatible).
 *
 * This re-runs detection against the CURRENT diff (never simulated) so the gate
 * decision is never stale, and persists the refreshed projection so session_brief
 * shows the same state. Stories that never started a guard session are unaffected.
 */
export function runGuardSessionGate(
  ctx: HandlerContext,
  storyId: string,
  phase: string,
): string {
  const session = ctx.store.readGuardSession(storyId);
  if (!session || session.status === 'stopped') return '';

  const contract = ctx.store.readScopeContract(storyId);
  if (!contract) return ''; // nothing to check against

  const now = new Date().toISOString();
  const diffPack = buildScopeDiffPack(ctx.root);
  const violations = detectGuardViolations(contract, diffPack, [], now);
  const scopeContractHash = digestScopeContract(contract);
  const updated = applyGuardCheck(session, violations, now, scopeContractHash);
  ctx.store.writeGuardSession(storyId, updated);

  if (violations.length > 0) {
    throw new Error(
      `Cannot enter ${phase}: guard session detected ${violations.length} forbidden write(s)\n\n` +
      renderGuardSession(updated) +
      `\n\n→ 移除 out-of-scope 改动，或用 scope_contract_acknowledge 记录必要扩展后重跑 story_advance --phase=${phase}`,
    );
  }
  const modeLabel = session.guardMode === 'active' ? 'native-pretool' : session.guardMode;
  return `\n\nGuard session: pass (${modeLabel}, 0 violations)`;
}

export type { GuardSessionData };
