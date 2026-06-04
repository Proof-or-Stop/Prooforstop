/**
 * @task B-6bfd
 * @checklist CHK-004
 * @title Koala-managed guarded session projection
 * @type feature
 * @priority high
 * @description
 *   Pure logic for the guard session projection (no I/O). A guard session is a
 *   story-scoped scope-protection projection layered on top of the existing
 *   scope contract; it is NOT a competing session truth source and does NOT
 *   replace the story owner lease, which stays authoritative for writes.
 *
 *   Provider capability:
 *     - A provider whose runtime supports pre-tool (PreToolUse-style) hooks can
 *       block forbidden writes before they happen → guardMode 'native-pretool'.
 *     - Any other provider can only be watched after the fact → guardMode
 *       'watcher-fallback'. We never pretend pre-tool blocking exists for a
 *       provider that cannot do it.
 *
 *   Violation detection is mode-independent: starting a guard session escalates
 *   protection, so guard_session_check evaluates the diff against an
 *   enforce-equivalent view of the contract and records every unacknowledged
 *   forbidden write. The lifecycle gate can then block on those violations.
 * @changes
 *   - [CHK-004] Add the guard session projection (pure logic, no I/O) layered on the scope contract without replacing the story owner lease
 *   - [CHK-004] Derive guardMode 'active' vs 'watcher-fallback' from provider pre-tool hook capability
 *   - [CHK-004] Detect unacknowledged forbidden writes via an enforce-equivalent contract view for the lifecycle gate
 */
import { createHash } from 'node:crypto';
import type {
  GuardSessionData,
  GuardSessionMode,
  GuardSessionViolation,
  ScopeContractData,
  ScopeDiffPack,
  ScopeViolation,
} from './types.js';
import { checkScopeContract } from './scope-contract.js';
import { checkSemanticScope } from './semantic-scope-gate.js';

/**
 * Providers whose agent runtime CAN expose a native PreToolUse hook for
 * pre-write interception. Being in this set does NOT mean the hook is currently
 * installed — that requires nativeHookVerified=true in resolveGuardMode context.
 * Matched case-insensitively after trim; common aliases included.
 */
export const GUARD_NATIVE_PRETOOL_PROVIDERS: ReadonlySet<string> = new Set([
  'claude',
  'claude-code',
  'claude_code',
  'claudecode',
  'codex',
  'openai-codex',
  'openai_codex',
]);

/**
 * Providers that support wrapped-preapply mode when invoked through Lattice
 * dispatch/pre-apply flow. Without dispatch context they fall back to
 * watcher-fallback — never pretend pre-write interception exists without it.
 */
export const GUARD_WRAPPED_PREAPPLY_PROVIDERS: ReadonlySet<string> = new Set([
  'codex',
  'gemini',
]);

/** @deprecated Use GUARD_NATIVE_PRETOOL_PROVIDERS. */
export const GUARD_PRELAUNCH_PROVIDERS: ReadonlySet<string> = GUARD_NATIVE_PRETOOL_PROVIDERS;

/** Normalize a provider string for capability lookup. */
export function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

/** @deprecated Use resolveGuardMode with context. True only when provider CAN support native hook. */
export function providerSupportsPreToolBlocking(provider: string): boolean {
  return GUARD_NATIVE_PRETOOL_PROVIDERS.has(normalizeProvider(provider));
}

/**
 * Context for resolving the guard mode of a provider invocation.
 *
 * - nativeHookVerified: true when a PreToolUse hook is confirmed installed and
 *   active in the host session (e.g. Claude Code .claude/settings.json or
 *   Codex .codex/hooks.json wires prewrite_guard_check). Without this, native
 *   hook-capable hosts fall back to watcher-fallback unless another guarded
 *   context such as wrapped-preapply applies.
 * - viaDispatch: true when Codex or Gemini is running through Lattice
 *   dispatch/pre-apply flow, enabling wrapped-preapply mode.
 *   Without this, those providers fall back to watcher-fallback.
 */
export interface GuardModeContext {
  nativeHookVerified?: boolean;
  viaDispatch?: boolean;
}

/**
 * Resolve the guard capability mode for a provider and invocation context.
 *
 * Truth table:
 * - Claude Code + nativeHookVerified=true  → 'native-pretool'
 * - Claude Code + nativeHookVerified≠true  → 'watcher-fallback'
 * - Codex + nativeHookVerified=true        → 'native-pretool'
 * - Codex/Gemini + viaDispatch=true        → 'wrapped-preapply'
 * - Codex/Gemini + no verified context     → 'watcher-fallback'
 * - fake / other                           → 'watcher-fallback'
 *
 * Never returns 'active' for new sessions — 'active' is a legacy alias kept
 * only for backwards compat when reading stored GuardSessionData.
 */
export function resolveGuardMode(provider: string, context: GuardModeContext = {}): GuardSessionMode {
  const normalized = normalizeProvider(provider);
  if (GUARD_NATIVE_PRETOOL_PROVIDERS.has(normalized) && context.nativeHookVerified === true) {
    return 'native-pretool';
  }
  if (GUARD_WRAPPED_PREAPPLY_PROVIDERS.has(normalized)) {
    return context.viaDispatch === true ? 'wrapped-preapply' : 'watcher-fallback';
  }
  return 'watcher-fallback';
}

/**
 * Return a human-readable label for a guard mode, normalizing the legacy
 * 'active' alias to 'native-pretool' for display purposes.
 */
export function guardModeLabel(mode: GuardSessionMode): string {
  if (mode === 'active') return 'native-pretool (legacy)';
  return mode;
}

/**
 * Stable hash over a scope contract's scope-defining fields (not timestamps or
 * runtime acknowledgements), used to bind a guard session to the contract it
 * protects. Changing any allow/deny/protect rule changes the hash.
 */
export function digestScopeContract(contract: ScopeContractData): string {
  return createHash('sha256').update(JSON.stringify({
    mode: contract.mode,
    allowedModify: contract.allowedModify,
    allowedCreate: contract.allowedCreate,
    allowedTest: contract.allowedTest,
    protectedFiles: contract.protectedFiles,
    explicitExcludes: contract.explicitExcludes,
    fileRules: contract.fileRules ?? [],
    protectedAnchors: contract.protectedAnchors ?? [],
  })).digest('hex');
}

/**
 * Build a fresh guard session projection. Starting (or restarting) a guard
 * session resets startedAt + violations: a started session always begins in the
 * 'active' status with no recorded violations.
 */
export function buildGuardSession(args: {
  storyId: string;
  provider: string;
  scopeContractHash?: string;
  now?: string;
  context?: GuardModeContext;
}): GuardSessionData {
  const now = args.now ?? new Date().toISOString();
  const provider = args.provider.trim();
  return {
    storyId: args.storyId,
    provider,
    guardMode: resolveGuardMode(provider, args.context ?? {}),
    status: 'active',
    ...(args.scopeContractHash ? { scopeContractHash: args.scopeContractHash } : {}),
    startedAt: now,
    updatedAt: now,
    violations: [],
  };
}

/**
 * Detect forbidden writes for a guard session by checking the diff pack (plus
 * any simulated writes) against an enforce-equivalent view of the contract.
 *
 * Mode coercion: a guard session escalates protection, so detection is
 * mode-independent — even a shadow/local contract surfaces every unacknowledged
 * forbidden write here. Acknowledged violations are NOT reported (they are an
 * explicit, reviewed scope expansion).
 *
 * simulatedWrites lets a caller (tests, dry-run) inject paths as if they had
 * been written, so a forbidden write can be recorded as a guard violation
 * without actually touching the file.
 */
export function detectGuardViolations(
  contract: ScopeContractData,
  diffPack: ScopeDiffPack,
  simulatedWrites: readonly string[] = [],
  now: string = new Date().toISOString(),
): GuardSessionViolation[] {
  const enforceContract: ScopeContractData = contract.mode === 'enforce'
    ? contract
    : { ...contract, mode: 'enforce' };

  const simulated = simulatedWrites
    .map((p) => (typeof p === 'string' ? p.trim().replace(/\\/g, '/') : ''))
    .filter((p) => p.length > 0);
  const simulatedSet = new Set(simulated);
  const changedFiles = [...new Set([...diffPack.changedFiles, ...simulated])].sort();

  const out: GuardSessionViolation[] = [];
  const seen = new Set<string>();
  const push = (v: ScopeViolation): void => {
    if (v.acknowledged) return;
    const key = `${v.path}::${v.rule}::${v.anchor ?? ''}::${v.hunkDigest ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      path: v.path,
      rule: v.rule,
      detectedAt: now,
      ...(v.anchor ? { anchor: v.anchor } : {}),
      ...(v.hunkDigest ? { hunkDigest: v.hunkDigest } : {}),
      ...(simulatedSet.has(v.path) ? { simulated: true } : {}),
    });
  };

  for (const v of checkScopeContract(enforceContract, changedFiles).violations) push(v);
  for (const v of checkSemanticScope(enforceContract, diffPack).violations) push(v);
  return out;
}

/**
 * Apply a fresh detection result to a guard session. Violations are OVERWRITTEN
 * (not appended) so re-checking a now-clean diff clears stale violations and
 * returns the session to 'active'. status follows the current detection.
 */
export function applyGuardCheck(
  session: GuardSessionData,
  violations: readonly GuardSessionViolation[],
  now: string = new Date().toISOString(),
  scopeContractHash?: string,
): GuardSessionData {
  return {
    ...session,
    status: violations.length > 0 ? 'violations_detected' : 'active',
    violations: [...violations],
    updatedAt: now,
    ...(scopeContractHash ? { scopeContractHash } : {}),
  };
}

/**
 * Whether a guard session currently blocks lifecycle progression: a non-stopped
 * session with at least one recorded violation. Absent session → never blocks
 * (backward compatible for stories that never started a guard session).
 */
export function guardSessionHasBlockingViolations(
  session: GuardSessionData | null | undefined,
): boolean {
  return !!session && session.status !== 'stopped' && session.violations.length > 0;
}

export type GuardSessionStateLabel = 'native-pretool' | 'wrapped-preapply' | 'watcher-fallback' | 'inactive' | 'violations detected';

/**
 * The single-line state label rendered under the story scope protection block.
 * Violations take priority over the capability mode; a stopped or absent session
 * reads as 'inactive'. The legacy 'active' mode is normalized to 'native-pretool'
 * for display to avoid overclaiming.
 */
export function guardSessionStateLabel(
  session: GuardSessionData | null | undefined,
): GuardSessionStateLabel {
  if (!session) return 'inactive';
  if (session.status === 'violations_detected' || session.violations.length > 0) {
    return 'violations detected';
  }
  if (session.status === 'stopped') return 'inactive';
  const mode = session.guardMode;
  if (mode === 'native-pretool' || mode === 'active') return 'native-pretool';
  if (mode === 'wrapped-preapply') return 'wrapped-preapply';
  return 'watcher-fallback';
}

/** session_brief line: `guard session: <label>`. */
export function renderGuardSessionLine(
  session: GuardSessionData | null | undefined,
): string {
  return `guard session: ${guardSessionStateLabel(session)}`;
}

/** Multi-line render of a guard session for status / start / check command output. */
export function renderGuardSession(session: GuardSessionData | null | undefined): string {
  if (!session) {
    return [
      'Guard session: inactive',
      'No guard session is running. Use guard_session_start to begin scope-guarded protection.',
    ].join('\n');
  }
  const displayMode = guardModeLabel(session.guardMode);
  const lines = [
    renderGuardSessionLine(session),
    `Story: ${session.storyId}`,
    `provider: ${session.provider}`,
    `guardMode: ${displayMode}`,
    `status: ${session.status}`,
    `scopeContractHash: ${session.scopeContractHash ?? '(none)'}`,
    `startedAt: ${session.startedAt}`,
    `updatedAt: ${session.updatedAt}`,
    `violations: ${session.violations.length}`,
  ];
  for (const v of session.violations) {
    const anchor = v.anchor ? ` anchor=${v.anchor}` : '';
    const digest = v.hunkDigest ? ` hunkDigest=${v.hunkDigest}` : '';
    const sim = v.simulated ? ' [simulated]' : '';
    lines.push(`  ${v.rule.toUpperCase()}: ${v.path}${anchor}${digest}${sim}`);
  }
  if (session.guardMode === 'watcher-fallback') {
    lines.push(
      'Note: provider has no pre-write interception; forbidden writes are detected after the fact (watcher-fallback).',
    );
  } else if (session.guardMode === 'wrapped-preapply') {
    lines.push(
      'Note: wrapped-preapply mode — pre-write checks run through the Lattice dispatch/pre-apply flow.',
    );
  } else if (session.guardMode === 'native-pretool' || session.guardMode === 'active') {
    lines.push(
      'Note: native-pretool mode — PreToolUse hook is installed; forbidden writes are intercepted before they land.',
    );
  }
  return lines.join('\n');
}

/**
 * Produce a one-line guard mode summary suitable for doctor / status diagnostics.
 * Avoids overclaiming by explicitly stating what the mode does NOT guarantee.
 */
export function renderGuardModeDiagnostic(mode: GuardSessionMode): string {
  if (mode === 'native-pretool' || mode === 'active') {
    return 'native-pretool: Claude Code PreToolUse hook verified; writes intercepted before landing.';
  }
  if (mode === 'wrapped-preapply') {
    return 'wrapped-preapply: running via Lattice dispatch/pre-apply; scope checked before each write.';
  }
  return 'watcher-fallback: no pre-write interception; violations detected after the fact only.';
}
