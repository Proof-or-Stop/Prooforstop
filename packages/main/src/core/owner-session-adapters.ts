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
  LATTICE_OWNER_SESSION_ADAPTER_PROVIDER?: string | undefined;
  LATTICE_OWNER_SESSION_ADAPTER_SESSION?: string | undefined;
  LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY?: string | undefined;
  CLAUDE_CODE_SESSION_ID?: string | undefined;
  CLAUDE_SESSION_ID?: string | undefined;
  CODEX_SESSION_ID?: string | undefined;
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
  return 'unknown';
}

function redactRef(provider: OwnerSessionHostProvider, key: string, value: string): string {
  const prefix = value.slice(0, 8);
  return `${provider}:${key}:${prefix}${value.length > prefix.length ? '...' : ''}`;
}

function detectProvider(env: OwnerSessionEnv): OwnerSessionHostProvider | null {
  return normalizeProvider(env.LATTICE_OWNER_SESSION_ADAPTER_PROVIDER)
    ?? normalizeProvider(env.LATTICE_ACTIVITY_SOURCE)
    ?? (trimToNull(env.CLAUDE_CODE_SESSION_ID) || trimToNull(env.CLAUDE_SESSION_ID) ? 'claude-code' : null)
    ?? (trimToNull(env.CODEX_SESSION_ID) || trimToNull(env.OPENAI_SESSION_ID) ? 'codex' : null)
    ?? (trimToNull(env.ANTIGRAVITY_SESSION_ID) || trimToNull(env.AGY_SESSION_ID) ? 'antigravity' : null);
}

function candidate(provider: OwnerSessionHostProvider, key: string, value: string | undefined): AdapterSessionIdentity | null {
  const sessionId = trimToNull(value);
  if (sessionId === null) return null;
  return {
    sessionId,
    sessionSource: 'host-adapter',
    hostProvider: provider,
    nativeSessionRef: redactRef(provider, key, sessionId),
  };
}

function nativeAdapterSession(env: OwnerSessionEnv, provider: OwnerSessionHostProvider): AdapterSessionIdentity | null {
  const explicitAdapterSession = candidate(provider, 'LATTICE_OWNER_SESSION_ADAPTER_SESSION', env.LATTICE_OWNER_SESSION_ADAPTER_SESSION);
  if (explicitAdapterSession) return explicitAdapterSession;

  if (provider === 'claude-code') {
    return candidate(provider, 'CLAUDE_CODE_SESSION_ID', env.CLAUDE_CODE_SESSION_ID)
      ?? candidate(provider, 'CLAUDE_SESSION_ID', env.CLAUDE_SESSION_ID);
  }

  if (provider === 'codex') {
    return candidate(provider, 'LATTICE_ACTIVITY_SESSION', env.LATTICE_ACTIVITY_SESSION)
      ?? candidate(provider, 'CODEX_SESSION_ID', env.CODEX_SESSION_ID)
      ?? candidate(provider, 'OPENAI_SESSION_ID', env.OPENAI_SESSION_ID)
      ?? candidate(provider, 'TERM_SESSION_ID', env.TERM_SESSION_ID);
  }

  if (provider === 'antigravity') {
    return candidate(provider, 'LATTICE_ACTIVITY_SESSION', env.LATTICE_ACTIVITY_SESSION)
      ?? candidate(provider, 'ANTIGRAVITY_SESSION_ID', env.ANTIGRAVITY_SESSION_ID)
      ?? candidate(provider, 'AGY_SESSION_ID', env.AGY_SESSION_ID);
  }

  if (provider === 'fake' || provider === 'unknown') {
    return candidate(provider, 'LATTICE_ACTIVITY_SESSION', env.LATTICE_ACTIVITY_SESSION);
  }

  return null;
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

  const native = nativeAdapterSession(env, provider);
  if (native !== null) return native;

  const boundary = trimToNull(env.LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY);
  if (boundary !== null) {
    return {
      sessionId: readOrCreateOwnerSessionToken(options.projectRoot, provider, boundary, options.now),
      sessionSource: 'generated-token',
      hostProvider: provider,
      nativeSessionRef: `${provider}:generated-boundary`,
    };
  }

  return null;
}
