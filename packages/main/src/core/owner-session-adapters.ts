import { createHash } from 'node:crypto';
import { readOrCreateOwnerSessionToken } from './owner-session-token-store.js';
import { readBrandEnv } from './brand-env.js';

export type OwnerSessionHostProvider =
  | 'codex'
  | 'claude-code'
  | 'antigravity'
  | 'fake'
  | 'unknown';

export type AdapterOwnerSessionSource = 'explicit-env' | 'host-adapter' | 'generated-token';

/**
 * Both brand spellings are declared. Every READ of these keys goes through
 * `readBrandEnv`, which prefers the canonical `PROOF_OR_STOP_*` name and falls back
 * to the deprecated `PROOF_OR_STOP_*` one, so the deprecated block below is not dead
 * weight: it documents the names a teammate's pre-rename branch may still export and
 * keeps them type-visible rather than only reachable via the index signature.
 */
export interface OwnerSessionEnv {
  [key: string]: string | undefined;
  PROOF_OR_STOP_SESSION_ID?: string | undefined;
  PROOF_OR_STOP_ACTIVITY_SOURCE?: string | undefined;
  PROOF_OR_STOP_ACTIVITY_SESSION?: string | undefined;
  PROOF_OR_STOP_AGENT?: string | undefined;
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER?: string | undefined;
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_SESSION?: string | undefined;
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK?: string | undefined;
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT?: string | undefined;
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_ROLE?: string | undefined;
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_BOUNDARY?: string | undefined;
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_GENERATED?: string | undefined;
  CLAUDE_CODE_SESSION_ID?: string | undefined;
  CLAUDE_SESSION_ID?: string | undefined;
  CODEX_SESSION_ID?: string | undefined;
  CODEX_THREAD_ID?: string | undefined;
  OPENAI_SESSION_ID?: string | undefined;
  TERM_SESSION_ID?: string | undefined;
  ANTIGRAVITY_SESSION_ID?: string | undefined;
  AGY_SESSION_ID?: string | undefined;
}

export interface AdapterSessionIdentity {
  sessionId: string;
  sessionSource: AdapterOwnerSessionSource;
  hostProvider?: OwnerSessionHostProvider;
  nativeSessionRef?: string;
}

export interface AdapterResolveOptions {
  projectRoot: string;
  now?: () => string;
}

function trimToNull(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeProvider(value: string | undefined): OwnerSessionHostProvider | null {
  const normalized = trimToNull(value)?.toLowerCase();
  if (!normalized) return null;
  if (
    normalized === 'claude'
    || normalized === 'claude-code'
    || normalized === 'claude_code'
    || normalized === 'claude-cli'
    || normalized === 'claude_cli'
  ) return 'claude-code';
  if (normalized === 'codex' || normalized === 'codex-cli' || normalized === 'codex_cli') return 'codex';
  if (normalized === 'antigravity' || normalized === 'agy') return 'antigravity';
  if (normalized === 'fake') return 'fake';
  if (normalized === 'unknown') return 'unknown';
  return null;
}

function detectProvider(env: OwnerSessionEnv): OwnerSessionHostProvider | null {
  const explicitProvider = trimToNull(readBrandEnv('OWNER_SESSION_ADAPTER_PROVIDER', env));
  if (explicitProvider !== null) {
    return normalizeProvider(explicitProvider) ?? 'unknown';
  }
  return normalizeProvider(readBrandEnv('ACTIVITY_SOURCE', env))
    ?? (trimToNull(env.CLAUDE_CODE_SESSION_ID) || trimToNull(env.CLAUDE_SESSION_ID) ? 'claude-code' : null)
    ?? (trimToNull(env.CODEX_THREAD_ID) || trimToNull(env.CODEX_SESSION_ID) || trimToNull(env.OPENAI_SESSION_ID) ? 'codex' : null)
    ?? (trimToNull(env.ANTIGRAVITY_SESSION_ID) || trimToNull(env.AGY_SESSION_ID) ? 'antigravity' : null);
}

function nativeTaskIdentity(
  env: OwnerSessionEnv,
  provider: OwnerSessionHostProvider,
): string | null {
  if (provider === 'claude-code') {
    return trimToNull(env.CLAUDE_CODE_SESSION_ID)
      ?? trimToNull(env.CLAUDE_SESSION_ID);
  }
  if (provider === 'codex') {
    return trimToNull(readBrandEnv('OWNER_SESSION_ADAPTER_TASK', env))
      ?? trimToNull(env.CODEX_THREAD_ID)
      ?? trimToNull(readBrandEnv('ACTIVITY_SESSION', env))
      ?? trimToNull(env.CODEX_SESSION_ID)
      ?? trimToNull(env.OPENAI_SESSION_ID)
      ?? trimToNull(env.TERM_SESSION_ID);
  }
  if (provider === 'antigravity') {
    return trimToNull(readBrandEnv('ACTIVITY_SESSION', env))
      ?? trimToNull(env.ANTIGRAVITY_SESSION_ID)
      ?? trimToNull(env.AGY_SESSION_ID);
  }
  if (provider === 'fake') {
    return trimToNull(readBrandEnv('ACTIVITY_SESSION', env));
  }
  return null;
}

export function deriveAdapterOwnerSessionId(
  projectRoot: string,
  provider: OwnerSessionHostProvider,
  taskIdentity: string,
  agentOrRoleIdentity: string,
): string {
  const digest = createHash('sha256')
    .update([
      'lattice.owner-session.host-adapter.v2',
      projectRoot,
      provider,
      taskIdentity,
      agentOrRoleIdentity,
    ].join('\0'))
    .digest('hex');
  return `sess-${digest.slice(0, 32)}`;
}

export function resolveAdapterOwnerSession(
  env: OwnerSessionEnv,
  options: AdapterResolveOptions,
): AdapterSessionIdentity | null {
  const canonical = trimToNull(readBrandEnv('SESSION_ID', env));
  if (canonical !== null) {
    const provider = detectProvider(env) ?? undefined;
    const nativeTask = provider ? nativeTaskIdentity(env, provider) : null;
    return {
      sessionId: canonical,
      sessionSource: 'explicit-env',
      hostProvider: provider,
      ...(provider && nativeTask ? { nativeSessionRef: `${provider}:validated-composite` } : {}),
    };
  }

  const provider = detectProvider(env);
  if (provider === null) return null;

  const canonicalTaskIdentity = trimToNull(readBrandEnv('OWNER_SESSION_ADAPTER_TASK', env));
  const nativeTask = nativeTaskIdentity(env, provider);
  const taskIdentity = canonicalTaskIdentity ?? nativeTask;
  const agentIdentity = trimToNull(readBrandEnv('OWNER_SESSION_ADAPTER_AGENT', env));
  const roleIdentity = trimToNull(readBrandEnv('OWNER_SESSION_ADAPTER_ROLE', env));
  if (agentIdentity !== null && roleIdentity !== null && agentIdentity !== roleIdentity) return null;
  const agentOrRoleIdentity = agentIdentity
    ?? roleIdentity
    ?? trimToNull(readBrandEnv('AGENT', env))
    ?? (canonicalTaskIdentity === null && nativeTask !== null ? 'main' : null);
  if (taskIdentity === null || agentOrRoleIdentity === null) return null;

  const boundary = trimToNull(readBrandEnv('OWNER_SESSION_ADAPTER_BOUNDARY', env));
  const generatedRequested = ['1', 'true'].includes(
    trimToNull(readBrandEnv('OWNER_SESSION_ADAPTER_GENERATED', env))?.toLowerCase() ?? '',
  );
  if (generatedRequested) {
    if (boundary === null) return null;
    return {
      sessionId: readOrCreateOwnerSessionToken(
        options.projectRoot,
        provider,
        taskIdentity,
        agentOrRoleIdentity,
        boundary,
        options.now,
      ),
      sessionSource: 'generated-token',
      hostProvider: provider,
      nativeSessionRef: `${provider}:generated-composite`,
    };
  }

  return {
    sessionId: deriveAdapterOwnerSessionId(
      options.projectRoot,
      provider,
      taskIdentity,
      agentOrRoleIdentity,
    ),
    sessionSource: 'host-adapter',
    hostProvider: provider,
    nativeSessionRef: `${provider}:validated-composite`,
  };
}
