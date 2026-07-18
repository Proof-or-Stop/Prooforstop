import { createHash } from 'node:crypto';
import { readOrCreateOwnerSessionToken } from './owner-session-token-store.js';

export type OwnerSessionHostProvider =
  | 'codex'
  | 'claude-code'
  | 'antigravity'
  | 'fake'
  | 'unknown';

export type AdapterOwnerSessionSource = 'explicit-env' | 'host-adapter' | 'generated-token';

export interface OwnerSessionEnv {
  [key: string]: string | undefined;
  LATTICE_SESSION_ID?: string | undefined;
  LATTICE_ACTIVITY_SOURCE?: string | undefined;
  LATTICE_ACTIVITY_SESSION?: string | undefined;
  LATTICE_AGENT?: string | undefined;
  LATTICE_OWNER_SESSION_ADAPTER_PROVIDER?: string | undefined;
  LATTICE_OWNER_SESSION_ADAPTER_SESSION?: string | undefined;
  LATTICE_OWNER_SESSION_ADAPTER_TASK?: string | undefined;
  LATTICE_OWNER_SESSION_ADAPTER_AGENT?: string | undefined;
  LATTICE_OWNER_SESSION_ADAPTER_ROLE?: string | undefined;
  LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY?: string | undefined;
  LATTICE_OWNER_SESSION_ADAPTER_GENERATED?: string | undefined;
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
  if (normalized === 'claude' || normalized === 'claude-code' || normalized === 'claude_code') return 'claude-code';
  if (normalized === 'codex') return 'codex';
  if (normalized === 'antigravity' || normalized === 'agy') return 'antigravity';
  if (normalized === 'fake') return 'fake';
  return null;
}

function detectProvider(env: OwnerSessionEnv): OwnerSessionHostProvider | null {
  return normalizeProvider(env.LATTICE_OWNER_SESSION_ADAPTER_PROVIDER)
    ?? normalizeProvider(env.LATTICE_ACTIVITY_SOURCE)
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
    return trimToNull(env.LATTICE_OWNER_SESSION_ADAPTER_TASK)
      ?? trimToNull(env.CODEX_THREAD_ID)
      ?? trimToNull(env.LATTICE_ACTIVITY_SESSION)
      ?? trimToNull(env.CODEX_SESSION_ID)
      ?? trimToNull(env.OPENAI_SESSION_ID)
      ?? trimToNull(env.TERM_SESSION_ID);
  }
  if (provider === 'antigravity') {
    return trimToNull(env.LATTICE_ACTIVITY_SESSION)
      ?? trimToNull(env.ANTIGRAVITY_SESSION_ID)
      ?? trimToNull(env.AGY_SESSION_ID);
  }
  if (provider === 'fake') {
    return trimToNull(env.LATTICE_ACTIVITY_SESSION);
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
  const canonical = trimToNull(env.LATTICE_SESSION_ID);
  if (canonical !== null) {
    return {
      sessionId: canonical,
      sessionSource: 'explicit-env',
      hostProvider: detectProvider(env) ?? undefined,
    };
  }

  const provider = detectProvider(env);
  if (provider === null) return null;

  const canonicalTaskIdentity = trimToNull(env.LATTICE_OWNER_SESSION_ADAPTER_TASK);
  const nativeTask = nativeTaskIdentity(env, provider);
  const taskIdentity = canonicalTaskIdentity ?? nativeTask;
  const agentIdentity = trimToNull(env.LATTICE_OWNER_SESSION_ADAPTER_AGENT);
  const roleIdentity = trimToNull(env.LATTICE_OWNER_SESSION_ADAPTER_ROLE);
  if (agentIdentity !== null && roleIdentity !== null && agentIdentity !== roleIdentity) return null;
  const agentOrRoleIdentity = agentIdentity
    ?? roleIdentity
    ?? trimToNull(env.LATTICE_AGENT)
    ?? (canonicalTaskIdentity === null && nativeTask !== null ? 'main' : null);
  if (taskIdentity === null || agentOrRoleIdentity === null) return null;

  const boundary = trimToNull(env.LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY);
  const generatedRequested = ['1', 'true'].includes(
    trimToNull(env.LATTICE_OWNER_SESSION_ADAPTER_GENERATED)?.toLowerCase() ?? '',
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
