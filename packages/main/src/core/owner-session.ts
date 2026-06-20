import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { resolveAdapterOwnerSession, type OwnerSessionEnv, type OwnerSessionHostProvider } from './owner-session-adapters.js';
import { gitProbe } from './git-probe.js';

export type SessionSource = 'explicit-env' | 'host-adapter' | 'generated-token' | 'derived-ppid';
export type LegacySessionSource = 'koala-env' | 'claude-code-env';

export interface SessionIdentity {
  sessionId: string;
  sessionSource: SessionSource;
  hostProvider?: OwnerSessionHostProvider;
  nativeSessionRef?: string;
}

export type SessionEnv = OwnerSessionEnv;

export interface SessionDerivationInputs {
  hostname: string;
  root: string;
  ppid: number;
}

export interface SessionResolveOptions {
  now?: () => string;
}

export function deriveLocalSessionId(host: string, root: string, ppid: number): string {
  const material = `${host}\0${root}\0${ppid}`;
  const digest = createHash('sha256').update(material).digest('hex');
  return `sess-${digest.slice(0, 16)}`;
}

export function normalizeSessionSource(value: unknown): SessionSource | null {
  if (value === 'explicit-env' || value === 'host-adapter' || value === 'generated-token' || value === 'derived-ppid') {
    return value;
  }
  if (value === 'koala-env') return 'explicit-env';
  if (value === 'claude-code-env') return 'host-adapter';
  return null;
}

export function resolveSessionIdentity(
  env: SessionEnv,
  inputs: SessionDerivationInputs,
  options: SessionResolveOptions = {},
): SessionIdentity {
  const adapted = resolveAdapterOwnerSession(env, { projectRoot: inputs.root, now: options.now });
  if (adapted !== null) return adapted;

  return {
    sessionId: deriveLocalSessionId(inputs.hostname, inputs.root, inputs.ppid),
    sessionSource: 'derived-ppid',
  };
}

function resolveSessionRoot(): string {
  const probe = gitProbe('git rev-parse --show-toplevel');
  const top = probe.ok ? probe.output.trim() : '';
  return top.length > 0 ? top : process.cwd();
}

let cachedSessionIdentity: SessionIdentity | null = null;

export function getSessionIdentity(): SessionIdentity {
  if (cachedSessionIdentity !== null) return cachedSessionIdentity;
  cachedSessionIdentity = resolveSessionIdentity(
    process.env as SessionEnv,
    { hostname: hostname(), root: resolveSessionRoot(), ppid: process.ppid },
  );
  return cachedSessionIdentity;
}

export function getSessionId(): string {
  return getSessionIdentity().sessionId;
}

export function resetSessionIdForTest(): void {
  cachedSessionIdentity = null;
}

